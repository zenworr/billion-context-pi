import { readFile, writeFile, stat, copyFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { debug, logError, logWarn } from "./log.js";

const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status", "acp_artifact"] as const;

const BUILTIN_DEFAULT_TOOLS: Record<string, string[]> = {
  advisor: ["read", "grep", "find", "ls", "bash", "intercom"],
  "context-builder": ["read", "grep", "find", "ls", "bash", "write", "web_search", "intercom"],
  delegate: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
  oracle: ["read", "grep", "find", "ls", "bash", "intercom"],
  planner: ["read", "grep", "find", "ls", "intercom"],
  researcher: ["read", "write", "web_search", "fetch_content", "get_search_content", "intercom"],
  reviewer: ["read", "grep", "find", "ls", "bash", "edit", "write", "intercom"],
  scout: ["read", "grep", "find", "ls", "bash", "write", "intercom"],
  worker: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
};

export function resolveAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return homedir();
  if (configured?.startsWith("~/")) return join(homedir(), configured.slice(2));
  return configured || join(homedir(), CONFIG_DIR_NAME, "agent");
}

export interface SetupResult {
  path: string;
  action: "skipped" | "updated" | "failed";
  reason?: string;
}

type OverrideEntry = { tools?: string[]; [k: string]: unknown };

function desiredTools(existing: OverrideEntry | undefined, name: string): { tools: string[]; changed: boolean } {
  const base = Array.isArray(existing?.tools) && existing!.tools!.length > 0
    ? [...(existing!.tools as string[])]
    : [...(BUILTIN_DEFAULT_TOOLS[name] ?? [])];
  const hasAll = ACP_TOOLS.every((t) => base.includes(t));
  if (hasAll) return { tools: base, changed: false };
  for (const t of ACP_TOOLS) if (!base.includes(t)) base.push(t);
  return { tools: base, changed: true };
}

export async function ensureSubagentAcpTools(settingsPath?: string): Promise<SetupResult> {
  const path = settingsPath ?? join(resolveAgentDir(), "settings.json");

  let raw: string;
  let mtimeMs: number;
  try {
    raw = await readFile(path, "utf-8");
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return { path, action: "skipped", reason: "settings.json not found; will retry next session" };
  }

  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { path, action: "failed", reason: "settings.json root is not a JSON object" };
    }
    settings = parsed as Record<string, unknown>;
  } catch (e) {
    return { path, action: "failed", reason: `settings.json is not valid JSON: ${(e as Error).message}` };
  }

  const subagents = (typeof settings.subagents === "object" && settings.subagents !== null && !Array.isArray(settings.subagents))
    ? { ...(settings.subagents as Record<string, unknown>) }
    : {};
  const overridesRaw = (typeof subagents.agentOverrides === "object" && subagents.agentOverrides !== null && !Array.isArray(subagents.agentOverrides))
    ? { ...(subagents.agentOverrides as Record<string, unknown>) }
    : {};

  const updatedOverrides: Record<string, unknown> = { ...overridesRaw };
  let anyChanged = false;
  for (const name of Object.keys(BUILTIN_DEFAULT_TOOLS)) {
    const existing = (overridesRaw[name] ?? undefined) as OverrideEntry | undefined;
    const { tools, changed } = desiredTools(existing, name);
    if (changed) {
      updatedOverrides[name] = { ...(existing ?? {}), tools };
      anyChanged = true;
    }
  }

  if (!anyChanged) {
    return { path, action: "skipped", reason: "all builtin agents already have ACP tools" };
  }

  const backupPath = `${path}.acp-bak`;
  if (!existsSync(backupPath)) {
    try { await copyFile(path, backupPath); } catch { /* best effort */ }
  }

  // Optimistic concurrency guard: bail if the file changed since we read it.
  try {
    if ((await stat(path)).mtimeMs !== mtimeMs) {
      return { path, action: "skipped", reason: "settings.json changed during setup (concurrent write); will retry next session" };
    }
  } catch {
    return { path, action: "failed", reason: "settings.json disappeared during setup" };
  }

  const next: Record<string, unknown> = {
    ...settings,
    subagents: { ...subagents, agentOverrides: updatedOverrides },
  };

  const tmpPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    await rename(tmpPath, path);
  } catch (e) {
    return { path, action: "failed", reason: `write failed: ${(e as Error).message}` };
  }

  try {
    const verify = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const sub = verify.subagents as Record<string, unknown> | undefined;
    const v = sub?.agentOverrides;
    if (typeof v !== "object" || v === null) throw new Error("agentOverrides missing after write");
    for (const name of Object.keys(BUILTIN_DEFAULT_TOOLS)) {
      const tools = (v as Record<string, OverrideEntry>)[name]?.tools;
      if (!Array.isArray(tools) || !ACP_TOOLS.every((t) => tools.includes(t))) {
        throw new Error(`${name} missing ACP tools after write`);
      }
    }
  } catch (e) {
    try { await copyFile(backupPath, path); } catch { /* leave as-is */ }
    return { path, action: "failed", reason: `verification failed; restored backup: ${(e as Error).message}` };
  }

  return { path, action: "updated" };
}

export async function runSetupAndNotify(notify?: (msg: string) => void): Promise<SetupResult> {
  try {
    const result = await ensureSubagentAcpTools();
    debug.event("setup-subagent-tools", { action: result.action, reason: result.reason });
    if (result.action === "updated" && notify) {
      notify(`ACP: enabled context tools (compress/decompress/search_context/acp_status/acp_artifact) for subagents`);
    }
    if (result.action === "failed") {
      logWarn("setup", { event: "subagent-tools", action: result.action, reason: result.reason });
    }
    return result;
  } catch (e) {
    debug.event("setup-subagent-tools-error", { msg: String(e) });
    logError("setup", { event: "subagent-tools-error", error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack ?? "" : "" });
    return { path: "", action: "failed", reason: String(e) };
  }
}
