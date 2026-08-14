import assert from "node:assert/strict";
import test from "node:test";
import { commitCheckpointEpoch, createInitialState } from "../src/index.js";

test("checkpoint epochs deactivate but retain prior active blocks", () => {
  const state = createInitialState("session");
  state.blocks.push({
    blockId: "b1", runId: "r1", active: true, tier: 1, epoch: 0,
    summary: "durable summary", renderedSummary: "durable summary", compressedTokens: 10_000,
    directMessageIds: ["raw-1", "raw-2"], effectiveMessageIds: ["raw-1", "raw-2"],
    directBlockIds: [], createdAt: 1, survivedCount: 0, generation: "young",
  });
  const first = commitCheckpointEpoch(state, {
    summary: "checkpoint one", sourceMessageIds: ["raw-1", "raw-2"], tokensBefore: 40_000,
    firstKeptEntryId: "raw-3", createdAt: 2, coverageComplete: true,
    provenance: {
      route: "configured", configuredRoute: "configured", actualRoute: "configured",
      model: "openai/gpt-5.6-luna", provider: "openai", thinking: "high",
      generatedAt: 2, sourceHash: "source-hash", summaryHash: "summary-hash",
      usage: { input: 120, output: 30, cacheRead: 10, cost: { total: 0.01 } },
    },
  });
  assert.equal(first.state.currentEpoch, 1);
  assert.equal(first.state.blocks[0]?.active, false);
  assert.equal(first.state.blocks[0]?.summary, "durable summary");
  assert.deepEqual(first.checkpoint.sourceBlockIds, ["b1"]);
  assert.deepEqual(first.checkpoint.sourceMessageIds, ["raw-1", "raw-2"]);
  assert.equal(first.state.stats.checkpointCount, 1);
  assert.equal(first.checkpoint.coverageVersion, 1);
  assert.equal(first.checkpoint.coverageComplete, true);
  assert.equal(first.checkpoint.provenance?.configuredRoute, "configured");
  assert.equal(first.checkpoint.provenance?.actualRoute, "configured");
  assert.equal(first.checkpoint.provenance?.model, "openai/gpt-5.6-luna");
  assert.equal(first.checkpoint.provenance?.usage?.input, 120);

  const second = commitCheckpointEpoch(first.state, { summary: "checkpoint two", tokensBefore: 30_000, createdAt: 3 });
  assert.equal(second.state.currentEpoch, 2);
  assert.equal(second.state.checkpoints.length, 2);
  assert.equal(second.checkpoint.id, "c2");
  assert.equal(second.checkpoint.parentCheckpointId, "c1");
  assert.deepEqual(second.checkpoint.directSourceMessageIds, [], "checkpoint ownership is direct, not cumulatively copied");
  assert.equal(second.checkpoint.coverageComplete, false, "missing migrated ownership never claims completeness");
  assert.equal(second.state.revision, state.revision + 2);
});

test("checkpoint parent follows the active branch rather than global creation order", () => {
  const base = createInitialState("branched-checkpoint");
  const first = commitCheckpointEpoch(base, { summary: "common", entryId: "entry-common" });
  const sibling = commitCheckpointEpoch(first.state, { summary: "sibling", entryId: "entry-sibling" });
  const rewound = { ...sibling.state, currentEpoch: first.checkpoint.epoch, currentCheckpointId: first.checkpoint.id };
  const branch = commitCheckpointEpoch(rewound, { summary: "new branch", entryId: "entry-branch" });
  assert.equal(branch.checkpoint.parentCheckpointId, first.checkpoint.id);
  assert.notEqual(branch.checkpoint.parentCheckpointId, sibling.checkpoint.id);
});

test("checkpoint commit consumes the blocks captured before Pi mutates the branch", () => {
  const state = createInitialState("transactional-checkpoint");
  state.blocks.push({
    blockId: "b1", runId: "r1", active: false, tier: 1, epoch: 0,
    summary: "captured summary", compressedTokens: 100,
    directMessageIds: ["raw-1"], effectiveMessageIds: ["raw-1"], directBlockIds: [],
    createdAt: 1, survivedCount: 0, generation: "young",
  });
  const committed = commitCheckpointEpoch(state, {
    summary: "host checkpoint", sourceMessageIds: ["raw-1"], sourceBlockIds: ["b1"],
    entryId: "compaction-entry", coverageComplete: true,
  });
  assert.deepEqual(committed.checkpoint.directSourceBlockIds, ["b1"]);
  assert.equal(committed.checkpoint.entryId, "compaction-entry");
  assert.equal(committed.state.blocks[0]!.active, false);
});
