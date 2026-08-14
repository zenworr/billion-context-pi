import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "acp-kernel";
import { buildSearchDocs } from "../src/search-index.js";

test("checkpoint root ownership indexes every projected assistant submessage", () => {
  const entry = {
    type: "message",
    id: "assistant-entry",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "checkpoint reasoning detail" },
        { type: "text", text: "checkpoint visible decision" },
      ],
      timestamp: Date.now(),
    },
  } as SessionEntry;
  const state = createInitialState("search-checkpoint");
  state.checkpoints.push({
    id: "c1",
    epoch: 1,
    summary: "checkpoint",
    sourceBlockIds: [],
    sourceMessageIds: ["assistant-entry"],
    tokensBefore: 1000,
    createdAt: Date.now(),
    coverageVersion: 1,
    coverageComplete: true,
  });
  const ctx = {
    sessionManager: { getEntries: () => [entry] },
  } as unknown as ExtensionContext;

  const messages = buildSearchDocs(ctx, state).filter((doc) => doc.kind === "message");
  assert.deepEqual(messages.map((doc) => doc.ref), ["assistant-entry#reasoning", "assistant-entry"]);
  assert.ok(messages.every((doc) => doc.checkpointId === "c1"));
  assert.ok(messages.every((doc) => doc.blockId === undefined));
});
