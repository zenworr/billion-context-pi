import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ClearingConfig, Prompts } from "acp-kernel";
import type { AdapterConfig, ArtifactConfig, BudgetConfig, CompressConfig, DelegateConfig, MemoryConfig, OptimizationConfig } from "./config.js";
import { debug, logWarn } from "./log.js";

/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  ~/.<CONFIG_DIR_NAME>/acp.json (global) and <cwd>/.<CONFIG_DIR_NAME>/acp.json
 *  (project-local overrides project-global). Project wins over global. */
export interface UserAcpConfig {
  debug?: boolean;
  autoUpdate?: boolean;
  modelContextLimit?: number;
  toolBashDefaultTimeout?: number;
  toolOutputMaxBytes?: number;
  delegate?: boolean | DelegateConfig;
  clearing?: Partial<ClearingConfig>;
  compress?: CompressConfig;
  budget?: BudgetConfig;
  memory?: MemoryConfig;
  artifacts?: ArtifactConfig;
  optimization?: OptimizationConfig;
  displayUsage?: "merged" | "separate";
  prompts?: Partial<Prompts>;
  acknowledgePromptsRisk?: boolean;
  /** Internal origin-aware safety result; never read from JSON. */
  projectTransferPolicyValid?: boolean;
  projectAllowCrossProvider?: boolean;
  projectAcknowledgeCrossProviderDataTransfer?: boolean;
}

const configFileCache = new Map<string, { identity: string; value: unknown }>();

async function readCachedConfig(file: string): Promise<unknown> {
  const before = await fs.stat(file);
  const identity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
  const cached = configFileCache.get(file);
  if (cached?.identity === identity) return structuredClone(cached.value);
  const raw = await fs.readFile(file, "utf8");
  const after = await fs.stat(file);
  const afterIdentity = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
  if (identity !== afterIdentity) return readCachedConfig(file);
  const value = JSON.parse(raw) as unknown;
  configFileCache.set(file, { identity, value: structuredClone(value) });
  while (configFileCache.size > 64) configFileCache.delete(configFileCache.keys().next().value!);
  return value;
}

