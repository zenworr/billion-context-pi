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
  assert.equal(second.checkpoint.coverageComplete, false, "missing migrated ownership never claims completeness");
  assert.equal(second.state.revision, state.revision + 2);
});
