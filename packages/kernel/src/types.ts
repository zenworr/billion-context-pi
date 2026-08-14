export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageContentType =
  "text" | "tool-call" | "tool-result" | "reasoning";

export type ReasoningContentKind =
  | "plaintext-provider-agnostic"
  | "encrypted"
  | "opaque"
  | "provider-specific";

export interface CoreMedia {
  kind: "image" | "audio" | "file" | "unknown";
  mimeType?: string;
  byteLength?: number;
  digest?: string;
  estimatedInputTokens: number;
  retrievableArtifactId?: string;
}

export interface CoreMessage {
  id: string;
  role: MessageRole;
  contentType: MessageContentType;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  reasoningKind?: ReasoningContentKind;
  reasoningSignature?: string;
  /** Root Pi entry used to keep provider protocol units indivisible. */
  protocolGroupId?: string;
  /** Unsupported provider content must stay verbatim in the active request. */
  hardProtected?: boolean;
  /** Synthetic host notifications are context, but are not user-turn boundaries. */
  synthetic?: boolean;
  media?: CoreMedia[];
  estimatedInputTokens?: number;
}

export type CompressionTier = 1 | 2 | 3;

export type BlockGeneration = "young" | "old";

export interface ManifestFact {
  text: string;
  sourceRefs: string[];
}

export interface ManifestDecision {
  decision: string;
  rationale?: string;
  sourceRefs: string[];
}

export interface ManifestFile {
  path: string;
  status: "read" | "created" | "modified" | "deleted";
  sourceRefs: string[];
}

export interface ManifestCommand {
  command: string;
  exitCode?: number;
  result: string;
  sourceRefs: string[];
}

export interface ManifestError {
  exactText: string;
  cause?: string;
  status?: string;
  sourceRefs: string[];
}

export interface ManifestContradiction {
  left: string;
  right: string;
  sourceRefs: string[];
}

export interface ManifestSemanticFacts {
  objectives: ManifestFact[];
  requirements: ManifestFact[];
  decisions: ManifestDecision[];
  completed: ManifestFact[];
  active: ManifestFact[];
  blocked: ManifestFact[];
  openQuestions: ManifestFact[];
  nextSteps: ManifestFact[];
  files: ManifestFile[];
  commands: ManifestCommand[];
  errors: ManifestError[];
  facts: ManifestFact[];
  contradictions: ManifestContradiction[];
}

export interface CompressionManifest {
  sourceRefs: string[];
  userMessageRefs: string[];
  paths: string[];
  symbols: string[];
  commands: string[];
  errorStrings: string[];
  numbersAndIds: string[];
  toolCalls: Array<{
    name: string;
    callId?: string;
    inputDigest: string;
    exitCode?: number;
  }>;
  semanticFacts?: ManifestSemanticFacts;
  sourceHash: string;
}

export interface StructuredSummary {
  objective: string[];
  userRequirements: Array<{ text: string; sourceRefs: string[]; verbatim: boolean }>;
  decisions: Array<{ decision: string; rationale?: string; sourceRefs: string[] }>;
  workState: {
    completed: string[];
    active: string[];
    blocked: string[];
    next: string[];
  };
  files: Array<{
    path: string;
    status?: "read" | "created" | "modified" | "deleted";
    symbols?: string[];
    notes?: string[];
  }>;
  commands: Array<{ command: string; exitCode?: number; result: string }>;
  errors: Array<{ exactText: string; cause?: string; status?: string }>;
  facts: string[];
  retrievalCues: string[];
}

export interface BlockGenerationMetadata {
  requestedRoute: "main" | "configured";
  execution: "inline-main" | "isolated-main" | "isolated-configured";
  provider: string;
  model: string;
  thinking: string;
  promptVersion: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  durationMs?: number;
}

export interface BlockQuality {
  status: "passed" | "repaired" | "fallback" | "unverified";
  missingRequiredFacts: string[];
  compressionRatio: number;
  attempts: number;
}

