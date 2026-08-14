import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionBeforeCompactEvent,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { NudgeDecision, CompressionBlock, CompressionState, Prompts } from "acp-kernel";
import { commitCheckpointEpoch, renderNudgeText, resolvePrompts, defaultPrompts } from "acp-kernel";
import {
  type AdapterConfig,
  compressorModeForTier,
  compressionThinkingLevel,
  parseCompressionModel,
  resolveDelegate,
  safeResumeThreshold,
} from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeArtifactTool } from "./artifact-tool.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, runningRunsSnapshot, resetDelegateUsage, setDelegateDisplayUsage } from "./delegate-tool.js";
import { makeCommands } from "./commands.js";
import { coreOutToAgentMessages, materializeCompressionAnchors } from "./messages.js";
import { buildAcpSystemPrompt, ACP_DELEGATE_PROMPT } from "./system-prompt.js";
import { delegateStatusWidget } from "./fleet-widget.js";
import { FORCED_COMPRESSION_TOKEN_LIMIT, wireToolGuardrails } from "./tool-guardrails.js";
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
import { wireAutomaticCompaction } from "./automatic-compaction.js";
import { captureWorldState, FreshnessTracker, renderWorldOverlay } from "./freshness.js";
import { registerPinTool, renderPins } from "./pin-tool.js";
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
    wireCompactionCoordinator(pi, runtime, freshness);
    wireSessionLifecycle(pi, runtime, freshness);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi, runtime, freshness);
    wireAutomaticCompaction(pi, runtime);
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
  now?: number;
  minimumSavings?: number;
  fixedReserveTokens?: number;
}): boolean {
  if (input.reason !== "threshold" || !input.changed) return false;
  const now = input.now ?? Date.now();
  if (!input.calibrationSamples || !input.calibrationUpdatedAt) return false;
  if (now - input.calibrationUpdatedAt > TOKEN_CALIBRATION_MAX_AGE_MS || input.calibrationUpdatedAt > now) return false;
  const minimumSavings = input.minimumSavings ?? 12_000;
  const projectedTotal = input.projectedTokens + (input.fixedReserveTokens ?? HOST_SYSTEM_TOOL_RESERVE_TOKENS);
  return projectedTotal <= input.safeThreshold
    && input.hostTokensBefore - projectedTotal >= minimumSavings;
}

