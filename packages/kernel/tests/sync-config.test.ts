import { test } from "node:test";
import assert from "node:assert/strict";
import { syncBlocks } from "../src/sync.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

function msg(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: id };
}

function makeBlock(
  overrides: Partial<CompressionBlock> & { blockId: string },
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("syncBlocks activates a block only when its complete source set is present", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["gone1", "gone2"] }),
    makeBlock({ blockId: "b2", effectiveMessageIds: ["kept", "also-gone"] }),
    makeBlock({ blockId: "b3", effectiveMessageIds: ["kept", "present"] }),
  );

  const result = syncBlocks([msg("kept"), msg("present")], state);
  assert.deepEqual(result.deactivated, ["b1", "b2"]);
  assert.equal(result.state.blocks[0]!.active, false);
  assert.equal(result.state.blocks[1]!.active, false);
  assert.equal(result.state.blocks[2]!.active, true);
});

test("syncBlocks keeps divergent-branch blocks inactive despite a shared source", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b-left", effectiveMessageIds: ["root", "left"] }),
    makeBlock({ blockId: "b-right", effectiveMessageIds: ["root", "right"] }),
  );

  const result = syncBlocks([msg("root"), msg("left")], state);
  assert.equal(result.state.blocks[0]!.active, true);
  assert.equal(result.state.blocks[1]!.active, false);
  assert.deepEqual(result.deactivated, ["b-right"]);
});

test("an abandoned parent does not consume a valid inherited child", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b-child", active: false, effectiveMessageIds: ["root", "left"] }),
    makeBlock({
      blockId: "b-parent",
      tier: 2,
      effectiveMessageIds: ["root", "left", "abandoned"],
      directBlockIds: ["b-child"],
    }),
  );

  const result = syncBlocks([msg("root"), msg("left")], state);
  assert.equal(result.state.blocks[0]!.active, true);
  assert.equal(result.state.blocks[1]!.active, false);
  assert.deepEqual(result.deactivated, ["b-parent"]);
});

test("a complete parent consumes its child on the current branch", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b-child", effectiveMessageIds: ["root", "left"] }),
    makeBlock({
      blockId: "b-parent",
      tier: 2,
      effectiveMessageIds: ["root", "left", "current"],
      directBlockIds: ["b-child"],
    }),
  );

  const result = syncBlocks([msg("root"), msg("left"), msg("current")], state);
  assert.equal(result.state.blocks[0]!.active, false);
  assert.equal(result.state.blocks[1]!.active, true);
  assert.deepEqual(result.deactivated, []);
});

test("syncBlocks does not mutate input state", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["x"] }));
  syncBlocks([], state);
  assert.equal(state.blocks[0]!.active, true);
});

test("defaultConfig provides sensible production defaults", () => {
  const cfg = defaultConfig(200000);
  assert.equal(cfg.modelContextLimit, 200000);
  assert.equal(cfg.promotionThreshold, 5);
  assert.equal(cfg.truncate.threshold, 0.95);
  assert.equal(cfg.nudge.maxContextLimitPct, 0.75);
  assert.equal(cfg.nudge.emergencyThresholdPct, 0.95);
  assert.ok(cfg.tiers.tier3Trigger > cfg.tiers.tier2Trigger);
});

test("defaultConfig has no gc namespace (GC removed)", () => {
  const cfg = defaultConfig(200000) as unknown as Record<string, unknown>;
  assert.equal(cfg["gc"], undefined, "gc config namespace must not exist");
});

test("defaultConfig applies overrides", () => {
  const cfg = defaultConfig(200000, { preserveRecentMessages: 20 });
  assert.equal(cfg.preserveRecentMessages, 20);
  assert.equal(cfg.modelContextLimit, 200000);
});

test("validateConfig flags invalid limits", () => {
  const cfg = defaultConfig(200000, { modelContextLimit: -1 } as never);
  assert.ok(validateConfig(cfg).some((e) => e.includes("modelContextLimit")));
});

test("validateConfig flags min > max nudge thresholds", () => {
  const base = defaultConfig(200000);
  base.nudge.minContextLimitPct = 0.8;
  base.nudge.maxContextLimitPct = 0.5;
  assert.ok(validateConfig(base).some((e) => e.includes("minContextLimitPct")));
});

test("validateConfig passes for default config", () => {
  assert.deepEqual(validateConfig(defaultConfig(200000)), []);
});
