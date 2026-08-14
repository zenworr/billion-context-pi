import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionBeforeCompactEvent,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { CompressionManifest, NudgeDecision, CompressionBlock, CompressionState, CoreMessage, Prompts } from "acp-kernel";
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
import { compressionPolicyRevision, makePlanCompressionTool } from "./compression-plan-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeArtifactTool } from "./artifact-tool.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, runningRunsSnapshot, resetDelegateUsage, setDelegateDisplayUsage } from "./delegate-tool.js";
import { makeCommands } from "./commands.js";
import { coreOutToAgentMessages, extractText } from "./messages.js";
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
import { cleanupArtifactStore, ensureArtifactStore, spoolArtifact } from "./artifact-store.js";
import { compressWithModel, compressionErrorUsage, type CompressionUsage } from "./model-compressor.js";
import { CompressionCallBudget } from "./model-call-budget.js";
import { ensureCompactionTransferAllowed, redactCompactionTransfer } from "./compress-tool.js";
import {
  compileBranchSource,
  compileCheckpointSource,
  manifestForCompiledSource,
  prepareBranchSource,
} from "./checkpoint-source.js";
import { renderAuthoritativeSummary, sha256, structuredSummaryFromRendered, validateAndRepairSummary } from "./manifest.js";
import { compileFinalRequestProjection } from "./final-request.js";
import { auditProviderPayload, deepFreezeProviderPayload, sanitizeUnsafeProviderMedia } from "./provider-audit.js";


type AgentMessage = SessionMessageEntry["message"];

declare const CURRENT_VERSION: string;

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    // User configuration is always reapplied to this immutable startup base;
    // never inherit project-local security settings from a prior session.
    const baseAdapter = applyUserConfig(adapter, {});
    const runtime = createRuntime(baseAdapter);
    const freshness = new FreshnessTracker();
    wireSurvivalAging(pi, runtime);
    const optimization = wireAutomaticCompaction(pi, runtime);
    wireCompactionCoordinator(pi, runtime, freshness, optimization, baseAdapter);
    wireSessionLifecycle(pi, runtime, freshness, baseAdapter);
    wireContextTransform(pi, runtime, freshness, baseAdapter);
    wireToolGuardrails(pi, runtime);
    wireSystemPrompt(pi, runtime, freshness, baseAdapter);
    wireProviderRequestAuditor(pi, runtime, freshness, baseAdapter);
    pi.registerTool(makePlanCompressionTool(runtime));
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

