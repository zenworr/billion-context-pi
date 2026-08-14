import type {
  EvaluationMetrics,
  ReplayAssertion,
  ReplayCaseResult,
  ReplayEvent,
  ReplayFixture,
} from "./types.js";

interface Proposal {
  revision: number;
  sourceHash: string;
  provider: string;
  branch: string;
}

interface Totals {
  activeInputs: number[];
  turns: number;
  mutations: number;
  cacheBeforeTotal: number;
  cacheAfterTotal: number;
  cacheSamples: number;
  constraintsRetained: number;
  constraintsTotal: number;
  exactFactsRetained: number;
  exactFactsTotal: number;
  unresolvedRetained: number;
  unresolvedTotal: number;
  contradictions: number;
  summaries: number;
  retrievalSuccesses: number;
  retrievalAttempts: number;
  continuationSuccesses: number;
  continuationAttempts: number;
  testsCompleted: number;
  testsAttempted: number;
}

interface ReplayState {
  revision: number;
  branch: string;
  provider: string;
  epoch: number;
  effectiveTokens: number;
  proposals: Map<string, Proposal>;
  completedDelegates: Set<string>;
  configuredChunks: Map<string, { count: number; indexes: Set<number> }>;
  oversizedConfiguredCommits: number;
  validCommits: number;
  successfulWrites: number;
  failures: string[];
  totals: Totals;
  metrics: EvaluationMetrics;
}

export function replayFixture(fixture: ReplayFixture): ReplayCaseResult {
  const state = createState(fixture);
  for (const event of fixture.events) applyEvent(fixture, state, event);
  finalizeState(state);
  state.metrics.context.activeInputP50 = percentile(state.totals.activeInputs, 0.5);
  state.metrics.context.activeInputP90 = percentile(state.totals.activeInputs, 0.9);
  state.metrics.context.activeInputP95 = percentile(state.totals.activeInputs, 0.95);
  state.metrics.context.mutationsPer100Turns = ratio(state.totals.mutations * 100, state.totals.turns);
  state.metrics.context.cacheHitBefore = ratio(state.totals.cacheBeforeTotal, state.totals.cacheSamples);
  state.metrics.context.cacheHitAfter = ratio(state.totals.cacheAfterTotal, state.totals.cacheSamples);
  state.metrics.quality.exactUserConstraintRetention = ratio(state.totals.constraintsRetained, state.totals.constraintsTotal);
  state.metrics.quality.exactFactRetention = ratio(state.totals.exactFactsRetained, state.totals.exactFactsTotal);
  state.metrics.quality.unresolvedWorkRetention = ratio(state.totals.unresolvedRetained, state.totals.unresolvedTotal);
  state.metrics.quality.contradictionRate = ratio(state.totals.contradictions, state.totals.summaries);
  state.metrics.quality.retrievalSuccessRate = ratio(state.totals.retrievalSuccesses, state.totals.retrievalAttempts);
  state.metrics.quality.continuationSuccessRate = ratio(state.totals.continuationSuccesses, state.totals.continuationAttempts);
  state.metrics.quality.testCompletionRate = ratio(state.totals.testsCompleted, state.totals.testsAttempted);

  const snapshot = snapshotForAssertions(state);
  for (const assertion of fixture.assertions) checkAssertion(state, snapshot, assertion);
  state.metrics.reliability.invariantFailures = state.failures.length;
  return {
    id: fixture.id,
    mode: fixture.mode,
    passed: state.failures.length === 0,
    failures: state.failures,
    metrics: state.metrics,
  };
}

function createState(fixture: ReplayFixture): ReplayState {
  return {
    revision: fixture.initial.revision,
    branch: fixture.initial.branch,
    provider: fixture.initial.provider,
    epoch: 0,
    effectiveTokens: 0,
    proposals: new Map(),
    completedDelegates: new Set(),
    configuredChunks: new Map(),
    oversizedConfiguredCommits: 0,
    validCommits: 0,
    successfulWrites: 0,
    failures: [],
    totals: {
      activeInputs: [], turns: 0, mutations: 0, cacheBeforeTotal: 0, cacheAfterTotal: 0, cacheSamples: 0,
      constraintsRetained: 0, constraintsTotal: 0, exactFactsRetained: 0, exactFactsTotal: 0,
      unresolvedRetained: 0, unresolvedTotal: 0, contradictions: 0, summaries: 0,
      retrievalSuccesses: 0, retrievalAttempts: 0, continuationSuccesses: 0, continuationAttempts: 0,
      testsCompleted: 0, testsAttempted: 0,
    },
    metrics: emptyMetrics(),
  };
}

