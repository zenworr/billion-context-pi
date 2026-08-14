import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  defaultCountTokens,
  type CompressionManifest,
  type CompressionState,
  type CoreMessage,
} from "acp-kernel";
import { extractCompressionManifest, sha256 } from "./manifest.js";
import { entriesToCoreMessages, messageIdentity } from "./messages.js";

export const RECENT_CHECKPOINT_RAW_TAIL_TOKENS = 48_000;

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

export interface CompiledCheckpointSource {
  source: string;
  sourceMessageIds: string[];
  sourceTokens: number;
}

export interface CompiledBranchSource {
  source: string;
  messages: CoreMessage[];
  sourceTokens: number;
  sourceMessageIds: string[];
}

export function compileBranchSource(entries: SessionEntry[], refsByRaw: Record<string, string>, projectContext?: string): CompiledBranchSource {
  const branchMessages = entriesToCoreMessages(entries);
  const messages: CoreMessage[] = projectContext
    ? [{
        id: "acp:branch-project-context",
        role: "system",
        contentType: "text",
        text: `[Current project instructions]\n${projectContext}`,
      }, ...branchMessages]
    : branchMessages;
  const source = serializeCoreMessages(messages, refsByRaw);
  return {
    source,
    messages,
    sourceTokens: defaultCountTokens(source),
    sourceMessageIds: unique(branchMessages.map((message) => rawMessageId(message.id))),
  };
}

export function compileCheckpointSource(input: {
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  state: CompressionState;
  includePriorCheckpoint?: boolean;
}): CompiledCheckpointSource {
  const preparedMessages = matchPreparedMessages(
    [...input.preparation.messagesToSummarize, ...input.preparation.turnPrefixMessages],
    input.branchEntries,
  );
  const fullManifest = extractCompressionManifest(preparedMessages, refsFor(preparedMessages, input.state.messageRefs.byRaw));
  const rawTail = recentRawTail(preparedMessages, RECENT_CHECKPOINT_RAW_TAIL_TOKENS);
  const preparedIds = new Set(preparedMessages.map((message) => rawMessageId(message.id)));
  const activeBlocks = input.state.blocks
    .filter((block) => block.active && block.effectiveMessageIds.every((id) => preparedIds.has(rawMessageId(id))))
    .sort((left, right) => left.createdAt - right.createdAt || left.blockId.localeCompare(right.blockId));
  const priorCheckpoint = input.includePriorCheckpoint === false
    ? ""
    : input.preparation.previousSummary?.trim()
      || input.state.checkpoints.at(-1)?.summary.trim()
      || "";
  const requirements = renderCurrentRequirements(fullManifest);
  const parts: string[] = [];
  if (priorCheckpoint) parts.push(`[Prior checkpoint]\n${priorCheckpoint}`);
  if (activeBlocks.length > 0) {
    parts.push(`[Active ACP block summaries and manifests]\n${activeBlocks.map((block) => [
      `Block ${block.blockId} (Tier ${block.tier})`,
      `Summary:\n${block.renderedSummary || block.summary}`,
      `Manifest:\n${stableStringify(block.manifest ?? null)}`,
    ].join("\n")).join("\n\n")}`);
  }
  parts.push(`[Current requirements]\n${requirements || "No explicit current requirements were extracted."}`);
  // The complete deterministic manifest covers exact facts outside the recent
  // raw tail. This prevents the first checkpoint from silently losing old
  // paths, commands, errors, IDs, or semantic requirements.
  parts.push(`[Deterministic full-prefix manifest]\n${stableStringify(fullManifest)}`);
  if (rawTail.length > 0) {
    parts.push(`[Recent raw tail]\n${serializeCoreMessages(rawTail, input.state.messageRefs.byRaw)}`);
  }
  const source = parts.join("\n\n");
  const priorRecord = input.state.checkpoints.at(-1);
  // Coverage is exact: every prepared source message represented by the full
  // manifest is recorded, not only the recent raw tail. Prior checkpoint
  // coverage remains reachable through the new checkpoint as well.
  const sourceMessageIds = unique([
    ...(priorCheckpoint && priorRecord ? priorRecord.sourceMessageIds : []),
    ...preparedMessages.map((message) => rawMessageId(message.id)),
  ]);
  return { source, sourceMessageIds, sourceTokens: defaultCountTokens(source) };
}