function wireCompactionCoordinator(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker): void {
  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary || runtime.adapter.compress?.branchSummaryCompressor !== "configured") return;
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state } = await runtime.stateFor(ctx);
      const compiled = compileBranchSource(event.preparation.entriesToSummarize, state.messageRefs.byRaw);
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
        summaryMaxChars: 40_000,
        signal: event.signal,
      });
      const validation = validateAndRepairSummary({
        summary: result.summary,
        manifest: prepared.manifest,
        sourceTokens: compiled.sourceTokens,
        tier: 1,
      });
      return {
        summary: {
          summary: validation.renderedSummary,
          usage: result.usage,
          details: {
            source: "hybrid-acp-configured-branch",
            route: result.model,
            sourceHash: prepared.manifest.sourceHash,
            sourceMessageIds: compiled.sourceMessageIds,
            validation: validation.status,
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
      const committed = commitCheckpointEpoch(state, {
        summary: event.compactionEntry.summary,
        firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
        sourceMessageIds: event.compactionEntry.details && typeof event.compactionEntry.details === "object" && "sourceMessageIds" in event.compactionEntry.details && Array.isArray(event.compactionEntry.details.sourceMessageIds)
          ? event.compactionEntry.details.sourceMessageIds.filter((id): id is string => typeof id === "string")
          : [],
        tokensBefore: event.compactionEntry.tokensBefore,
        provider: model?.provider,
        model: model?.id,
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
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages } = await runtime.stateFor(ctx);
      const config = runtime.configFor(ctx);
      const modelKey = modelCalibrationKey(ctx.model);
      const localBefore = estimateTokens(coreMessages, collectCoveredMessageIds(state), state.tokenSnapshots);
      const hostTokensBefore = conservativeTokenCount([
        event.preparation.tokensBefore,
        ctx.getContextUsage?.()?.tokens,
        calibratedTokenEstimate(localBefore, state, modelKey),
      ]);
      const turn = runtime.core.processTurn({
        messages: coreMessages,
        state,
        config,
        tokenCount: hostTokensBefore,
      });
      const projectedLocal = estimateTokens(turn.messages, undefined, turn.state.tokenSnapshots);
      const projectedTokens = calibratedTokenEstimate(projectedLocal, turn.state, modelKey);
      const calibration = turn.state.policyState.tokenCalibration[modelKey];
      const persisted = await runtime.save(turn.state, ctx);
      const changed = turn.messages.length < coreMessages.length
        && persisted.revision > state.revision;
      runtime.recordProjection(sid, {
        revision: persisted.revision,
        estimatedTokens: projectedTokens,
        sourceMessages: coreMessages.length,
        projectedMessages: turn.messages.length,
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
      if (runtime.adapter.compress?.checkpointCompressor === "configured") {
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
  const inScope = !ctx.scopedModels || ctx.scopedModels.length === 0
    || ctx.scopedModels.some((candidate) => candidate.model.provider === ref.provider && candidate.model.id === ref.id);
  if (!inScope) return undefined;
  const model = ctx.modelRegistry.find(ref.provider, ref.id);
  return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

// (acp_delegate injection is best-effort: sendUserMessage is fire-and-forget
// in pi, and interactive/rpc sessions are long-lived so their main loop
// consumes the follow-up queue naturally — no shutdown drain needed.)

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime, freshness: FreshnessTracker): void {
  pi.on("session_start", async (_event, ctx) => {
    freshness.invalidate();
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
      if (nextPins.length !== state.pins.length || nextPins.some((pin, index) => pin.remainingTurns !== state.pins[index]?.remainingTurns)) {
        await runtime.save({ ...state, pins: nextPins }, ctx);
      }
    } catch (error) {
      logWarn("pin", { event: "expiry-failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
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
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages, entries } = await runtime.stateFor(ctx, event.messages);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      const realUsage = ctx.getContextUsage?.();
      const modelKey = modelCalibrationKey(ctx.model);
      const estimated = estimateTokens(coreMessages, coveredIds, state.tokenSnapshots);
      updateTokenCalibration(state, modelKey, estimated, realUsage?.tokens);
      const calibrated = calibratedTokenEstimate(estimated, state, modelKey);
      const tokenCount = conservativeTokenCount([estimated, calibrated, realUsage?.tokens]);
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

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      const persisted = await runtime.save(turn.state, ctx);
      const projectedLocal = estimateTokens(turn.messages, undefined, persisted.tokenSnapshots);
      const projectedTokens = calibratedTokenEstimate(projectedLocal, persisted, modelKey);
      runtime.recordProjection(sid, {
        revision: persisted.revision,
        estimatedTokens: projectedTokens,
        sourceMessages: coreMessages.length,
        projectedMessages: turn.messages.length,
        changed: turn.messages.length < coreMessages.length,
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
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
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
    const rebuilt = materializeCompressionAnchors(
      coreOutToAgentMessages(turn.messages, originalById),
      turn.state.blocks,
      "compress",
    );
    const debugOn = debug.enabled;
    const pinnedOverlay = renderPins(turn.state, coreMessages, ctx);
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
        const budgetText = remainingToolBudgetText(tokenCount);
        rebuilt.push(nudgeMessage(turn.nudge, turn.state.blocks.filter((b) => b.active), runtime.prompts, runtime.adapter, tokenCount));
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
  pi.on("before_agent_start", (event, ctx) => {
    const delegate = runtime.adapter.delegate !== false;
    const acp = buildAcpSystemPrompt(runtime.prompts, runtime.adapter);
    const prompt = delegate ? `${acp}\n${ACP_DELEGATE_PROMPT}` : acp;
    const projectOverlay = freshness.projectOverlay(event.systemPromptOptions?.contextFiles ?? []);
    const worldOverlay = renderWorldOverlay(captureWorldState(ctx.cwd));
    return {
      systemPrompt: formatSystemPromptForEvent(
        event.systemPrompt,
        [prompt, projectOverlay, worldOverlay].filter((value): value is string => Boolean(value)).join("\n\n"),
      ),
    };
  });
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

export function remainingToolBudgetText(tokenCount: number): string {
  const remaining = Math.max(0, FORCED_COMPRESSION_TOKEN_LIMIT - tokenCount);
  return `Remaining context budget until tool block: ${Math.round(remaining / 1000)}k`;
}

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[], prompts: Prompts, adapter: AdapterConfig, tokenCount: number): AgentMessage {
  const rendered = renderNudgeText(nudge, prompts);
  const tier = (nudge.tier ?? 1) as 1 | 2 | 3;
  const routedText = routeCompressionNudgeText(rendered.text, adapter, tier);
  const lines = [routedText, remainingToolBudgetText(tokenCount)];

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
