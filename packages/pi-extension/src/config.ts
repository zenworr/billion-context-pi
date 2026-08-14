import { defaultConfig, type ClearingConfig, type Config, type Prompts } from "acp-kernel";

/** Delegate sub-agent configuration. */
export interface DelegateConfig {
  /** Enable acp_delegate tools (delegate/wait/cancel) and their system-prompt
   *  section. Default: true. Set `enabled: false` to skip registering them. */
  enabled?: boolean;
  /** How delegate usage is reported back to the main session.
   *  "separate" (default) — delegate tokens tracked in a separate accumulator;
   *  main session totals stay clean, delegate usage shows as its own block in
   *  acp_status (excluded from main totals).
   *  "merged" — delegate token usage folded into the tool-result usage field,
   *  counted as part of the main session totals. */
  displayUsage?: "merged" | "separate";
}

/** Selects who writes a compression summary for a tier. */
export type CompressorMode = "main" | "configured";

/** Thinking level for the configured compression model. */
export type CompressionThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Compression tiers supported by acp-kernel. */
export type CompressionTier = 1 | 2 | 3;

/** Compression tuning. All fields accept a ratio (0.75) or percent string
 *  ("75%") where noted. */
export interface CompressConfig {
  /** Context usage percentage that triggers forced compression nudges
   *  (bypasses growth-gate + cadence). Accepts a ratio (0.75) or percent
   *  string ("75%"). Default: 0.75. Maps to kernel nudge.maxContextLimitPct. */
  maxContextLimit?: number | string;
  /** Context usage percentage that triggers emergency truncation of large
   *  tool outputs. Accepts a ratio (0.95) or percent string ("95%").
   *  Default: 0.95. Must be >= maxContextLimit. Maps to kernel
   *  nudge.emergencyThresholdPct + truncate.threshold. */
  emergencyThresholdPercent?: number | string;
  /** Token growth threshold for soft compression nudges. Default: 50000.
   *  Maps to kernel nudge.growthFloor + nudge.growthCap. */
  nudgeGrowthTokens?: number;
  /** Model selected by /acp-model, stored as "provider/model-id". */
  model?: string;
  /** Default thinking level used by configured compression. Default: "medium". */
  thinkingLevel?: CompressionThinkingLevel;
  /** Tier-2 override. Default: "low" when omitted. */
  tier2ThinkingLevel?: CompressionThinkingLevel;
  /** Tier-3 override. Default: "minimal" when omitted. */
  tier3ThinkingLevel?: CompressionThinkingLevel;
  /** Full-checkpoint override. Default: the general level. */
  checkpointThinkingLevel?: CompressionThinkingLevel;
  /** Branch-summary override. Default: "low" when omitted. */
  branchThinkingLevel?: CompressionThinkingLevel;
  /** Summary writer for Tier 1. Default: "main". */
  tier1Compressor?: CompressorMode;
  /** Summary writer for Tier 2. Default: "main". */
  tier2Compressor?: CompressorMode;
  /** Summary writer for Tier 3. Default: "main". */
  tier3Compressor?: CompressorMode;
  /** Permit a configured compressor from a provider other than the active main provider. */
  allowCrossProvider?: boolean;
  /** Confirm that selected source context can be transferred to that other provider. */
  acknowledgeCrossProviderDataTransfer?: boolean;
  /** Extra regular expressions whose matches are replaced before compactor transfer. */
  secretPatterns?: string[];
  /** Summary writer for full checkpoints when selective rescue is insufficient. Default: main (host compactor). */
  checkpointCompressor?: CompressorMode;
  /** Summary writer for branch/tree checkpoints. Default: main (host compactor). */
  branchSummaryCompressor?: CompressorMode;
}

export interface BudgetConfig {
  targetActiveTokens?: number;
  targetContextPercent?: number;
  hardContextPercent?: number;
  emergencyContextPercent?: number;
  outputReserveTokens?: number;
  safetyMarginTokens?: number;
}