export interface CompressionBlock {
  blockId: string;
  runId: string;
  epoch: number;
  tier: CompressionTier;
  topic?: string;
  summary: string;
  renderedSummary: string;
  structuredSummary?: StructuredSummary;
  manifest?: CompressionManifest;
  sourceHash?: string;
  summaryHash?: string;
  provenance?: BlockGenerationMetadata;
  quality?: BlockQuality;
  directMessageIds: string[];
  effectiveMessageIds: string[];
  directBlockIds: string[];
  /** Token count of the original messages compressed by this block (for accurate reporting). */
  compressedTokens: number;
  createdAt: number;
  survivedCount: number;
  generation: BlockGeneration;
  active: boolean;
  supersededBy?: string;
  durationMs?: number;
  compressCallId?: string;
  startRef?: string;
  endRef?: string;
}

export interface MessageRefMap {
  byRaw: Record<string, string>;
  byRef: Record<string, string>;
}

export interface NudgeState {
  lastPerMessageNudgeTokens: number;
  lastNudgeShownTokens: number;
  baselineTokens: number;
  anchors: Record<string, unknown>;
  /** Per-tier cadence baseline: the tokenCount at which that tier last had a
   *  nudge injected. A tier is allowed to inject again only once
   *  `tokenCount - lastShownByTier[tier] >= growthFloor`, independent of other
   *  tiers. Using a record (not N named fields) so adding tier 4+ needs no
   *  schema change. */
  lastShownByTier: Record<number, number>;
}

export interface ArtifactRecord {
  id: string;
  status?: "pending" | "ready" | "unavailable";
  error?: string;
  sha256: string;
  sourceMessageId: string;
  toolCallId?: string;
  toolName?: string;
  mime: string;
  bytes: number;
  estimatedTokens: number;
  localPath: string;
  createdAt: number;
  retrievable: boolean;
}

export interface CheckpointRecord {
  id: string;
  epoch: number;
  summary: string;
  sourceBlockIds: string[];
  sourceMessageIds: string[];
  parentCheckpointId?: string;
  directSourceBlockIds?: string[];
  directSourceMessageIds?: string[];
  firstKeptEntryId?: string;
  entryId?: string;
  tokensBefore: number;
  createdAt: number;
  provider?: string;
  model?: string;
  provenance?: BlockGenerationMetadata;
  sourceHash?: string;
  /** Versioned exact-source ownership. Missing on migrated records means incomplete. */
  coverageVersion?: 1;
  coverageComplete?: boolean;
  validationStatus?: "passed" | "repaired" | "fallback" | "unverified";
}

export interface PinRecord {
  id: string;
  ref: string;
  mode: "summary" | "full";
  remainingTurns: number;
  createdAt: number;
}

export interface TokenCalibrationState {
  /** Number of mutually consistent delta samples. Density is trusted at >=2. */
  samples: number;
  ratio: number;
  verified: boolean;
  anchorProviderTokens: number;
  anchorLocalTokens: number;
  anchorEpoch: number;
  fixedOverheadTokens: number;
  candidateRatio?: number;
  candidateSamples?: number;
  lastProviderTokens: number;
  lastEstimatedTokens: number;
  updatedAt: number;
}

export interface CompressionStats {
  tokensCompressed: number;
  compressionCount: number;
  rawTokensExternalized: number;
  semanticTokensCompressed: number;
  checkpointCount: number;
  searchCount: number;
  decompressionCount: number;
}

