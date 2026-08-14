import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { searchBlocks, type SearchDocKind, type SearchResult } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { buildSearchDocsCached } from "./search-index.js";
import { logThrow } from "./log.js";
import { recordRecentRetrievals } from "./retrieval-tracking.js";
import { publicAcpRef, type PublicRefKind } from "./public-refs.js";

const SearchParams = Type.Object({
    query: Type.String({ description: "Keywords, path, symbol, or exact error text to locate in compressed history." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Max results (default 10, hard maximum 20)." })),
    kinds: Type.Optional(Type.Array(Type.Union([
        Type.Literal("block"), Type.Literal("message"), Type.Literal("artifact"), Type.Literal("checkpoint"),
    ]), { description: "Optional source filters: block, message, artifact." })),
    tiers: Type.Optional(Type.Array(Type.Number(), { description: "Optional compression-tier filters for blocks and messages." })),
    roles: Type.Optional(Type.Array(Type.Union([
        Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"),
    ]), { description: "Optional historical-message role filters." })),
});

type SearchArgs = Static<typeof SearchParams>;

export function makeSearchTool(runtime: AcpRuntime): ToolDefinition<typeof SearchParams> {
    return {
        name: "search_context",
        label: "Search Context",
        description:
            "Search compressed blocks AND historical messages by keyword. Use to cheaply locate detail before decompressing. Returns ranked results with ref, size, preview, and the decompress command to retrieve full content.",
        promptSnippet: 'search_context({ query: "auth token" })',
        promptGuidelines: [
            "Search locates detail folded into summaries or past messages — cheaper than decompressing blind.",
            "Each result shows a ref (b3 block / m00350 message), size, and the exact decompress command for full content.",
            "Message hits link to the owning block — decompress that block to recover surrounding detail.",
        ],
        parameters: SearchParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
            let result: Awaited<ReturnType<typeof handleSearch>>;
            try {
                result = await handleSearch(params as SearchArgs, runtime, ctx);
            } catch (e) {
                logThrow("search", e, { sid: ctx.sessionManager.getSessionId(), query: (params as SearchArgs).query });
                throw e;
            }
            return { details: result.details, content: [{ type: "text", text: result.text }] };
        },
    };
}

async function handleSearch(args: SearchArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<{
    text: string;
    details: { version: 1; query: string; results: Array<SearchResult & { canonicalRef: string; pinCommand: string }> };
}> {
    const { state } = await runtime.stateFor(ctx);
    const docs = await buildSearchDocsCached(ctx, state);
    const msgCount = docs.filter((d) => d.kind === "message").length;
    const blockCount = docs.filter((d) => d.kind === "block").length;
    const artifactCount = docs.filter((d) => d.kind === "artifact").length;
    const checkpointCount = docs.filter((d) => d.kind === "checkpoint").length;
    const results = searchBlocks(docs, args.query, {
        limit: Math.min(20, Math.max(1, args.limit ?? 10)),
        kinds: args.kinds as SearchDocKind[] | undefined,
        tiers: args.tiers,
        roles: args.roles,
    });

    if (results.length === 0) {
        const blocks = state.blocks.length;
        return { text: `No matches for "${args.query}" across ${blocks} block(s) and ${msgCount} historical message(s).`, details: { version: 1, query: args.query, results: [] } };
    }

    await recordRecentRetrievals(runtime, ctx, results.map((result) => result.checkpointId ?? result.blockId ?? result.ref));
    const enriched = results.map((result) => {
        const canonicalRef = publicAcpRef(result.kind as PublicRefKind, result.ref);
        return { ...result, canonicalRef, pinCommand: `pin_context({ ref: "${canonicalRef}" })` };
    });
    const lines = [`Found ${results.length} match(es) for "${args.query}" (searched ${blockCount} blocks + ${checkpointCount} checkpoints + ${msgCount} messages + ${artifactCount} artifacts):`];
    for (const r of enriched) lines.push("", formatResult(r));
    return { text: lines.join("\n"), details: { version: 1, query: args.query, results: enriched } };
}

function formatResult(r: SearchResult & { canonicalRef: string; pinCommand: string }): string {
    const sizeStr = r.tokens != null ? formatSize(r.tokens) : "";
    const meta = [
        `${r.kind} ${r.canonicalRef}`,
        r.role ? `(${r.role})` : "",
        r.kind === "artifact" ? "" : `T${r.tier}`,
        `score:${r.score.toFixed(2)}`,
        sizeStr,
    ].filter(Boolean).join(" ");

    const header = `${meta}  "${truncate(r.title, 50)}"`;

    const decompressHint = r.kind === "block" || r.kind === "checkpoint"
        ? `→ decompress({ blockId: "${r.ref}" })`
        : r.kind === "artifact"
          ? `→ acp_artifact({ id: "${r.ref}" })`
          : r.blockId
            ? `→ decompress({ blockId: "${r.blockId}" })  (block containing message ${r.ref})`
            : r.checkpointId
              ? `→ decompress({ blockId: "${r.ref}" })  (message owned by checkpoint ${r.checkpointId})`
              : `(message ${r.ref} is still visible in context)`;

    return `${header}\n  ${truncate(r.preview, 2_000)}\n  ${decompressHint}\n  → ${r.pinCommand}`;
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
}

function formatSize(tokens: number): string {
    if (tokens < 1000) return `${tokens}tok`;
    if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1_000_000).toFixed(1)}M`;
}