export interface ArtifactConfig {
  /** Maximum bytes for one durable artifact. Default: 50 MiB. */
  maxArtifactBytes?: number;
  /** Maximum durable artifact bytes per session. Default: 500 MiB. */
  maxSessionBytes?: number;
  /** Maximum durable bytes across all ACP artifact sessions. Default: 2 GiB. */
  maxGlobalBytes?: number;
  /** Lifecycle policy is explicit; ACP never age-deletes artifacts by default. */
  lifecycle?: "retain" | "session";
}

export interface MemoryConfig {
  /** Durable memory policy. Default: session. */
  mode?: "off" | "session" | "project";
  /** Project-relative directory for explicitly promoted memory. Default: .pi/memory. */
  projectDirectory?: string;
  /** Reserved for a future approval workflow. Automatic writes remain disabled. */
  automaticPromotion?: false;
}

export interface OptimizationConfig {
  /** Enable automatic configured T2/T3 jobs at agent_end. Default: false. */
  automaticDistillation?: boolean;
  /** Generate and validate automatic summaries but never commit them. Default: false. */
  shadowCompaction?: boolean;
  /** Minimum active child blocks required for an automatic distillation. Default: 3. */
  minimumBlocks?: number;
  /** Minimum child-summary tokens required for an automatic distillation. Default: 12000. */
  minimumSourceTokens?: number;
  /** Minimum completed turns a child block must survive. Default: 3. */
  minimumSurvivalTurns?: number;
  /** Maximum stale-source replans for one boundary event. Default: 1. */
  maxReplans?: number;
  /** Enable in-memory usage, savings, and latency telemetry. Default: false. */
  telemetry?: boolean;
  /** Permit telemetry-based route choice. Default: false. */
  costAwareRouting?: boolean;
  /** Enable per-model/tier validation adaptation. Default: false. */
  qualityAdaptation?: boolean;
  /** Consecutive failures before bounded fallback is recommended. Default: 2. */
  fallbackAfterFailures?: number;
  /** Highest thinking level selected by adaptation. Default: high. */
  maxAdaptiveThinking?: CompressionThinkingLevel;
}

/**
 * Adapter configuration. Maps onto acp-kernel's `Config` plus Pi-specific knobs
 * (live model context window, protected tools, state persistence).
 */
