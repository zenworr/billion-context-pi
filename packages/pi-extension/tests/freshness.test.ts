import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureWorldState, captureWorldStateAsync, FreshnessTracker, renderWorldOverlay } from "../src/freshness.js";

function git(cwd: string, command: string): void {
  execFileSync("git", ["-C", cwd, ...command.split(" ")]);
}

test("unchanged host project context needs no authoritative override", () => {
  const tracker = new FreshnessTracker();
  const files = [{ path: "/virtual/AGENTS.md", content: "Rule one." }];
  assert.equal(tracker.projectOverlay(files), undefined);
  assert.equal(tracker.projectOverlay(files), undefined);
});

test("project fingerprint reads current disk content instead of stale host content", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-project-fresh-"));
  const file = join(cwd, "AGENTS.md");
  writeFileSync(file, "current rule\n");
  const tracker = new FreshnessTracker();
  const current = tracker.projectOverlay([{ path: file, content: "stale rule" }]);
  writeFileSync(file, "new current rule\n");
  const changed = tracker.projectOverlay([{ path: file, content: "still stale" }]);
  assert.match(current ?? "", /current rule/);
  assert.notEqual(current, changed, "disk content hash drives freshness");
  assert.match(changed ?? "", /new current rule/);
  assert.doesNotMatch(changed ?? "", /still stale/);
  const staleSystem = `<project_instructions path="${file}">\nstill stale\n</project_instructions>`;
  assert.match(tracker.patchSystemPrompt(staleSystem), /new current rule/);
  assert.doesNotMatch(tracker.patchSystemPrompt(staleSystem), /still stale/);
  tracker.queueRuntimeOverlay(changed, "world");
  assert.equal(tracker.consumeRuntimeOverlay(), "world", "project changes stay at system priority, not the runtime user suffix");
  assert.equal(tracker.projectOverlay([{ path: file, content: "new current rule\n" }]), undefined, "override clears after Pi catches up");
});

test("project instructions refresh after a mutating tool without replacing the host baseline", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-project-tool-refresh-"));
  const file = join(cwd, "AGENTS.md");
  writeFileSync(file, "host rule\n");
  const tracker = new FreshnessTracker();
  assert.equal(tracker.projectOverlay([{ path: file, content: "host rule\n" }]), undefined);
  writeFileSync(file, "tool changed rule\n");
  const changed = tracker.refreshProjectOverlay();
  assert.match(changed ?? "", /tool changed rule/);
  assert.match(tracker.refreshProjectOverlay() ?? "", /tool changed rule/, "authoritative override persists until Pi supplies the new baseline");
});

test("project refresh discovers new instruction files and emits deletion tombstones", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-project-discovery-"));
  const tracked = join(cwd, "AGENTS.md");
  writeFileSync(tracked, "host rule\n");
  const tracker = new FreshnessTracker();
  assert.equal(tracker.projectOverlay([{ path: tracked, content: "host rule\n" }], cwd), undefined);
  writeFileSync(join(cwd, "AGENTS.override.md"), "new override\n");
  rmSync(tracked);
  const overlay = tracker.refreshProjectOverlay() ?? "";
  assert.match(overlay, /new override/);
  assert.match(overlay, /deleted="true"/);
  assert.match(overlay, /Ignore stale host copies/);
});

test("world state deterministically reports branch and working tree without blocking production hooks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-world-"));
  git(cwd, "init");
  git(cwd, "config user.email acp@example.invalid");
  git(cwd, "config user.name ACP");
  writeFileSync(join(cwd, "tracked.txt"), "one\n");
  git(cwd, "add tracked.txt");
  git(cwd, "commit -m initial");
  writeFileSync(join(cwd, "tracked.txt"), "two\n");
  writeFileSync(join(cwd, "new.txt"), "new\n");
  const state = captureWorldState(cwd);
  const asyncState = await captureWorldStateAsync(cwd);
  assert.deepEqual(asyncState, state);
  assert.ok(state.repoRoot);
  assert.deepEqual(state.modified, ["tracked.txt"]);
  assert.deepEqual(state.untracked, ["new.txt"]);
  assert.match(renderWorldOverlay(state), /tracked\.txt/);
});
