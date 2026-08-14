import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

export interface WorldState {
  cwd: string;
  repoRoot?: string;
  branch?: string;
  staged: string[];
  modified: string[];
  untracked: string[];
  testFacts: string[];
}

export class FreshnessTracker {
  private fingerprints = new Map<string, string>();
  private forceRefresh = true;
  private lastOverlay: string | undefined;

  invalidate(): void { this.forceRefresh = true; }

  projectOverlay(files: ProjectContextFile[]): string | undefined {
    const current = files.map(currentProjectFile);
    const next = new Map<string, string>();
    const records = current.map((file) => fingerprint(file));
    for (const record of records) next.set(record.path, JSON.stringify(record));
    const changed = this.forceRefresh || next.size !== this.fingerprints.size
      || [...next].some(([path, value]) => this.fingerprints.get(path) !== value);
    this.fingerprints = next;
    this.forceRefresh = false;
    if (changed) {
      const body = current.sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => `--- ${file.path} ---\n${file.content}`)
        .join("\n\n");
      this.lastOverlay = `<acp-authoritative-project-context>\nCurrent project instructions. This overlay is authoritative and supersedes historical summaries.\n${body}\n</acp-authoritative-project-context>`;
    }
    // Pi rebuilds the base system prompt each turn. Re-emit the byte-stable
    // cached overlay even when no file changed; only fingerprinting work is
    // freshness-gated.
    return this.lastOverlay;
  }
}

export function captureWorldState(cwd: string, testFacts: string[] = []): WorldState {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { cwd, staged: [], modified: [], untracked: [], testFacts: [...testFacts].sort() };
  const branch = git(root, ["branch", "--show-current"]) || undefined;
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  const status = gitRaw(root, ["status", "--porcelain=v1", "-z"]);
  for (const entry of status.split("\0").filter(Boolean)) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === "??") untracked.push(path);
    else {
      if (code[0] !== " " && code[0] !== "?") staged.push(path);
      if (code[1] !== " " && code[1] !== "?") modified.push(path);
    }
  }
  return { cwd, repoRoot: root, branch, staged: staged.sort(), modified: modified.sort(), untracked: untracked.sort(), testFacts: [...testFacts].sort() };
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

function gitRaw(cwd: string, args: string[]): string {
  try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

function git(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trim();
}