export interface CompressionState {
  schemaVersion: 2;
  /** Projection graph revision: blocks/checkpoints/artifacts/coverage only. */
  graphRevision: number;
  /** Metadata revision: telemetry, cadence, calibration, and display state. */
  metadataRevision: number;
  /** Persistence transaction revision. */
  revision: number;
  sessionId: string;
  currentEpoch: number;
  /** Checkpoint entry active on the current branch, if any. */
  currentCheckpointId?: string;
  blocks: CompressionBlock[];
  messageRefs: MessageRefMap;
  /** Persistent monotonic allocator; decimal string avoids namespace exhaustion. */
  nextMessageRefId: string;
  tokenSnapshots: Record<string, number>;
  artifacts: ArtifactRecord[];
  checkpoints: CheckpointRecord[];
  pins: PinRecord[];
  nudge: NudgeState;
  policyState: {
    nudgeBaselines: Record<string, number>;
    lastActionAt: Record<string, number>;
    recentRetrievals: Record<string, number>;
    /** Stable completed-turn identity; prevents duplicate lifecycle hooks from aging blocks twice. */
    lastSurvivedTurnId?: string;
    tokenCalibration: Record<string, TokenCalibrationState>;
  };
  stats: CompressionStats;
  nextBlockId: number;
  nextRunId: number;
  nextArtifactId: number;
  nextCheckpointId: number;
  nextPinId: number;
}

export interface TierConfig {
  enabled: boolean;
  tier2Trigger: number;
  tier3Trigger: number;
}

export interface NudgeConfig {
  maxContextLimitPct: number;
  minContextLimitPct: number;
  frequency: number;
  iterationThreshold: number;
  force: "soft" | "strong";
  growthRatio: number;
  /** Adaptive growth threshold = modelContextLimit × this ratio, clamped to [growthFloor, growthCap]. Default 0.05 (5%). */
  growthFloor: number;
  /** Upper clamp for adaptive growth threshold. Default 50000. */
  growthCap: number;
  /** Anti-thrashing: suppress nudge unless growth ≥ max(minGrowthFloor, minGrowthRatio × growthTokens). Default 5000. */
  minGrowthFloor: number;
  /** Ratio for growth floor: max(minGrowthFloor, minGrowthRatio × growthTokens). Default 0.45. */
  minGrowthRatio: number;
  /** Emergency override: always nudge when usage ≥ this fraction. Default 0.98 (98%). */
  emergencyThresholdPct: number;
}

export type ReasoningClearingPolicy = "safe-only" | "preserve";

export interface ClearingConfig {
  enabled: boolean;
  keepRecentToolUses: number;
  clearAtLeastTokens: number;
  excludeTools: string[];
  reasoning: ReasoningClearingPolicy;
}

export interface TruncateConfig {
  // Context-usage fraction that triggers the emergency tool-output truncation
  // node (the LAST safety valve of the pipeline). 1.0 = 100% of the model
  // context limit. Removed GC age-deactivation/summary-truncation are gone;
  // this is the only "context near full" fallback that remains.
  threshold: number;
}

export interface CompressValidationConfig {
  /** Minimum total chars of original messages in a range to allow compression. 0 = disabled. Default 5000. */
  minCompressRange: number;
  /** Maximum summary length (chars). Summary exceeding this is rejected unless summaryMaxChars override is used. 0 = disabled. Default 20000. */
  maxSummaryLength: number;
  /** Minimum summary length (chars). Summary shorter than this is rejected. 0 = disabled. Default 50. */
  minSummaryLength: number;
}

export interface Config {
  tiers: TierConfig;
  nudge: NudgeConfig;
  // young→old promotion after N survivals (drives merge-blocks). Age-based
  // deactivation is GONE — blocks are never dropped for being old.
  promotionThreshold: number;
  truncate: TruncateConfig;
  clearing: ClearingConfig;
  compress: CompressValidationConfig;
  protectedTools: string[];
  isToolProtected?: (toolName: string, toolInputText?: string) => boolean;
  preserveRecentMessages: number;
  preserveRecentTokens: number;
  modelContextLimit: number;
  messageFilters?: import("./filter/types.js").MessageFiltersConfig;
}

export type CompressMode = "range" | "message";

export interface CompressionRangeRequest {
  startRef: string;
  endRef: string;
  topic?: string;
  preserve?: string[];
  rationale?: string;
}