export interface AdapterConfig {
  /** When omitted, the adapter reads `ctx.model.contextWindow` live each turn.
   *  Set explicitly for tests/headless runs. */
  modelContextLimit?: number;
  protectedTools?: string[];
  preserveRecentMessages?: number;
  /** Check for a newer release and show a notification. This never installs
   *  updates. Default: false. Enable explicitly during dogfooding. */
  autoUpdate?: boolean;
  /** Conservative active-context and host-compaction budgets. */
  budget?: BudgetConfig;
  /** Enable debug-level events in the ACP log file (default ~/.pi/acp.log).
   *  Always-on events (session/turn/compress/delegate lifecycle, all errors and
   *  warnings) are written regardless; `debug` only adds verbose diagnostics.
   *  Default: false (or env ACP_DEBUG=1/true). */
  debug?: boolean;
  /** Default timeout in seconds injected into the bash tool when the model
   *  omits `timeout`. Pi has NO built-in default, so without this a command
   *  that the model forgets to time out can hang for thousands of seconds.
   *  Default: 60 (catches hangs quickly). On timeout the model is guided to
   *  re-run with a larger `timeout`. Set to 0 to disable (restore Pi's
   *  unbounded behavior). */
  toolBashDefaultTimeout?: number;
  /** Byte cap applied to tool result text via the `tool_result` hook.
   *  ACP first preserves the complete text in private content-addressed
   *  storage and includes a bounded retrieval reference. If storage or quota
   *  validation fails, ACP does not apply an additional cap. Non-text result
   *  blocks remain unchanged. Default: 200000; set lower (for example, 8192)
   *  for a tighter context budget, or 0 to disable. */
  toolOutputMaxBytes?: number;
  /** Delegate sub-agent config. Accepts a boolean shorthand (`true` →
   *  `{ enabled: true }`, `false` → `{ enabled: false }`) or a DelegateConfig
   *  object. Default: enabled. */
  delegate?: boolean | DelegateConfig;
  /** Lossless historical tool-result clearing. */
  clearing?: Partial<ClearingConfig>;
  /** Compression tuning. */
  compress?: CompressConfig;
  /** Optional project memory. Project writes require mode=project and an explicit promote command. */
  memory?: MemoryConfig;
  /** Durable artifact limits and lifecycle. */
  artifacts?: ArtifactConfig;
  /** Optional Phase-7 background optimization. All active behavior defaults off. */
  optimization?: OptimizationConfig;
  /** Legacy flat alias for `delegate.displayUsage`. Kept for backward
   *  compatibility with existing acp.json files. Prefer `delegate.displayUsage`. */
  displayUsage?: "merged" | "separate";
  /** Override acp-kernel's load-bearing compression prompt rules (the 4
   *  Prompts fields). Each set field replaces the kernel default verbatim.
   *  Requires acknowledgePromptsRisk: true — without it, overrides are dropped
   *  (defaults used) and a warning is logged. Set via ~/.pi/acp.json. */
  prompts?: Partial<Prompts>;
  /** Must be true for `prompts` overrides to take effect. Acknowledges that
   *  replacing the kernel's tuned compression rules may reduce summary quality
   *  (lost paths/signatures/decisions → worse retrieval). */
  acknowledgePromptsRisk?: boolean;
  coreOverrides?: Partial<Config>;
}

export const DEFAULT_TOOL_BASH_TIMEOUT = 60;
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 200_000;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384;
export const DEFAULT_SAFETY_MARGIN_TOKENS = 8_000;

export function effectiveActiveTarget(adapter: AdapterConfig, contextWindow: number): number {
  const absolute = adapter.budget?.targetActiveTokens ?? Number.POSITIVE_INFINITY;
  const percentage = adapter.budget?.targetContextPercent;
  const proportional = percentage !== undefined ? contextWindow * percentage : Number.POSITIVE_INFINITY;
  const target = Math.min(absolute, proportional);
  return Number.isFinite(target) ? Math.max(0, target) : Math.max(0, contextWindow);
}

export function safeResumeThreshold(adapter: AdapterConfig, contextWindow: number): number {
  const reserve = adapter.budget?.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const margin = adapter.budget?.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  return Math.max(0, Math.min(contextWindow - reserve - margin, effectiveActiveTarget(adapter, contextWindow) + reserve));
}

/** Hard tool gate for the active model. It is derived from current budget policy. */
export function forcedCompressionLimit(adapter: AdapterConfig, contextWindow: number): number {
  const reserve = adapter.budget?.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const margin = adapter.budget?.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  const hardPercent = adapter.budget?.hardContextPercent ?? 0.75;
  const emergencyPercent = adapter.budget?.emergencyContextPercent ?? 0.95;
  return Math.max(1, Math.floor(Math.min(
    contextWindow - reserve - margin,
    contextWindow * hardPercent,
    contextWindow * emergencyPercent,
  )));
}

/** Resolve delegate config from the adapter, handling the boolean shorthand
 *  and the legacy flat `displayUsage` alias. */
export function resolveDelegate(adapter: AdapterConfig): { enabled: boolean; displayUsage: "merged" | "separate" } {
  const d = adapter.delegate;
  if (typeof d === "object" && d !== null) {
    return {
      enabled: d.enabled !== false,
      displayUsage: d.displayUsage ?? adapter.displayUsage ?? "separate",
    };
  }
  return {
    enabled: d !== false,
    displayUsage: adapter.displayUsage ?? "separate",
  };
}

