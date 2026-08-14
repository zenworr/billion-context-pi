import assert from "node:assert/strict";
import test from "node:test";
import { createCore } from "../src/compress.js";
import { defaultConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import type { CoreMessage } from "../src/types.js";

test("processTurn includes conservative media estimates in original and projected tokens", () => {
  const messages: CoreMessage[] = [{
    id: "image-user", role: "user", contentType: "text", text: "image",
    hardProtected: true,
    media: [{ kind: "image", mimeType: "image/png", estimatedInputTokens: 3_000 }],
    estimatedInputTokens: 3_000,
  }];
  const turn = createCore().processTurn({
    messages,
    state: createInitialState(),
    config: defaultConfig(200_000),
    tokenCount: 3_010,
  });
  assert.ok(turn.projection.originalTokens >= 3_000);
  assert.ok(turn.projection.projectedTokens >= 3_000);
});