export interface PlannedCompressionRange extends CompressionRangeRequest {
  adjustedStartRef: string;
  adjustedEndRef: string;
  outputTier: CompressionTier;
  sourceMessageIds: string[];
  sourceBlockIds: string[];
  protectedMessageIds: string[];
  sourceHash: string;
  sourceTokens: number;
}

export interface CompressionPlan {
  transactionId: string;
  stateRevision: number;
  ranges: PlannedCompressionRange[];
  sourceHash: string;
  createdAt: number;
}

export interface CompressRangeSpec {
  startRef: string;
  endRef: string;
  summary: string;
  topic?: string;
  preserve?: string[];
  rationale?: string;
  compressCallId?: string;
  /** Per-call override for max summary length. Model can set this when content needs more detail. */
  summaryMaxChars?: number;
}

export interface CompressCall {
  mode: CompressMode;
  ranges: CompressRangeSpec[];
}

export interface CompressibleRange {
  startRef: string;
  endRef: string;
  count: number;
  tokens: number;
  toolPct: number;
  textPct: number;
  dangerous?: boolean;
}

export interface ProtectedRange {
  startRef: string;
  endRef: string;
  count: number;
  tokens: number;
  tools: string[];
}

export interface ContextRanges {
  compressible: CompressibleRange[];
  protected: ProtectedRange[];
}

export interface Recommendation {
  contextRanges: ContextRanges;
  recommendedRanges: CompressibleRange[];
  nothingToCompress: boolean;
}

export interface ContextBreakdown {
  system: number;
  tool: number;
  summaries: number;
  code: number;
  text: number;
  total: number;
  growth: number;
}

export interface NudgeDecision {
  shouldInject: boolean;
  reason: string;
  compressibleRanges: CompressibleRange[];
  protectedRanges?: ProtectedRange[];
  /** When `tier` is set, the active lower-tier blocks that should be distilled
   *  into a single higher-tier block. Empty when no tier nudge. */
  tierTargetBlocks?: CompressionBlock[];
  contextUsage: number;
  tier: CompressionTier | null;
  breakdown: NudgeBreakdown;
  contextBreakdown?: ContextBreakdown;
}

/** Numeric debug/reason fields exposed alongside a nudge decision. Keeping
 *  these typed (rather than a bare Record<string, number>) means adapters
 *  that read e.g. emergencyOverride get a compile-time signal if a key is
 *  renamed or removed. */
export interface NudgeBreakdown {
  usage: number;
  growth: number;
  growthReference: number;
  effectiveThreshold: number;
  nudgeGrowthTokens: number;
  growthFloor: number;
  hasPendingNudge: number;
  overLimit: number;
  emergencyOverride: number;
  pendingT1: number;
  pendingT2: number;
  pendingT3: number;
  [key: string]: number;
}

export interface ResolvedBoundary {
  startIndex: number;
  endIndex: number;
  protectedGaps: number[];
}

export interface PlanCompressionResult {
  plan?: CompressionPlan;
  errors: string[];
  warnings: string[];
}

export interface ApplyCompressionResult {
  state: CompressionState;
  result: {
    blocksCreated: number;
    tokensCompressed: number;
    errors: string[];
    /** Non-fatal notices (e.g. protected messages excluded from a range).
     *  The compression still succeeded; the host should surface these to the
     *  model so it understands what was skipped. */
    warnings: string[];
  };
}

export interface ProjectionEffect {
  originalTokens: number;
  projectedTokens: number;
  tokensCleared: number;
  tokensPruned: number;
  contentChanged: boolean;
  projectionHash: string;
}

export interface ProcessTurnResult {
  messages: CoreMessage[];
  state: CompressionState;
  projection: ProjectionEffect;
  nudge?: NudgeDecision;
  clearing?: {
    clearedCount: number;
    savedTokens: number;
  };
}

export interface StatusReport {
  contextUsage: number;
  tokenCount: number;
  modelContextLimit: number;
  activeBlocks: number;
  totalBlocks: number;
  tokensCompressed: number;
  breakdown: Record<string, number>;
}
