import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionBeforeCompactEvent,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { CompressionManifest, NudgeDecision, CompressionBlock, CompressionState, Prompts } from "acp-kernel";
import { commitCheckpointEpoch, renderNudgeText, resolvePrompts, defaultPrompts } from "acp-kernel";
import {
  type AdapterConfig,
  compressorModeForTier,
  compressionThinkingLevel,
  parseCompressionModel,
  resolveDelegate,
  safeResumeThreshold,
  forcedCompressionLimit,
} from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeArtifactTool } from "./artifact-tool.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, runningRunsSnapshot, resetDelegateUsage, setDelegateDisplayUsage } from "./delegate-tool.js";
import { makeCommands } from "./commands.js";
import { coreOutToAgentMessages } from "./messages.js";
import { buildAcpSystemPrompt, ACP_DELEGATE_PROMPT } from "./system-prompt.js";
import { delegateStatusWidget } from "./fleet-widget.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { debug, setDebugEnabled, logError, logInfo, logWarn, logThrow, closeLogStream } from "./log.js";
import {
  calibratedTokenEstimate,
  collectCoveredMessageIds,
  conservativeTokenCount,
  estimateTokens,
  lastUserMessageId,
  modelCalibrationKey,
  updateTokenCalibration,
} from "./tokens.js";
import { checkForUpdate } from "./update.js";
import { runSetupAndNotify } from "./setup-subagent-tools.js";
import { loadUserConfig, applyUserConfig } from "./user-config.js";
import { formatSystemPromptForEvent } from "./compat.js";
import { wireAutomaticCompaction, type AutomaticCompactionController } from "./automatic-compaction.js";
import { captureWorldStateAsync, FreshnessTracker, renderWorldOverlay } from "./freshness.js";
import { registerPinTool, renderPins } from "./pin-tool.js";
import { cleanupArtifactStore, ensureArtifactStore, removeArtifactSession } from "./artifact-store.js";
import { compressWithModel } from "./model-compressor.js";
import { ensureCompactionTransferAllowed, redactCompactionSecrets } from "./compress-tool.js";
import {
  compileBranchSource,
  compileCheckpointSource,
  manifestForCompiledSource,
  prepareBranchSource,
} from "./checkpoint-source.js";
import { sha256, structuredSummaryFromRendered, validateAndRepairSummary } from "./manifest.js";


type AgentMessage = SessionMessageEntry["message"];

declare const CURRENT_VERSION: string;

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const runtime = createRuntime(adapter);
    const freshness = new FreshnessTracker();
    const optimization = wireAutomaticCompaction(pi, runtime);
    wireCompactionCoordinator(pi, runtime, freshness, optimization);
    wireSessionLifecycle(pi, runtime, freshness);
    wireContextTransform(pi, runtime, freshness);
    wireSystemPrompt(pi, runtime, freshness);
    wireToolGuardrails(pi, runtime);
    pi.registerTool(makeCompressTool(runtime));
    pi.registerTool(makeDecompressTool(runtime));
    pi.registerTool(makeSearchTool(runtime));
    pi.registerTool(makeStatusTool(runtime));
    pi.registerTool(makeArtifactTool(runtime));
    registerPinTool(pi, runtime);
    for (const { name, options } of makeCommands(runtime)) {
      pi.registerCommand(name, options);
    }
  };
}

export default createAcpExtension();

export const TOKEN_CALIBRATION_MAX_AGE_MS = 30 * 60 * 1_000;
export const HOST_SYSTEM_TOOL_RESERVE_TOKENS = 32_000;

export function shouldCancelHostCompaction(input: {
  reason: "manual" | "threshold" | "overflow";
  changed: boolean;
  projectedTokens: number;
  hostTokensBefore: number;
  safeThreshold: number;
  calibrationSamples?: number;
  calibrationUpdatedAt?: number;
  calibrationVerified?: boolean;
  now?: number;
  minimumSavings?: number;
  fixedReserveTokens?: number;
}): boolean {
  if (input.reason !== "threshold" || !input.changed) return false;
  const now = input.now ?? Date.now();
  if (!input.calibrationVerified || !input.calibrationSamples || !input.calibrationUpdatedAt) return false;
  if (now - input.calibrationUpdatedAt > TOKEN_CALIBRATION_MAX_AGE_MS || input.calibrationUpdatedAt > now) return false;
  const minimumSavings = input.minimumSavings ?? 12_000;
  const projectedTotal = input.projectedTokens + (input.fixedReserveTokens ?? HOST_SYSTEM_TOOL_RESERVE_TOKENS);
  return projectedTotal <= input.safeThreshold
    && input.hostTokensBefore - projectedTotal >= minimumSavings;
}

