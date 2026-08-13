import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CompressionBlock, CompressionState, CoreMessage, Config } from "acp-kernel";
import type { CompressionTier } from "./config.js";
import { compressionThinkingLevel, compressorModeForTier, parseCompressionModel } from "./config.js";
import { CompressionModelError, compressionErrorUsage, compressWithModel, type CompressionUsage } from "./model-compressor.js";
import type { AcpRuntime } from "./runtime.js";
import { debug, logError, logInfo, logThrow } from "./log.js";
import { estimateTokens, collectCoveredMessageIds } from "./tokens.js";

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

const RangeSpec = Type.Object({
  startId: Type.String({ description: 'Message ref, e.g. "m00005" (from the acp tag), or a block id "b3".' }),
  endId: Type.String({ description: 'Inclusive end ref. Must be at or after startId.' }),
  summary: Type.Optional(Type.String({ description: "Complete technical summary replacing the range. Required when the target tier uses the main model; omit when it uses the configured compression model." })),
  topic: Type.Optional(Type.String({ description: "Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Omit to use top-level topic. When compressing multiple unrelated ranges, give each its own topic for better quality." })),
});

const CompressParams = Type.Object({
  topic: Type.Optional(Type.String({ description: "Fallback topic for entries without their own. Omit when each content entry specifies its own topic." })),
  content: Type.Array(RangeSpec, { description: "One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges in one call, give each its own topic." }),
  summaryMaxChars: Type.Optional(Type.Number({ description: "Override max summary length (default max: 20000 chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit." })),
});

type CompressArgs = Static<typeof CompressParams>;

export function makeCompressTool(runtime: AcpRuntime): ToolDefinition<typeof CompressParams> {
  return {
    name: "compress",
    label: "Compress",
    description:
      "Replace older conversation ranges with detailed summaries. Write each summary unless that range's target tier is configured to use /acp-model; in that case omit summary and the tool writes it.",
    promptSnippet: "compress({ content: [{ startId, endId, summary? }] }) or batch multiple ranges",
    promptGuidelines: [
      "Each message has an acp tag with its mNNNNN ref. Compress ranges by their refs.",
      "Batch multiple unrelated ranges in one call and give each one a topic.",
      "When the target tier uses the main model, write a dense summary preserving paths, signatures, errors, and decisions.",
      "When the target tier uses the configured compression model, omit summary; the tool generates and returns it.",
      "Never compress content the current step is actively using.",
    ],
    parameters: CompressParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      let result: HandleCompressResult;
      try {
        result = await handleCompress(params as CompressArgs, runtime, ctx, signal, toolCallId);
      } catch (e) {
        logThrow("compress", e, { sid: ctx.sessionManager.getSessionId(), ranges: (params as CompressArgs).content?.length ?? 0 });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result.text }], usage: result.usage };
    },
  };
}

interface HandleCompressResult {
  text: string;
  usage?: CompressionUsage;
}

interface GeneratedSummary {
  tier: CompressionTier;
  model: string;
  fallbackFrom?: string;
}

interface ResolvedRange {
  startId: string;
  endId: string;
  summary: string;
  topic?: string;
  generated?: GeneratedSummary;
}

