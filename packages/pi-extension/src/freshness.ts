import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ProjectContextFile {
  path: string;
  content: string;
  deleted?: boolean;
}

export interface ContextFileFingerprint {
  path: string;
  mtimeMs: number;
  size: number;
  hash: string;
}

const PROJECT_INSTRUCTION_NAMES = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"] as const;
const MAX_WORLD_PATHS_PER_SECTION = 200;
const MAX_WORLD_PATH_CHARS = 512;
const execFileAsync = promisify(execFile);

export interface WorldState {
  cwd: string;
  available: boolean;
  error?: string;
  repoRoot?: string;
  branch?: string;
  staged: string[];
  modified: string[];
  untracked: string[];
  counts: { staged: number; modified: number; untracked: number };
  omitted: { staged: number; modified: number; untracked: number };
  statusDigest: string;
}

export class FreshnessTracker {
  private pendingWorldOverlay: string | undefined;
  private authoritativeProjectOverlay: string | undefined;
  private lastWorldHash = "";
  private hostProjectFiles: ProjectContextFile[] = [];
  private baselineDiskPaths = new Set<string>();
  private projectCwd: string | undefined;
  private currentProjectFiles: ProjectContextFile[] = [];

  invalidate(): void { this.authoritativeProjectOverlay = undefined; }

  queueRuntimeOverlay(_project: string | undefined, world: string): void {
    const worldHash = createHash("sha256").update(world).digest("hex");
    if (worldHash !== this.lastWorldHash) this.pendingWorldOverlay = world;
    this.lastWorldHash = worldHash;
  }

  previewRuntimeOverlay(): string | undefined {
    return this.pendingWorldOverlay;
  }

  consumeRuntimeOverlay(): string | undefined {
    const world = this.pendingWorldOverlay;
    this.pendingWorldOverlay = undefined;
    return world;
  }

  /** Replace Pi's exact stale context-file segments at system priority. */
  patchSystemPrompt(systemPrompt: string): string {
    let prompt = systemPrompt;
    const injections: string[] = [];
    const currentByPath = new Map(this.currentProjectFiles.map((file) => [file.path, file]));
    for (const host of this.hostProjectFiles) {
      const current = currentByPath.get(host.path);
      const replacement = current?.deleted
        ? renderProjectDeletion(host.path)
        : renderProjectInstruction(host.path, current?.content ?? host.content);
      const expression = new RegExp(`<project_instructions\\s+path=["']${escapeRegExp(host.path)}["'][^>]*>[\\s\\S]*?<\\/project_instructions>`, "g");
      let placed = false;
      prompt = prompt.replace(expression, () => {
        if (placed) return "";
        placed = true;
        return replacement;
      });
      if (!placed) injections.push(replacement);
    }
    const hostPaths = new Set(this.hostProjectFiles.map((file) => file.path));
    injections.push(...this.currentProjectFiles
      .filter((file) => !file.deleted && !hostPaths.has(file.path))
      .map((file) => renderProjectInstruction(file.path, file.content)));
    if (injections.length > 0) {
      const marker = "</project_context>";
      const body = `${injections.join("\n\n")}\n\n`;
      prompt = prompt.includes(marker)
        ? prompt.replace(marker, `${body}${marker}`)
        : `${prompt}\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${body}</project_context>`;
    }
    return prompt;
  }

  /** Patch provider-specific payload strings that still contain Pi's system prompt. */
  patchProviderPayload(payload: unknown): unknown {
    return mapProviderSystemStrings(payload, (value) => {
      const carriesSystemContext = value.includes("<project_context>")
        || this.hostProjectFiles.some((file) => value.includes(`<project_instructions path=\"${file.path}\"`));
      return carriesSystemContext ? this.patchSystemPrompt(value) : value;
    });
  }

  branchProjectContext(): string | undefined {
    if (this.currentProjectFiles.length === 0) return undefined;
    return this.currentProjectFiles
      .filter((file) => !file.deleted)
      .map((file) => `--- ${file.path} ---\n${file.content}`)
      .join("\n\n");
  }

  projectOverlay(files: ProjectContextFile[], cwd?: string): string | undefined {
    this.hostProjectFiles = files.slice().sort((left, right) => left.path.localeCompare(right.path));
    this.baselineDiskPaths = new Set(this.hostProjectFiles.filter((file) => fileExists(file.path)).map((file) => file.path));
    this.projectCwd = cwd;
    return this.refreshProjectOverlay();
  }