function wireCompactionCoordinator(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker, optimization: AutomaticCompactionController): void {
  const pendingCheckpointSources = new Map<string, { sourceMessageIds: string[]; sourceHash: string }>();
  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary || runtime.adapter.compress?.branchSummaryCompressor !== "configured") return;
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state } = await runtime.stateFor(ctx);
      const compiled = compileBranchSource(
        event.preparation.entriesToSummarize,
        state.messageRefs.byRaw,
        freshness.branchProjectContext(),
      );
      if (!compiled.source.trim()) throw new Error("Pi supplied no branch-bounded messages to summarize.");
      const model = configuredCompressionModel(runtime, ctx);
      if (!model) throw new Error("The configured branch summary model is unavailable or unauthenticated.");
      ensureCompactionTransferAllowed({
        activeProvider: ctx.model?.provider,
        configuredProvider: model.provider,
        allowCrossProvider: runtime.adapter.compress?.allowCrossProvider === true,
        acknowledgeCrossProviderDataTransfer: runtime.adapter.compress?.acknowledgeCrossProviderDataTransfer === true,
      });
      const prepared = prepareBranchSource(
        compiled,
        (source) => redactCompactionSecrets(source, runtime.adapter.compress?.secretPatterns),
      );
      const result = await compressWithModel({
        ctx,
        model,
        thinkingLevel: compressionThinkingLevel(runtime.adapter),
        tier: 1,
        source: prepared.source,
        prompts: runtime.prompts,
        summaryMaxChars: 30_000,
        signal: event.signal,
        trustedInstructions: event.preparation.customInstructions,
        replaceInstructions: event.preparation.replaceInstructions === true,
      });
      const validation = validateAndRepairSummary({
        summary: result.summary,
        manifest: prepared.manifest,
        sourceTokens: compiled.sourceTokens,
        tier: 1,
        summaryMaxChars: 30_000,
      });
      return {
        summary: {
          summary: validation.renderedSummary,
          usage: result.usage,
          details: {
            source: "hybrid-acp-configured-branch",
            route: result.model,
            thinking: result.thinking,
            sourceHash: prepared.manifest.sourceHash,
            sourceMessageIds: compiled.sourceMessageIds,
            validation: validation.status,
            instructionHash: event.preparation.customInstructions
              ? sha256(event.preparation.customInstructions)
              : undefined,
            replaceInstructions: event.preparation.replaceInstructions === true,
            structuredSummary: structuredSummaryFromRendered(validation.renderedSummary, prepared.manifest),
          },
        },
      };
    } catch (error) {
      logWarn("compaction", {
        event: "configured-branch-summary-failed-host-fallback",
        sid,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      release();
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    runtime.clearContextTokens(sid);
    const release = await runtime.acquireLock(sid);
    try {
      const { state } = await runtime.stateFor(ctx);
      const model = ctx.model;
      const details = event.compactionEntry.details;
      const detailRecord = details && typeof details === "object" ? details as Record<string, unknown> : undefined;
      const route = typeof detailRecord?.route === "string" ? detailRecord.route : undefined;
      const routeSeparator = route?.indexOf("/") ?? -1;
      const actualProvider = routeSeparator > 0 ? route!.slice(0, routeSeparator) : model?.provider;
      const actualModel = routeSeparator > 0 ? route!.slice(routeSeparator + 1) : model?.id;
      const pending = pendingCheckpointSources.get(sid);
      pendingCheckpointSources.delete(sid);
      const sourceMessageIds = Array.isArray(detailRecord?.sourceMessageIds)
        ? detailRecord.sourceMessageIds.filter((id): id is string => typeof id === "string")
        : pending?.sourceMessageIds ?? [];
      const usage = event.compactionEntry.usage;
      const configured = detailRecord?.source === "hybrid-acp-configured";
      const committed = commitCheckpointEpoch(state, {
        summary: event.compactionEntry.summary,
        firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
        sourceMessageIds,
        tokensBefore: event.compactionEntry.tokensBefore,
        provider: actualProvider,
        model: actualModel,
        provenance: actualProvider && actualModel ? {
          requestedRoute: configured ? "configured" : "main",
          execution: configured ? "isolated-configured" : "inline-main",
          provider: actualProvider,
          model: actualModel,
          thinking: typeof detailRecord?.thinking === "string" ? detailRecord.thinking : "unknown",
          promptVersion: configured ? "checkpoint-v1" : "pi-native",
          inputTokens: usage?.input,
          outputTokens: usage?.output,
          cachedInputTokens: usage?.cacheRead,
        } : undefined,
        sourceHash: typeof detailRecord?.sourceHash === "string" ? detailRecord.sourceHash : pending?.sourceHash,
        coverageComplete: sourceMessageIds.length > 0 && Boolean(typeof detailRecord?.sourceHash === "string" ? detailRecord.sourceHash : pending?.sourceHash),
        validationStatus: detailRecord?.validation === "passed" || detailRecord?.validation === "repaired"
          || detailRecord?.validation === "fallback" || detailRecord?.validation === "unverified"
          ? detailRecord.validation
          : "unverified",
      });
      await runtime.save({ ...committed.state, revision: state.revision }, ctx);
      runtime.clearNudgeTracking();
      freshness.invalidate();
      logInfo("compaction", { event: "checkpoint-epoch", sid, epoch: committed.state.currentEpoch, checkpointId: committed.checkpoint.id });
    } catch (error) {
      logWarn("compaction", { event: "checkpoint-record-failed", sid, error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason === "manual") return;
    const sid = ctx.sessionManager.getSessionId();
    const configuredCheckpoint = runtime.adapter.compress?.checkpointCompressor === "configured";
    const configuredTierOneRescue = compressorModeForTier(runtime.adapter, 1) === "configured";
    let tierOneRescue: TierOneRescueOutcome = "unavailable";
    if (configuredTierOneRescue) {
      for (let attempt = 0; attempt < 2 && !event.signal.aborted; attempt++) {
        try {
          if (!await optimization.runNow(ctx, event.signal)) break;
          logInfo("compaction", { event: "rescue-distillation", sid, attempt: attempt + 1 });
        } catch (error) {
          logWarn("compaction", { event: "rescue-distillation-failed", sid, error: error instanceof Error ? error.message : String(error) });
          break;
        }
      }
      tierOneRescue = await runTierOneRescue(runtime, ctx, event);
      if (tierOneRescue === "aborted") return;
      if (tierOneRescue === "failed" || tierOneRescue === "stale") {
        logWarn("compaction", { event: "tier-one-rescue-fallback", sid, outcome: tierOneRescue });
      }
    }
    if (event.signal.aborted) return;
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages } = await runtime.stateFor(ctx);
      const config = runtime.configFor(ctx);
      const modelKey = modelCalibrationKey(ctx.model);
      const localBefore = estimateTokens(coreMessages, collectCoveredMessageIds(state));
      const hostTokensBefore = conservativeTokenCount([
        event.preparation.tokensBefore,
        ctx.getContextUsage?.()?.tokens,
        calibratedTokenEstimate(localBefore, state, modelKey),
      ]);
      const workingState = structuredClone(state);
      const turn = runtime.core.processTurn({
        messages: coreMessages,
        state: workingState,
        config,
        tokenCount: hostTokensBefore,
      });
      const projectedTokens = calibratedTokenEstimate(turn.projection.projectedTokens, turn.state, modelKey);
      const calibration = turn.state.policyState.tokenCalibration[modelKey];
      const changed = turn.projection.contentChanged && projectedTokens < hostTokensBefore;
      runtime.recordProjection(sid, {
        revision: state.revision,
        graphRevision: state.graphRevision,
        epoch: state.currentEpoch,
        modelKey,
        contextWindow: config.modelContextLimit,
        estimatedTokens: projectedTokens,
        localTokens: turn.projection.projectedTokens,
        originalTokens: turn.projection.originalTokens,
        tokensCleared: turn.projection.tokensCleared,
        tokensPruned: turn.projection.tokensPruned,
        projectionHash: turn.projection.projectionHash,
        sourceMessages: coreMessages.length,
        projectedMessages: turn.messages.length,
        changed,
        recordedAt: Date.now(),
      });
      if ((!configuredTierOneRescue || tierOneRescue === "committed") && shouldCancelHostCompaction({
        reason: event.reason,
        changed,
        projectedTokens,
        hostTokensBefore,
        safeThreshold: safeResumeThreshold(runtime.adapter, config.modelContextLimit),
        calibrationSamples: calibration?.samples,
        calibrationUpdatedAt: calibration?.updatedAt,
        calibrationVerified: calibration?.verified,
        fixedReserveTokens: calibration?.verified ? 0 : HOST_SYSTEM_TOOL_RESERVE_TOKENS,
      })) {
        logInfo("compaction", {
          event: "selective-rescue",
          sid,
          reason: event.reason,
          projectedTokens: projectedTokens + HOST_SYSTEM_TOOL_RESERVE_TOKENS,
          hostTokensBefore,
        });
        return { cancel: true };
      }
      try {
        const nativeSource = compileCheckpointSource({
          preparation: event.preparation,
          branchEntries: event.branchEntries,
          state: turn.state,
        });
        pendingCheckpointSources.set(sid, {
          sourceMessageIds: nativeSource.sourceMessageIds,
          sourceHash: sha256(nativeSource.source),
        });
      } catch (error) {
        logWarn("compaction", { event: "checkpoint-source-ownership-unavailable", sid, error: error instanceof Error ? error.message : String(error) });
      }
      if (configuredCheckpoint) {
        const checkpoint = await generateConfiguredCheckpoint(
          runtime,
          ctx,
          event,
          turn.state,
        );
        if (checkpoint) return { compaction: checkpoint };
      }
      logWarn("compaction", {
        event: "host-fallback",
        sid,
        reason: event.reason,
        projectedTokens,
        hostTokensBefore,
      });
      return;
    } catch (error) {
      logWarn("compaction", {
        event: "rescue-failed-host-fallback",
        sid,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      release();
    }
  });
}

type TierOneRescueOutcome = "committed" | "unavailable" | "failed" | "stale" | "aborted";

type ActiveMainModel = NonNullable<ExtensionContext["model"]>;

interface TierOneRescueSnapshot {
  sessionId: string;
  stateRevision: number;
  graphRevision: number;
  model: ActiveMainModel;
  modelKey: string;
  startRef: string;
  endRef: string;
  planSourceHash: string;
  source: string;
  sourceTokens: number;
  manifest: CompressionManifest;
}

async function runTierOneRescue(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
): Promise<TierOneRescueOutcome> {
  if (event.signal.aborted) return "aborted";
  let snapshot: TierOneRescueSnapshot | undefined;
  try {
    snapshot = await captureTierOneRescueSnapshot(runtime, ctx, event);
  } catch (error) {
    logWarn("compaction", {
      event: "tier-one-rescue-capture-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return event.signal.aborted ? "aborted" : "failed";
  }
  if (!snapshot) return "unavailable";

  const started = Date.now();
  try {
    const result = await compressWithModel({
      ctx,
      model: snapshot.model,
      thinkingLevel: compressionThinkingLevel(runtime.adapter),
      tier: 1,
      source: redactCompactionSecrets(snapshot.source, runtime.adapter.compress?.secretPatterns),
      prompts: runtime.prompts,
      summaryMaxChars: 40_000,
      signal: event.signal,
    });
    if (event.signal.aborted) return "aborted";
    const validation = validateAndRepairSummary({
      summary: result.summary,
      manifest: snapshot.manifest,
      sourceTokens: snapshot.sourceTokens,
      tier: 1,
      summaryMaxChars: 40_000,
    });
    if (event.signal.aborted) return "aborted";
    return commitTierOneRescue(runtime, ctx, event.signal, snapshot, {
      summary: validation.renderedSummary,
      structuredSummary: structuredSummaryFromRendered(validation.renderedSummary, snapshot.manifest),
      quality: {
        status: validation.status,
        missingRequiredFacts: validation.missingRequiredFacts,
        compressionRatio: validation.compressionRatio,
        attempts: 1,
      },
      provenance: {
        requestedRoute: "configured",
        execution: "isolated-configured",
        provider: snapshot.model.provider,
        model: snapshot.model.id,
        thinking: result.thinking,
        promptVersion: "hybrid-acp-v2-tier-one-rescue",
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cachedInputTokens: result.usage.cacheRead,
        durationMs: Date.now() - started,
      },
    });
  } catch (error) {
    logWarn("compaction", {
      event: "tier-one-rescue-generation-failed",
      sessionId: snapshot.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return event.signal.aborted ? "aborted" : "failed";
  }
}

async function captureTierOneRescueSnapshot(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
): Promise<TierOneRescueSnapshot | undefined> {
  const configuredRef = parseCompressionModel(runtime.adapter.compress?.model);
  const model = configuredRef ? ctx.modelRegistry.find(configuredRef.provider, configuredRef.id) : undefined;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error("The configured compression model is unavailable or unauthenticated for Tier-1 rescue.");
  }
  ensureCompactionTransferAllowed({
    activeProvider: ctx.model?.provider,
    configuredProvider: model.provider,
    allowCrossProvider: runtime.adapter.compress?.allowCrossProvider === true,
    acknowledgeCrossProviderDataTransfer: runtime.adapter.compress?.acknowledgeCrossProviderDataTransfer === true,
  });
  const sid = ctx.sessionManager.getSessionId();
  const release = await runtime.acquireLock(sid);
  try {
    if (event.signal.aborted) return undefined;
    const { state, coreMessages } = await runtime.stateFor(ctx);
    const config = runtime.configFor(ctx);
    const preparedState = structuredClone(state);
    const turn = runtime.core.processTurn({
      messages: coreMessages,
      state: preparedState,
      config,
      tokenCount: event.preparation.tokensBefore,
    });
    const checkpointScope = compileCheckpointSource({
      preparation: event.preparation,
      branchEntries: event.branchEntries,
      state: turn.state,
      includePriorCheckpoint: false,
    });
    const eligibleMessageIds = new Set(checkpointScope.sourceMessageIds);
    const ranges = turn.nudge?.compressibleRanges ?? [];
    for (let startIndex = 0; startIndex < ranges.length; startIndex++) {
      const start = ranges[startIndex]!;
      for (let endIndex = ranges.length - 1; endIndex >= startIndex; endIndex--) {
        const end = ranges[endIndex]!;
        const planned = runtime.core.planCompression({
          ranges: [{ startRef: start.startRef, endRef: end.endRef }],
          messages: coreMessages,
          state: turn.state,
          config,
        });
        const plannedRange = planned.plan?.ranges[0];
        if (!planned.plan || !plannedRange || plannedRange.outputTier !== 1 || plannedRange.sourceBlockIds.length > 0) continue;
        const rootIds = [...new Set(plannedRange.sourceMessageIds.map(rawMessageId))];
        if (rootIds.length === 0 || rootIds.some((id) => !eligibleMessageIds.has(id))) continue;
        const selectedRootIds = new Set(rootIds);
        const plannedMessageIds = new Set(plannedRange.sourceMessageIds);
        if (coreMessages.some((message) => selectedRootIds.has(rawMessageId(message.id)) && !plannedMessageIds.has(message.id))) continue;
        const sourceChars = plannedRange.sourceMessageIds.reduce((total, id) => {
          const message = coreMessages.find((candidate) => candidate.id === id);
          return total + (message?.text?.length ?? 0);
        }, 0);
        if (config.compress.minCompressRange > 0 && sourceChars < config.compress.minCompressRange) continue;
        const selectedMessages: AgentMessage[] = [];
        for (const entry of event.branchEntries) {
          if (entry.type === "message" && selectedRootIds.has(entry.id)) selectedMessages.push(entry.message);
        }
        if (selectedMessages.length !== selectedRootIds.size) continue;
        const compiled = compileCheckpointSource({
          preparation: {
            ...event.preparation,
            messagesToSummarize: selectedMessages,
            turnPrefixMessages: [],
            previousSummary: undefined,
          },
          branchEntries: event.branchEntries,
          state: turn.state,
          includePriorCheckpoint: false,
        });
        if (compiled.sourceMessageIds.length !== selectedRootIds.size
          || compiled.sourceMessageIds.some((id) => !selectedRootIds.has(id))) continue;
        return {
          sessionId: sid,
          stateRevision: state.revision,
          graphRevision: state.graphRevision,
          model,
          modelKey: `${model.provider}/${model.id}`,
          startRef: start.startRef,
          endRef: end.endRef,
          planSourceHash: planned.plan.sourceHash,
          source: compiled.source,
          sourceTokens: compiled.sourceTokens,
          manifest: manifestForCompiledSource(compiled.source),
        };
      }
    }
    return undefined;
  } finally {
    release();
  }
}

async function commitTierOneRescue(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  signal: AbortSignal,
  snapshot: TierOneRescueSnapshot,
  proposal: {
    summary: string;
    structuredSummary: ReturnType<typeof structuredSummaryFromRendered>;
    quality: NonNullable<CompressionBlock["quality"]>;
    provenance: NonNullable<CompressionBlock["provenance"]>;
  },
): Promise<TierOneRescueOutcome> {
  if (signal.aborted) return "aborted";
  const release = await runtime.acquireLock(snapshot.sessionId);
  try {
    if (signal.aborted) return "aborted";
    const configuredRef = parseCompressionModel(runtime.adapter.compress?.model);
    const configuredModel = configuredRef ? ctx.modelRegistry.find(configuredRef.provider, configuredRef.id) : undefined;
    if (!configuredModel || `${configuredModel.provider}/${configuredModel.id}` !== snapshot.modelKey
      || !ctx.modelRegistry.hasConfiguredAuth(configuredModel)) return "stale";
    const { state, coreMessages } = await runtime.stateFor(ctx);
    if (state.revision !== snapshot.stateRevision || state.graphRevision !== snapshot.graphRevision) return "stale";
    const config = runtime.configFor(ctx);
    const prepared = runtime.core.processTurn({
      messages: coreMessages,
      state: structuredClone(state),
      config,
      tokenCount: config.modelContextLimit,
    });
    const planned = runtime.core.planCompression({
      ranges: [{ startRef: snapshot.startRef, endRef: snapshot.endRef }],
      messages: coreMessages,
      state: prepared.state,
      config,
    });
    if (!planned.plan || planned.plan.sourceHash !== snapshot.planSourceHash) return "stale";
    const applied = runtime.core.applyCompression({
      ranges: [{
        startRef: snapshot.startRef,
        endRef: snapshot.endRef,
        summary: proposal.summary,
        topic: "Synchronous Tier-1 compaction rescue",
        summaryMaxChars: 40_000,
      }],
      messages: coreMessages,
      state: prepared.state,
      config,
      expectedRevision: snapshot.stateRevision,
      expectedSourceHash: snapshot.planSourceHash,
      atomic: true,
    });
    if (applied.result.errors.length > 0 || applied.result.blocksCreated !== 1) return "stale";
    const block = applied.state.blocks.at(-1)!;
    block.summary = proposal.summary;
    block.renderedSummary = proposal.summary;
    block.structuredSummary = proposal.structuredSummary;
    block.manifest = snapshot.manifest;
    block.sourceHash = snapshot.planSourceHash;
    block.summaryHash = sha256(proposal.summary);
    block.provenance = proposal.provenance;
    block.quality = proposal.quality;
    if (signal.aborted) return "aborted";
    await runtime.save(applied.state, ctx);
    logInfo("compaction", {
      event: "tier-one-rescue-committed",
      sessionId: snapshot.sessionId,
      blockId: block.blockId,
      sourceHash: snapshot.planSourceHash,
    });
    return "committed";
  } catch (error) {
    logWarn("compaction", {
      event: "tier-one-rescue-commit-failed",
      sessionId: snapshot.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return signal.aborted ? "aborted" : "stale";
  } finally {
    release();
  }
}

function rawMessageId(id: string): string {
  return id.split("#", 1)[0]!;
}

async function generateConfiguredCheckpoint(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  state: CompressionState,
): Promise<{
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
  usage: Awaited<ReturnType<typeof compressWithModel>>["usage"];
  details: {
    source: string;
    route: string;
    thinking: string;
    sourceHash: string;
    sourceMessageIds: string[];
    validation: string;
    structuredSummary: ReturnType<typeof structuredSummaryFromRendered>;
  };
} | undefined> {
  try {
    const model = configuredCompressionModel(runtime, ctx);
    if (!model) throw new Error("The configured checkpoint model is unavailable or unauthenticated.");
    ensureCompactionTransferAllowed({
      activeProvider: ctx.model?.provider,
      configuredProvider: model.provider,
      allowCrossProvider: runtime.adapter.compress?.allowCrossProvider === true,
      acknowledgeCrossProviderDataTransfer: runtime.adapter.compress?.acknowledgeCrossProviderDataTransfer === true,
    });
    const compiled = compileCheckpointSource({
      preparation: event.preparation,
      branchEntries: event.branchEntries,
      state,
    });
    const source = redactCompactionSecrets(compiled.source, runtime.adapter.compress?.secretPatterns);
    const manifest = manifestForCompiledSource(source);
    const result = await compressWithModel({
      ctx,
      model,
      thinkingLevel: compressionThinkingLevel(runtime.adapter),
      tier: 1,
      source,
      prompts: runtime.prompts,
      summaryMaxChars: 40_000,
      signal: event.signal,
    });
    const validation = validateAndRepairSummary({
      summary: result.summary,
      manifest,
      sourceTokens: compiled.sourceTokens,
      tier: 1,
      summaryMaxChars: 40_000,
    });
    const summary = `[Hybrid ACP checkpoint]\n${validation.renderedSummary}`;
    return {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      estimatedTokensAfter: Math.max(1, Math.ceil(summary.length / 3)),
      usage: result.usage,
      details: {
        source: "hybrid-acp-configured",
        route: result.model,
        thinking: result.thinking,
        sourceHash: sha256(source),
        sourceMessageIds: compiled.sourceMessageIds,
        validation: validation.status,
        structuredSummary: structuredSummaryFromRendered(validation.renderedSummary, manifest),
      },
    };
  } catch (error) {
    logWarn("compaction", { event: "configured-checkpoint-failed-host-fallback", error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function configuredCompressionModel(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
): NonNullable<ExtensionContext["model"]> | undefined {
  const ref = parseCompressionModel(runtime.adapter.compress?.model);
  if (!ref) return undefined;
  const model = ctx.modelRegistry.find(ref.provider, ref.id);
  return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

// (acp_delegate injection is best-effort: sendUserMessage is fire-and-forget
// in pi, and interactive/rpc sessions are long-lived so their main loop
// consumes the follow-up queue naturally — no shutdown drain needed.)

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker): void {
  pi.on("session_start", async (_event, ctx) => {
    freshness.invalidate();
    try {
      await ensureArtifactStore();
      const { state } = await runtime.stateFor(ctx);
      const cleaned = await cleanupArtifactStore(state, ctx.sessionManager.getSessionId());
      if (cleaned.removed > 0) logInfo("artifact", { event: "startup-cleanup", ...cleaned });
    } catch (error) {
      logWarn("artifact", { event: "store-unavailable", error: error instanceof Error ? error.message : String(error) });
      if (ctx.hasUI) ctx.ui.notify(`ACP artifact store is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    runtime.store.invalidate();
    runtime.clearNudgeTracking();
    runtime.clearContextTokens();
    resetDelegateUsage();
    setDelegateDisplayUsage("separate");
    const sid = ctx.sessionManager.getSessionId();
    logInfo("session", { event: "start", sid, cwd: ctx.cwd, debug: runtime.adapter.debug ?? null, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null });
    try {
      const user = await loadUserConfig(ctx.cwd);
      runtime.setAdapter(applyUserConfig(runtime.adapter, user));
      setDelegateDisplayUsage(resolveDelegate(runtime.adapter).displayUsage);
      if (runtime.adapter.debug !== undefined) setDebugEnabled(runtime.adapter.debug);
    } catch (e) {
      logThrow("config", e, { sid, phase: "session_start" });
    }
    try {
      runtime.setPrompts(resolvePrompts(runtime.adapter.prompts, { acknowledgeRisk: runtime.adapter.acknowledgePromptsRisk === true }));
    } catch (e) {
      logWarn("config", { event: "prompts-resolve-failed", error: e instanceof Error ? e.message : String(e) });
      runtime.setPrompts(defaultPrompts);
    }
    if (resolveDelegate(runtime.adapter).enabled) {
      pi.registerTool(makeDelegateTool(pi));
      pi.registerTool(makeDelegateWaitTool(pi));
      pi.registerTool(makeDelegateCancelTool(pi));
      void runSetupAndNotify(ctx.hasUI ? (message) => ctx.ui.notify(message) : undefined);
    }
    void checkForUpdate(runtime.adapter.autoUpdate ?? false, (message) => {
      if (ctx.hasUI) ctx.ui.notify(message);
    });
    // Bind the TUI status widget for async delegates. The widget reads the
    // in-memory runs Map (via runningRunsSnapshot) and renders a live list of
    // running delegates below the editor. Only the interactive TUI has a UI;
    // rpc/json/print have hasUI=false and the call is a no-op.
    delegateStatusWidget.setContext(ctx, runningRunsSnapshot);
  });
  pi.on("turn_end", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state } = await runtime.stateFor(ctx);
      const nextPins = state.pins
        .map((pin) => ({ ...pin, remainingTurns: pin.remainingTurns - 1 }))
        .filter((pin) => pin.remainingTurns > 0);
      const pinsChanged = nextPins.length !== state.pins.length || nextPins.some((pin, index) => pin.remainingTurns !== state.pins[index]?.remainingTurns);
      const survivedTurns = runtime.metadataTurnsDue(sid, 3);
      if (pinsChanged || survivedTurns > 0) {
        await runtime.save({
          ...state,
          pins: nextPins,
          blocks: survivedTurns > 0
            ? state.blocks.map((block) => block.active ? { ...block, survivedCount: block.survivedCount + survivedTurns } : block)
            : state.blocks,
        }, ctx);
      }
    } catch (error) {
      logWarn("pin", { event: "expiry-failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (runtime.adapter.artifacts?.lifecycle === "session") {
      await removeArtifactSession(ctx.sessionManager.getSessionId()).catch((error) => {
        logWarn("artifact", { event: "session-cleanup-failed", error: error instanceof Error ? error.message : String(error) });
      });
    }
  });
  pi.on("session_before_fork", () => { freshness.invalidate(); });
  pi.on("session_tree", () => { freshness.invalidate(); });
  pi.on("session_shutdown", () => {
    delegateStatusWidget.dispose();
    closeLogStream();
  });
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker): void {
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages, entries } = await runtime.stateFor(ctx, event.messages);
      const workingState = structuredClone(state);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(workingState);
      const realUsage = ctx.getContextUsage?.();
      const modelKey = modelCalibrationKey(ctx.model);
      const previousProjection = runtime.projectionFor(sid);
      const previousCalibration = JSON.stringify(workingState.policyState.tokenCalibration[modelKey] ?? null);
      if (previousProjection
        && previousProjection.modelKey === modelKey
        && previousProjection.epoch === workingState.currentEpoch
        && previousProjection.contextWindow === config.modelContextLimit) {
        updateTokenCalibration(
          workingState,
          modelKey,
          previousProjection.localTokens,
          realUsage?.tokens,
          workingState.currentEpoch,
        );
      }
      const estimated = estimateTokens(coreMessages, coveredIds);
      const calibrated = calibratedTokenEstimate(estimated, workingState, modelKey);
      // Host usage belongs to the previous provider request. It trains the
      // anchored calibration above, but never overrides this projection.
      const tokenCount = conservativeTokenCount([estimated, calibrated]);
      runtime.recordContextTokens(sid, tokenCount);

      debug.event("context-in", {
        sid,
        eventMsgs: event.messages?.length ?? 0,
        entries: entries.length,
        coreMsgs: coreMessages.length,
        tokenCount,
        estimatedTokens: estimated,
        realTokens: realUsage?.tokens ?? null,
        realPercent: realUsage?.percent ?? null,
        limit: config.modelContextLimit,
        blocksBefore: state.blocks.length,
        activeBefore: state.blocks.filter((b) => b.active).length,
      });

      const beforeGraph = projectionGraphFingerprint(state);
      const beforeMetadata = projectionMetadataFingerprint(state);
      const turn = runtime.core.processTurn({ messages: coreMessages, state: workingState, config, tokenCount });
      const afterGraph = projectionGraphFingerprint(turn.state);
      const graphChanged = beforeGraph !== afterGraph;
      const calibrationChanged = previousCalibration !== JSON.stringify(turn.state.policyState.tokenCalibration[modelKey] ?? null);
      const metadataChanged = beforeMetadata !== projectionMetadataFingerprint(turn.state) || calibrationChanged;
      let persisted = state;
      if (graphChanged || metadataChanged) {
        turn.state.graphRevision = state.graphRevision + (graphChanged ? 1 : 0);
        turn.state.metadataRevision = state.metadataRevision + (metadataChanged ? 1 : 0);
        persisted = await runtime.save(turn.state, ctx);
      }
      const projectedTokens = calibratedTokenEstimate(turn.projection.projectedTokens, turn.state, modelKey);
      runtime.recordProjection(sid, {
        revision: persisted.revision,
        graphRevision: turn.state.graphRevision,
        epoch: turn.state.currentEpoch,
        modelKey,
        contextWindow: config.modelContextLimit,
        estimatedTokens: projectedTokens,
        localTokens: turn.projection.projectedTokens,
        originalTokens: turn.projection.originalTokens,
        tokensCleared: turn.projection.tokensCleared,
        tokensPruned: turn.projection.tokensPruned,
        projectionHash: turn.projection.projectionHash,
        sourceMessages: coreMessages.length,
        projectedMessages: turn.messages.length,
        changed: turn.projection.contentChanged,
        recordedAt: Date.now(),
      });

      logInfo("turn", {
        sid,
        inMsgs: coreMessages.length,
        outMsgs: turn.messages.length,
        tokens: tokenCount,
        pct: realUsage?.percent ?? (config.modelContextLimit > 0 ? Math.round((tokenCount / config.modelContextLimit) * 100) : null),
        limit: config.modelContextLimit,
        nudge: turn.nudge?.shouldInject ? (turn.nudge.breakdown?.emergencyOverride === 1 ? "emergency" : "active") : "idle",
        nudgeReason: turn.nudge?.reason ?? null,
        blocks: turn.state.blocks.length,
        activeBlocks: turn.state.blocks.filter((b) => b.active).length,
        clearedToolResults: turn.clearing?.clearedCount ?? 0,
        clearedTokens: turn.clearing?.savedTokens ?? 0,
      });

      debug.event("processTurn", {
        outMsgs: turn.messages.length,
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp:block:")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp:block:")).length,
        nudgeShouldInject: turn.nudge?.shouldInject ?? false,
        nudgeReason: turn.nudge?.reason ?? null,
        nudgeVoice: turn.nudge ? renderNudgeText(turn.nudge, runtime.prompts).voice : null,
      nudgePct: turn.nudge ? Math.round(turn.nudge.contextUsage * 100) : null,
      nudgeTier: turn.nudge?.tier ?? null,
      nudgeCompressibleCount: turn.nudge?.compressibleRanges.length ?? 0,
      nudgeProtectedCount: turn.nudge?.protectedRanges?.length ?? 0,
      nothingToCompress: turn.nudge?.reason?.includes("nothing to compress") ?? false,
      blocksAfter: turn.state.blocks.length,
      activeAfter: turn.state.blocks.filter((b) => b.active).length,
    });

    const originalById = collectOriginals(entries);
    const rebuilt = coreOutToAgentMessages(turn.messages, originalById);
    const debugOn = debug.enabled;
    const runtimeOverlay = freshness.consumeRuntimeOverlay();
    if (runtimeOverlay) rebuilt.push({ role: "user", content: runtimeOverlay, timestamp: Date.now() });
    const pinnedOverlay = renderPins(turn.state, coreMessages, ctx, runtime);
    if (pinnedOverlay) rebuilt.push({ role: "user", content: pinnedOverlay, timestamp: Date.now() });

    if (turn.nudge?.shouldInject) {
      // Two independent channels for the nudge:
      //  1. CONTEXT injection (always on): the nudge is appended to the
      //     messages returned to the LLM so the model sees it and compresses.
      //     This is a per-turn append — the next context event rebuilds the
      //     array from scratch, so it does NOT permanently pollute context.
      //  2. TERMINAL echo (debug only): when debug is on, also print the exact
      //     text via ctx.ui.notify so the user can observe what is being
      //     injected while debugging. The model never sees terminal output.
      // Emergency nudges (usage >= 80%) bypass the per-turn dedup so the
      // overflow warning always reaches the model. Other nudges inject at most
      // once per turn: pi fires the context event multiple times per assistant
      // reply (streaming/tool loop), and without this gate the same nudge
      // would be appended on every event.
      const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
      const turnKey = lastUserMessageId(entries) ?? sid;
      const alreadyShown = !emergency && runtime.nudgeShownFor(turnKey);
      if (!alreadyShown) {
        const budgetText = remainingToolBudgetText(tokenCount, forcedCompressionLimit(runtime.adapter, config.modelContextLimit));
        rebuilt.push(nudgeMessage(
          turn.nudge,
          turn.state.blocks.filter((b) => b.active),
          runtime.prompts,
          runtime.adapter,
          tokenCount,
          forcedCompressionLimit(runtime.adapter, config.modelContextLimit),
        ));
        const rendered = renderNudgeText(turn.nudge, runtime.prompts);
        const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
        const targetTier = (turn.nudge.tier ?? 1) as 1 | 2 | 3;
        const externalWriter = compressorModeForTier(runtime.adapter, targetTier) === "configured";
        const summaryArg = externalWriter ? "" : ', summary: "..."';
        const example = top ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}"${summaryArg} }] })` : "";
        if (emergency) {
          logWarn("nudge", { sid: ctx.sessionManager.getSessionId(), event: "emergency-inject", pct: Math.round(turn.nudge.contextUsage * 100), voice: rendered.voice, compressible: turn.nudge.compressibleRanges.length });
        }
        if (debugOn && ctx.hasUI) {
          ctx.ui.notify(`[ACP nudge → context]${emergency ? " [EMERGENCY]" : ""}\n${rendered.text}\n${budgetText}${example}`);
        }
        if (!emergency) runtime.markNudgeShown(turnKey);
        debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channels: ["context", debugOn ? "terminal" : null].filter(Boolean), emergency, turnKey, text: `${rendered.text}\n${budgetText}${example}` });
      } else {
        debug.event("nudge-suppressed", { sid: ctx.sessionManager.getSessionId(), turnKey, reason: turn.nudge.reason });
      }
    }

    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    debug.event("context-out", { outMsgs: rebuilt.length, injected: turn.nudge?.shouldInject ?? false, emergency: turn.nudge?.breakdown?.emergencyOverride === 1 });
    return { messages: rebuilt };
    } catch (e) {
      logThrow("context", e, { sid, phase: "transform" });
      throw e;
    } finally {
      release();
    }
  });
}

function wireSystemPrompt(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const delegate = runtime.adapter.delegate !== false;
    const acp = buildAcpSystemPrompt(runtime.prompts, runtime.adapter);
    const prompt = delegate ? `${acp}\n${ACP_DELEGATE_PROMPT}` : acp;
    const projectOverlay = freshness.projectOverlay(event.systemPromptOptions?.contextFiles ?? []);
    const worldOverlay = renderWorldOverlay(await captureWorldStateAsync(ctx.cwd));
    freshness.queueRuntimeOverlay(projectOverlay, worldOverlay);
    // Keep the provider prefix stable. Project files are already injected by
    // Pi; ACP emits only changed fingerprints/world state near the user tail.
    return { systemPrompt: formatSystemPromptForEvent(event.systemPrompt, prompt) };
  });
}

function projectionMetadataFingerprint(state: CompressionState): string {
  return sha256(JSON.stringify({
    nudge: state.nudge,
    policyState: state.policyState,
    stats: state.stats,
  }));
}

function projectionGraphFingerprint(state: CompressionState): string {
  return sha256(JSON.stringify({
    blocks: state.blocks.map((block) => ({
      blockId: block.blockId,
      active: block.active,
      tier: block.tier,
      epoch: block.epoch,
      directMessageIds: block.directMessageIds,
      effectiveMessageIds: block.effectiveMessageIds,
      summary: block.summary,
      renderedSummary: block.renderedSummary,
      supersededBy: block.supersededBy,
    })),
    checkpoints: state.checkpoints,
    artifacts: state.artifacts,
    pins: state.pins,
    messageRefs: state.messageRefs,
    tokenSnapshots: state.tokenSnapshots,
    currentEpoch: state.currentEpoch,
  }));
}

function collectOriginals(entries: Array<{ type: string; id: string; message?: AgentMessage; content?: unknown }>): Map<string, AgentMessage> {
  const map = new Map<string, AgentMessage>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      map.set(entry.id, entry.message);
    } else if (entry.type === "custom_message") {
      // Pi's convertToLlm projects custom messages as { role: "user", content }
      // for the LLM. Mirror that here so coreOutToAgentMessages restores a
      // proper user AgentMessage — using role:"custom" would be dropped by Pi.
      const content = typeof entry.content === "string"
        ? [{ type: "text" as const, text: entry.content }]
        : entry.content;
      map.set(entry.id, { role: "user", content } as AgentMessage);
    }
  }
  return map;
}

export function routeCompressionNudgeText(text: string, adapter: AdapterConfig, tier: 1 | 2 | 3): string {
  return compressorModeForTier(adapter, tier) === "configured"
    ? text.replaceAll(', summary: "..."', "").replaceAll(', "summary": "..."', "")
    : text;
}

export function remainingToolBudgetText(tokenCount: number, limit: number): string {
  const remaining = Math.max(0, limit - tokenCount);
  return `Remaining context budget until tool block: ${Math.round(remaining / 1000)}k`;
}

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[], prompts: Prompts, adapter: AdapterConfig, tokenCount: number, hardLimit: number): AgentMessage {
  const rendered = renderNudgeText(nudge, prompts);
  const tier = (nudge.tier ?? 1) as 1 | 2 | 3;
  const routedText = routeCompressionNudgeText(rendered.text, adapter, tier);
  const lines = [routedText, remainingToolBudgetText(tokenCount, hardLimit)];

  if (blocks.length > 0) {
    const totalSummary = blocks.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
    const totalCompressed = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
    const tierCounts: Record<number, number> = {};
    for (const b of blocks) {
      const t = b.tier ?? 1;
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    }
    const tierStr = Object.keys(tierCounts).map(Number).sort().map((t) => `T${t}:${tierCounts[t]}`).join(" ");
    const ids = blocks.slice(0, 10).map((b) => b.blockId).join(", ");
    const extra = blocks.length > 10 ? ` (+${blocks.length - 10} more)` : "";
    lines.push("");
    lines.push(`Compressed blocks: ${blocks.length} active (${tierStr}) — ${fmt(totalSummary)} summary, ${fmt(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`);
  }

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