export function resolveConfig(adapter: AdapterConfig, liveContextLimit: number): Config {
  const envLimit = process.env.ACP_MODEL_CONTEXT_LIMIT;
  const envLimitNum = envLimit ? Number(envLimit) : NaN;
  const FALLBACK_LIMIT = 150_000;
  const limit =
    !Number.isNaN(envLimitNum) && envLimitNum > 0
      ? envLimitNum
      : adapter.modelContextLimit && adapter.modelContextLimit > 0
        ? adapter.modelContextLimit
        : liveContextLimit > 0
          ? liveContextLimit
          : FALLBACK_LIMIT;
  const config = defaultConfig(limit, {
    protectedTools: adapter.protectedTools ?? [],
    preserveRecentMessages: adapter.preserveRecentMessages ?? 5,
    ...adapter.coreOverrides,
    clearing: {
      ...defaultConfig(limit).clearing,
      ...adapter.coreOverrides?.clearing,
      ...adapter.clearing,
      excludeTools: [
        ...(adapter.coreOverrides?.clearing?.excludeTools ?? []),
        ...(adapter.clearing?.excludeTools ?? []),
      ],
    },
  });
  const c = adapter.compress;
  if (adapter.budget?.hardContextPercent !== undefined) config.nudge.maxContextLimitPct = adapter.budget.hardContextPercent;
  if (adapter.budget?.emergencyContextPercent !== undefined) {
    config.nudge.emergencyThresholdPct = adapter.budget.emergencyContextPercent;
    config.truncate.threshold = adapter.budget.emergencyContextPercent;
  }
  if (c?.maxContextLimit !== undefined) config.nudge.maxContextLimitPct = parsePercent(c.maxContextLimit);
  if (c?.emergencyThresholdPercent !== undefined) {
    const pct = parsePercent(c.emergencyThresholdPercent);
    config.nudge.emergencyThresholdPct = pct;
    config.truncate.threshold = pct;
  }
  if (c?.nudgeGrowthTokens !== undefined) {
    config.nudge.growthFloor = c.nudgeGrowthTokens;
    config.nudge.growthCap = c.nudgeGrowthTokens;
  }
  return config;
}

export function parsePercent(v: number | string): number {
  if (typeof v === "number") return v;
  const s = v.trim();
  if (s.endsWith("%")) return Number(s.slice(0, -1)) / 100;
  return Number(s);
}

export function compressorModeForTier(adapter: AdapterConfig, tier: CompressionTier): CompressorMode {
  const compress = adapter.compress;
  const configured = tier === 1
    ? compress?.tier1Compressor
    : tier === 2
      ? compress?.tier2Compressor
      : compress?.tier3Compressor;
  return configured === "configured" ? "configured" : "main";
}

export function compressionThinkingLevel(
  adapter: AdapterConfig,
  purpose: CompressionTier | "checkpoint" | "branch" = 1,
): CompressionThinkingLevel {
  const compress = adapter.compress;
  const fallback = purpose === 2 ? "low" : purpose === 3 ? "minimal" : purpose === "branch" ? "low" : "medium";
  const level = purpose === 2
    ? compress?.tier2ThinkingLevel
    : purpose === 3
      ? compress?.tier3ThinkingLevel
      : purpose === "checkpoint"
        ? compress?.checkpointThinkingLevel
        : purpose === "branch"
          ? compress?.branchThinkingLevel
          : compress?.thinkingLevel;
  const resolved = level ?? (purpose === "checkpoint" ? compress?.thinkingLevel : purpose === 1 ? compress?.thinkingLevel : undefined) ?? fallback;
  if (resolved === "off" || resolved === "minimal" || resolved === "low" || resolved === "medium" || resolved === "high" || resolved === "xhigh" || resolved === "max") return resolved;
  return fallback;
}

export function parseCompressionModel(value: unknown): { provider: string; id: string } | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
