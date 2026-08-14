import assert from "node:assert/strict";
import test from "node:test";
import type { SessionBeforeCompactEvent, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "acp-kernel";
import { compileCheckpointSource } from "../src/checkpoint-source.js";

function entry(id: string, text: string): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: text, timestamp: 0 },
  };
}

function preparation(messages: SessionMessageEntry["message"][]): SessionBeforeCompactEvent["preparation"] {
  return {
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    firstKeptEntryId: "kept",
    isSplitTurn: false,
    tokensBefore: 100_000,
    previousSummary: undefined,
    fileOperations: { read: [], modified: [], created: [] },
    settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
  };
}

test("checkpoint compiler retains exact old-prefix facts outside the raw tail", () => {
  const old = entry("old-entry", "Requirement: preserve exact path src/old-critical.ts.");
  const recent = entry("recent-entry", `Current working set\n${"x".repeat(200_000)}`);
  const compiled = compileCheckpointSource({
    preparation: preparation([old.message, recent.message]),
    branchEntries: [old, recent],
    state: createInitialState("checkpoint-source"),
  });
  assert.match(compiled.source, /Deterministic full-prefix manifest/);
  assert.match(compiled.source, /src\/old-critical\.ts/);
});

test("checkpoint compiler fails closed when branch matching is partial", () => {
  const old = entry("old-entry", "old fact");
  const missing = entry("missing-entry", "missing fact");
  assert.throws(() => compileCheckpointSource({
    preparation: preparation([old.message, missing.message]),
    branchEntries: [old],
    state: createInitialState("checkpoint-partial"),
  }), /matched completely/);
});
