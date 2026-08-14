import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, statSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ProjectContextFile {
  path: string;
  content: string;
}

export interface ContextFileFingerprint {
  path: string;
  mtimeMs: number;
  size: number;
  hash: string;
}

const MAX_WORLD_PATHS_PER_SECTION = 200;
const MAX_WORLD_PATH_CHARS = 512;
const execFileAsync = promisify(execFile);

export interface WorldState {
  cwd: string;
  repoRoot?: string;
  branch?: string;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export class FreshnessTracker {
  private fingerprints = new Map<string, string>();
  private forceRefresh = true;
  private pendingRuntimeOverlay: string | undefined;
  private lastWorldHash = "";
  private currentProjectFiles: ProjectContextFile[] = [];

  invalidate(): void { this.forceRefresh = true; }

  queueRuntimeOverlay(project: string | undefined, world: string): void {
    const worldHash = createHash("sha256").update(world).digest("hex");
    const worldChanged = worldHash !== this.lastWorldHash;
    this.lastWorldHash = worldHash;
    const parts = [project, worldChanged ? world : undefined].filter((value): value is string => Boolean(value));
    if (parts.length > 0) this.pendingRuntimeOverlay = parts.join("\n\n");
  }

  consumeRuntimeOverlay(): string | undefined {
    const overlay = this.pendingRuntimeOverlay;
    this.pendingRuntimeOverlay = undefined;
    return overlay;
  }

  branchProjectContext(): string | undefined {
    if (this.currentProjectFiles.length === 0) return undefined;
    return this.currentProjectFiles
      .map((file) => `--- ${file.path} ---\n${file.content}`)
      .join("\n\n");
  }

  projectOverlay(files: ProjectContextFile[]): string | undefined {
    const current = files.map(currentProjectFile).sort((left, right) => left.path.localeCompare(right.path));
    this.currentProjectFiles = current;
    const next = new Map<string, string>();
    const records = current.map((file) => fingerprint(file));
    for (const record of records) next.set(record.path, JSON.stringify(record));
    const changed = this.forceRefresh || next.size !== this.fingerprints.size
      || [...next].some(([path, value]) => this.fingerprints.get(path) !== value);
    this.fingerprints = next;
    this.forceRefresh = false;
    if (!changed) return undefined;
    const body = records.sort((a, b) => a.path.localeCompare(b.path))
      .map((record) => `${record.path} sha256=${record.hash} mtimeMs=${record.mtimeMs} bytes=${record.size}`)
      .join("\n");
    return `<acp-project-freshness>\nProject instruction files changed. Pi's current host-provided project context is authoritative; historical summaries are not.\n${body}\n</acp-project-freshness>`;
  }
}

export function captureWorldState(cwd: string): WorldState {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { cwd, staged: [], modified: [], untracked: [] };
  const branch = git(root, ["branch", "--show-current"]) || undefined;
  return parseWorldState(cwd, root, branch, gitRaw(root, ["status", "--porcelain=v1", "-z"]));
}

export async function captureWorldStateAsync(cwd: string): Promise<WorldState> {
  const root = (await gitRawAsync(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!root) return { cwd, staged: [], modified: [], untracked: [] };
  const [branchText, status] = await Promise.all([
    gitRawAsync(root, ["branch", "--show-current"]),
    gitRawAsync(root, ["status", "--porcelain=v1", "-z"]),
  ]);
  return parseWorldState(cwd, root, branchText.trim() || undefined, status);
}

export function renderWorldOverlay(state: WorldState): string {
  return `<acp-authoritative-world-state>\nCurrent observed world state; do not use historical summaries as filesystem truth.\n${JSON.stringify(state, null, 2)}\n</acp-authoritative-world-state>`;
}

export function contextFilesFrom(ctx: ExtensionContext, files: ProjectContextFile[] | undefined): ProjectContextFile[] {
  return files ?? [];
}

function currentProjectFile(file: ProjectContextFile): ProjectContextFile {
  try {
    return { path: file.path, content: readFileSync(file.path, "utf8") };
  } catch {
    return file;
  }
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
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const entry of status.split("\0").filter(Boolean)) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3, 3 + MAX_WORLD_PATH_CHARS);
    if (code === "??") {
      if (untracked.length < MAX_WORLD_PATHS_PER_SECTION) untracked.push(path);
    } else {
      if (code[0] !== " " && code[0] !== "?" && staged.length < MAX_WORLD_PATHS_PER_SECTION) staged.push(path);
      if (code[1] !== " " && code[1] !== "?" && modified.length < MAX_WORLD_PATHS_PER_SECTION) modified.push(path);
    }
  }
  return { cwd, repoRoot: root, branch, staged: staged.sort(), modified: modified.sort(), untracked: untracked.sort() };
}

async function gitRawAsync(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    return result.stdout;
  } catch { return ""; }
}

function gitRaw(cwd: string, args: string[]): string {
  try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

function git(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trim();
}