function applyEvent(fixture: ReplayFixture, state: ReplayState, event: ReplayEvent): void {
  const context = state.metrics.context;
  const cost = state.metrics.cost;
  const reliability = state.metrics.reliability;
  switch (event.type) {
    case "turn":
      state.totals.turns++;
      state.totals.activeInputs.push(event.activeInputTokens);
      context.cachedInputTokens += event.cachedInputTokens;
      context.uncachedInputTokens += event.uncachedInputTokens;
      return;
    case "usage":
      state.effectiveTokens = Math.max(event.providerReported, event.locallyCompiled, event.piEstimate, event.pendingPrompt);
      return;
    case "host-compaction": {
      const safe = event.reason === "threshold"
        && event.changed
        && event.projectedTokens <= fixture.initial.safeThreshold
        && state.effectiveTokens <= fixture.initial.contextWindow
        && state.effectiveTokens - event.projectedTokens >= event.minimumSavings;
      if (event.cancel !== safe) fail(state, `host compaction decision was ${event.cancel}; expected ${safe}`);
      if (event.cancel) reliability.hostCompactionCanceled++;
      else reliability.hostCheckpointAllowed++;
      if (event.reason === "overflow" || event.reason === "threshold") context.emergencyCheckpointFrequency++;
      return;
    }
    case "mutation":
      state.totals.mutations++;
      context.tokensReclaimed += event.reclaimedTokens;
      state.totals.cacheBeforeTotal += event.cacheHitBefore;
      state.totals.cacheAfterTotal += event.cacheHitAfter;
      state.totals.cacheSamples++;
      return;
    case "compactor": {
      cost.compactionLatencyMs += event.latencyMs;
      if (event.route === "main") cost.mainCompactionOutputTokens += event.outputTokens;
      else {
        cost.configuredInputTokens += event.inputTokens;
        cost.configuredOutputTokens += event.outputTokens;
      }
      const valid = event.outcome === "valid";
      if (!valid && event.commit) fail(state, `${event.outcome} compactor result committed`);
      if ((event.outcome === "malformed" || event.outcome === "empty") && !event.commit) reliability.malformedOutputsRejected++;
      if ((event.outcome === "timeout" || event.outcome === "abort") && !event.commit) reliability.timeoutAbortCommitsPrevented++;
      if (valid && event.commit && fixture.mode === "shadow") fail(state, "shadow compaction committed a candidate");
      if (valid && event.commit) {
        state.validCommits++;
        if (event.route === "configured" && event.inputTokens > 220_000) state.oversizedConfiguredCommits++;
      }
      return;
    }
    case "state-write":
      if (event.revisionBefore !== state.revision) fail(state, `state write started at revision ${event.revisionBefore}, current ${state.revision}`);
      if (!event.success) {
        if (event.revisionAfter !== event.revisionBefore || event.successReported) fail(state, "failed state write changed revision or reported success");
        else reliability.stateWriteFailuresRolledBack++;
      } else {
        if (event.revisionAfter <= event.revisionBefore || !event.successReported) fail(state, "successful state write did not advance revision");
        state.revision = event.revisionAfter;
        state.successfulWrites++;
      }
      return;
    case "proposal-start":
      state.proposals.set(event.id, { revision: event.revision, sourceHash: event.sourceHash, provider: event.provider, branch: event.branch });
      return;
    case "proposal-complete": {
      const proposal = state.proposals.get(event.id);
      const fresh = proposal !== undefined
        && proposal.revision === state.revision
        && event.revision === state.revision
        && proposal.sourceHash === event.sourceHash
        && proposal.provider === state.provider
        && event.provider === state.provider
        && proposal.branch === state.branch
        && event.branch === state.branch;
      if (event.commit !== fresh) fail(state, `proposal ${event.id} commit was ${event.commit}; freshness was ${fresh}`);
      if (!fresh && !event.commit) reliability.staleProposalsRejected++;
      state.proposals.delete(event.id);
      return;
    }
    case "branch-switch":
      state.branch = event.branch;
      state.revision = event.revision;
      return;
    case "provider-switch":
      state.provider = event.provider;
      state.revision = event.revision;
      reliability.providerSwitchesHandled++;
      return;
    case "configured-chunk": {
      reliability.maxConfiguredChunkTokens = Math.max(reliability.maxConfiguredChunkTokens, event.inputTokens);
      if (event.inputTokens > 220_000) fail(state, `configured chunk ${event.job}:${event.index}/${event.count} used ${event.inputTokens} tokens`);
      const group = state.configuredChunks.get(event.job) ?? { count: event.count, indexes: new Set<number>() };
      if (group.count !== event.count || event.index < 1 || event.index > event.count || group.indexes.has(event.index)) fail(state, `configured chunk sequence ${event.job} is invalid`);
      group.indexes.add(event.index);
      state.configuredChunks.set(event.job, group);
      return;
    }
    case "protocol-range": {
      const overlaps = event.compressedStart <= event.unitEnd && event.unitStart <= event.compressedEnd;
      const containsUnit = event.compressedStart <= event.unitStart && event.unitEnd <= event.compressedEnd;
      if (overlaps && !containsUnit) {
        reliability.protocolPairViolations++;
        fail(state, `${event.protocol} unit ${event.unitId} was split at a range boundary`);
      }
      return;
    }
    case "sidecar":
      if (!event.canonicalHistoryVisible) fail(state, `${event.status} sidecar hid canonical history`);
      if (event.status === "corrupt" && event.action !== "quarantine-rebuild") fail(state, "corrupt sidecar was not quarantined and rebuilt");
      if (event.status === "missing" && event.action !== "rebuild") fail(state, "missing sidecar was not rebuilt");
      if (event.status !== "valid") reliability.sidecarRecoveries++;
      return;
    case "checkpoint":
      if (event.epochBefore !== state.epoch || event.epochAfter !== event.epochBefore + 1) fail(state, `checkpoint ${event.id} has a non-monotonic epoch`);
      if (!event.priorBlocksInactive || !event.canonicalHistoryVisible) fail(state, `checkpoint ${event.id} violated epoch or canonical-history safety`);
      state.epoch = event.epochAfter;
      reliability.checkpoints++;
      return;
    case "delegate-completion":
      if (!event.batch) fail(state, `delegate completion ${event.delegateId} has no concurrency batch`);
      if (!event.retained || state.completedDelegates.has(event.delegateId)) fail(state, `delegate completion ${event.delegateId} was lost or duplicated`);
      else {
        state.completedDelegates.add(event.delegateId);
        reliability.delegateCompletionsRetained++;
      }
      return;
    case "extension-context-mutation":
      if (event.beforeHash === event.mutatedHash || event.compiledHash !== event.mutatedHash || event.recompiles < 1) fail(state, "later extension context mutation was not recompiled");
      else reliability.extensionMutationsRecompiled++;
      return;
    case "shadow-proposal":
      if (event.committed) fail(state, `shadow candidate ${event.candidateId} replaced ${event.authoritativeBlockId}`);
      else reliability.shadowCommitsPrevented++;
      state.totals.constraintsRetained += event.retainedConstraints;
      state.totals.constraintsTotal += event.totalConstraints;
      return;
    case "quality":
      if (!validCount(event.constraintsRetained, event.constraintsTotal) || !validCount(event.exactFactsRetained, event.exactFactsTotal) || !validCount(event.unresolvedRetained, event.unresolvedTotal) || event.contradictions < 0 || event.summaries < 0) fail(state, "quality event contains invalid counts");
      state.totals.constraintsRetained += event.constraintsRetained;
      state.totals.constraintsTotal += event.constraintsTotal;
      state.totals.exactFactsRetained += event.exactFactsRetained;
      state.totals.exactFactsTotal += event.exactFactsTotal;
      state.totals.unresolvedRetained += event.unresolvedRetained;
      state.totals.unresolvedTotal += event.unresolvedTotal;
      state.totals.contradictions += event.contradictions;
      state.totals.summaries += event.summaries;
      state.totals.retrievalSuccesses += event.retrievalSuccesses;
      state.totals.retrievalAttempts += event.retrievalAttempts;
      state.totals.continuationSuccesses += event.continuationSuccesses;
      state.totals.continuationAttempts += event.continuationAttempts;
      state.totals.testsCompleted += event.testsCompleted;
      state.totals.testsAttempted += event.testsAttempted;
      state.metrics.quality.repeatedRetrievalCount += event.repeatedRetrievals;
      state.metrics.quality.falseConfidenceCount += event.falseConfidence;
      return;
    case "quality-content": {
      const retainedConstraints = retained(event.summary, event.userConstraints);
      const retainedFacts = retained(event.summary, event.exactFacts);
      const retainedWork = retained(event.summary, event.unresolvedWork);
      const contradictions = retained(event.summary, event.forbiddenClaims);
      state.totals.constraintsRetained += retainedConstraints;
      state.totals.constraintsTotal += event.userConstraints.length;
      state.totals.exactFactsRetained += retainedFacts;
      state.totals.exactFactsTotal += event.exactFacts.length;
      state.totals.unresolvedRetained += retainedWork;
      state.totals.unresolvedTotal += event.unresolvedWork.length;
      state.totals.contradictions += contradictions;
      state.totals.summaries++;
      state.totals.retrievalSuccesses += retained(event.summary, event.retrievalCues);
      state.totals.retrievalAttempts += event.retrievalCues.length;
      state.totals.continuationSuccesses += event.continuationPass ? 1 : 0;
      state.totals.continuationAttempts++;
      state.totals.testsCompleted += event.testsPass ? 1 : 0;
      state.totals.testsAttempted++;
      if (retainedConstraints !== event.userConstraints.length || retainedWork !== event.unresolvedWork.length || contradictions > 0 || !event.continuationPass || !event.testsPass) fail(state, "content-based quality invariant failed");
      return;
    }
    case "baseline":
      return;
    default:
      throw new Error(`Unknown replay event: ${JSON.stringify(event)}`);
  }
}