async function handleCompress(
  args: CompressArgs,
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  toolCallId?: string,
): Promise<HandleCompressResult> {
  const ranges = args.content ?? [];
  if (ranges.length === 0) return { text: "No ranges provided." };
  const { state: initialState, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  const estimatedTokens = estimateTokens(coreMessages, collectCoveredMessageIds(initialState));
  const realUsage = ctx.getContextUsage?.();
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state: initialState,
    config,
    tokenCount: realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : estimatedTokens,
  });
  const state = turn.state;
  const compressionMessages = coreMessages;
  const visibleMessages = turn.messages;
  const beforeTokens = estimateTokens(visibleMessages, collectCoveredMessageIds(state));
  const summaryMaxChars = args.summaryMaxChars;
  const externalSummaryMaxChars = summaryMaxChars ?? 20_000;
  const topLevelTopic = args.topic;

  debug.event("compress-in", {
    sid: ctx.sessionManager.getSessionId(),
    ranges: ranges.length,
    spans: ranges.map((r) => ({ span: `${r.startId}..${r.endId}`, summaryLen: r.summary?.length ?? null, summary: r.summary ?? null, topic: r.topic ?? topLevelTopic ?? null })),
    blocksBefore: state.blocks.length,
    activeBefore: state.blocks.filter((b) => b.active).length,
    beforeMsgCount: visibleMessages.length,
    beforeTokens,
  });

  let totalUsage: CompressionUsage | undefined;
  const resolved: ResolvedRange[] = [];
  const preview = previewRanges(runtime, ranges, state, compressionMessages, config, summaryMaxChars);
  const configuredSources = new Map<number, { tier: CompressionTier; source: string }>();
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]!;
    const previewBlock = preview.blocksByIndex.get(index);
    if (!previewBlock || range.summary?.trim()) continue;
    const tier = compressionTier(previewBlock);
    if (compressorModeForTier(runtime.adapter, tier) === "main") {
      throw new Error(`Tier-${tier} uses the main model; summary is required for ${range.startId}..${range.endId}.`);
    }
    configuredSources.set(index, {
      tier,
      source: serializeCompressionSource(previewBlock, state, compressionMessages),
    });
  }
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]!;
    const previewBlock = preview.blocksByIndex.get(index);
    if (!previewBlock) continue;
    const supplied = range.summary?.trim();
    if (supplied) {
      resolved.push({ startId: range.startId, endId: range.endId, summary: supplied, topic: range.topic ?? topLevelTopic });
      continue;
    }
    const configuredSource = configuredSources.get(index);
    if (!configuredSource) throw new Error(`Cannot resolve configured compression source for ${range.startId}..${range.endId}.`);
    const { tier, source } = configuredSource;
    try {
      const generated = await generateConfiguredSummary(
        runtime,
        ctx,
        tier,
        source,
        externalSummaryMaxChars,
        signal,
      );
      totalUsage = addUsage(totalUsage, generated.usage);
      resolved.push({
        startId: range.startId,
        endId: range.endId,
        summary: generated.summary,
        topic: range.topic ?? topLevelTopic,
        generated: { tier, model: generated.model, fallbackFrom: generated.fallbackFrom },
      });
    } catch (error) {
      const failedUsage = compressionErrorUsage(error);
      if (failedUsage) totalUsage = addUsage(totalUsage, failedUsage);
      const message = error instanceof Error ? error.message : String(error);
      return { text: `Compression model failed before ACP state was changed: ${message}`, usage: totalUsage };
    }
  }
  if (resolved.length === 0) {
    return { text: `Compression failed: ${preview.errors.join("; ") || "no range created a block"}`, usage: totalUsage };
  }

  const applied = runtime.core.applyCompression({
    ranges: resolved.map((r) => ({ startRef: r.startId, endRef: r.endId, summary: r.summary, topic: r.topic, summaryMaxChars, compressCallId: toolCallId })),
    messages: compressionMessages,
    state,
    config,
  });
  await runtime.save(applied.state, ctx);
  const { blocksCreated, tokensCompressed, errors: applyErrors, warnings } = applied.result;
  const errors = [...preview.errors, ...applyErrors];
  const afterTokens = Math.max(0, beforeTokens - tokensCompressed);
  const newBlocks = applied.state.blocks.slice(-blocksCreated);

  debug.event("compress-out", {
    sid: ctx.sessionManager.getSessionId(),
    blocksCreated,
    tokensCompressed,
    beforeTokens,
    afterTokens,
    afterMsgCount: applied.state.blocks.length,
    errors: errors.length,
    errorDetails: errors.slice(0, 3),
    blocksAfter: applied.state.blocks.length,
    activeAfter: applied.state.blocks.filter((b) => b.active).length,
    newBlocks: newBlocks.map((b) => ({ blockId: b.blockId, tier: b.tier, summaryLen: b.summary.length, directMsgCount: b.directMessageIds.length, effectiveMsgCount: b.effectiveMessageIds.length, summary: b.summary })),
  });

  logInfo("compress", {
    sid: ctx.sessionManager.getSessionId(),
    event: "applied",
    ranges: ranges.length,
    blocksCreated,
    tokensCompressed,
    beforeTokens,
    afterTokens,
    warnings: warnings.length,
    errors: errors.length,
    newBlockIds: newBlocks.map((b) => b.blockId),
  });
  if (errors.length > 0) {
    logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "errors", count: errors.length, errors: errors.slice(0, 5) });
  }
  if (warnings.length > 0) {
    logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "warnings", count: warnings.length, warnings: warnings.slice(0, 5) });
  }

  const lines = [`▣ ACP | ${formatK(beforeTokens)} → ${formatK(afterTokens)} tokens (~${formatK(tokensCompressed)} reclaimed, ${blocksCreated} block${blocksCreated > 1 ? "s" : ""})`];
  if (warnings.length > 0) lines.push("⚠️ " + warnings.join("; "));
  if (errors.length > 0) lines.push("Errors: " + errors.join("; "));
  for (const range of resolved) {
    if (!range.generated) continue;
    const block = newBlocks.find((candidate) => candidate.startRef === range.startId && candidate.endRef === range.endId && candidate.summary === range.summary);
    if (!block) continue;
    const blockId = block.blockId;
    const fallback = range.generated.fallbackFrom ? `; fallback from ${range.generated.fallbackFrom}` : "";
    lines.push("", `Generated summary for ${blockId} (Tier ${range.generated.tier}, ${range.generated.model}${fallback}):`, range.summary);
  }
  return { text: lines.join("\n"), usage: totalUsage };
}

