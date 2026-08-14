import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLEARED_REASONING_MARKER,
  CLEARED_TOOL_RESULT_MARKER,
  clearHistoricalContent,
  createCore,
  createInitialState,
  defaultConfig,
  type ArtifactRecord,
  type CoreMessage,
} from "../src/index.js";

function call(index: number, toolName = "read"): CoreMessage {
  return {
    id: `call-${index}`,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: `tc-${index}`,
    text: JSON.stringify({ path: `/tmp/${index}` }),
  };
}

function result(index: number, tokens: number, toolName = "read"): CoreMessage {
  return {
    id: `result-${index}`,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId: `tc-${index}`,
    text: "x".repeat(tokens),
  };
}

function artifact(index: number, toolName = "read"): ArtifactRecord {
  return {
    id: `a${index}`,
    sha256: String(index).padStart(64, "0"),
    sourceMessageId: `result-${index}`,
    toolCallId: `tc-${index}`,
    toolName,
    mime: "text/plain; charset=utf-8",
    bytes: 100,
    estimatedTokens: 100,
    localPath: `/tmp/a${index}.gz`,
    createdAt: index,
    retrievable: true,
  };
}

const countTokens = (text: string): number => text.length;

function messages(count: number, tokens: number): CoreMessage[] {
  return Array.from({ length: count }, (_, index) => [call(index), result(index, tokens)]).flat();
}

test("T0 waits for aggregate savings before it mutates the projection", () => {
  const input = messages(2, 7000);
  const artifacts = [artifact(0), artifact(1)];
  const config = {
    ...defaultConfig(200_000).clearing,
    keepRecentToolUses: 0,
    clearAtLeastTokens: 16_000,
  };
  const below = clearHistoricalContent(input, artifacts, config, countTokens);
  assert.strictEqual(below.messages, input);
  assert.equal(below.clearedCount, 0);

  const aboveInput = messages(3, 7000);
  const above = clearHistoricalContent(
    aboveInput,
    [artifact(0), artifact(1), artifact(2)],
    config,
    countTokens,
  );
  assert.equal(above.clearedCount, 3);
  assert.ok(above.savedTokens >= 16_000);
});

