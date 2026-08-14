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
}

/** Read global + project acp.json, project overrides global. Returns {} on any
 *  error (missing file, bad JSON) — never throws. */
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const home = homedir();
  const merged: UserAcpConfig = {};
  for (const base of [join(home, CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    const file = join(base, "acp.json");
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const known = pickKnown(parsed as Record<string, unknown>);
        const previousCompress = validCompressConfig(merged.compress);
        const previousClearing = validClearingConfig(merged.clearing);
        Object.assign(merged, known);
        const nextCompress = validCompressConfig(known.compress);
        const nextClearing = validClearingConfig(known.clearing);
        if (previousCompress || nextCompress) merged.compress = { ...previousCompress, ...nextCompress };
        if (previousClearing || nextClearing) {
          merged.clearing = {
            ...previousClearing,
            ...nextClearing,
            excludeTools: [
              ...(previousClearing?.excludeTools ?? []),
              ...(nextClearing?.excludeTools ?? []),
            ],
          };
        }
        debug.event("config-loaded", { file });
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logWarn("config", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
      }
    }
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
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as CompressConfig
    : undefined;
}

function validClearingConfig(value: unknown): Partial<ClearingConfig> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ClearingConfig>
    : undefined;
}

function join(... parts: string[]): string {
  return path.join(...parts);
}

const KNOWN = new Set([
  "debug", "autoUpdate", "modelContextLimit",
  "toolBashDefaultTimeout", "toolOutputMaxBytes",
  "delegate", "clearing", "compress", "budget", "memory", "artifacts", "optimization", "displayUsage",
  "prompts", "acknowledgePromptsRisk",
]);

function pickKnown(parsed: Record<string, unknown>): UserAcpConfig {
  const out: UserAcpConfig = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (KNOWN.has(k)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Merge user config onto an adapter config: user config wins for the keys it
 *  sets. Used at session_start to apply runtime-discovered config. */
export function applyUserConfig(adapter: AdapterConfig, user: UserAcpConfig): AdapterConfig {
  const compress = {
    ...validCompressConfig(adapter.compress),
    ...validCompressConfig(user.compress),
  };
  const optimization = {
    ...validOptimizationConfig(adapter.optimization),
    ...validOptimizationConfig(user.optimization),
  };
  const budget = { ...validBudgetConfig(adapter.budget), ...validBudgetConfig(user.budget) };
  const memory = { ...validMemoryConfig(adapter.memory), ...validMemoryConfig(user.memory) };
  const artifacts = { ...validArtifactConfig(adapter.artifacts), ...validArtifactConfig(user.artifacts) };
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

function validBudgetConfig(value: unknown): BudgetConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const result: BudgetConfig = {};
  for (const key of ["targetActiveTokens", "targetContextPercent", "hardContextPercent", "emergencyContextPercent", "outputReserveTokens", "safetyMarginTokens"] as const) {
    if (typeof candidate[key] === "number" && Number.isFinite(candidate[key]) && candidate[key] >= 0) result[key] = candidate[key];
  }
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
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as OptimizationConfig
    : undefined;
}