/** Read global + project acp.json, project overrides global. Returns {} on any
 *  error (missing file, bad JSON) — never throws. File identity caching removes
 *  repeated parse I/O while preserving immediate mtime/identity revocations. */
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const home = homedir();
  const merged: UserAcpConfig = {};
  const bases = [join(home, CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)];
  for (let sourceIndex = 0; sourceIndex < bases.length; sourceIndex++) {
    const base = bases[sourceIndex]!;
    const projectSource = sourceIndex === 1;
    const file = join(base, "acp.json");
    try {
      const parsed = await readCachedConfig(file);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const candidate = parsed as Record<string, unknown>;
        if (projectSource) {
          const rawCompress = candidate.compress;
          const object = rawCompress && typeof rawCompress === "object" && !Array.isArray(rawCompress)
            ? rawCompress as Record<string, unknown>
            : undefined;
          const allow = object?.allowCrossProvider;
          const acknowledge = object?.acknowledgeCrossProviderDataTransfer;
          setProjectTransferPolicy(merged, allow, acknowledge);
        }
        for (const diagnostic of configDiagnostics(candidate)) {
          logWarn("config", { event: "invalid-value", file, path: diagnostic.path, reason: diagnostic.reason });
        }
        const known = pickKnown(candidate);
        const previous = { ...merged };
        Object.assign(merged, known);
        const previousCompress = validCompressConfig(previous.compress);
        const nextCompress = validCompressConfig(known.compress);
        const combinedCompress = validCompressConfig({ ...previousCompress, ...nextCompress });
        if (previousCompress || nextCompress) merged.compress = combinedCompress ?? previousCompress;
        const previousClearing = validClearingConfig(previous.clearing);
        const nextClearing = validClearingConfig(known.clearing);
        if (previousClearing || nextClearing) {
          merged.clearing = {
            ...previousClearing,
            ...nextClearing,
            excludeTools: [...(previousClearing?.excludeTools ?? []), ...(nextClearing?.excludeTools ?? [])],
          };
        }
        const mergeValidated = <T extends object>(prior: T | undefined, next: T | undefined, validate: (value: unknown) => T | undefined): T | undefined =>
          prior || next ? validate({ ...prior, ...next }) ?? prior : undefined;
        merged.budget = mergeValidated(validBudgetConfig(previous.budget), validBudgetConfig(known.budget), validBudgetConfig);
        merged.memory = mergeValidated(validMemoryConfig(previous.memory), validMemoryConfig(known.memory), validMemoryConfig);
        merged.artifacts = mergeValidated(validArtifactConfig(previous.artifacts), validArtifactConfig(known.artifacts), validArtifactConfig);
        merged.optimization = mergeValidated(validOptimizationConfig(previous.optimization), validOptimizationConfig(known.optimization), validOptimizationConfig);
        if (previous.prompts || known.prompts) merged.prompts = { ...previous.prompts, ...known.prompts };
        if (previous.delegate && typeof previous.delegate === "object" && known.delegate && typeof known.delegate === "object") {
          merged.delegate = { ...previous.delegate, ...known.delegate };
        }
        debug.event("config-loaded", { file });
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (projectSource) setProjectTransferPolicyValidity(merged, false);
      if (code !== "ENOENT") {
        logWarn("config", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  if (merged.projectTransferPolicyValid !== true) {
    if (merged.compress?.allowCrossProvider === true || merged.compress?.acknowledgeCrossProviderDataTransfer === true) {
      logWarn("config", { event: "cross-provider-disabled", reason: "Project transfer policy is missing, unreadable, malformed, or incomplete." });
    }
  } else {
    // Security booleans are independent from all sibling validation. An
    // invalid threshold or model field cannot erase an explicit project deny.
    merged.compress = {
      ...merged.compress,
      allowCrossProvider: merged.projectAllowCrossProvider!,
      acknowledgeCrossProviderDataTransfer: merged.projectAcknowledgeCrossProviderDataTransfer!,
    };
  }
  return merged;
}

/** Persist compression settings without disturbing unrelated or future keys. */
export async function updateGlobalCompressionConfig(patch: Partial<CompressConfig>): Promise<string> {
  return updateCompressionConfigAt(join(homedir(), CONFIG_DIR_NAME), patch);
}

export async function updateProjectCompressionConfig(cwd: string, patch: Partial<CompressConfig>): Promise<string> {
  return updateCompressionConfigAt(join(cwd, CONFIG_DIR_NAME), patch);
}

async function updateCompressionConfigAt(dir: string, patch: Partial<CompressConfig>): Promise<string> {
  const file = join(dir, "acp.json");
  let root: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${file} must contain a JSON object.`);
    }
    root = { ...parsed as Record<string, unknown> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existing = root.compress;
  const compress = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  root.compress = { ...compress, ...patch };
  await fs.mkdir(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
  return file;
}
function validCompressConfig(value: unknown): CompressConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: CompressConfig = {};
  for (const key of ["maxContextLimit", "emergencyThresholdPercent"] as const) {
    const item = input[key];
    if (percentRatio(item) !== undefined) out[key] = item as number | string;
  }
  if (typeof input.nudgeGrowthTokens === "number" && Number.isSafeInteger(input.nudgeGrowthTokens) && input.nudgeGrowthTokens >= 0) out.nudgeGrowthTokens = input.nudgeGrowthTokens;
  for (const key of ["maxRangesPerCall", "maxModelCalls", "maxInputTokens", "maxOutputTokens", "maxDurationMs", "minimumNetSavingsTokens"] as const) {
    if (typeof input[key] === "number" && Number.isSafeInteger(input[key]) && input[key] > 0) out[key] = input[key];
  }
  if (typeof input.maxCostUsd === "number" && Number.isFinite(input.maxCostUsd) && input.maxCostUsd > 0) out.maxCostUsd = input.maxCostUsd;
  if (typeof input.minimumNetSavingsPercent === "number" && Number.isFinite(input.minimumNetSavingsPercent) && input.minimumNetSavingsPercent > 0 && input.minimumNetSavingsPercent < 1) out.minimumNetSavingsPercent = input.minimumNetSavingsPercent;
  if (typeof input.model === "string" && /^[^/\s]+\/.+/.test(input.model)) out.model = input.model;
  const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const key of ["thinkingLevel", "tier2ThinkingLevel", "tier3ThinkingLevel", "checkpointThinkingLevel", "branchThinkingLevel"] as const) {
    if (typeof input[key] === "string" && thinking.has(input[key])) out[key] = input[key] as NonNullable<CompressConfig[typeof key]>;
  }
  const modes = new Set(["main", "configured"]);
  for (const key of ["tier1Compressor", "tier2Compressor", "tier3Compressor", "checkpointCompressor", "branchSummaryCompressor"] as const) {
    if (typeof input[key] === "string" && modes.has(input[key])) out[key] = input[key] as NonNullable<CompressConfig[typeof key]>;
  }
  for (const key of ["allowCrossProvider", "acknowledgeCrossProviderDataTransfer"] as const) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  if (Array.isArray(input.secretPatterns) && input.secretPatterns.every((item) => typeof item === "string")) out.secretPatterns = input.secretPatterns;
  const maxContext = percentRatio(out.maxContextLimit);
  const emergency = percentRatio(out.emergencyThresholdPercent);
  if (maxContext !== undefined && emergency !== undefined && maxContext > emergency) return undefined;
  return out;
}

function validClearingConfig(value: unknown): Partial<ClearingConfig> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: Partial<ClearingConfig> = {};
  if (typeof input.enabled === "boolean") out.enabled = input.enabled;
  for (const key of ["keepRecentToolUses", "clearAtLeastTokens"] as const) {
    if (typeof input[key] === "number" && Number.isSafeInteger(input[key]) && input[key] >= 0) out[key] = input[key];
  }
  if (Array.isArray(input.excludeTools) && input.excludeTools.every((item) => typeof item === "string")) out.excludeTools = input.excludeTools;
  if (input.reasoning === "preserve" || input.reasoning === "safe-only") out.reasoning = input.reasoning;
  return out;
}

function join(... parts: string[]): string {
  return path.join(...parts);
}

interface ConfigDiagnostic { path: string; reason: "unknown key" | "invalid value" | "invalid cross-field relationship" }

const CONFIG_KEYS = new Set([
  "debug", "autoUpdate", "modelContextLimit", "toolBashDefaultTimeout", "toolOutputMaxBytes",
  "delegate", "clearing", "compress", "budget", "memory", "artifacts", "optimization",
  "displayUsage", "prompts", "acknowledgePromptsRisk",
]);
const NESTED_KEYS: Record<string, readonly string[]> = {
  delegate: ["enabled", "displayUsage"],
  clearing: ["enabled", "keepRecentToolUses", "clearAtLeastTokens", "excludeTools", "reasoning"],
  compress: ["maxContextLimit", "emergencyThresholdPercent", "nudgeGrowthTokens", "model", "thinkingLevel", "tier2ThinkingLevel", "tier3ThinkingLevel", "checkpointThinkingLevel", "branchThinkingLevel", "tier1Compressor", "tier2Compressor", "tier3Compressor", "checkpointCompressor", "branchSummaryCompressor", "allowCrossProvider", "acknowledgeCrossProviderDataTransfer", "secretPatterns", "maxRangesPerCall", "maxModelCalls", "maxInputTokens", "maxOutputTokens", "maxDurationMs", "maxCostUsd", "minimumNetSavingsTokens", "minimumNetSavingsPercent"],
  budget: ["targetActiveTokens", "targetContextPercent", "hardContextPercent", "emergencyContextPercent", "outputReserveTokens", "safetyMarginTokens"],
  memory: ["mode", "projectDirectory", "automaticPromotion"],
  artifacts: ["maxArtifactBytes", "maxSessionBytes", "maxGlobalBytes", "lifecycle"],
  optimization: ["automaticDistillation", "shadowCompaction", "telemetry", "costAwareRouting", "qualityAdaptation", "minimumBlocks", "minimumSourceTokens", "minimumSurvivalTurns", "maxReplans", "fallbackAfterFailures", "maxAdaptiveThinking"],
  prompts: ["compressPhilosophy", "howToCompressRules", "tier2DistillRules", "tier3CondenseRules"],
};

function setProjectTransferPolicy(config: UserAcpConfig, allow: unknown, acknowledge: unknown): void {
  setInternalConfigValue(config, "projectTransferPolicyValid", typeof allow === "boolean" && typeof acknowledge === "boolean");
  setInternalConfigValue(config, "projectAllowCrossProvider", typeof allow === "boolean" ? allow : undefined);
  setInternalConfigValue(config, "projectAcknowledgeCrossProviderDataTransfer", typeof acknowledge === "boolean" ? acknowledge : undefined);
}

function setProjectTransferPolicyValidity(config: UserAcpConfig, valid: boolean): void {
  setInternalConfigValue(config, "projectTransferPolicyValid", valid);
  if (!valid) {
    setInternalConfigValue(config, "projectAllowCrossProvider", undefined);
    setInternalConfigValue(config, "projectAcknowledgeCrossProviderDataTransfer", undefined);
  }
}

function setInternalConfigValue<K extends keyof UserAcpConfig>(config: UserAcpConfig, key: K, value: UserAcpConfig[K]): void {
  Object.defineProperty(config, key, { value, enumerable: false, configurable: true, writable: true });
}

function configDiagnostics(parsed: Record<string, unknown>): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.has(key)) diagnostics.push({ path: key, reason: "unknown key" });
  }
  const validators: Record<string, (value: unknown) => Record<string, unknown> | undefined> = {
    clearing: (value) => validClearingConfig(value) as Record<string, unknown> | undefined,
    compress: (value) => validCompressConfig(value) as Record<string, unknown> | undefined,
    budget: (value) => validBudgetConfig(value) as Record<string, unknown> | undefined,
    memory: (value) => validMemoryConfig(value) as Record<string, unknown> | undefined,
    artifacts: (value) => validArtifactConfig(value) as Record<string, unknown> | undefined,
    optimization: (value) => validOptimizationConfig(value) as Record<string, unknown> | undefined,
  };
  for (const [section, keys] of Object.entries(NESTED_KEYS)) {
    const raw = parsed[section];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      diagnostics.push({ path: section, reason: "invalid value" });
      continue;
    }
    const object = raw as Record<string, unknown>;
    const allowed = new Set(keys);
    for (const key of Object.keys(object)) {
      if (!allowed.has(key)) diagnostics.push({ path: `${section}.${key}`, reason: "unknown key" });
    }
    if (section === "delegate") {
      for (const key of keys) {
        if (!(key in object)) continue;
        const valid = key === "enabled" ? typeof object[key] === "boolean" : object[key] === "merged" || object[key] === "separate";
        if (!valid) diagnostics.push({ path: `${section}.${key}`, reason: "invalid value" });
      }
      continue;
    }
    if (section === "prompts") {
      for (const key of keys) if (key in object && typeof object[key] !== "string") diagnostics.push({ path: `${section}.${key}`, reason: "invalid value" });
      continue;
    }
    const valid = validators[section]?.(raw);
    if (!valid) {
      diagnostics.push({ path: section, reason: "invalid cross-field relationship" });
      continue;
    }
    for (const key of keys) {
      if (key in object && !(key in valid)) diagnostics.push({ path: `${section}.${key}`, reason: "invalid value" });
    }
  }
  const known = pickKnownWithoutDiagnostics(parsed);
  for (const key of ["debug", "autoUpdate", "modelContextLimit", "toolBashDefaultTimeout", "toolOutputMaxBytes", "displayUsage", "acknowledgePromptsRisk"] as const) {
    if (key in parsed && known[key] === undefined) diagnostics.push({ path: key, reason: "invalid value" });
  }
  if ("delegate" in parsed && typeof parsed.delegate !== "boolean" && (!parsed.delegate || typeof parsed.delegate !== "object" || Array.isArray(parsed.delegate))) {
    diagnostics.push({ path: "delegate", reason: "invalid value" });
  }
  return diagnostics;
}

function pickKnown(parsed: Record<string, unknown>): UserAcpConfig {
  return pickKnownWithoutDiagnostics(parsed);
}

function pickKnownWithoutDiagnostics(parsed: Record<string, unknown>): UserAcpConfig {
  const out: UserAcpConfig = {};
  if (typeof parsed.modelContextLimit === "number" && Number.isFinite(parsed.modelContextLimit) && parsed.modelContextLimit > 0) out.modelContextLimit = parsed.modelContextLimit;
  for (const key of ["toolBashDefaultTimeout", "toolOutputMaxBytes"] as const) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  if (typeof parsed.debug === "boolean") out.debug = parsed.debug;
  if (typeof parsed.autoUpdate === "boolean") out.autoUpdate = parsed.autoUpdate;
  if (typeof parsed.acknowledgePromptsRisk === "boolean") out.acknowledgePromptsRisk = parsed.acknowledgePromptsRisk;
  if (parsed.displayUsage === "merged" || parsed.displayUsage === "separate") out.displayUsage = parsed.displayUsage;
  if (typeof parsed.delegate === "boolean") out.delegate = parsed.delegate;
  else if (parsed.delegate && typeof parsed.delegate === "object" && !Array.isArray(parsed.delegate)) {
    const value = parsed.delegate as Record<string, unknown>;
    out.delegate = {
      ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
      ...(value.displayUsage === "merged" || value.displayUsage === "separate" ? { displayUsage: value.displayUsage } : {}),
    };
  }
  out.compress = validCompressConfig(parsed.compress);
  out.clearing = validClearingConfig(parsed.clearing);
  out.budget = validBudgetConfig(parsed.budget);
  out.memory = validMemoryConfig(parsed.memory);
  out.artifacts = validArtifactConfig(parsed.artifacts);
  out.optimization = validOptimizationConfig(parsed.optimization);
  if (parsed.prompts && typeof parsed.prompts === "object" && !Array.isArray(parsed.prompts)) {
    out.prompts = Object.fromEntries(Object.entries(parsed.prompts as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Partial<Prompts>;
  }
  return out;
}

/** Merge user config onto an adapter config: user config wins for the keys it
 *  sets. Used at session_start to apply runtime-discovered config. */
export function applyUserConfig(adapter: AdapterConfig, user: UserAcpConfig): AdapterConfig {
  const compress = validCompressConfig({
    ...validCompressConfig(adapter.compress),
    ...validCompressConfig(user.compress),
  }) ?? validCompressConfig(adapter.compress) ?? {};
  if (user.projectTransferPolicyValid === true) {
    compress.allowCrossProvider = user.projectAllowCrossProvider === true;
    compress.acknowledgeCrossProviderDataTransfer = user.projectAcknowledgeCrossProviderDataTransfer === true;
  } else if (user.projectTransferPolicyValid === false) {
    compress.allowCrossProvider = false;
    compress.acknowledgeCrossProviderDataTransfer = false;
  }
  const optimization = {
    ...validOptimizationConfig(adapter.optimization),
    ...validOptimizationConfig(user.optimization),
  };
  const requestedBudget = validBudgetConfig({ ...validBudgetConfig(adapter.budget), ...validBudgetConfig(user.budget) });
  const contextWindow = user.modelContextLimit ?? adapter.modelContextLimit;
  const budget = requestedBudget && (contextWindow === undefined
    || (requestedBudget.outputReserveTokens ?? 0) + (requestedBudget.safetyMarginTokens ?? 0) < contextWindow)
    ? requestedBudget
    : validBudgetConfig(adapter.budget) ?? {};
  const memory = { ...validMemoryConfig(adapter.memory), ...validMemoryConfig(user.memory) };
  const artifacts = validArtifactConfig({ ...validArtifactConfig(adapter.artifacts), ...validArtifactConfig(user.artifacts) })
    ?? validArtifactConfig(adapter.artifacts) ?? {};
  const adapterClearing = validClearingConfig(adapter.clearing);
  const userClearing = validClearingConfig(user.clearing);
  const clearing = {
    ...adapterClearing,
    ...userClearing,
    excludeTools: [
      ...(adapterClearing?.excludeTools ?? []),
      ...(userClearing?.excludeTools ?? []),
    ],
  };
  return {
    ...adapter,
    ...user,
    clearing: Object.keys(clearing).length > 0 ? clearing : undefined,
    compress: Object.keys(compress).length > 0 ? compress : undefined,
    budget: Object.keys(budget).length > 0 ? budget : undefined,
    memory: Object.keys(memory).length > 0 ? memory : undefined,
    artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
    optimization: Object.keys(optimization).length > 0 ? optimization : undefined,
    coreOverrides: adapter.coreOverrides,
    protectedTools: adapter.protectedTools,
    preserveRecentMessages: adapter.preserveRecentMessages,
  };
}

function percentRatio(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?%$/.test(value)) return undefined;
  const ratio = Number.parseFloat(value) / 100;
  return Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : undefined;
}

function validBudgetConfig(value: unknown): BudgetConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const result: BudgetConfig = {};
  for (const key of ["targetActiveTokens", "outputReserveTokens", "safetyMarginTokens"] as const) {
    if (typeof candidate[key] === "number" && Number.isSafeInteger(candidate[key]) && candidate[key] >= 0) result[key] = candidate[key];
  }
  for (const key of ["targetContextPercent", "hardContextPercent", "emergencyContextPercent"] as const) {
    if (typeof candidate[key] === "number" && Number.isFinite(candidate[key]) && candidate[key] > 0 && candidate[key] <= 1) result[key] = candidate[key];
  }
  const target = result.targetContextPercent;
  const hard = result.hardContextPercent;
  const emergency = result.emergencyContextPercent;
  if ((target !== undefined && hard !== undefined && target > hard)
    || (hard !== undefined && emergency !== undefined && hard > emergency)
    || (target !== undefined && emergency !== undefined && target > emergency)) return undefined;
  return result;
}

function validArtifactConfig(value: unknown): ArtifactConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const result: ArtifactConfig = {};
  for (const key of ["maxArtifactBytes", "maxSessionBytes", "maxGlobalBytes"] as const) {
    if (typeof candidate[key] === "number" && Number.isFinite(candidate[key]) && candidate[key] > 0) result[key] = candidate[key];
  }
  if (candidate.lifecycle === "retain" || candidate.lifecycle === "session") result.lifecycle = candidate.lifecycle;
  if ((result.maxArtifactBytes !== undefined && result.maxSessionBytes !== undefined && result.maxArtifactBytes > result.maxSessionBytes)
    || (result.maxSessionBytes !== undefined && result.maxGlobalBytes !== undefined && result.maxSessionBytes > result.maxGlobalBytes)
    || (result.maxArtifactBytes !== undefined && result.maxGlobalBytes !== undefined && result.maxArtifactBytes > result.maxGlobalBytes)) return undefined;
  return result;
}

function validMemoryConfig(value: unknown): MemoryConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const mode = candidate.mode;
  const result: MemoryConfig = {};
  if (mode === "off" || mode === "session" || mode === "project") result.mode = mode;
  if (typeof candidate.projectDirectory === "string" && candidate.projectDirectory.trim()) result.projectDirectory = candidate.projectDirectory;
  if (candidate.automaticPromotion === false) result.automaticPromotion = false;
  return result;
}

function validOptimizationConfig(value: unknown): OptimizationConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: OptimizationConfig = {};
  for (const key of ["automaticDistillation", "shadowCompaction", "telemetry", "costAwareRouting", "qualityAdaptation"] as const) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  for (const key of ["minimumBlocks", "minimumSourceTokens", "minimumSurvivalTurns", "maxReplans", "fallbackAfterFailures"] as const) {
    if (typeof input[key] === "number" && Number.isSafeInteger(input[key]) && input[key] >= 0) out[key] = input[key];
  }
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(input.maxAdaptiveThinking))) {
    out.maxAdaptiveThinking = input.maxAdaptiveThinking as NonNullable<OptimizationConfig["maxAdaptiveThinking"]>;
  }
  return out;
}
