import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  BlockGenerationMetadata,
  BlockQuality,
  CompressionBlock,
  CompressionManifest,
  CompressionState,
  CompressionTier,
  CoreMessage,
  StructuredSummary,
} from "acp-kernel";
import { TransactionalBackgroundJobs, sameSnapshot, type BackgroundJobOutcome, type BackgroundTrigger, type JobSnapshot } from "./background-jobs.js";
import { compressorModeForTier, compressionThinkingLevel, parseCompressionModel } from "./config.js";
import { routeCompaction } from "./compaction-routing.js";
import {
  extractCompressionManifest,
  mergeCompressionManifests,
  sha256,
  renderAuthoritativeSummary,
  structuredSummaryFromRendered,
  validateAndRepairSummary,
} from "./manifest.js";
import { compressionErrorUsage, compressWithModel, type CompressionUsage } from "./model-compressor.js";
import { OptimizationTelemetry, type OptimizationRoute } from "./optimization-telemetry.js";
import { QualityAdapter } from "./quality-adaptation.js";
import type { AcpRuntime } from "./runtime.js";
import { ensureCompactionTransferAllowed, redactCompactionTransfer } from "./compress-tool.js";
import { logInfo, logWarn } from "./log.js";
import { wasRecentlyRetrieved } from "./retrieval-tracking.js";
import { compressionPolicyRevision } from "./compression-plan-tool.js";
import { collectCoveredMessageIds, estimateTokens } from "./tokens.js";
import { CompressionCallBudget } from "./model-call-budget.js";

type CompressionModel = NonNullable<ExtensionContext["model"]>;

interface AutomaticSnapshot extends JobSnapshot {
  tier: 2 | 3;
  sourceTier: 1 | 2;
  sourceBlockIds: string[];
  startRef: string;
  endRef: string;
  planSourceHash: string;
  sourceTokens: number;
  source: string;
  manifest: CompressionManifest;
  candidateKey: string;
  policyRevision: string;
}

interface AutomaticProposal {
  summary: string;
  structuredSummary: StructuredSummary;
  quality: BlockQuality;
  provenance: BlockGenerationMetadata;
  usage: CompressionUsage;
  route: OptimizationRoute;
  modelKey: string;
  generatedAt: number;
}

export interface AutomaticCompactionController {
  jobs: TransactionalBackgroundJobs;
  telemetry: OptimizationTelemetry;
  quality: QualityAdapter;
  schedule(trigger: BackgroundTrigger, ctx: ExtensionContext): void;
  /** Synchronous rescue-ladder distillation; returns true only after atomic commit. */
  runNow(ctx: ExtensionContext, signal: AbortSignal): Promise<boolean>;
  cancel(reason: "tree" | "model" | "session" | "shutdown"): void;
}

export function createAutomaticCompaction(runtime: AcpRuntime): AutomaticCompactionController {
  const jobs = new TransactionalBackgroundJobs();
  const telemetry = new OptimizationTelemetry();
  const quality = new QualityAdapter();

  const controller: AutomaticCompactionController = {
    jobs,
    telemetry,
    quality,
    schedule(trigger, ctx) {
      if (runtime.adapter.optimization?.automaticDistillation !== true) return;
      const shadow = runtime.adapter.optimization.shadowCompaction === true;
      let scheduledSnapshot: AutomaticSnapshot | undefined;
      void jobs.schedule(trigger, {
        capture: async (signal) => {
          scheduledSnapshot = await captureSnapshot(runtime, ctx, signal);
          return scheduledSnapshot;
        },
        generate: (snapshot, signal) => generateProposal(runtime, ctx, snapshot, signal, telemetry, quality),
        current: (snapshot, signal) => currentSnapshot(runtime, ctx, snapshot, signal),
        commit: (snapshot, proposal, signal) => commitProposal(runtime, ctx, snapshot, proposal, signal, telemetry),
        shadow,
        maxReplans: runtime.adapter.optimization.maxReplans ?? 1,
        onOutcome: (outcome, durationMs) => {
          if (runtime.adapter.optimization?.telemetry === true && outcome !== "committed") {
            telemetry.recordMutation({
              savingsTokens: 0,
              latencyMs: durationMs,
              discarded: outcome === "stale" || outcome === "aborted" || outcome === "failed",
              shadow: outcome === "shadowed",
            });
          }
          if (scheduledSnapshot) void recordAutomaticOutcome(runtime, ctx, scheduledSnapshot, outcome);
          logInfo("optimization", { event: outcome, trigger, shadow, durationMs });
        },
      });
    },
    async runNow(ctx, signal) {
      const snapshot = await captureSnapshot(runtime, ctx, signal);
      if (!snapshot || signal.aborted) return false;
      // The synchronous rescue path bypasses TransactionalBackgroundJobs, so it
      // must perform the same fresh preflight immediately before provider I/O.
      const preflight = await currentSnapshot(runtime, ctx, snapshot, signal);
      if (!preflight || !sameSnapshot(snapshot, preflight) || signal.aborted) return false;
      const proposal = await generateProposal(runtime, ctx, snapshot, signal, telemetry, quality);
      if (signal.aborted) return false;
      const current = await currentSnapshot(runtime, ctx, snapshot, signal);
      if (!current || !sameSnapshot(snapshot, current)) return false;
      return commitProposal(runtime, ctx, snapshot, proposal, signal, telemetry);
    },
    cancel(reason) {
      jobs.cancelAll(reason);
      logInfo("optimization", { event: "cancel", reason });
    },
  };
  return controller;
}

