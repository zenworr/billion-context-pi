import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureWorldState, FreshnessTracker, renderWorldOverlay } from "../src/freshness.js";

function git(cwd: string, command: string): void {
  execFileSync("git", ["-C", cwd, ...command.split(" ")]);
}

test("project overlay is byte-stable and emitted only on freshness changes", () => {
  const tracker = new FreshnessTracker();
  const files = [{ path: "/virtual/AGENTS.md", content: "Rule one." }];
  const first = tracker.projectOverlay(files);
  assert.match(first ?? "", /authoritative/);
  assert.equal(tracker.projectOverlay(files), first, "byte-stable authoritative overlay is re-emitted each turn");
  const changed = tracker.projectOverlay([{ ...files[0]!, content: "Rule two." }]);
  assert.match(changed ?? "", /Rule two/);
  tracker.invalidate();
  assert.equal(tracker.projectOverlay([{ ...files[0]!, content: "Rule two." }]), changed);
});

test("project overlay reads current disk content instead of stale host content", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-project-fresh-"));
  const file = join(cwd, "AGENTS.md");
  writeFileSync(file, "current rule\n");
  const overlay = new FreshnessTracker().projectOverlay([{ path: file, content: "stale rule" }]);
  assert.match(overlay ?? "", /current rule/);
  assert.doesNotMatch(overlay ?? "", /stale rule/);
});

test("world state deterministically reports branch and working tree", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-world-"));
  git(cwd, "init");
  git(cwd, "config user.email acp@example.invalid");
  git(cwd, "config user.name ACP");
  writeFileSync(join(cwd, "tracked.txt"), "one\n");
  git(cwd, "add tracked.txt");
  git(cwd, "commit -m initial");
  writeFileSync(join(cwd, "tracked.txt"), "two\n");
  writeFileSync(join(cwd, "new.txt"), "new\n");
  const state = captureWorldState(cwd, ["npm test passed"]);
  assert.ok(state.repoRoot);
  assert.deepEqual(state.modified, ["tracked.txt"]);
  assert.deepEqual(state.untracked, ["new.txt"]);
  assert.match(renderWorldOverlay(state), /npm test passed/);
});