export function prepareBranchSource(
  compiled: CompiledBranchSource,
  redact: (source: string) => string,
): { source: string; manifest: CompressionManifest } {
  const messages = compiled.messages.map((message) => ({
    ...message,
    text: redact(message.text ?? ""),
  }));
  const refs = Object.fromEntries(messages.map((message) => [message.id, rawMessageId(message.id)]));
  return {
    source: serializeCoreMessages(messages, refs),
    manifest: extractCompressionManifest(messages, refs),
  };
}

export function manifestForCompiledSource(source: string): CompressionManifest {
  const id = `compiled:${sha256(source)}`;
  return extractCompressionManifest(
    [{ id, role: "system", contentType: "text", text: source }],
    { [id]: id },
  );
}

function matchPreparedMessages(
  prepared: CompactionPreparation["messagesToSummarize"],
  branchEntries: SessionEntry[],
): CoreMessage[] {
  const remaining = new Map<string, number>();
  for (const message of prepared) {
    const identity = messageIdentity(message);
    remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  }
  const selected: SessionEntry[] = [];
  for (const entry of branchEntries) {
    if (entry.type !== "message") continue;
    const identity = messageIdentity(entry.message);
    const count = remaining.get(identity) ?? 0;
    if (count <= 0) continue;
    selected.push(entry);
    remaining.set(identity, count - 1);
  }
  const unmatched = [...remaining.values()].reduce((total, count) => total + count, 0);
  const matched = entriesToCoreMessages(selected);
  if (unmatched > 0) {
    throw new Error(`Pi compaction preparation could not be matched completely to branch entries (${prepared.length - unmatched}/${prepared.length}).`);
  }
  return matched;
}

function recentRawTail(messages: CoreMessage[], tokenBudget: number): CoreMessage[] {
  const selected: CoreMessage[] = [];
  let tokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const messageTokens = defaultCountTokens(message.text ?? "");
    if (selected.length > 0 && tokens + messageTokens > tokenBudget) break;
    selected.unshift(message);
    tokens += messageTokens;
  }
  return selected;
}

function renderCurrentRequirements(manifest: CompressionManifest): string {
  const semantic = manifest.semanticFacts;
  if (!semantic) return "";
  const lines = [
    ...semantic.objectives.map((fact) => `Objective: ${fact.text}`),
    ...semantic.requirements.map((fact) => `Requirement: ${fact.text}`),
    ...semantic.decisions.map((fact) => `Decision: ${fact.decision}${fact.rationale ? ` because ${fact.rationale}` : ""}`),
    ...semantic.active.map((fact) => `Active work: ${fact.text}`),
    ...semantic.blocked.map((fact) => `Blocked: ${fact.text}`),
    ...semantic.openQuestions.map((fact) => `Open question: ${fact.text}`),
    ...semantic.nextSteps.map((fact) => `Next step: ${fact.text}`),
  ];
  return unique(lines).join("\n");
}

function serializeCoreMessages(messages: CoreMessage[], refsByRaw: Record<string, string>): string {
  return messages.map((message) => {
    const rawId = rawMessageId(message.id);
    const ref = refsByRaw[message.id] ?? refsByRaw[rawId] ?? rawId;
    const tool = message.toolName ? ` ${message.toolName}` : "";
    return `[${ref}] ${message.role}/${message.contentType}${tool}\n${message.text ?? ""}`;
  }).join("\n\n");
}

function refsFor(messages: CoreMessage[], refsByRaw: Record<string, string>): Record<string, string> {
  return Object.fromEntries(messages.map((message) => {
    const rawId = rawMessageId(message.id);
    return [message.id, refsByRaw[message.id] ?? refsByRaw[rawId] ?? rawId];
  }));
}

function rawMessageId(id: string): string {
  return id.split("#", 1)[0]!;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
