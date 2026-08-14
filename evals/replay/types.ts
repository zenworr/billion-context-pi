export type ReplayMode = "authoritative" | "shadow";

export interface ReplayFixture {
  schemaVersion: 1;
  id: string;
  description: string;
  mode: ReplayMode;
  initial: ReplayInitialState;
  events: ReplayEvent[];
  assertions: ReplayAssertion[];
}

export interface ReplayInitialState {
  contextWindow: number;
  safeThreshold: number;
  revision: number;
  branch: string;
  provider: string;
  canonicalMessages: number;
}

export type ReplayEvent =
  | { type: "turn"; activeInputTokens: number; cachedInputTokens: number; uncachedInputTokens: number; cacheHitRate: number }
  | { type: "usage"; providerReported: number; locallyCompiled: number; piEstimate: number; pendingPrompt: number }
  | { type: "host-compaction"; reason: "manual" | "threshold" | "overflow"; changed: boolean; projectedTokens: number; minimumSavings: number; cancel: boolean }
  | { type: "mutation"; reclaimedTokens: number; cacheHitBefore: number; cacheHitAfter: number }
  | { type: "compactor"; outcome: "valid" | "malformed" | "empty" | "timeout" | "abort"; route: "main" | "configured"; inputTokens: number; outputTokens: number; cachedInputTokens: number; latencyMs: number; commit: boolean }
  | { type: "state-write"; success: boolean; revisionBefore: number; revisionAfter: number; successReported: boolean }
  | { type: "proposal-start"; id: string; revision: number; sourceHash: string; provider: string; branch: string }
  | { type: "proposal-complete"; id: string; revision: number; sourceHash: string; provider: string; branch: string; commit: boolean }
  | { type: "branch-switch"; branch: string; revision: number }
  | { type: "provider-switch"; provider: string; revision: number }
  | { type: "configured-chunk"; job: string; index: number; count: number; inputTokens: number }
  | { type: "protocol-range"; protocol: "tool" | "reasoning"; unitId: string; unitStart: number; unitEnd: number; compressedStart: number; compressedEnd: number }
  | { type: "sidecar"; status: "valid" | "missing" | "corrupt"; action: "load" | "rebuild" | "quarantine-rebuild"; canonicalHistoryVisible: boolean }
  | { type: "checkpoint"; id: string; epochBefore: number; epochAfter: number; priorBlocksInactive: boolean; canonicalHistoryVisible: boolean }
  | { type: "delegate-completion"; delegateId: string; batch: string; retained: boolean }
  | { type: "extension-context-mutation"; beforeHash: string; mutatedHash: string; compiledHash: string; recompiles: number }
  | { type: "shadow-proposal"; candidateId: string; committed: boolean; authoritativeBlockId: string; retainedConstraints: number; totalConstraints: number }
  | { type: "quality"; constraintsRetained: number; constraintsTotal: number; exactFactsRetained: number; exactFactsTotal: number; unresolvedRetained: number; unresolvedTotal: number; contradictions: number; summaries: number; retrievalSuccesses: number; retrievalAttempts: number; continuationSuccesses: number; continuationAttempts: number; testsCompleted: number; testsAttempted: number; repeatedRetrievals: number; falseConfidence: number }
  | { type: "quality-content"; summary: string; userConstraints: string[]; exactFacts: string[]; unresolvedWork: string[]; forbiddenClaims: string[]; retrievalCues: string[]; continuationPass: boolean; testsPass: boolean }
  | { type: "baseline"; name: "main-inline" | "configured" | "configured-t0" | "pi-native" | "hybrid-checkpoint" };

export interface ReplayAssertion {
  path: string;
  op: "eq" | "lte" | "gte";
  value: string | number | boolean;
}

export interface ReplayCaseResult {
  id: string;
  mode: ReplayMode;
  passed: boolean;
  failures: string[];
  metrics: EvaluationMetrics;
}

export interface EvaluationMetrics {
  context: {
    activeInputP50: number;
    activeInputP90: number;
    activeInputP95: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    tokensReclaimed: number;
    tokensReclaimedPerMutation: number;
    mutationsPer100Turns: number;
    cacheHitBefore: number;
    cacheHitAfter: number;
    emergencyCheckpointFrequency: number;
  };
  cost: {
    mainCompactionOutputTokens: number;
    configuredInputTokens: number;
    configuredOutputTokens: number;
    compactionLatencyMs: number;
    compactionLatencyP50Ms: number;
    compactionLatencyP95Ms: number;
  };
  quality: {
    exactUserConstraintRetention: number;
    exactFactRetention: number;
    unresolvedWorkRetention: number;
    contradictionRate: number;
    retrievalSuccessRate: number;
    continuationSuccessRate: number;
    testCompletionRate: number;
    repeatedRetrievalCount: number;
    falseConfidenceCount: number;
  };
  reliability: {
    invariantFailures: number;
    malformedOutputsRejected: number;
    timeoutAbortCommitsPrevented: number;
    stateWriteFailuresRolledBack: number;
    staleProposalsRejected: number;
    providerSwitchesHandled: number;
    maxConfiguredChunkTokens: number;
    protocolPairViolations: number;
    sidecarRecoveries: number;
    checkpoints: number;
    delegateCompletionsRetained: number;
    extensionMutationsRecompiled: number;
    hostCheckpointAllowed: number;
    hostCompactionCanceled: number;
    shadowCommitsPrevented: number;
    networkRequests: number;
  };
}