function finalizeState(state: ReplayState): void {
  for (const [job, group] of state.configuredChunks) {
    if (group.indexes.size !== group.count) fail(state, `configured chunk sequence ${job} is incomplete (${group.indexes.size}/${group.count})`);
  }
  if (state.oversizedConfiguredCommits > 0 && state.configuredChunks.size === 0) fail(state, "oversized configured compaction had no chunk trace");
  if (state.validCommits > state.successfulWrites) fail(state, `${state.validCommits - state.successfulWrites} valid commit(s) had no successful atomic state write`);
}

function validCount(retainedCount: number, totalCount: number): boolean {
  return Number.isInteger(retainedCount) && Number.isInteger(totalCount) && retainedCount >= 0 && retainedCount <= totalCount;
}

function retained(summary: string, values: string[]): number {
  return values.filter((value) => summary.includes(value)).length;
}

function snapshotForAssertions(state: ReplayState): Record<string, unknown> {
  return {
    revision: state.revision,
    branch: state.branch,
    provider: state.provider,
    epoch: state.epoch,
    completedDelegates: state.completedDelegates.size,
    context: state.metrics.context,
    cost: state.metrics.cost,
    quality: state.metrics.quality,
    reliability: state.metrics.reliability,
  };
}

function checkAssertion(state: ReplayState, snapshot: Record<string, unknown>, assertion: ReplayAssertion): void {
  const actual = getPath(snapshot, assertion.path);
  const matches = assertion.op === "eq"
    ? actual === assertion.value
    : typeof actual === "number" && typeof assertion.value === "number"
      ? assertion.op === "lte" ? actual <= assertion.value : actual >= assertion.value
      : false;
  if (!matches) fail(state, `assert ${assertion.path} ${assertion.op} ${String(assertion.value)}; got ${String(actual)}`);
}