function wireCompactionCoordinator(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker, optimization: AutomaticCompactionController, baseAdapter: AdapterConfig): void {
  const pendingCheckpointSources = new Map<string, {
    transactionId: string;
    sessionId: string;
    firstKeptEntryId: string;
    sourceMessageIds: string[];
    sourceBlockIds: string[];
    sourceHash: string;
  }>();
  pi.on("session_before_tree", async (event, ctx) => {
    await reloadRuntimeConfig(runtime, baseAdapter, ctx);
    if (!event.preparation.userWantsSummary || runtime.adapter.compress?.branchSummaryCompressor !== "configured") return;
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    let compiled: ReturnType<typeof compileBranchSource>;
    try {
      const { state } = await runtime.stateFor(ctx);
      compiled = compileBranchSource(
        event.preparation.entriesToSummarize,
        state.messageRefs.byRaw,
        freshness.branchProjectContext(),
      );
    } finally {
      release();
    }
    try {
      if (!compiled.source.trim()) throw new Error("Pi supplied no branch-bounded messages to summarize.");
      const model = configuredCompressionModel(runtime, ctx);
      if (!model) throw new Error("The configured branch summary model is unavailable or unauthenticated.");
      ensureCompactionTransferAllowed({
        activeProvider: ctx.model?.provider,
        configuredProvider: model.provider,
        allowCrossProvider: runtime.adapter.compress?.allowCrossProvider === true,
        acknowledgeCrossProviderDataTransfer: runtime.adapter.compress?.acknowledgeCrossProviderDataTransfer === true,
      });
      const prepared = prepareBranchSource(compiled, (source) => source);
      const transfer = redactCompactionTransfer(prepared.source, runtime.adapter.compress?.secretPatterns);
      const transferManifest = manifestForCompiledSource(transfer.source);
      const callBudget = new CompressionCallBudget(runtime.adapter.compress);
      const deadline = AbortSignal.timeout(runtime.adapter.compress?.maxDurationMs ?? 60_000);
      const generationSignal = event.signal ? AbortSignal.any([event.signal, deadline]) : deadline;
      const result = await compressWithModel({
        ctx,
        model,
        thinkingLevel: compressionThinkingLevel(runtime.adapter, "branch"),
        tier: 1,
        source: transfer.source,
        prompts: runtime.prompts,
        summaryMaxChars: 30_000,
        signal: generationSignal,
        beforeCall: (inputTokens, outputTokens) => callBudget.reserveEstimated(inputTokens, outputTokens),
        trustedInstructions: event.preparation.customInstructions,
        replaceInstructions: event.preparation.replaceInstructions === true,
      });
      callBudget.observe(result.usage);
      const validation = validateAndRepairSummary({
        summary: result.summary,
        manifest: transferManifest,
        sourceTokens: compiled.sourceTokens,
        tier: 1,
        summaryMaxChars: 30_000,
      });
      const structuredSummary = structuredSummaryFromRendered(validation.renderedSummary, prepared.manifest);
      return {
        summary: {
          summary: renderAuthoritativeSummary(structuredSummary),
          usage: result.usage,
          details: {
            source: "hybrid-acp-configured-branch",
            route: result.model,
            thinking: result.thinking,
            sourceHash: transfer.rawSourceHash,
            rawSourceHash: transfer.rawSourceHash,
            transferSourceHash: transfer.transferSourceHash,
            redactionManifestHash: transfer.redactionManifestHash,
            redactionPolicyVersion: transfer.redactionPolicyVersion,
            sourceMessageIds: compiled.sourceMessageIds,
            validation: validation.status,
            instructionHash: event.preparation.customInstructions
              ? sha256(event.preparation.customInstructions)
              : undefined,
            replaceInstructions: event.preparation.replaceInstructions === true,
            structuredSummary,
            nonAuthoritativeCommentary: validation.renderedSummary,
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
      const reportedTransactionId = typeof detailRecord?.checkpointTransactionId === "string" ? detailRecord.checkpointTransactionId : undefined;
      const matchingCandidates = [...pendingCheckpointSources.values()]
        .filter((candidate) => candidate.sessionId === sid && candidate.firstKeptEntryId === event.compactionEntry.firstKeptEntryId);
      const pending = reportedTransactionId
        ? pendingCheckpointSources.get(reportedTransactionId)
        : matchingCandidates.length === 1 ? matchingCandidates[0] : undefined;
      if (reportedTransactionId && (!pending || pending.sessionId !== sid || pending.firstKeptEntryId !== event.compactionEntry.firstKeptEntryId)) {
        throw new Error(`Checkpoint transaction ${reportedTransactionId} does not match the committed compaction entry.`);
      }
      for (const [key, candidate] of pendingCheckpointSources) {
        if (candidate.sessionId === sid) pendingCheckpointSources.delete(key);
      }
      const sourceMessageIds = Array.isArray(detailRecord?.sourceMessageIds)
        ? detailRecord.sourceMessageIds.filter((id): id is string => typeof id === "string")
        : pending?.sourceMessageIds ?? [];
      const usage = event.compactionEntry.usage;
      const configured = detailRecord?.source === "hybrid-acp-configured";
      const reportedSourceHash = typeof detailRecord?.sourceHash === "string" ? detailRecord.sourceHash : undefined;
      const capturedSourceVerified = configured
        && reportedTransactionId !== undefined
        && pending?.transactionId === reportedTransactionId
        && reportedSourceHash !== undefined
        && reportedSourceHash === pending.sourceHash;
      const committed = commitCheckpointEpoch(state, {
        summary: event.compactionEntry.summary,
        firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
        entryId: event.compactionEntry.id,
        sourceMessageIds,
        // Native Pi compaction does not consume compileCheckpointSource()'s
        // exact source envelope. Keep its coverage incomplete and leave ACP
        // blocks active instead of claiming content it may not summarize.
        sourceBlockIds: capturedSourceVerified ? pending?.sourceBlockIds : [],
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
        sourceHash: capturedSourceVerified ? reportedSourceHash : undefined,
        rawSourceHash: capturedSourceVerified && typeof detailRecord?.rawSourceHash === "string" ? detailRecord.rawSourceHash : undefined,
        transferSourceHash: capturedSourceVerified && typeof detailRecord?.transferSourceHash === "string" ? detailRecord.transferSourceHash : undefined,
        redactionManifestHash: capturedSourceVerified && typeof detailRecord?.redactionManifestHash === "string" ? detailRecord.redactionManifestHash : undefined,
        redactionPolicyVersion: capturedSourceVerified && typeof detailRecord?.redactionPolicyVersion === "string" ? detailRecord.redactionPolicyVersion : undefined,
        policyRevision: capturedSourceVerified && typeof detailRecord?.policyRevision === "string" ? detailRecord.policyRevision : undefined,
        coverageComplete: capturedSourceVerified && sourceMessageIds.length > 0,
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
    await reloadRuntimeConfig(runtime, baseAdapter, ctx);
    const sid = ctx.sessionManager.getSessionId();
    let checkpointTransactionId: string | undefined;
    const captureRelease = await runtime.acquireLock(sid);
    try {
      const { state } = await runtime.stateFor(ctx);
      const compiled = compileCheckpointSource({ preparation: event.preparation, branchEntries: event.branchEntries, state });
      const sourceRoots = new Set(compiled.sourceMessageIds);
      const sourceBlockIds = state.blocks
        .filter((block) => block.active && block.effectiveMessageIds.every((id) => sourceRoots.has(id.split("#", 1)[0]!)))
        .map((block) => block.blockId);
      for (const [key, candidate] of pendingCheckpointSources) {
        if (candidate.sessionId === sid) pendingCheckpointSources.delete(key);
      }
      const transactionId = randomUUID();
      checkpointTransactionId = transactionId;
      pendingCheckpointSources.set(transactionId, {
        transactionId,
        sessionId: sid,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        sourceMessageIds: compiled.sourceMessageIds,
        sourceBlockIds,
        sourceHash: sha256(compiled.source),
      });
      event.signal.addEventListener("abort", () => pendingCheckpointSources.delete(transactionId), { once: true });
    } catch (error) {
      logWarn("compaction", { event: "checkpoint-source-capture-failed", sid, error: error instanceof Error ? error.message : String(error) });
    } finally {
      captureRelease();
    }
    if (event.reason === "manual") return;
    const configuredCheckpoint = runtime.adapter.compress?.checkpointCompressor === "configured";
    const configuredTierOneRescue = compressorModeForTier(runtime.adapter, 1) === "configured";
    const configuredHigherTierRescue = compressorModeForTier(runtime.adapter, 2) === "configured"
      || compressorModeForTier(runtime.adapter, 3) === "configured";
    const rescueCallBudget = new CompressionCallBudget(runtime.adapter.compress);
    const rescueController = new AbortController();
    const abortRescueFromHost = () => rescueController.abort(event.signal.reason);
    event.signal.addEventListener("abort", abortRescueFromHost, { once: true });
    const rescueTimer = setTimeout(
      () => rescueController.abort(new Error(`Synchronous rescue exceeded ${SYNCHRONOUS_RESCUE_BUDGET_MS}ms total budget.`)),
      SYNCHRONOUS_RESCUE_BUDGET_MS,
    );
    rescueTimer.unref?.();
    const finishRescueBudget = () => {
      clearTimeout(rescueTimer);
      event.signal.removeEventListener("abort", abortRescueFromHost);
    };
    let higherTierMadeSafe = false;
    if (configuredHigherTierRescue && !rescueController.signal.aborted) {
      try {
        if (await optimization.runNow(ctx, rescueController.signal)) {
          logInfo("compaction", { event: "rescue-distillation", sid, attempt: 1 });
          higherTierMadeSafe = await rescueProjectionFits(runtime, freshness, ctx, event);
        }
      } catch (error) {
        logWarn("compaction", { event: "rescue-distillation-failed", sid, error: error instanceof Error ? error.message : String(error) });
      }
    }
    let tierOneRescue: TierOneRescueOutcome = "unavailable";
    if (configuredTierOneRescue && !higherTierMadeSafe && !rescueController.signal.aborted) {
      tierOneRescue = await runTierOneRescue(runtime, ctx, { ...event, signal: rescueController.signal }, rescueCallBudget);
      if (tierOneRescue === "aborted" && event.signal.aborted) {
        finishRescueBudget();
        return;
      }
      if (tierOneRescue === "failed" || tierOneRescue === "stale" || tierOneRescue === "aborted") {
        logWarn("compaction", { event: "tier-one-rescue-fallback", sid, outcome: tierOneRescue });
      }
    }
    if (event.signal.aborted) {
      finishRescueBudget();
      return;
    }
    const release = await runtime.acquireLock(sid);
    let lockHeld = true;
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
      // Rescue mutations can replace the blocks captured at hook entry. Freeze
      // ownership again from the final graph that the checkpoint will consume.
      if (checkpointTransactionId) {
        const candidate = pendingCheckpointSources.get(checkpointTransactionId);
        if (candidate) {
          const compiled = compileCheckpointSource({ preparation: event.preparation, branchEntries: event.branchEntries, state: turn.state });
          const sourceRoots = new Set(compiled.sourceMessageIds);
          candidate.sourceMessageIds = compiled.sourceMessageIds;
          candidate.sourceBlockIds = turn.state.blocks
            .filter((block) => block.active && block.effectiveMessageIds.every((id) => sourceRoots.has(rawMessageId(id))))
            .map((block) => block.blockId);
          candidate.sourceHash = sha256(compiled.source);
        }
      }
      const suffixTexts: string[] = [];
      const runtimeOverlay = freshness.previewRuntimeOverlay();
      if (runtimeOverlay) suffixTexts.push(runtimeOverlay);
      const pinBudgetSuffixes = [...suffixTexts];
      if (turn.nudge?.shouldInject) pinBudgetSuffixes.push(extractText(nudgeMessage(
        turn.nudge, turn.state.blocks.filter((block) => block.active), runtime.prompts, runtime.adapter,
        hostTokensBefore, forcedCompressionLimit(runtime.adapter, config.modelContextLimit),
      )));
      const beforePins = compileFinalRequestProjection({
        baseLocalTokens: turn.projection.projectedTokens,
        suffixTexts: pinBudgetSuffixes,
        state: turn.state,
        modelKey,
        baseProjectionHash: turn.projection.projectionHash,
      }).estimatedTokens;
      const pinnedOverlay = renderPins(turn.state, coreMessages, ctx, runtime, beforePins);
      if (pinnedOverlay) suffixTexts.push(pinnedOverlay);
      if (turn.nudge?.shouldInject) {
        const nudge = nudgeMessage(
          turn.nudge,
          turn.state.blocks.filter((block) => block.active),
          runtime.prompts,
          runtime.adapter,
          hostTokensBefore,
          forcedCompressionLimit(runtime.adapter, config.modelContextLimit),
        );
        suffixTexts.push(extractText(nudge));
      }
      const finalProjection = compileFinalRequestProjection({
        baseLocalTokens: turn.projection.projectedTokens,
        suffixTexts,
        state: turn.state,
        modelKey,
        baseProjectionHash: turn.projection.projectionHash,
      });
      const projectedTokens = finalProjection.estimatedTokens;
      const calibration = turn.state.policyState.tokenCalibration[modelKey];
      const providerAudit = runtime.providerAuditFor(sid);
      const changed = Boolean(providerAudit) && turn.projection.contentChanged && projectedTokens < hostTokensBefore;
      runtime.recordProjection(sid, {
        revision: state.revision,
        graphRevision: state.graphRevision,
        epoch: state.currentEpoch,
        modelKey,
        contextWindow: config.modelContextLimit,
        estimatedTokens: projectedTokens,
        localTokens: finalProjection.localTokens,
        originalTokens: turn.projection.originalTokens,
        tokensCleared: turn.projection.tokensCleared,
        tokensPruned: turn.projection.tokensPruned,
        projectionHash: finalProjection.projectionHash,
        sourceMessages: coreMessages.length,
        projectedMessages: turn.messages.length + suffixTexts.length,
        changed,
        recordedAt: Date.now(),
      });
      if (shouldCancelHostCompaction({
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
        for (const [key, candidate] of pendingCheckpointSources) {
          if (candidate.sessionId === sid) pendingCheckpointSources.delete(key);
        }
        logInfo("compaction", {
          event: "selective-rescue",
          sid,
          reason: event.reason,
          projectedTokens,
          hostTokensBefore,
        });
        return { cancel: true };
      }
      if (configuredCheckpoint && !rescueController.signal.aborted) {
        const expectedRevision = state.revision;
        const expectedGraphRevision = state.graphRevision;
        const frozenState = structuredClone(turn.state);
        release();
        lockHeld = false;
        const checkpoint = await generateConfiguredCheckpoint(
          runtime,
          ctx,
          { ...event, signal: rescueController.signal },
          frozenState,
          checkpointTransactionId,
          rescueCallBudget,
        );
        if (checkpoint) {
          const verifyRelease = await runtime.acquireLock(sid);
          try {
            const current = await runtime.stateFor(ctx);
            if (current.state.revision === expectedRevision && current.state.graphRevision === expectedGraphRevision) {
              return { compaction: checkpoint };
            }
            logWarn("compaction", { event: "configured-checkpoint-stale", sid, expectedRevision, actualRevision: current.state.revision });
          } finally {
            verifyRelease();
          }
        }
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
      if (lockHeld) release();
      finishRescueBudget();
    }
  });
  const clearPendingForSession = (_event: unknown, ctx: ExtensionContext) => {
    const sid = ctx.sessionManager.getSessionId();
    for (const [key, candidate] of pendingCheckpointSources) {
      if (candidate.sessionId === sid) pendingCheckpointSources.delete(key);
    }
  };
  pi.on("session_before_switch", clearPendingForSession);
  pi.on("session_shutdown", clearPendingForSession);
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

const SYNCHRONOUS_RESCUE_BUDGET_MS = 30_000;

async function runTierOneRescue(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  callBudget: CompressionCallBudget,
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
  const transfer = redactCompactionTransfer(snapshot.source, runtime.adapter.compress?.secretPatterns);
  try {
    const result = await compressWithModel({
      ctx,
      model: snapshot.model,
      thinkingLevel: compressionThinkingLevel(runtime.adapter),
      tier: 1,
      source: transfer.source,
      prompts: runtime.prompts,
      summaryMaxChars: 40_000,
      signal: event.signal,
      beforeCall: (inputTokens, outputTokens) => callBudget.reserveEstimated(inputTokens, outputTokens),
    });
    callBudget.observe(result.usage);
    if (event.signal.aborted) return "aborted";
    const validation = validateAndRepairSummary({
      summary: result.summary,
      manifest: manifestForCompiledSource(transfer.source),
      sourceTokens: snapshot.sourceTokens,
      tier: 1,
      summaryMaxChars: 40_000,
    });
    if (event.signal.aborted) return "aborted";
    const structuredSummary = structuredSummaryFromRendered(validation.renderedSummary, snapshot.manifest);
    return commitTierOneRescue(runtime, ctx, event.signal, snapshot, {
      summary: renderAuthoritativeSummary(structuredSummary),
      structuredSummary,
      quality: {
        status: validation.status,
        missingRequiredFacts: validation.missingRequiredFacts,
        compressionRatio: validation.compressionRatio,
        attempts: 1,
      },
      provenance: {
        requestedRoute: "configured",
        actualWriter: "configured",
        policyRevision: compressionPolicyRevision(runtime),
        rawSourceHash: transfer.rawSourceHash,
        transferSourceHash: transfer.transferSourceHash,
        redactionManifestHash: transfer.redactionManifestHash,
        redactionPolicyVersion: transfer.redactionPolicyVersion,
        nonAuthoritativeCommentary: validation.renderedSummary,
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
    let failure: unknown = error;
    const failedUsage = compressionErrorUsage(error);
    if (failedUsage) {
      try { callBudget.observe(failedUsage); } catch (budgetError) { failure = budgetError; }
    }
    logWarn("compaction", {
      event: "tier-one-rescue-generation-failed",
      sessionId: snapshot.sessionId,
      error: failure instanceof Error ? failure.message : String(failure),
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
    const messageById = new Map(coreMessages.map((message) => [message.id, message]));
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
        const sourceChars = plannedRange.sourceMessageIds.reduce((total, id) => total + (messageById.get(id)?.text?.length ?? 0), 0);
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

async function rescueProjectionFits(runtime: AcpRuntime, freshness: FreshnessTracker, ctx: ExtensionContext, event: SessionBeforeCompactEvent): Promise<boolean> {
  const release = await runtime.acquireLock(ctx.sessionManager.getSessionId());
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
    const turn = runtime.core.processTurn({ messages: coreMessages, state: structuredClone(state), config, tokenCount: hostTokensBefore });
    const suffixTexts: string[] = [];
    const runtimeOverlay = freshness.previewRuntimeOverlay();
    if (runtimeOverlay) suffixTexts.push(runtimeOverlay);
    const pinBudgetSuffixes = [...suffixTexts];
    if (turn.nudge?.shouldInject) pinBudgetSuffixes.push(extractText(nudgeMessage(
      turn.nudge, turn.state.blocks.filter((block) => block.active), runtime.prompts, runtime.adapter,
      hostTokensBefore, forcedCompressionLimit(runtime.adapter, config.modelContextLimit),
    )));
    const beforePins = compileFinalRequestProjection({
      baseLocalTokens: turn.projection.projectedTokens,
      suffixTexts: pinBudgetSuffixes,
      state: turn.state,
      modelKey,
      baseProjectionHash: turn.projection.projectionHash,
    }).estimatedTokens;
    const pins = renderPins(turn.state, coreMessages, ctx, runtime, beforePins);
    if (pins) suffixTexts.push(pins);
    if (turn.nudge?.shouldInject) suffixTexts.push(extractText(nudgeMessage(
      turn.nudge, turn.state.blocks.filter((block) => block.active), runtime.prompts, runtime.adapter,
      hostTokensBefore, forcedCompressionLimit(runtime.adapter, config.modelContextLimit),
    )));
    const projection = compileFinalRequestProjection({
      baseLocalTokens: turn.projection.projectedTokens,
      suffixTexts,
      state: turn.state,
      modelKey,
      baseProjectionHash: turn.projection.projectionHash,
    });
    const calibration = turn.state.policyState.tokenCalibration[modelKey];
    const reserve = calibration?.verified ? 0 : HOST_SYSTEM_TOOL_RESERVE_TOKENS;
    return projection.estimatedTokens + reserve <= safeResumeThreshold(runtime.adapter, config.modelContextLimit);
  } finally {
    release();
  }
}

async function generateConfiguredCheckpoint(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  state: CompressionState,
  checkpointTransactionId?: string,
  sharedCallBudget?: CompressionCallBudget,
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
    rawSourceHash: string;
    transferSourceHash: string;
    redactionManifestHash: string;
    redactionPolicyVersion: string;
    policyRevision: string;
    sourceMessageIds: string[];
    validation: string;
    structuredSummary: ReturnType<typeof structuredSummaryFromRendered>;
    nonAuthoritativeCommentary?: string;
    checkpointTransactionId?: string;
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
    const transfer = redactCompactionTransfer(compiled.source, runtime.adapter.compress?.secretPatterns);
    const source = transfer.source;
    const localManifest = manifestForCompiledSource(compiled.source);
    const manifest = manifestForCompiledSource(source);
    const callBudget = sharedCallBudget ?? new CompressionCallBudget(runtime.adapter.compress);
    const deadline = AbortSignal.timeout(runtime.adapter.compress?.maxDurationMs ?? 60_000);
    const generationSignal = event.signal ? AbortSignal.any([event.signal, deadline]) : deadline;
    const runCheckpoint = (checkpointSource: string) => {
      return compressWithModel({
      ctx,
      model,
      thinkingLevel: compressionThinkingLevel(runtime.adapter, "checkpoint"),
      tier: 1,
      source: checkpointSource,
      prompts: runtime.prompts,
      summaryMaxChars: 40_000,
        signal: generationSignal,
        beforeCall: (inputTokens, outputTokens) => callBudget.reserveEstimated(inputTokens, outputTokens),
      });
    };
    let result = await runCheckpoint(source);
    callBudget.observe(result.usage);
    let validation: ReturnType<typeof validateAndRepairSummary> | undefined;
    let validationFailure: unknown;
    try {
      validation = validateAndRepairSummary({
        summary: result.summary,
        manifest,
        sourceTokens: compiled.sourceTokens,
        tier: 1,
        summaryMaxChars: 40_000,
      });
    } catch (error) {
      validationFailure = error;
    }
    if (!validation) {
      const repair = await runCheckpoint([
        `[Validation repair request] The prior output failed: ${validationFailure instanceof Error ? validationFailure.message : String(validationFailure)}`,
        `[Prior summary]\n${result.summary}`,
        `[Authoritative source]\n${source}`,
      ].join("\n\n"));
      result = { ...repair, usage: mergeCheckpointUsage(result.usage, repair.usage) };
      callBudget.observe(result.usage);
      validation = validateAndRepairSummary({
        summary: result.summary,
        manifest,
        sourceTokens: compiled.sourceTokens,
        tier: 1,
        summaryMaxChars: 40_000,
      });
    }
    const structuredSummary = structuredSummaryFromRendered(validation.renderedSummary, localManifest);
    const summary = `[Hybrid ACP checkpoint]\n${renderAuthoritativeSummary(structuredSummary)}`;
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
        sourceHash: transfer.rawSourceHash,
        rawSourceHash: transfer.rawSourceHash,
        transferSourceHash: transfer.transferSourceHash,
        redactionManifestHash: transfer.redactionManifestHash,
        redactionPolicyVersion: transfer.redactionPolicyVersion,
        policyRevision: compressionPolicyRevision(runtime),
        sourceMessageIds: compiled.sourceMessageIds,
        validation: validation.status,
        structuredSummary,
        nonAuthoritativeCommentary: validation.renderedSummary,
        checkpointTransactionId,
      },
    };
  } catch (error) {
    logWarn("compaction", { event: "configured-checkpoint-failed-host-fallback", error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function mergeCheckpointUsage(left: CompressionUsage, right: CompressionUsage): CompressionUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cacheWrite1h: left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined ? (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) : undefined,
    reasoning: left.reasoning !== undefined || right.reasoning !== undefined ? (left.reasoning ?? 0) + (right.reasoning ?? 0) : undefined,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
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

function wireSurvivalAging(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("agent_end", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages } = await runtime.stateFor(ctx);
      const userTurn = [...coreMessages].reverse().find((message) => message.role === "user" && !message.synthetic);
      const turnId = userTurn?.id.split("#", 1)[0];
      if (!turnId || state.policyState.lastSurvivedTurnId === turnId) return;
      const promotionThreshold = runtime.configFor(ctx).promotionThreshold;
      await runtime.save({
        ...state,
        pins: state.pins.map((pin) => ({ ...pin, remainingTurns: pin.remainingTurns - 1 })).filter((pin) => pin.remainingTurns > 0),
        blocks: state.blocks.map((block) => {
          if (!block.active) return block;
          const survivedCount = block.survivedCount + 1;
          return { ...block, survivedCount, generation: survivedCount >= promotionThreshold ? "old" : block.generation };
        }),
        policyState: { ...state.policyState, lastSurvivedTurnId: turnId },
      }, ctx);
    } catch (error) {
      logWarn("survival", { event: "aging-failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
  });
}

async function reloadRuntimeConfig(runtime: AcpRuntime, baseAdapter: AdapterConfig, ctx: ExtensionContext): Promise<void> {
  // ExtensionContext always supplies cwd in Pi/OMP. Minimal test and legacy
  // compatibility contexts may omit it; retain their explicit adapter rather
  // than accidentally loading configuration from this process's repository.
  if (typeof ctx.cwd !== "string" || ctx.cwd.length === 0) return;
  const user = await loadUserConfig(ctx.cwd);
  const loaded = applyUserConfig(baseAdapter, user);
  const sid = ctx.sessionManager?.getSessionId?.() ?? "__acp_global__";
  const resolved = runtime.agentPolicyRunActive(sid)
    ? applyImmediateSecurityRevocations(runtime.adapter, loaded)
    : loaded;
  runtime.setAdapter(resolved);
  setDelegateDisplayUsage(resolveDelegate(resolved).displayUsage);
  setDebugEnabled(resolved.debug ?? false);
  if (runtime.agentPolicyRunActive(sid)) return;
  try {
    runtime.setPrompts(resolvePrompts(resolved.prompts, { acknowledgeRisk: resolved.acknowledgePromptsRisk === true }));
  } catch (error) {
    logWarn("config", { event: "prompts-resolve-failed", error: error instanceof Error ? error.message : String(error) });
    runtime.setPrompts(defaultPrompts);
  }
}

function applyImmediateSecurityRevocations(frozen: AdapterConfig, loaded: AdapterConfig): AdapterConfig {
  const frozenDelegate = resolveDelegate(frozen);
  const loadedDelegate = resolveDelegate(loaded);
  const delegate = !loadedDelegate.enabled
    ? false
    : frozenDelegate.enabled ? loaded.delegate : false;
  return {
    ...frozen,
    delegate,
    compress: {
      ...frozen.compress,
      allowCrossProvider: frozen.compress?.allowCrossProvider === true && loaded.compress?.allowCrossProvider === true,
      acknowledgeCrossProviderDataTransfer: frozen.compress?.acknowledgeCrossProviderDataTransfer === true
        && loaded.compress?.acknowledgeCrossProviderDataTransfer === true,
    },
  };
}

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker, baseAdapter: AdapterConfig): void {
  let delegateToolsRegistered = false;
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
    try {
      await reloadRuntimeConfig(runtime, baseAdapter, ctx);
    } catch (e) {
      // Fail closed to startup defaults if configuration cannot be refreshed.
      runtime.setAdapter(baseAdapter);
      runtime.setPrompts(defaultPrompts);
      setDebugEnabled(baseAdapter.debug ?? false);
      setDelegateDisplayUsage(resolveDelegate(baseAdapter).displayUsage);
      logThrow("config", e, { sid, phase: "session_start" });
    }
    logInfo("session", { event: "start", sid, cwd: ctx.cwd, debug: runtime.adapter.debug ?? null, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null });
    if (resolveDelegate(runtime.adapter).enabled && !delegateToolsRegistered) {
      const delegateEnabled = () => resolveDelegate(runtime.adapter).enabled;
      pi.registerTool(makeDelegateTool(pi, delegateEnabled));
      pi.registerTool(makeDelegateWaitTool(pi, delegateEnabled));
      pi.registerTool(makeDelegateCancelTool(pi, delegateEnabled));
      delegateToolsRegistered = true;
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
  pi.on("session_shutdown", async (_event, ctx) => {
    if (runtime.adapter.artifacts?.lifecycle !== "session") return;
    // Shutdown reasons do not prove that no fork, resume, reload, or tree can
    // still reference this content-addressed directory. Sweep only files that
    // are already unreferenced by durable state; never delete the whole store.
    try {
      const { state } = await runtime.stateFor(ctx);
      const cleaned = await cleanupArtifactStore(state, ctx.sessionManager.getSessionId());
      if (cleaned.removed > 0) logInfo("artifact", { event: "session-sweep", ...cleaned });
    } catch (error) {
      logWarn("artifact", { event: "session-cleanup-failed", error: error instanceof Error ? error.message : String(error) });
    }
  });
  pi.on("session_before_fork", () => { freshness.invalidate(); });
  pi.on("session_tree", () => { freshness.invalidate(); });
  pi.on("session_shutdown", () => {
    delegateStatusWidget.dispose();
    closeLogStream();
  });
}

async function ensureReasoningArtifacts(
  initial: CompressionState,
  messages: readonly CoreMessage[],
  sessionId: string,
  adapter: AdapterConfig,
): Promise<CompressionState> {
  let state = initial;
  let currentTurnStart = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "user" && !messages[index]!.synthetic) { currentTurnStart = index; break; }
  }
  for (let index = 0; index < currentTurnStart; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.contentType !== "reasoning"
      || message.reasoningKind !== "plaintext-provider-agnostic" || message.reasoningSignature !== undefined
      || message.hardProtected || !(message.text?.length)) continue;
    const group = message.protocolGroupId ?? message.id.split("#", 1)[0]!;
    const companionComplete = messages.some((candidate, candidateIndex) => candidateIndex > index
      && candidateIndex < currentTurnStart
      && (candidate.protocolGroupId ?? candidate.id.split("#", 1)[0]!) === group
      && candidate.role === "assistant"
      && (candidate.contentType === "text" || candidate.contentType === "tool-call"));
    if (!companionComplete || state.artifacts.some((artifact) => artifact.sourceMessageId === message.id && artifact.retrievable)) continue;
    try {
      const spooled = await spoolArtifact(state, {
        sessionId,
        sourceMessageId: message.id,
        toolName: "reasoning",
        text: message.text,
        force: true,
        maxArtifactBytes: adapter.artifacts?.maxArtifactBytes,
        maxSessionBytes: adapter.artifacts?.maxSessionBytes,
        maxGlobalBytes: adapter.artifacts?.maxGlobalBytes,
      });
      if (spooled) state = spooled.state;
    } catch (error) {
      logWarn("artifact", { event: "reasoning-spool-failed-preserved-inline", sourceMessageId: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return state;
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker, baseAdapter: AdapterConfig): void {
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      // Re-read both global and project acp.json before every provider call so
      // revocations (transfer consent, secrets, clearing) take effect now.
      await reloadRuntimeConfig(runtime, baseAdapter, ctx);
      const { state, coreMessages, entries } = await runtime.stateFor(ctx, event.messages);
      let workingState = structuredClone(state);
      const config = runtime.configFor(ctx);
      if (config.clearing.reasoning === "safe-only") {
        workingState = await ensureReasoningArtifacts(workingState, coreMessages, sid, runtime.adapter);
      }
      const coveredIds = collectCoveredMessageIds(workingState);
      const realUsage = ctx.getContextUsage?.();
      const modelKey = modelCalibrationKey(ctx.model);
      const previousProjection = runtime.projectionFor(sid);
      const previousAudit = runtime.providerAuditFor(sid, false);
      const previousCalibration = JSON.stringify(workingState.policyState.tokenCalibration[modelKey] ?? null);
      const exactAuditMatch = previousProjection?.authoritative === true
        && previousAudit !== undefined
        && previousProjection.requestGeneration === previousAudit.requestGeneration
        && previousProjection.payloadHash === previousAudit.payloadHash
        && previousProjection.fixedPrefixFingerprint === previousAudit.fixedPrefixFingerprint;
      if (previousProjection
        && previousProjection.modelKey === modelKey
        && previousProjection.epoch === workingState.currentEpoch
        && previousProjection.contextWindow === config.modelContextLimit
        && (!previousProjection.authoritative || exactAuditMatch)) {
        updateTokenCalibration(
          workingState,
          modelKey,
          previousProjection.localTokens,
          realUsage?.tokens,
          workingState.currentEpoch,
          Date.now(),
          exactAuditMatch ? {
            requestGeneration: previousAudit.requestGeneration,
            payloadHash: previousAudit.payloadHash,
            fixedPrefixFingerprint: previousAudit.fixedPrefixFingerprint,
            mediaVerified: previousAudit.mediaVerified,
          } : undefined,
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
    const suffixTexts: string[] = [];
    const debugOn = debug.enabled;
    const runtimeOverlay = freshness.consumeRuntimeOverlay();
    if (runtimeOverlay) {
      rebuilt.push({ role: "user", content: runtimeOverlay, timestamp: Date.now() });
      suffixTexts.push(runtimeOverlay);
    }
    const pinBudgetSuffixes = [...suffixTexts];
    if (turn.nudge?.shouldInject) pinBudgetSuffixes.push(extractText(nudgeMessage(
      turn.nudge, turn.state.blocks.filter((block) => block.active), runtime.prompts, runtime.adapter,
      tokenCount, forcedCompressionLimit(runtime.adapter, config.modelContextLimit),
    )));
    const beforePins = compileFinalRequestProjection({
      baseLocalTokens: turn.projection.projectedTokens,
      suffixTexts: pinBudgetSuffixes,
      state: turn.state,
      modelKey,
      baseProjectionHash: turn.projection.projectionHash,
    }).estimatedTokens;
    const pinnedOverlay = renderPins(turn.state, coreMessages, ctx, runtime, beforePins);
    if (pinnedOverlay) {
      rebuilt.push({ role: "user", content: pinnedOverlay, timestamp: Date.now() });
      suffixTexts.push(pinnedOverlay);
    }

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
        const nudge = nudgeMessage(
          turn.nudge,
          turn.state.blocks.filter((b) => b.active),
          runtime.prompts,
          runtime.adapter,
          tokenCount,
          forcedCompressionLimit(runtime.adapter, config.modelContextLimit),
        );
        rebuilt.push(nudge);
        suffixTexts.push(extractText(nudge));
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

    const finalProjection = compileFinalRequestProjection({
      baseLocalTokens: turn.projection.projectedTokens,
      suffixTexts,
      state: turn.state,
      modelKey,
      baseProjectionHash: turn.projection.projectionHash,
    });
    runtime.recordProjection(sid, {
      revision: persisted.revision,
      graphRevision: turn.state.graphRevision,
      epoch: turn.state.currentEpoch,
      modelKey,
      contextWindow: config.modelContextLimit,
      estimatedTokens: finalProjection.estimatedTokens,
      localTokens: finalProjection.localTokens,
      originalTokens: turn.projection.originalTokens,
      tokensCleared: turn.projection.tokensCleared,
      tokensPruned: turn.projection.tokensPruned,
      projectionHash: finalProjection.projectionHash,
      sourceMessages: coreMessages.length,
      projectedMessages: turn.messages.length + suffixTexts.length,
      changed: turn.projection.contentChanged,
      recordedAt: Date.now(),
    });
    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    debug.event("context-out", { outMsgs: rebuilt.length, finalTokens: finalProjection.estimatedTokens, suffixTokens: finalProjection.suffixTokens, injected: turn.nudge?.shouldInject ?? false, emergency: turn.nudge?.breakdown?.emergencyOverride === 1 });
    return { messages: rebuilt };
    } catch (e) {
      logThrow("context", e, { sid, phase: "transform" });
      throw e;
    } finally {
      release();
    }
  });
}

function wireSystemPrompt(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker, baseAdapter: AdapterConfig): void {
  let worldCapture: Promise<string> | undefined;
  const captureWorldDebounced = (cwd: string): Promise<string> => {
    if (worldCapture) return worldCapture;
    const started = Date.now();
    worldCapture = captureWorldStateAsync(cwd).then(renderWorldOverlay).finally(() => {
      logInfo("latency", { event: "world-capture", durationMs: Date.now() - started });
      setTimeout(() => { worldCapture = undefined; }, 100).unref();
    });
    return worldCapture;
  };
  pi.on("before_agent_start", async (event, ctx) => {
    await reloadRuntimeConfig(runtime, baseAdapter, ctx);
    const sid = ctx.sessionManager?.getSessionId?.() ?? "__acp_global__";
    runtime.beginAgentPolicyRun(sid);
    const delegate = resolveDelegate(runtime.adapter).enabled;
    const acp = buildAcpSystemPrompt(runtime.prompts, runtime.adapter);
    const prompt = delegate ? `${acp}\n${ACP_DELEGATE_PROMPT}` : acp;
    const projectOverlay = freshness.projectOverlay(event.systemPromptOptions?.contextFiles ?? [], ctx.cwd);
    const worldOverlay = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? await captureWorldDebounced(ctx.cwd) : "";
    freshness.queueRuntimeOverlay(projectOverlay, worldOverlay);
    const authoritativeBase = freshness.patchSystemPrompt(event.systemPrompt);
    return { systemPrompt: formatSystemPromptForEvent(authoritativeBase, prompt) };
  });
  const mutatingTools = new Set(["bash", "write", "edit", "apply_patch"]);
  pi.on("tool_result", async (event, ctx) => {
    if (!mutatingTools.has(event.toolName)) return;
    if (event.toolName === "bash" && !bashMayMutate(event.input.command)) return;
    const started = Date.now();
    const projectOverlay = freshness.refreshProjectOverlay();
    const worldOverlay = await captureWorldDebounced(ctx.cwd);
    freshness.queueRuntimeOverlay(projectOverlay, worldOverlay);
    logInfo("latency", { event: "freshness-refresh", toolName: event.toolName, durationMs: Date.now() - started });
  });
  pi.on("agent_end", (_event, ctx) => {
    runtime.endAgentPolicyRun(ctx.sessionManager?.getSessionId?.() ?? "__acp_global__");
  });
}

function bashMayMutate(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return true;
  const normalized = command.trim().replace(/\s+/g, " ");
  const readOnly = /^(?:pwd|ls(?: |$)|rg(?: |$)|grep(?: |$)|fd(?: |$)|find(?: |$)|cat(?: |$)|head(?: |$)|tail(?: |$)|git (?:status|diff|log|show|rev-parse|branch)(?: |$))/.test(normalized);
  const explicitMutation = /(?:^|\s)(?:>|>>|tee|rm|mv|cp|touch|mkdir|rmdir|chmod|chown|sed\s+-i|git\s+(?:add|commit|checkout|switch|reset|restore|merge|rebase|cherry-pick|clean)|npm\s+(?:install|uninstall)|pnpm\s+(?:add|remove)|yarn\s+(?:add|remove))(?:\s|$)/.test(normalized);
  return !readOnly || explicitMutation;
}

function wireProviderRequestAuditor(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker, baseAdapter: AdapterConfig): void {
  pi.on("before_provider_request", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    // Freeze non-security policy for the run, but observe consent and delegate
    // revocations before every outbound provider request.
    await reloadRuntimeConfig(runtime, baseAdapter, ctx);
    const patchedPayload = freshness.patchProviderPayload(event.payload);
    const sanitized = sanitizeUnsafeProviderMedia(patchedPayload);
    const payload = deepFreezeProviderPayload(sanitized.payload);
    if (sanitized.droppedMedia > 0) {
      ctx.ui.notify(`ACP omitted ${sanitized.droppedMedia} unverified media payload(s). Externalize or resend them with verified dimensions and format.`, "warning");
      logWarn("provider-audit", { event: "unverified-media-omitted", sid, count: sanitized.droppedMedia });
    }
    const modelKey = modelCalibrationKey(ctx.model);
    const audit = auditProviderPayload(payload, ctx.model?.provider);
    const previous = runtime.providerAuditFor(sid, false);
    const release = await runtime.acquireLock(sid);
    try {
      const { state } = await runtime.stateFor(ctx);
      let persisted = state;
      if (previous && previous.fixedPrefixFingerprint !== audit.fixedPrefixFingerprint
        && state.policyState.tokenCalibration[modelKey] !== undefined) {
        const next = structuredClone(state);
        delete next.policyState.tokenCalibration[modelKey];
        persisted = await runtime.save(next, ctx);
        logWarn("calibration", { event: "fixed-prefix-changed", sid, modelKey });
      }
      runtime.beginProviderCycle(sid);
      const recorded = runtime.recordProviderAudit(sid, {
        ...audit,
        modelKey,
        contextWindow: runtime.liveContextLimit(ctx),
      });
      runtime.recordContextTokens(sid, audit.estimatedTokens);
      const priorProjection = runtime.projectionFor(sid);
      runtime.recordProjection(sid, {
        revision: persisted.revision,
        graphRevision: persisted.graphRevision,
        epoch: persisted.currentEpoch,
        modelKey,
        contextWindow: runtime.liveContextLimit(ctx),
        estimatedTokens: audit.estimatedTokens,
        localTokens: audit.textTokens + audit.mediaTokens,
        originalTokens: priorProjection?.originalTokens ?? audit.estimatedTokens,
        tokensCleared: priorProjection?.tokensCleared ?? 0,
        tokensPruned: priorProjection?.tokensPruned ?? 0,
        projectionHash: audit.canonicalPayloadHash,
        sourceMessages: priorProjection?.sourceMessages ?? 0,
        projectedMessages: priorProjection?.projectedMessages ?? 0,
        changed: priorProjection?.changed ?? false,
        recordedAt: recorded.recordedAt,
        authoritative: true,
        requestGeneration: recorded.requestGeneration,
        payloadHash: audit.payloadHash,
        toolSchemaFingerprint: audit.toolSchemaFingerprint,
        systemPromptFingerprint: audit.systemPromptFingerprint,
        fixedPrefixFingerprint: audit.fixedPrefixFingerprint,
        mediaTokens: audit.mediaTokens,
        mediaVerified: audit.mediaVerified,
      });
      debug.event("provider-request-audit", {
        sid,
        tokens: audit.estimatedTokens,
        mediaTokens: audit.mediaTokens,
        mediaVerified: audit.mediaVerified,
        payloadHash: audit.payloadHash,
        fixedPrefixFingerprint: audit.fixedPrefixFingerprint,
      });
    } finally {
      release();
    }
    return payload;
  });
  pi.on("tool_result", (_event, ctx) => {
    runtime.markProviderMutation(ctx.sessionManager.getSessionId());
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
    currentCheckpointId: state.currentCheckpointId,
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

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[], _prompts: Prompts, adapter: AdapterConfig, tokenCount: number, hardLimit: number): AgentMessage {
  const tier = (nudge.tier ?? 1) as 1 | 2 | 3;
  const writer = compressorModeForTier(adapter, tier);
  const ranges = [...nudge.compressibleRanges]
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 5)
    .map((range) => `${range.startRef}..${range.endRef} (~${Math.round(range.tokens / 1000)}k)`);
  const permission = writer === "configured"
    ? "Omit summary; caller summaries are forbidden."
    : "Call plan_compression first; then pass its transactionId and a source-backed summary.";
  const lines = [
    `ACP compression action: Tier ${tier}, ${writer} writer. ${permission}`,
    ranges.length > 0 ? `Valid ranges only: ${ranges.join(", ")}.` : "No valid range is available; do not retry compression and allow host checkpointing.",
    `Reason: ${nudge.reason ?? "context budget"}. ${remainingToolBudgetText(tokenCount, hardLimit)}.`,
  ];
  if (blocks.length > 0) lines.push(`Active blocks: ${blocks.slice(0, 5).map((block) => block.blockId).join(", ")}${blocks.length > 5 ? ` (+${blocks.length - 5})` : ""}.`);

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n").slice(0, 4_000) }],
    timestamp: Date.now(),
  } as AgentMessage;
}