  /** Re-read and rediscover instruction files after a mutating tool. */
  refreshProjectOverlay(): string | undefined {
    const hostPaths = new Set(this.hostProjectFiles.map((file) => file.path));
    const current = [
      ...this.hostProjectFiles.map((file) => currentProjectFile(file, this.baselineDiskPaths.has(file.path))),
      ...discoverProjectFiles(this.projectCwd, this.hostProjectFiles).filter((file) => !hostPaths.has(file.path)),
    ].sort((left, right) => left.path.localeCompare(right.path));
    this.currentProjectFiles = current;
    const hostByPath = new Map(this.hostProjectFiles.map((file) => [file.path, createHash("sha256").update(file.content).digest("hex")]));
    const records = current.map((file) => fingerprint(file));
    const overrides = current.filter((file, index) => hostByPath.get(file.path) !== records[index]!.hash);
    if (overrides.length === 0) {
      this.authoritativeProjectOverlay = undefined;
      return undefined;
    }
    const body = overrides.map((file) => {
      const record = records.find((candidate) => candidate.path === file.path)!;
      if (file.deleted) return `<acp-authoritative-project-context path=${JSON.stringify(file.path)} deleted="true">\nThis instruction file was deleted on disk. Ignore stale host copies.\n</acp-authoritative-project-context>`;
      return `<acp-authoritative-project-context path=${JSON.stringify(file.path)} sha256=${JSON.stringify(record.hash)}>\n${file.content}\n</acp-authoritative-project-context>`;
    }).join("\n\n");
    this.authoritativeProjectOverlay = `<acp-project-freshness>\nProject instruction files changed on disk. The full contents below override stale host copies until Pi reloads them.\n${body}\n</acp-project-freshness>`;
    return this.authoritativeProjectOverlay;
  }
}

export function captureWorldState(cwd: string): WorldState {
  const rootResult = gitRawChecked(cwd, ["rev-parse", "--show-toplevel"]);
  const root = rootResult.output.trim();
  if (!rootResult.ok || !root) return unavailableWorldState(cwd, "Git repository state is unavailable.");
  const branch = gitRawChecked(root, ["branch", "--show-current"]).output.trim() || undefined;
  const status = gitRawChecked(root, ["status", "--porcelain=v1", "-z"]);
  if (!status.ok) return unavailableWorldState(cwd, "Git status failed or exceeded its bounded output limit.", root, branch);
  return parseWorldState(cwd, root, branch, status.output);
}

export async function captureWorldStateAsync(cwd: string): Promise<WorldState> {
  const rootResult = await gitRawAsyncChecked(cwd, ["rev-parse", "--show-toplevel"]);
  const root = rootResult.output.trim();
  if (!rootResult.ok || !root) return unavailableWorldState(cwd, "Git repository state is unavailable.");
  const [branchResult, status] = await Promise.all([
    gitRawAsyncChecked(root, ["branch", "--show-current"]),
    gitRawAsyncChecked(root, ["status", "--porcelain=v1", "-z"]),
  ]);
  const branch = branchResult.output.trim() || undefined;
  if (!status.ok) return unavailableWorldState(cwd, "Git status failed or exceeded its bounded output limit.", root, branch);
  return parseWorldState(cwd, root, branch, status.output);
}

export function renderWorldOverlay(state: WorldState): string {
  return `<acp-authoritative-world-state>\nCurrent observed world state; do not use historical summaries as filesystem truth.\n${JSON.stringify(state, null, 2)}\n</acp-authoritative-world-state>`;
}

