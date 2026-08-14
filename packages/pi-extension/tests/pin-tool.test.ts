import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, defaultCountTokens } from "acp-kernel";
import { forcedCompressionLimit } from "../src/config.js";
import { boundPinText, renderPins } from "../src/pin-tool.js";

test("boundPinText keeps ASCII and CJK pin payloads inside the exact token budget", () => {
  for (const value of ["a".repeat(20_000), "界".repeat(20_000)]) {
    const bounded = boundPinText(value, 1_000, "\n[pin truncated; retrieve with decompress]");
    assert.ok(defaultCountTokens(bounded) <= 1_000);
    assert.match(bounded, /pin truncated/);
  }
});

test("boundPinText preserves complete content that fits", () => {
  assert.equal(boundPinText("small", 10, "notice"), "small");
});

test("renderPins reserves its complete envelope inside the remaining request budget", () => {
  const state = createInitialState("pin-budget");
  state.messageRefs.byRaw.message = "m00001";
  state.messageRefs.byRef.m00001 = "message";
  state.pins.push({ id: "pin-1", ref: "m00001", mode: "full", remainingTurns: 2, createdAt: 1 });
  const messages = [{ id: "message", role: "user", contentType: "text", text: "界".repeat(20_000) }] as const;
  const contextWindow = 200_000;
  state.policyState.tokenCalibration["openai/pin-model"] = {
    samples: 2, ratio: 2, verified: true,
    anchorProviderTokens: 100, anchorLocalTokens: 50, anchorEpoch: 0,
    fixedOverheadTokens: 10, lastProviderTokens: 100, lastEstimatedTokens: 50, updatedAt: Date.now(),
  };
  const runtime = {
    adapter: {},
    liveContextLimit: () => contextWindow,
    projectionFor: () => undefined,
  } as any;
  const ctx = {
    model: { provider: "openai", id: "pin-model" },
    sessionManager: { getSessionId: () => "pin-budget" },
  } as any;
  const hardLimit = forcedCompressionLimit(runtime.adapter, contextWindow);
  const availableProviderTokens = 137;
  const rendered = renderPins(state, messages as any, ctx, runtime, hardLimit - availableProviderTokens);
  assert.ok(rendered);
  assert.ok(defaultCountTokens(rendered) <= Math.floor(availableProviderTokens / 2));
  assert.match(rendered, /^<acp-pinned-context>/);
  assert.match(rendered, /<\/acp-pinned-context>$/);
});