async function recordAutomaticOutcome(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  snapshot: AutomaticSnapshot,
  outcome: BackgroundJobOutcome,
): Promise<void> {
  if (outcome !== "failed" && outcome !== "committed") return;
  const release = await runtime.acquireLock(snapshot.sessionId);
  try {
    const { state } = await runtime.stateFor(ctx);
    const automaticCooldowns = { ...state.policyState.automaticCooldowns };
    if (outcome === "committed") delete automaticCooldowns[snapshot.candidateKey];
    else {
      const previous = automaticCooldowns[snapshot.candidateKey];
      const next = nextAutomaticCooldown(previous, Date.now(), snapshot.planSourceHash, snapshot.policyRevision);
      const { failures, circuitOpen, warned } = next;
      automaticCooldowns[snapshot.candidateKey] = next;
      if (circuitOpen && previous?.warned !== true) {
        const warning = `ACP automatic Tier-${snapshot.tier} distillation paused for this unchanged candidate after ${failures} failures. It will retry after source or policy changes.`;
        logWarn("optimization", { event: "circuit-open", candidateKey: snapshot.candidateKey, failures });
        if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      }
    }
    await runtime.save({
      ...state,
      metadataRevision: state.metadataRevision + 1,
      policyState: { ...state.policyState, automaticCooldowns },
    }, ctx);
  } catch (error) {
    logWarn("optimization", { event: "cooldown-state-failed", error: error instanceof Error ? error.message : String(error) });
  } finally {
    release();
  }
}

export function nextAutomaticCooldown(
  previous: CompressionState["policyState"]["automaticCooldowns"][string] | undefined,
  now: number,
  sourceHash: string,
  policyRevision: string,
): CompressionState["policyState"]["automaticCooldowns"][string] {
  const failures = (previous?.failures ?? 0) + 1;
  const circuitOpen = failures >= 3;
  return {
    failures,
    nextRetryAt: now + Math.min(5 * 60_000, 5_000 * (2 ** Math.min(6, failures - 1))),
    circuitOpen,
    warned: previous?.warned === true || circuitOpen,
    sourceHash,
    policyRevision,
  };
}

export function wireAutomaticCompaction(pi: ExtensionAPI, runtime: AcpRuntime): AutomaticCompactionController {
  const controller = createAutomaticCompaction(runtime);
  pi.on("turn_end", (event, ctx) => {
    if (runtime.adapter.optimization?.telemetry === true && event.message.role === "assistant") {
      controller.telemetry.recordUsage("main", event.message.usage);
    }
    // Generate only after agent_end, when the agent is idle. Scheduling here
    // and at agent_end can start the same expensive provider work twice.
  });
  pi.on("agent_end", (_event, ctx) => controller.schedule("agent_end", ctx));
  pi.on("session_before_tree", () => controller.cancel("tree"));
  pi.on("session_tree", () => controller.cancel("tree"));
  pi.on("model_select", () => controller.cancel("model"));
  pi.on("session_before_switch", () => controller.cancel("session"));
  pi.on("session_before_fork", () => controller.cancel("session"));
  pi.on("session_start", () => controller.cancel("session"));
  pi.on("session_shutdown", () => controller.cancel("shutdown"));
  return controller;
}

