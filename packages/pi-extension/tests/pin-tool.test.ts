import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { boundPinText } from "../src/pin-tool.js";

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