test("T0 keeps the five most recent tool uses and preserves call/result protocol units", () => {
  const input = messages(7, 5000);
  const config = {
    ...defaultConfig(200_000).clearing,
    clearAtLeastTokens: 1,
  };
  const cleared = clearHistoricalContent(
    input,
    Array.from({ length: 7 }, (_, index) => artifact(index)),
    config,
    countTokens,
  );

  assert.equal(cleared.clearedCount, 2);
  for (let index = 0; index < 7; index++) {
    const toolCall = cleared.messages.find((message) => message.id === `call-${index}`);
    const toolResult = cleared.messages.find((message) => message.id === `result-${index}`);
    assert.ok(toolCall, `call ${index} remains`);
    assert.ok(toolResult, `result ${index} remains`);
    assert.equal(toolResult.toolCallId, toolCall.toolCallId);
    if (index < 2) {
      assert.match(toolResult.text ?? "", new RegExp(CLEARED_TOOL_RESULT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(toolResult.text ?? "", new RegExp(`acp_artifact\\(\\{ id: "a${index}" \\}\\)`));
    } else {
      assert.equal(toolResult.text, "x".repeat(5000));
    }
  }
});

test("T0 requires a retrievable artifact and honors mandatory and configured exclusions", () => {
  const toolNames = ["compress", "edit", "write", "memory_write", "secret_tool", "read", "grep"];
  const input = toolNames.flatMap((toolName, index) => [call(index, toolName), result(index, 5000, toolName)]);
  const artifacts = toolNames.map((toolName, index) => artifact(index, toolName));
  artifacts.at(-1)!.retrievable = false;
  const config = {
    ...defaultConfig(200_000).clearing,
    keepRecentToolUses: 0,
    clearAtLeastTokens: 1,
    excludeTools: ["secret_tool"],
  };
  const cleared = clearHistoricalContent(input, artifacts, config, countTokens);

  assert.equal(cleared.clearedCount, 1);
  assert.match(cleared.messages.find((message) => message.id === "result-5")?.text ?? "", /artifact: a5/);
  for (const index of [0, 1, 2, 3, 4, 6]) {
    assert.equal(cleared.messages.find((message) => message.id === `result-${index}`)?.text, "x".repeat(5000));
  }
});

test("safe-only reasoning clears only explicit provider-agnostic plaintext", () => {
  const input: CoreMessage[] = [
    {
      id: "plain",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "plaintext-provider-agnostic",
      text: `plain:${"r".repeat(20_000)}`,
    },
    {
      id: "unknown",
      role: "assistant",
      contentType: "reasoning",
      text: `unknown:${"r".repeat(20_000)}`,
    },
    {
      id: "encrypted",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "encrypted",
      text: `encrypted:${"r".repeat(20_000)}`,
    },
    {
      id: "opaque",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "opaque",
      text: `opaque:${"r".repeat(20_000)}`,
    },
    {
      id: "provider",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "provider-specific",
      reasoningSignature: "provider-signature",
      text: `provider:${"r".repeat(20_000)}`,
    },
    {
      id: "signed-plain",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "plaintext-provider-agnostic",
      reasoningSignature: "unexpected-signature",
      text: `signed:${"r".repeat(20_000)}`,
    },
    {
      id: "non-assistant",
      role: "user",
      contentType: "reasoning",
      reasoningKind: "plaintext-provider-agnostic",
      text: `user:${"r".repeat(20_000)}`,
    },
  ];
  const config = {
    ...defaultConfig(200_000).clearing,
    keepRecentToolUses: 0,
    clearAtLeastTokens: 1,
    reasoning: "safe-only" as const,
  };
  const cleared = clearHistoricalContent(input, [], config, countTokens);

  assert.equal(cleared.clearedCount, 1);
  assert.equal(cleared.messages[0]!.text, CLEARED_REASONING_MARKER);
  for (let index = 1; index < input.length; index++) {
    assert.strictEqual(cleared.messages[index], input[index]);
  }
});

test("preserve reasoning policy keeps all reasoning content", () => {
  const input: CoreMessage[] = [
    {
      id: "plain",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "plaintext-provider-agnostic",
      text: "r".repeat(20_000),
    },
    {
      id: "provider",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "provider-specific",
      reasoningSignature: "signature",
      text: "p".repeat(20_000),
    },
  ];
  const config = {
    ...defaultConfig(200_000).clearing,
    clearAtLeastTokens: 1,
    reasoning: "preserve" as const,
  };
  const cleared = clearHistoricalContent(input, [], config, countTokens);

  assert.strictEqual(cleared.messages, input);
  assert.equal(cleared.clearedCount, 0);
});

test("reasoning clearing preserves tool call and result protocol", () => {
  const input: CoreMessage[] = [
    {
      id: "reasoning",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "plaintext-provider-agnostic",
      text: "r".repeat(20_000),
    },
    call(1),
    result(1, 5000),
  ];
  const config = {
    ...defaultConfig(200_000).clearing,
    keepRecentToolUses: 0,
    clearAtLeastTokens: 1,
    reasoning: "safe-only" as const,
  };
  const cleared = clearHistoricalContent(input, [], config, countTokens);

  assert.equal(cleared.messages.length, input.length);
  assert.equal(cleared.messages[0]!.text, CLEARED_REASONING_MARKER);
  assert.strictEqual(cleared.messages[1], input[1]);
  assert.strictEqual(cleared.messages[2], input[2]);
  assert.equal(cleared.messages[1]!.toolCallId, "tc-1");
  assert.equal(cleared.messages[2]!.toolCallId, "tc-1");
});

test("processTurn never tags preserved or signed reasoning payloads", () => {
  const core = createCore({ countTokens });
  const providerText = `provider:${"p".repeat(20_000)}`;
  const plainText = `plain:${"r".repeat(20_000)}`;
  const messagesWithPairs: CoreMessage[] = [
    {
      id: "plain",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "plaintext-provider-agnostic",
      text: plainText,
    },
    { id: "plain-answer", role: "assistant", contentType: "text", text: "plain answer" },
    {
      id: "provider",
      role: "assistant",
      contentType: "reasoning",
      reasoningKind: "provider-specific",
      reasoningSignature: "provider-signature",
      text: providerText,
    },
    { id: "provider-answer", role: "assistant", contentType: "text", text: "provider answer" },
  ];
  const safeConfig = defaultConfig(200_000, {
    clearing: {
      ...defaultConfig(200_000).clearing,
      clearAtLeastTokens: 1,
      reasoning: "safe-only",
    },
  });
  const safeTurn = core.processTurn({
    messages: messagesWithPairs,
    state: createInitialState("safe"),
    config: safeConfig,
    tokenCount: 40_000,
  });

  assert.equal(safeTurn.messages.find((message) => message.id === "plain")?.text, CLEARED_REASONING_MARKER);
  assert.equal(safeTurn.messages.find((message) => message.id === "provider")?.text, providerText);

  const preserveConfig = defaultConfig(200_000, {
    clearing: {
      ...defaultConfig(200_000).clearing,
      clearAtLeastTokens: 1,
      reasoning: "preserve",
    },
  });
  const preserveTurn = core.processTurn({
    messages: messagesWithPairs,
    state: createInitialState("preserve"),
    config: preserveConfig,
    tokenCount: 40_000,
  });

  assert.equal(preserveTurn.messages.find((message) => message.id === "plain")?.text, plainText);
  assert.equal(preserveTurn.messages.find((message) => message.id === "provider")?.text, providerText);
});

test("processTurn runs deterministic T0 before emergency truncation", () => {
  const core = createCore({ countTokens });
  const input = messages(2, 10_000);
  const state = createInitialState("session");
  state.artifacts = [artifact(0), artifact(1)];
  const config = defaultConfig(200_000, {
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    clearing: {
      ...defaultConfig(200_000).clearing,
      keepRecentToolUses: 0,
      clearAtLeastTokens: 16_000,
    },
  });
  const turn = core.processTurn({ messages: input, state, config, tokenCount: 20_000, renderTags: "none" });
  assert.equal(turn.clearing?.clearedCount, 2);
  assert.equal(turn.messages.filter((message) => message.text?.includes(CLEARED_TOOL_RESULT_MARKER)).length, 2);
});