async function captureSnapshot(runtime: AcpRuntime, ctx: ExtensionContext, signal: AbortSignal): Promise<AutomaticSnapshot | undefined> {
  if (signal.aborted) return undefined;
  const sid = ctx.sessionManager.getSessionId();
  const release = await runtime.acquireLock(sid);
  try {
    const { state, coreMessages } = await runtime.stateFor(ctx);
    const minimumBlocks = Math.max(2, runtime.adapter.optimization?.minimumBlocks ?? 3);
    const minimumTokens = Math.max(1, runtime.adapter.optimization?.minimumSourceTokens ?? 12_000);
    const recentCount = Math.max(1, runtime.adapter.preserveRecentMessages ?? 5);
    const recentMessageIds = new Set(coreMessages.slice(-recentCount).map((message) => message.id));
    const candidate = selectCandidate(state, minimumBlocks, minimumTokens, recentMessageIds, runtime);
    if (!candidate) return undefined;
    const range = { startRef: candidate.blocks[0]!.blockId, endRef: candidate.blocks.at(-1)!.blockId };
    const planned = runtime.core.planCompression({
      ranges: [range],
      messages: coreMessages,
      state,
      config: runtime.configFor(ctx),
    });
    const planRange = planned.plan?.ranges[0];
    if (!planned.plan || !planRange || planRange.outputTier !== candidate.tier) return undefined;
    const plannedBlocks = planRange.sourceBlockIds.flatMap((blockId) => {
      const block = state.blocks.find((item) => item.blockId === blockId && item.active);
      return block ? [block] : [];
    });
    if (plannedBlocks.length !== planRange.sourceBlockIds.length) return undefined;
    const sourceHashes = Object.fromEntries(plannedBlocks.map((block) => [block.blockId, blockDigest(block)]));
    const source = serializeAutomaticSource(plannedBlocks, planRange.sourceMessageIds, coreMessages, state);
    const policyRevision = compressionPolicyRevision(runtime);
    const writer = compressorModeForTier(runtime.adapter, candidate.tier);
    const candidateKey = sha256(`${writer}:${candidate.tier}:${planned.plan.sourceHash}:${policyRevision}`);
    const cooldown = state.policyState.automaticCooldowns[candidateKey];
    if (cooldown && cooldown.sourceHash === planned.plan.sourceHash && cooldown.policyRevision === policyRevision
      && (cooldown.circuitOpen || cooldown.nextRetryAt > Date.now())) return undefined;
    if (writer === "configured") {
      const configuredRef = parseCompressionModel(runtime.adapter.compress?.model);
      const configured = configuredRef ? ctx.modelRegistry.find(configuredRef.provider, configuredRef.id) : undefined;
      if (!authenticated(ctx, configured)) return undefined;
      try {
        ensureCompactionTransferAllowed({
          activeProvider: ctx.model?.provider,
          configuredProvider: configured!.provider,
          allowCrossProvider: runtime.adapter.compress?.allowCrossProvider === true,
          acknowledgeCrossProviderDataTransfer: runtime.adapter.compress?.acknowledgeCrossProviderDataTransfer === true,
        });
      } catch (error) {
        logWarn("optimization", { event: "preflight-transfer-denied", candidateKey, error: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    }
    const messageById = new Map(coreMessages.map((message) => [message.id, message]));
    const rawManifest = extractCompressionManifest(
      planRange.sourceMessageIds.flatMap((id) => {
        const message = messageById.get(id);
        return message ? [message] : [];
      }),
      state.messageRefs.byRaw,
    );
    return {
      sessionId: sid,
      revision: state.graphRevision,
      sourceHashes,
      treeKey: planned.plan.sourceHash,
      modelKey: automaticWriterKey(runtime, ctx),
      tier: candidate.tier,
      sourceTier: candidate.sourceTier,
      sourceBlockIds: plannedBlocks.map((block) => block.blockId),
      startRef: range.startRef,
      endRef: range.endRef,
      planSourceHash: planned.plan.sourceHash,
      sourceTokens: planRange.sourceTokens,
      source,
      candidateKey,
      policyRevision,
      manifest: mergeCompressionManifests([
        rawManifest,
        ...plannedBlocks.flatMap((block) => block.manifest ? [block.manifest] : []),
      ], planRange.sourceHash, candidate.tier),
    };
  } finally {
    release();
  }
}

async function currentSnapshot(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  expected: AutomaticSnapshot,
  signal: AbortSignal,
): Promise<AutomaticSnapshot | undefined> {
  if (signal.aborted) return undefined;
  const sid = ctx.sessionManager.getSessionId();
  const release = await runtime.acquireLock(sid);
  try {
    const { state } = await runtime.stateFor(ctx);
    const sourceHashes: Record<string, string> = {};
    for (const blockId of expected.sourceBlockIds) {
      const block = state.blocks.find((item) => item.blockId === blockId && item.active);
      if (!block) return undefined;
      sourceHashes[blockId] = blockDigest(block);
    }
    return {
      ...expected,
      sessionId: sid,
      revision: state.graphRevision,
      sourceHashes,
      treeKey: expected.treeKey,
      modelKey: automaticWriterKey(runtime, ctx),
    };
  } finally {
    release();
  }
}

async function generateProposal(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  snapshot: AutomaticSnapshot,
  signal: AbortSignal,
  telemetry: OptimizationTelemetry,
  quality: QualityAdapter,
): Promise<AutomaticProposal> {
  const configuredRef = parseCompressionModel(runtime.adapter.compress?.model);
  const configured = configuredRef ? ctx.modelRegistry.find(configuredRef.provider, configuredRef.id) : undefined;
  const main = ctx.model;
  const route = routeCompaction({
    explicit: "configured",
    costAware: runtime.adapter.optimization?.costAwareRouting === true,
    configuredAvailable: authenticated(ctx, configured),
    mainAvailable: authenticated(ctx, main),
  }, telemetry);
  let selected = route === "configured" ? configured : main;
  if (!selected) throw new Error(`No authenticated ${route} model is available for automatic Tier-${snapshot.tier} compaction.`);
  const selectedKey = `${selected.provider}/${selected.id}`;
  const decision = quality.decide(selectedKey, snapshot.tier, compressionThinkingLevel(runtime.adapter, snapshot.tier), {
    enabled: runtime.adapter.optimization?.qualityAdaptation === true,
    fallbackAfterFailures: runtime.adapter.optimization?.fallbackAfterFailures ?? 2,
    maxThinking: runtime.adapter.optimization?.maxAdaptiveThinking ?? "high",
  });
  let actualRoute = route;
  if (decision.fallback && route === "configured" && authenticated(ctx, main)) {
    selected = main;
    actualRoute = "main";
  }
  if (actualRoute === "configured") {
    ensureCompactionTransferAllowed({
      activeProvider: main?.provider,
      configuredProvider: selected.provider,
      allowCrossProvider: runtime.adapter.compress?.allowCrossProvider === true,
      acknowledgeCrossProviderDataTransfer: runtime.adapter.compress?.acknowledgeCrossProviderDataTransfer === true,
    });
  }
  const started = Date.now();
  const initialTransfer = route === "configured"
    ? redactCompactionTransfer(snapshot.source, runtime.adapter.compress?.secretPatterns)
    : undefined;
  try {
    const callBudget = new CompressionCallBudget(runtime.adapter.compress);
    const runModel = (model: CompressionModel, routeForCall: OptimizationRoute, rawSource: string) => {
      const source = routeForCall === "configured" ? redactCompactionTransfer(rawSource, runtime.adapter.compress?.secretPatterns).source : rawSource;
      return compressWithModel({
        ctx,
        model,
        thinkingLevel: decision.thinking,
        tier: snapshot.tier,
        source,
        prompts: runtime.prompts,
        summaryMaxChars: 20_000,
        signal,
        beforeCall: (inputTokens, outputTokens) => callBudget.reserveEstimated(inputTokens, outputTokens),
      });
    };
    let accumulatedUsage: CompressionUsage | undefined;
    const paidCall = async (model: CompressionModel, routeForCall: OptimizationRoute, source: string) => {
      try {
        const result = await runModel(model, routeForCall, source);
        accumulatedUsage = mergeCompressionUsage(accumulatedUsage, result.usage);
        callBudget.observe(accumulatedUsage);
        return result;
      } catch (error) {
        accumulatedUsage = mergeCompressionUsage(accumulatedUsage, compressionErrorUsage(error));
        callBudget.observe(accumulatedUsage);
        throw error;
      }
    };
    let attempts = 1;
    let result;
    try {
      result = await paidCall(selected, actualRoute, snapshot.source);
    } catch (error) {
      if (signal.aborted || actualRoute !== "configured" || !authenticated(ctx, main)) throw error;
      selected = main!;
      actualRoute = "main";
      attempts += 1;
      result = await paidCall(selected, actualRoute, snapshot.source);
    }
    let validation: ReturnType<typeof validateAndRepairSummary> | undefined;
    let validationFailure: unknown;
    try {
      validation = validateAndRepairSummary({
        summary: result.summary,
        manifest: snapshot.manifest,
        sourceTokens: snapshot.sourceTokens,
        tier: snapshot.tier,
        summaryMaxChars: 20_000,
      });
    } catch (error) {
      validationFailure = error;
    }
    if (!validation) {
      const repairSource = [
        `[Validation repair request] The prior output failed: ${validationFailure instanceof Error ? validationFailure.message : String(validationFailure)}`,
        `[Prior summary]\n${result.summary}`,
        `[Authoritative source]\n${snapshot.source}`,
      ].join("\n\n");
      attempts += 1;
      try {
        result = await paidCall(selected, actualRoute, repairSource);
      } catch (error) {
        if (signal.aborted || actualRoute !== "configured" || !authenticated(ctx, main)) throw error;
        selected = main!;
        actualRoute = "main";
        attempts += 1;
        result = await paidCall(selected, actualRoute, snapshot.source);
      }
      try {
        validation = validateAndRepairSummary({
          summary: result.summary,
          manifest: snapshot.manifest,
          sourceTokens: snapshot.sourceTokens,
          tier: snapshot.tier,
          summaryMaxChars: 20_000,
        });
      } catch (error) {
        validationFailure = error;
      }
    }
    if (!validation && actualRoute === "configured" && authenticated(ctx, main)) {
      selected = main!;
      actualRoute = "main";
      attempts += 1;
      result = await paidCall(selected, actualRoute, snapshot.source);
      validation = validateAndRepairSummary({
        summary: result.summary,
        manifest: snapshot.manifest,
        sourceTokens: snapshot.sourceTokens,
        tier: snapshot.tier,
        summaryMaxChars: 20_000,
      });
    }
    if (!validation) throw validationFailure instanceof Error ? validationFailure : new Error(String(validationFailure));
    result = { ...result, usage: accumulatedUsage ?? result.usage };
    if (runtime.adapter.optimization?.telemetry === true) telemetry.recordUsage(actualRoute, result.usage);
    const outcome = validation.status === "repaired" ? "repaired" : "passed";
    quality.record(`${selected.provider}/${selected.id}`, snapshot.tier, outcome);
    const structuredSummary = structuredSummaryFromRendered(validation.renderedSummary, snapshot.manifest, [], snapshot.tier);
    return {
      summary: renderAuthoritativeSummary(structuredSummary),
      structuredSummary,
      quality: {
        status: validation.status,
        missingRequiredFacts: validation.missingRequiredFacts,
        compressionRatio: validation.compressionRatio,
        attempts,
      },
      provenance: {
        requestedRoute: route,
        actualWriter: actualRoute,
        fallbackReason: actualRoute !== route ? `Automatic ${route} writer fell back to ${actualRoute}.` : undefined,
        policyRevision: snapshot.policyRevision,
        rawSourceHash: initialTransfer?.rawSourceHash ?? sha256(snapshot.source),
        transferSourceHash: initialTransfer?.transferSourceHash,
        redactionManifestHash: initialTransfer?.redactionManifestHash,
        redactionPolicyVersion: initialTransfer?.redactionPolicyVersion,
        nonAuthoritativeCommentary: validation.renderedSummary,
        execution: actualRoute === "configured" ? "isolated-configured" : "isolated-main",
        provider: selected.provider,
        model: selected.id,
        thinking: result.thinking,
        promptVersion: "hybrid-acp-v2-auto",
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cachedInputTokens: result.usage.cacheRead,
        durationMs: Date.now() - started,
      },
      usage: result.usage,
      route: actualRoute,
      modelKey: `${selected.provider}/${selected.id}`,
      generatedAt: Date.now(),
    };
  } catch (error) {
    quality.record(`${selected.provider}/${selected.id}`, snapshot.tier, "failed");
    throw error;
  }
}

async function commitProposal(
  runtime: AcpRuntime,
  ctx: ExtensionContext,
  snapshot: AutomaticSnapshot,
  proposal: AutomaticProposal,
  signal: AbortSignal,
  telemetry: OptimizationTelemetry,
): Promise<boolean> {
  if (signal.aborted) return false;
  const sid = ctx.sessionManager.getSessionId();
  const release = await runtime.acquireLock(sid);
  try {
    if (signal.aborted) return false;
    const { state, coreMessages } = await runtime.stateFor(ctx);
    const liveSourceHashes: Record<string, string> = {};
    for (const blockId of snapshot.sourceBlockIds) {
      const block = state.blocks.find((item) => item.blockId === blockId && item.active);
      if (block) liveSourceHashes[blockId] = blockDigest(block);
    }
    const live: AutomaticSnapshot = {
      ...snapshot,
      sessionId: sid,
      revision: state.graphRevision,
      sourceHashes: liveSourceHashes,
      treeKey: snapshot.treeKey,
      modelKey: automaticWriterKey(runtime, ctx),
    };
    if (!sameSnapshot(snapshot, live) || Object.keys(live.sourceHashes).length !== snapshot.sourceBlockIds.length) return false;
    const replanned = runtime.core.planCompression({
      ranges: [{ startRef: snapshot.startRef, endRef: snapshot.endRef }],
      messages: coreMessages,
      state,
      config: runtime.configFor(ctx),
    });
    if (!replanned.plan || replanned.plan.sourceHash !== snapshot.planSourceHash) return false;
    const config = runtime.configFor(ctx);
    const beforeTurn = runtime.core.processTurn({ messages: coreMessages, state: structuredClone(state), config, tokenCount: snapshot.sourceTokens });
    const beforeTokens = estimateTokens(beforeTurn.messages, collectCoveredMessageIds(beforeTurn.state));
    const applied = runtime.core.applyCompression({
      ranges: [{ startRef: snapshot.startRef, endRef: snapshot.endRef, summary: proposal.summary }],
      messages: coreMessages,
      state,
      config,
      expectedRevision: state.revision,
      expectedSourceHash: snapshot.planSourceHash,
      atomic: true,
    });
    if (applied.result.blocksCreated !== 1 || applied.result.errors.length > 0) return false;
    const block = applied.state.blocks.at(-1)!;
    block.summary = proposal.summary;
    block.renderedSummary = proposal.summary;
    block.structuredSummary = proposal.structuredSummary;
    block.manifest = snapshot.manifest;
    block.sourceHash = snapshot.planSourceHash;
    block.summaryHash = sha256(proposal.summary);
    block.provenance = proposal.provenance;
    block.quality = proposal.quality;
    const afterTurn = runtime.core.processTurn({ messages: coreMessages, state: structuredClone(applied.state), config, tokenCount: beforeTokens });
    const afterTokens = estimateTokens(afterTurn.messages, collectCoveredMessageIds(afterTurn.state));
    const netSavings = Math.max(0, beforeTokens - afterTokens);
    applied.state.stats.netTokensReclaimed = (applied.state.stats.netTokensReclaimed ?? 0) + netSavings;
    if (signal.aborted) return false;
    await runtime.save(applied.state, ctx);
    if (runtime.adapter.optimization?.telemetry === true) {
      telemetry.recordMutation({ savingsTokens: netSavings, latencyMs: Math.max(0, Date.now() - proposal.generatedAt) });
    }
    logInfo("optimization", { event: "committed", sid, tier: snapshot.tier, blockId: block.blockId, netSavingsTokens: netSavings, grossSourceTokens: applied.result.tokensCompressed });
    return true;
  } catch (error) {
    logWarn("optimization", { event: "commit-failed", sid, error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    release();
  }
}

function selectCandidate(
  state: CompressionState,
  minimumBlocks: number,
  minimumTokens: number,
  recentMessageIds: ReadonlySet<string>,
  runtime: AcpRuntime,
): { tier: 2 | 3; sourceTier: 1 | 2; blocks: CompressionBlock[] } | undefined {
  const pinnedBlockIds = new Set(state.pins.flatMap((pin) => {
    const direct = state.blocks.find((block) => block.blockId === pin.ref);
    if (direct) return [direct.blockId];
    const raw = state.messageRefs.byRef[pin.ref];
    return state.blocks.filter((block) => raw && block.effectiveMessageIds.includes(raw)).map((block) => block.blockId);
  }));
  for (const tier of [2, 3] as const) {
    if (compressorModeForTier(runtime.adapter, tier) !== "configured") continue;
    const sourceTier = (tier - 1) as 1 | 2;
    const minimumSurvivalTurns = Math.max(1, runtime.adapter.optimization?.minimumSurvivalTurns ?? 3);
    const ordered = state.blocks.filter((block) => block.active).sort((left, right) => left.createdAt - right.createdAt || left.blockId.localeCompare(right.blockId));
    let run: CompressionBlock[] = [];
    for (const block of ordered) {
      const ineligible = block.tier !== sourceTier
        || block.epoch !== state.currentEpoch
        || block.generation !== "old"
        || block.survivedCount < minimumSurvivalTurns
        || pinnedBlockIds.has(block.blockId)
        || wasRecentlyRetrieved(state.policyState.recentRetrievals[block.blockId])
        || block.effectiveMessageIds.some((id) => recentMessageIds.has(id));
      if (ineligible) {
        run = [];
        continue;
      }
      run.push(block);
      const tokens = run.reduce((sum, item) => sum + Math.max(1, Math.ceil(item.summary.length / 4)), 0);
      if (run.length >= minimumBlocks && tokens >= minimumTokens) return { tier, sourceTier, blocks: run };
    }
  }
  return undefined;
}

function serializeBlock(block: CompressionBlock): string {
  const summaryTokens = Math.max(1, Math.ceil(block.summary.length / 4));
  const ratio = Math.max(1, Math.round(block.compressedTokens / summaryTokens));
  const topic = block.topic ? ` [${block.topic}]` : "";
  return `Source: ${block.blockId} (${block.compressedTokens}→${summaryTokens} tok, ${ratio}x).${topic}\n${block.summary}`;
}

function serializeAutomaticSource(
  blocks: CompressionBlock[],
  rawMessageIds: string[],
  messages: CoreMessage[],
  state: CompressionState,
): string {
  const indexById = new Map(messages.map((message, index) => [message.id, index]));
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const parts: Array<{ index: number; text: string }> = blocks.map((block) => ({
    index: Math.min(...block.effectiveMessageIds.map((id) => indexById.get(id) ?? Number.MAX_SAFE_INTEGER)),
    text: serializeBlock(block),
  }));
  for (const id of rawMessageIds) {
    const message = messageById.get(id);
    if (!message) continue;
    const ref = state.messageRefs.byRaw[id] ?? id;
    const tool = message.toolName ? ` ${message.toolName}` : "";
    parts.push({
      index: indexById.get(id) ?? Number.MAX_SAFE_INTEGER,
      text: `[${ref}] ${message.role}/${message.contentType}${tool}\n${message.text ?? ""}`,
    });
  }
  return parts.sort((left, right) => left.index - right.index).map((part) => part.text).join("\n\n");
}

function blockDigest(block: CompressionBlock): string {
  return sha256(JSON.stringify({
    blockId: block.blockId,
    active: block.active,
    tier: block.tier,
    sourceHash: block.sourceHash,
    summaryHash: block.summaryHash,
    summary: block.summary,
  }));
}

function mergeCompressionUsage(left: CompressionUsage | undefined, right: CompressionUsage | undefined): CompressionUsage | undefined {
  if (!left) return right;
  if (!right) return left;
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

function activeModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function automaticWriterKey(runtime: AcpRuntime, ctx: ExtensionContext): string {
  const configuredRef = parseCompressionModel(runtime.adapter.compress?.model);
  const configured = configuredRef ? ctx.modelRegistry.find(configuredRef.provider, configuredRef.id) : undefined;
  return authenticated(ctx, configured) ? `${configured.provider}/${configured.id}` : activeModelKey(ctx);
}

function authenticated(ctx: ExtensionContext, model: CompressionModel | undefined): model is CompressionModel {
  return Boolean(model && ctx.modelRegistry.hasConfiguredAuth(model));
}
