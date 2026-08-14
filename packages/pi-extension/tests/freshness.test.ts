import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureWorldState, captureWorldStateAsync, FreshnessTracker, renderWorldOverlay } from "../src/freshness.js";

function git(cwd: string, command: string): void {
  execFileSync("git", ["-C", cwd, ...command.split(" ")]);
}

test("project fingerprints are emitted only on freshness changes", () => {
  const tracker = new FreshnessTracker();
  const files = [{ path: "/virtual/AGENTS.md", content: "Rule one." }];
  const first = tracker.projectOverlay(files);
  assert.match(first ?? "", /acp-project-freshness/);
  assert.doesNotMatch(first ?? "", /Rule one/, "Pi remains the sole injector of project contents");
  assert.equal(tracker.projectOverlay(files), undefined);
  const changed = tracker.projectOverlay([{ ...files[0]!, content: "Rule two." }]);
  assert.notEqual(changed, first);
  tracker.queueRuntimeOverlay(changed, "");
  assert.equal(tracker.consumeRuntimeOverlay(), changed);
  assert.equal(tracker.consumeRuntimeOverlay(), undefined);
});

test("project fingerprint reads current disk content instead of stale host content", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-project-fresh-"));
  const file = join(cwd, "AGENTS.md");
  writeFileSync(file, "current rule\n");
  const tracker = new FreshnessTracker();
  const current = tracker.projectOverlay([{ path: file, content: "stale rule" }]);
  writeFileSync(file, "new current rule\n");
  const changed = tracker.projectOverlay([{ path: file, content: "still stale" }]);
  assert.notEqual(current, changed, "disk content hash drives freshness");
  assert.doesNotMatch(changed ?? "", /new current rule|still stale/, "contents are not duplicated into ACP context");
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
