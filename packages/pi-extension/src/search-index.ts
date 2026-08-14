/**
 * Search index — bridges pi's session log into acp-kernel's search.
 *
 * Builds SearchDoc[] from:
 *  1. All compression blocks (active AND inactive) — via blockDocs()
 *  2. Historical messages that compression folded into a block summary.
 *
 * Which messages are searchable? Those covered by SOME block's
 * effectiveMessageIds — i.e. messages that were compressed into a summary and
 * are no longer individually visible. Messages still live in context (not in
 * any block) are skipped: the model can already see them.
 *
 * We deliberately do NOT use pi's buildContextEntries for the visible check:
 * ACP prunes messages itself (no pi `compaction` entry is written), so pi
 * reports ALL entries as in-context. The ACP state is the source of truth.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { artifactDocs, blockDocs, messageDocs, type SearchDoc, type MessageInput, type MessageRole } from "acp-kernel";
import { entriesToCoreMessages } from "./messages.js";
import type { CompressionState } from "acp-kernel";

interface PersistedSearchIndex {
    version: 1;
    graphRevision: number;
    entryCount: number;
    lastEntryId?: string;
    docs: SearchDoc[];
}

/** Load a persistent revision-keyed index when possible; rebuild atomically otherwise. */
export async function buildSearchDocsCached(ctx: ExtensionContext, state: CompressionState): Promise<SearchDoc[]> {
    const entries = ctx.sessionManager.getEntries();
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) return buildSearchDocsFromEntries(entries, state);
    const indexFile = `${sessionFile}.acp-search-index.json`;
    let lastEntryId: string | undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;
        if ("id" in entry && typeof entry.id === "string") { lastEntryId = entry.id; break; }
    }
    try {
        const cached = JSON.parse(await readFile(indexFile, "utf8")) as PersistedSearchIndex;
        if (cached.version === 1 && cached.graphRevision === state.graphRevision
            && cached.entryCount === entries.length && cached.lastEntryId === lastEntryId && Array.isArray(cached.docs)) {
            return cached.docs;
        }
    } catch {
        // Missing, torn, or stale indexes are safe to rebuild from canonical state.
    }
    const docs = buildSearchDocsFromEntries(entries, state);
    const record: PersistedSearchIndex = { version: 1, graphRevision: state.graphRevision, entryCount: entries.length, lastEntryId, docs };
    const temporary = `${indexFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, indexFile);
    return docs;
}

/** All message refs covered by any block (active or inactive). */
function buildCoveredRefs(state: CompressionState): Set<string> {
    const s = new Set<string>();
    for (const b of state.blocks) {
        for (const id of b.effectiveMessageIds) s.add(id);
    }
    for (const checkpoint of state.checkpoints) {
        for (const id of checkpoint.sourceMessageIds) s.add(id);
    }
    return s;
}

/** ref → owning blockId (active and latest block wins). */
function buildMessageOwnerMap(state: CompressionState): Map<string, string> {
    const m = new Map<string, string>();
    const ranked = [...state.blocks].sort((left, right) => {
        if (left.active !== right.active) return left.active ? 1 : -1;
        if (left.tier !== right.tier) return left.tier - right.tier;
        return left.createdAt - right.createdAt;
    });
    for (const block of ranked) {
        for (const id of block.effectiveMessageIds) m.set(id, block.blockId);
    }
    return m;
}

function rawMessageId(id: string): string {
    return id.split("#", 1)[0]!;
}

function estimateTokens(text: string): number {
    if (typeof text !== "string" || !text) return 0;
    const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    const cjkCount = cjk?.length ?? 0;
    return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

function toRole(entry: SessionMessageEntry): MessageRole | null {
    const role = entry.message.role;
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    if (role === "toolResult") return "tool";
    return null;
}

export function buildSearchDocs(ctx: ExtensionContext, state: CompressionState): SearchDoc[] {
    return buildSearchDocsFromEntries(ctx.sessionManager.getEntries(), state);
}

function buildSearchDocsFromEntries(allEntries: SessionEntry[], state: CompressionState): SearchDoc[] {
    const covered = buildCoveredRefs(state);
    const ownerMap = buildMessageOwnerMap(state);
    const checkpointOwnerMap = new Map<string, string>();
    for (const checkpoint of state.checkpoints) {
        for (const id of checkpoint.sourceMessageIds) checkpointOwnerMap.set(rawMessageId(id), checkpoint.id);
    }

    const blockTier = new Map<string, number>();
    for (const b of state.blocks) blockTier.set(b.blockId, b.tier ?? 1);

    const msgs: MessageInput[] = [];
    for (const entry of allEntries) {
        if (entry.type !== "message") continue;
        const role = toRole(entry);
        if (!role) continue;

        const cores = entriesToCoreMessages([entry]);
        for (const cm of cores) {
            if (!cm.id) continue;
            // Only include messages that were compressed into a block.
            // Still-live messages are visible to the model — no need to search them.
            if (!covered.has(cm.id) && !covered.has(rawMessageId(cm.id))) continue;
            const text = cm.text ?? "";
            if (!text || text.length < 2) continue;
            const ownerBlock = ownerMap.get(cm.id) ?? ownerMap.get(rawMessageId(cm.id));
            const checkpointId = ownerBlock ? undefined : checkpointOwnerMap.get(rawMessageId(cm.id));
            msgs.push({
                ref: cm.id,
                role,
                text,
                tokens: estimateTokens(text),
                blockId: ownerBlock,
                checkpointId,
                tier: ownerBlock ? blockTier.get(ownerBlock) : undefined,
            });
        }
    }

    const artifacts = artifactDocs(state.artifacts.filter((artifact) => artifact.retrievable).map((artifact) => ({
        ref: artifact.id,
        title: artifact.toolName ? `${artifact.toolName} artifact` : "ACP artifact",
        text: [artifact.toolName, artifact.sourceMessageId, artifact.toolCallId, artifact.localPath, artifact.sha256].filter(Boolean).join(" "),
        tokens: artifact.estimatedTokens,
    })));
    const checkpoints: SearchDoc[] = state.checkpoints.map((checkpoint) => ({
        kind: "checkpoint",
        ref: checkpoint.id,
        title: `Checkpoint epoch ${checkpoint.epoch}`,
        text: [checkpoint.summary, ...checkpoint.sourceMessageIds].join("\n"),
        tokens: estimateTokens(checkpoint.summary),
    }));
    return [...blockDocs(state), ...checkpoints, ...messageDocs(msgs), ...artifacts];
}