export function contextFilesFrom(ctx: ExtensionContext, files: ProjectContextFile[] | undefined): ProjectContextFile[] {
  return files ?? [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderProjectInstruction(path: string, content: string): string {
  return `<project_instructions path="${path}">\n${content}\n</project_instructions>`;
}

function renderProjectDeletion(path: string): string {
  return `<project_instructions path="${path}" deleted="true">\nThis instruction file was deleted on disk. Ignore all stale content from it.\n</project_instructions>`;
}

type ProviderPayloadPosition = "root" | "system" | "message-list" | "message" | "other";

function mapProviderSystemStrings(
  value: unknown,
  transform: (value: string) => string,
  position: ProviderPayloadPosition = "root",
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") return position === "system" ? transform(value) : value;
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  const cached = seen.get(object);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(object, output);
    const itemPosition = position === "message-list" ? "message" : position;
    for (const item of value) output.push(mapProviderSystemStrings(item, transform, itemPosition, seen));
    return output;
  }
  const record = value as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
  const systemMessage = position === "message" && (role === "system" || role === "developer");
  const output: Record<string, unknown> = {};
  seen.set(object, output);
  for (const [key, item] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    const rootSystemField = position === "root" && [
      "system", "systemprompt", "system_prompt", "systeminstruction", "system_instruction", "instructions", "developer",
    ].includes(normalized);
    const rootEnvelope = position === "root" && ["request", "body", "payload"].includes(normalized);
    const rootMessageList = position === "root" && ["messages", "input"].includes(normalized);
    const messageContent = systemMessage && ["content", "text", "input_text", "value"].includes(normalized);
    const structuredSystemText = position === "system" && ["content", "text", "input_text", "value", "parts"].includes(normalized);
    const childPosition: ProviderPayloadPosition = rootSystemField || messageContent || structuredSystemText
      ? "system"
      : rootEnvelope ? "root" : rootMessageList ? "message-list" : "other";
    output[key] = mapProviderSystemStrings(item, transform, childPosition, seen);
  }
  return output;
}

function currentProjectFile(file: ProjectContextFile, existedAtBaseline: boolean): ProjectContextFile {
  try {
    return { path: file.path, content: readFileSync(file.path, "utf8") };
  } catch {
    return existedAtBaseline ? { path: file.path, content: "", deleted: true } : file;
  }
}

function discoverProjectFiles(cwd: string | undefined, host: ProjectContextFile[]): ProjectContextFile[] {
  const directories = new Set(host.map((file) => dirname(file.path)));
  if (cwd) {
    let directory = cwd;
    const root = parse(directory).root;
    while (true) {
      directories.add(directory);
      if (directory === root) break;
      directory = dirname(directory);
    }
  }
  const found: ProjectContextFile[] = [];
  for (const directory of directories) {
    for (const name of PROJECT_INSTRUCTION_NAMES) {
      const path = join(directory, name);
      try { found.push({ path, content: readFileSync(path, "utf8") }); }
      catch { /* absent or unreadable */ }
    }
  }
  return found;
}

function fileExists(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function fingerprint(file: ProjectContextFile): ContextFileFingerprint {
  let mtimeMs = 0;
  let size = Buffer.byteLength(file.content);
  try {
    const stat = statSync(file.path);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch { /* virtual context file */ }
  return { path: file.path, mtimeMs, size, hash: createHash("sha256").update(file.content).digest("hex") };
}

function parseWorldState(cwd: string, root: string, branch: string | undefined, status: string): WorldState {
  const stagedAll: string[] = [];
  const modifiedAll: string[] = [];
  const untrackedAll: string[] = [];
  const entries = status.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const currentPath = entry.slice(3);
    const rename = code.includes("R") || code.includes("C");
    const previousPath = rename ? entries[++index] ?? "" : "";
    const displayPath = (rename ? `${previousPath} -> ${currentPath}` : currentPath).slice(0, MAX_WORLD_PATH_CHARS);
    if (code === "??") untrackedAll.push(displayPath);
    else {
      if (code[0] !== " " && code[0] !== "?") stagedAll.push(displayPath);
      if (code[1] !== " " && code[1] !== "?") modifiedAll.push(displayPath);
    }
  }
  const counts = { staged: stagedAll.length, modified: modifiedAll.length, untracked: untrackedAll.length };
  const staged = stagedAll.sort().slice(0, MAX_WORLD_PATHS_PER_SECTION);
  const modified = modifiedAll.sort().slice(0, MAX_WORLD_PATHS_PER_SECTION);
  const untracked = untrackedAll.sort().slice(0, MAX_WORLD_PATHS_PER_SECTION);
  return {
    cwd, available: true, repoRoot: root, branch, staged, modified, untracked, counts,
    omitted: { staged: counts.staged - staged.length, modified: counts.modified - modified.length, untracked: counts.untracked - untracked.length },
    statusDigest: createHash("sha256").update(status).digest("hex"),
  };
}

function unavailableWorldState(cwd: string, error: string, repoRoot?: string, branch?: string): WorldState {
  return {
    cwd, available: false, error, repoRoot, branch, staged: [], modified: [], untracked: [],
    counts: { staged: 0, modified: 0, untracked: 0 },
    omitted: { staged: 0, modified: 0, untracked: 0 },
    statusDigest: createHash("sha256").update(`unavailable:${error}`).digest("hex"),
  };
}

async function gitRawAsyncChecked(cwd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, output: result.stdout };
  } catch { return { ok: false, output: "" }; }
}

function gitRawChecked(cwd: string, args: string[]): { ok: boolean; output: string } {
  try { return { ok: true, output: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 * 1024 * 1024 }) }; }
  catch { return { ok: false, output: "" }; }
}
