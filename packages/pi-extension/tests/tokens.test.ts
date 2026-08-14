import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "acp-kernel";
import { calibratedTokenEstimate, estimateTokens, lastUserMessageId, updateTokenCalibration } from "../src/tokens.js";

test("estimateTokens matches kernel defaultCountTokens (CJK 1:1 + chars/4)", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "hello world foo bar baz" },
  ];
  // defaultCountTokens (acp-kernel 0.0.7+): CJK 1:1 + non-CJK chars/4.
  // 24 non-CJK chars → ceil(24/4) = 6
  assert.equal(estimateTokens(msgs), 6);
});

test("estimateTokens is consistent with kernel counter for CJK (each char = 1 token)", () => {
  const zh = "这是一个中文测试";
  const msgs = [{ id: "m1", role: "user", contentType: "text", text: zh }];
  // 8 CJK chars → 8 tokens under defaultCountTokens; chars/4 would give 2
  assert.equal(estimateTokens(msgs), 8);
});

test("estimateTokens skips compress tool calls", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "alpha beta gamma" },
    { id: "m2", role: "assistant", contentType: "tool-call", toolName: "compress", text: "ignored payload here" },
    { id: "m3", role: "user", contentType: "text", text: "delta epsilon" },
  ];
  // m1 (4) + skip m2 (compress) + m3 (4) = 8
  assert.equal(estimateTokens(msgs), 8);
});

test("estimateTokens skips covered (already-compressed) message ids", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "alpha beta gamma" },
    { id: "m3", role: "user", contentType: "text", text: "delta epsilon" },
  ];
  const covered = new Set(["m3"]);
  // m1 (4) + skip m3 (covered) = 4
  assert.equal(estimateTokens(msgs, covered), 4);
});

test("calibration uses two consistent anchored deltas and fixed overhead", () => {
  const state = createInitialState("calibration");
  const key = "openai/model";
  const anchor = updateTokenCalibration(state, key, 10_000, 17_000, 0, 1)!;
  assert.equal(anchor.verified, false);
  const first = updateTokenCalibration(state, key, 20_000, 32_000, 0, 2)!;
  assert.equal(first.verified, false, "one density delta is insufficient");
  const second = updateTokenCalibration(state, key, 30_000, 47_000, 0, 3)!;
  assert.equal(second.verified, true);
  assert.equal(second.ratio, 1.5);
  assert.equal(second.fixedOverheadTokens, 2_000);
  assert.equal(calibratedTokenEstimate(40_000, state, key), 62_000);
});

test("calibration resets across checkpoint epochs and rejects mismatched counters", () => {
  const state = createInitialState("calibration-reset");
  const key = "openai/model";
  updateTokenCalibration(state, key, 10_000, 12_000, 0, 1);
  updateTokenCalibration(state, key, 20_000, 24_000, 0, 2);
  const reset = updateTokenCalibration(state, key, 5_000, 7_000, 1, 3)!;
  assert.equal(reset.verified, false);
  assert.equal(reset.anchorEpoch, 1);
  assert.equal(reset.samples, 0);
});

test("lastUserMessageId returns the id of the last user-role entry", () => {
  const entries = [
    { id: "a", message: { role: "user" } },
    { id: "b", message: { role: "assistant" } },
    { id: "c", message: { role: "user" } },
    { id: "d", message: { role: "toolResult" } },
  ];
  assert.equal(lastUserMessageId(entries), "c", "last user message is c");
});

test("lastUserMessageId returns undefined when no user message exists", () => {
  const entries = [
    { id: "a", message: { role: "assistant" } },
    { id: "b", message: { role: "toolResult" } },
  ];
  assert.equal(lastUserMessageId(entries), undefined);
});

test("lastUserMessageId returns undefined for empty entries", () => {
  assert.equal(lastUserMessageId([]), undefined);
});

test("lastUserMessageId handles entries without message field", () => {
  const entries = [
    { id: "a" },
    { id: "b", message: { role: "user" } },
  ];
  assert.equal(lastUserMessageId(entries), "b", "skips entries without message");
});