interface BatchPreview {
  blocksByIndex: Map<number, CompressionBlock>;
  errors: string[];
}

function previewRanges(
  runtime: AcpRuntime,
  ranges: CompressArgs["content"],
  state: CompressionState,
  messages: CoreMessage[],
  config: Config,
  summaryMaxChars: number | undefined,
): BatchPreview {
  const summaries = ranges.map((range, index) => range.summary?.trim() || `ACP batch preview ${index}: validates boundaries and resolves the target compression tier only.`);
  const preview = runtime.core.applyCompression({
    ranges: ranges.map((range, index) => ({
      startRef: range.startId,
      endRef: range.endId,
      summary: summaries[index]!,
      summaryMaxChars,
    })),
    messages,
    state,
    config,
  });
  const created = preview.state.blocks.slice(-preview.result.blocksCreated);
  const blocksByIndex = new Map<number, CompressionBlock>();
  for (const block of created) {
    const index = ranges.findIndex((range) => range.startId === block.startRef && range.endId === block.endRef);
    if (index >= 0) blocksByIndex.set(index, block);
  }
  return { blocksByIndex, errors: preview.result.errors };
}

function compressionTier(block: CompressionBlock): CompressionTier {
  if (block.tier === 1 || block.tier === 2 || block.tier === 3) return block.tier;
  throw new Error(`Unsupported compression tier: ${block.tier}.`);
}

function serializeCompressionSource(block: CompressionBlock, state: CompressionState, messages: CoreMessage[]): string {
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const messageIndex = new Map(messages.map((message, index) => [message.id, index]));
  const parts: Array<{ index: number; text: string }> = [];

  const blockById = new Map(state.blocks.map((candidate) => [candidate.blockId, candidate]));
  for (const blockId of block.directBlockIds) {
    const source = blockById.get(blockId);
    if (!source) throw new Error(`Source block ${blockId} is unavailable.`);
    const indices = source.effectiveMessageIds
      .map((id) => messageIndex.get(id))
      .filter((index): index is number => index !== undefined);
    const topic = source.topic ? ` [${source.topic}]` : "";
    const summaryTokens = Math.max(1, Math.ceil(source.summary.length / 4));
    const reduction = `${Math.max(1, Math.round(source.compressedTokens / summaryTokens))}x`;
    parts.push({
      index: indices.length > 0 ? Math.min(...indices) : Number.MAX_SAFE_INTEGER,
      text: `Source: ${source.blockId} (${formatK(source.compressedTokens)}→${formatK(summaryTokens)} tok, ${reduction}).${topic}\n${source.summary}`,
    });
  }

  const rawIds = block.directMessageIds.length > 0 || block.directBlockIds.length > 0
    ? block.directMessageIds
    : block.effectiveMessageIds;
  for (const id of rawIds) {
    const message = messageById.get(id);
    if (!message) throw new Error(`Source message ${id} is unavailable.`);
    parts.push({ index: messageIndex.get(id) ?? Number.MAX_SAFE_INTEGER, text: serializeCoreMessage(message, state) });
  }

  if (parts.length === 0) throw new Error("Selected compression range has no readable message content.");
  return parts.sort((left, right) => left.index - right.index).map((part) => part.text).join("\n\n");
}


