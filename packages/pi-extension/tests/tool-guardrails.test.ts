import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBashTimeout,
  capToolOutput,
  detectBashTimeout,
  appendTimeoutNotice,
  forcedCompressionReason,
  isBashToolResult,
  shouldBlockToolForCompression,
} from "../src/tool-guardrails.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

type Content = ToolResultEvent["content"];
const text = (t: string): Content => [{ type: "text", text: t }];

test("forced compression blocks every tool except bounded ACP recovery tools at the active-model limit", () => {
  const limit = 204_000;
  assert.equal(shouldBlockToolForCompression("read", limit - 1, limit), false);
  assert.equal(shouldBlockToolForCompression("read", limit, limit), true);
  assert.equal(shouldBlockToolForCompression("bash", limit + 50_000, limit), true);
  assert.equal(shouldBlockToolForCompression("compress", limit + 50_000, limit), false);
  assert.equal(shouldBlockToolForCompression("acp_artifact", limit + 50_000, limit), false);
  assert.equal(shouldBlockToolForCompression("read", undefined, limit), false);
});

test("forced compression reason is actionable and identifies bounded recovery tools", () => {
  const reason = forcedCompressionReason(204_321, 204_000);
  assert.match(reason, /Context limit reached — compress now/);
  assert.match(reason, /204,321 tokens/);
  assert.match(reason, /bounded ACP recovery tools/);
});

test("resolveBashTimeout returns undefined when the model already set a timeout", () => {
  assert.equal(resolveBashTimeout({ timeout: 30 }, 60), undefined);
});

test("resolveBashTimeout injects the default when the model omitted timeout", () => {
  assert.equal(resolveBashTimeout({}, 60), 60);
  assert.equal(resolveBashTimeout({ timeout: undefined }, 60), 60);
});

test("resolveBashTimeout returns undefined when the default is disabled (0 / negative / NaN)", () => {
  assert.equal(resolveBashTimeout({}, 0), undefined);
  assert.equal(resolveBashTimeout({}, -5), undefined);
  assert.equal(resolveBashTimeout({}, Number.NaN), undefined);
});

test("resolveBashTimeout falls back to the 60s built-in default when default is undefined", () => {
  assert.equal(resolveBashTimeout({}, undefined), 60);
});

test("capToolOutput uses the bounded default when maxBytes is omitted", () => {
  const output = "x".repeat(1_100_000);
  const capped = capToolOutput(text(output), undefined);
  assert.ok(capped);
  assert.ok(Buffer.byteLength(capped.map((part) => part.type === "text" ? part.text : "").join(""), "utf8") < 1_100_000);
  assert.match(capped.map((part) => part.type === "text" ? part.text : "").join("\n"), /output capped/);
});

test("capToolOutput leaves small output untouched (returns undefined)", () => {
  assert.equal(capToolOutput(text("hello"), 100), undefined);
});

test("capToolOutput returns undefined when the cap is disabled", () => {
  assert.equal(capToolOutput(text("x".repeat(10_000)), 0), undefined);
  assert.equal(capToolOutput(text("x".repeat(10_000)), undefined), undefined);
});

test("capToolOutput truncates oversized text to under the byte cap and adds a notice", () => {
  const big = "line\n".repeat(4000);
  const out = capToolOutput(text(big), 500);
  assert.ok(out, "should return truncated content");
  const t = (out![0] as { text: string }).text;
  assert.ok(Buffer.byteLength(t, "utf8") <= 500 + 200, "truncated payload must be near the cap (notice adds a little)");
  assert.match(t, /ACP guardrail/);
  assert.match(t, /dropped/);
});

test("capToolOutput keeps a complete last line (no mid-line cut)", () => {
  const big = "0123456789\n".repeat(2000);
  const out = capToolOutput(text(big), 100);
  const t = (out![0] as { text: string }).text;
  const body = t.split("\n\n[ACP guardrail")[0];
  for (const line of body.split("\n")) {
    assert.ok(line.length === 0 || line.length === 10, "no partial line: " + JSON.stringify(line));
  }
});

test("capToolOutput mentions the saved full-output path for bash-style results", () => {
  const big = "x".repeat(10_000);
  const out = capToolOutput(text(big), 500, "/tmp/acp-full.log");
  const t = (out![0] as { text: string }).text;
  assert.match(t, /\/tmp\/acp-full\.log/);
});

test("capToolOutput counts and removes non-text content from bounded inline output", () => {
  const img = { type: "image", source: { media_type: "image/png", data: "AAAA" } } as Content[number];
  const content: Content = [{ type: "text", text: "x".repeat(10_000) }, img];
  const out = capToolOutput(content, 500);
  assert.ok(out);
  assert.equal(out!.some((c) => c.type === "image"), false, "durably spooled non-text must not bypass the inline budget");
  assert.equal(out!.some((c) => c.type === "text"), true, "bounded text and retrieval notice must be present");
});

test("capToolOutput is UTF-8 safe (never splits a multibyte sequence)", () => {
  const big = "中文测试\n".repeat(3000);
  const out = capToolOutput(text(big), 200);
  const t = (out![0] as { text: string }).text;
  const body = t.split("\n\n[ACP guardrail")[0];
  const buf = Buffer.from(body, "utf8");
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    const size = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    assert.ok(i + size <= buf.length, "no truncated multibyte sequence at byte " + i);
    i += size;
  }
});

test("detectBashTimeout extracts the seconds from Pi's timeout error text", () => {
  assert.equal(detectBashTimeout(text("Command timed out after 60 seconds")), 60);
  assert.equal(detectBashTimeout(text("partial output\nCommand timed out after 300 seconds")), 300);
});

test("detectBashTimeout returns undefined when there is no timeout error", () => {
  assert.equal(detectBashTimeout(text("Command aborted")), undefined);
  assert.equal(detectBashTimeout(text("no error here")), undefined);
  assert.equal(detectBashTimeout([]), undefined);
});

test("appendTimeoutNotice appends actionable guidance to the last text part", () => {
  const out = appendTimeoutNotice(text("Command timed out after 60 seconds"), 60);
  assert.equal(out.length, 1);
  const t = (out[0] as { text: string }).text;
  assert.match(t, /killed after 60s/);
  assert.match(t, /`timeout`/);
  assert.match(t, /"timeout": 120/);
});

test("appendTimeoutNotice suggests a larger timeout that scales with the kill time", () => {
  const out = appendTimeoutNotice(text("Command timed out after 300 seconds"), 300);
  const t = (out[0] as { text: string }).text;
  assert.match(t, /"timeout": 600/);
});

test("appendTimeoutNotice adds a new text part when content has no text part", () => {
  const img = { type: "image", source: { media_type: "image/png", data: "AAAA" } } as Content[number];
  const out = appendTimeoutNotice([img], 30);
  assert.equal(out.length, 2);
  assert.equal(out[1].type, "text");
});

test("isBashToolResult narrows by toolName and exposes bash details (vendored guard, host-agnostic)", () => {
  const bash = { toolName: "bash", content: text("ok"), isError: false, details: { fullOutputPath: "/tmp/x" } } as unknown as ToolResultEvent;
  const other = { toolName: "read", content: text("ok"), isError: false } as unknown as ToolResultEvent;
  assert.equal(isBashToolResult(bash), true);
  assert.equal(isBashToolResult(other), false);
  if (isBashToolResult(bash)) {
    assert.equal(bash.details?.fullOutputPath, "/tmp/x");
  }
});