function getPath(root: Record<string, unknown>, path: string): unknown {
  let value: unknown = root;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function fail(state: ReplayState, message: string): void {
  state.failures.push(message);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

export function emptyMetrics(): EvaluationMetrics {
  return {
    context: { activeInputP50: 0, activeInputP90: 0, activeInputP95: 0, cachedInputTokens: 0, uncachedInputTokens: 0, tokensReclaimed: 0, tokensReclaimedPerMutation: 0, mutationsPer100Turns: 0, cacheHitBefore: 0, cacheHitAfter: 0, emergencyCheckpointFrequency: 0 },
    cost: { mainCompactionOutputTokens: 0, configuredInputTokens: 0, configuredOutputTokens: 0, compactionLatencyMs: 0, compactionLatencyP50Ms: 0, compactionLatencyP95Ms: 0 },
    quality: { exactUserConstraintRetention: 0, exactFactRetention: 0, unresolvedWorkRetention: 0, contradictionRate: 0, retrievalSuccessRate: 0, continuationSuccessRate: 0, testCompletionRate: 0, repeatedRetrievalCount: 0, falseConfidenceCount: 0 },
    reliability: { invariantFailures: 0, malformedOutputsRejected: 0, timeoutAbortCommitsPrevented: 0, stateWriteFailuresRolledBack: 0, staleProposalsRejected: 0, providerSwitchesHandled: 0, maxConfiguredChunkTokens: 0, protocolPairViolations: 0, sidecarRecoveries: 0, checkpoints: 0, delegateCompletionsRetained: 0, extensionMutationsRecompiled: 0, hostCheckpointAllowed: 0, hostCompactionCanceled: 0, shadowCommitsPrevented: 0, networkRequests: 0 },
  };
}