function serializeCoreMessage(message: CoreMessage, state: CompressionState): string {
  const ref = state.messageRefs.byRaw[message.id] ?? message.id;
  const tool = message.toolName ? ` ${message.toolName}` : "";
  return `[${ref}] ${message.role}/${message.contentType}${tool}\n${message.text ?? ""}`;
}

async function generateConfiguredSummary(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  tier: CompressionTier,
  source: string,
  summaryMaxChars: number,
  signal: AbortSignal | undefined,
): Promise<{ summary: string; usage: CompressionUsage; model: string; fallbackFrom?: string }> {
  const configuredRef = parseCompressionModel(runtime.adapter.compress?.model);
  const configuredLabel = runtime.adapter.compress?.model ?? "configured model";
  const configured = configuredRef
    ? ctx.modelRegistry.find(configuredRef.provider, configuredRef.id)
    : undefined;
  const configuredInScope = !configuredRef || !ctx.scopedModels || ctx.scopedModels.length === 0
    || ctx.scopedModels.some((candidate) => candidate.model.provider === configuredRef.provider && candidate.model.id === configuredRef.id);
  let failure = configuredRef
    ? configuredInScope ? "model is unavailable or unauthenticated" : "model is outside the active model scope"
    : "no model is selected";
  let failedUsage: CompressionUsage | undefined;
  if (configured && configuredInScope && ctx.modelRegistry.hasConfiguredAuth(configured)) {
    try {
      return await compressWithModel({ ctx, model: configured, thinkingLevel: compressionThinkingLevel(runtime.adapter), tier, source, prompts: runtime.prompts, summaryMaxChars, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      failedUsage = compressionErrorUsage(error);
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  const main = ctx.model;
  const sameAsConfigured = main && configured && main.provider === configured.provider && main.id === configured.id;
  if (!main || !ctx.modelRegistry.hasConfiguredAuth(main) || sameAsConfigured) {
    throw new CompressionModelError(`Configured compressor ${configuredLabel} failed (${failure}). No distinct authenticated main model is available for fallback.`, failedUsage);
  }
  const warning = `Configured compressor ${configuredLabel} failed (${failure}); falling back to ${main.provider}/${main.id}.`;
  logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "model-fallback", tier, configuredModel: configuredLabel, mainModel: `${main.provider}/${main.id}`, error: failure });
  if (ctx.hasUI) ctx.ui.notify(warning, "warning");
  try {
    const fallback = await compressWithModel({ ctx, model: main, thinkingLevel: ctx.thinkingLevel ?? "medium", tier, source, prompts: runtime.prompts, summaryMaxChars, signal });
    return { ...fallback, usage: failedUsage ? addUsage(failedUsage, fallback.usage) : fallback.usage, fallbackFrom: configuredLabel };
  } catch (error) {
    const fallbackUsage = compressionErrorUsage(error);
    throw new CompressionModelError(
      error instanceof Error ? error.message : String(error),
      failedUsage && fallbackUsage ? addUsage(failedUsage, fallbackUsage) : failedUsage ?? fallbackUsage,
    );
  }
}

function addUsage(total: CompressionUsage | undefined, usage: CompressionUsage): CompressionUsage {
  if (!total) return usage;
  const reasoning = total.reasoning !== undefined || usage.reasoning !== undefined
    ? (total.reasoning ?? 0) + (usage.reasoning ?? 0)
    : undefined;
  const cacheWrite1h = total.cacheWrite1h !== undefined || usage.cacheWrite1h !== undefined
    ? (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0)
    : undefined;
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    cacheWrite1h,
    reasoning,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
}
