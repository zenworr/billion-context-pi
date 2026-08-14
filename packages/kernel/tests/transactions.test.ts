import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { defaultConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import type { CoreMessage } from "../src/types.js";

function fixture() {
  const core = createCore();
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "old request ".repeat(400) },
    { id: "a1", role: "assistant", contentType: "text", text: "old response ".repeat(400) },
    { id: "u2", role: "user", contentType: "text", text: "current request" },
  ];
  const state = createInitialState("sid");
  const config = defaultConfig(200_000, {
    preserveRecentMessages: 1,
    preserveRecentTokens: 0,
    compress: { minCompressRange: 0, minSummaryLength: 1, maxSummaryLength: 20_000 },
  });
  const prepared = core.processTurn({ messages, state, config, tokenCount: 10_000 });
  return { core, messages, state: prepared.state, config };
}

test("planCompression is non-mutating, pair-safe, and freezes a source hash", () => {
  const { core, messages, state, config } = fixture();
  const before = structuredClone(state);
  const result = core.planCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", preserve: ["keep exact"] }],
    messages,
    state,
    config,
  });
  assert.deepEqual(state, before);
  assert.ok(result.plan);
  assert.equal(result.plan!.ranges.length, 1);
  assert.equal(result.plan!.ranges[0]!.sourceMessageIds.length, 2);
  assert.match(result.plan!.sourceHash, /^[a-f0-9]{64}$/);
});

test("atomic compression rejects stale revisions and changed sources without partial state", () => {
  const { core, messages, state, config } = fixture();
  const plan = core.planCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002" }],
    messages,
    state,
    config,
  }).plan!;
  const stale = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "durable summary" }],
    messages,
    state,
    config,
    atomic: true,
    expectedRevision: state.revision + 1,
    expectedSourceHash: plan.sourceHash,
  });
  assert.equal(stale.result.blocksCreated, 0);
  assert.equal(stale.state, state);

  const changed = messages.map((message) => message.id === "a1" ? { ...message, text: "changed source" } : message);
  const changedResult = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "durable summary" }],
    messages: changed,
    state,
    config,
    atomic: true,
    expectedRevision: state.revision,
    expectedSourceHash: plan.sourceHash,
  });
  assert.equal(changedResult.result.blocksCreated, 0);
  assert.equal(changedResult.state, state);
});

test("atomic batches roll back every range when one range is invalid", () => {
  const { core, messages, state, config } = fixture();
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00001", summary: "first valid summary" },
      { startRef: "m99999", endRef: "m99999", summary: "invalid range summary" },
    ],
    messages,
    state,
    config,
    atomic: true,
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.state, state);
  assert.equal(result.state.blocks.length, 0);
});
