import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultPrompts } from "acp-kernel";
import {
  compressWithModel,
  estimateCompressionInputTokens,
  MAX_COMPRESSION_INPUT_TOKENS,
} from "../src/model-compressor.js";

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function compressionModel() {
  return {
    id: "gpt-5.6-luna",
    name: "Luna",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 8_192,
  };
}

test("trusted branch instructions stay in system policy and preserve replace semantics", async () => {
  let systemPrompt = "";
  let sourcePayload = "";
  const ctx = {
    modelRegistry: {
      complete: async (_model: unknown, request: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> }) => {
        systemPrompt = request.systemPrompt ?? "";
        sourcePayload = request.messages[0]!.content[0]!.text;
        return {
          content: [{ type: "text", text: `Trusted branch summary. ${"detail ".repeat(30)}` }],
          stopReason: "stop",
          usage,
        };
      },
    },
  } as unknown as ExtensionContext;
  await compressWithModel({
    ctx,
    model: compressionModel(),
    thinkingLevel: "medium",
    tier: 1,
    source: "untrusted branch transcript",
    prompts: defaultPrompts,
    summaryMaxChars: 20_000,
    trustedInstructions: "Focus on unresolved branch decisions.",
    replaceInstructions: true,
  });
  assert.match(systemPrompt, /Focus on unresolved branch decisions/);
  assert.match(systemPrompt, /replaces the standard tier-specific task/);
  assert.doesNotMatch(sourcePayload, /Focus on unresolved branch decisions/);
});

test("configured compression splits oversized sources below the 220k input ceiling", async () => {
  const observed: number[] = [];
  const model = compressionModel();
  const ctx = {
    modelRegistry: {
      complete: async (_model: unknown, request: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> }) => {
        observed.push(Math.ceil(((request.systemPrompt?.length ?? 0) + request.messages[0]!.content[0]!.text.length) / 3));
        return {
          content: [{ type: "text", text: `Chunk summary preserves /src/example.ts and decision port 4317. ${"detail ".repeat(30)}` }],
          stopReason: "stop",
          usage,
        };
      },
    },
  } as unknown as ExtensionContext;
  const source = Array.from({ length: 400 }, (_, index) => `[m${String(index).padStart(5, "0")}] tool/tool-result read\n${"x".repeat(2_000)}`).join("\n\n");
  const result = await compressWithModel({
    ctx,
    model,
    thinkingLevel: "medium",
    tier: 1,
    source,
    prompts: defaultPrompts,
    summaryMaxChars: 20_000,
  });
  assert.ok(observed.length >= 3, "expected map chunks plus a final synthesis");
  assert.ok(observed.every((tokens) => tokens <= MAX_COMPRESSION_INPUT_TOKENS), `unsafe requests: ${observed.join(",")}`);
  assert.match(result.summary, /src\/example\.ts/);
  assert.equal(result.usage.input, observed.length * usage.input);
});

test("input estimator includes prompt and JSON envelope", () => {
  const tokens = estimateCompressionInputTokens({ tier: 1, source: "x".repeat(3_000), prompts: defaultPrompts, summaryMaxChars: 20_000 });
  assert.ok(tokens > 1_000);
});
