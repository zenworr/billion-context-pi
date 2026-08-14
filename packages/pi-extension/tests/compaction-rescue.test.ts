import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "acp-kernel";
import { createAcpExtension } from "../src/index.js";

const USAGE = {
  input: 120,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 160,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface ModelCall {
  model: string;
  source: string;
  systemPrompt: string;
  hasTools: boolean;
  cacheRetention?: string;
  sessionId?: string;
}

function captureApi(): { api: ExtensionAPI; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
  };
  return { api: api as unknown as ExtensionAPI, handlers };
}

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

function activeModel(provider: string, id: string) {
  return { provider, id, contextWindow: 200_000, maxTokens: 8192, reasoning: false };
}

async function rescueFixture(
  onRescueCall?: (entries: SessionEntry[], controller: AbortController) => void,
  tier1Compressor: "main" | "configured" = "configured",
): Promise<{
  dir: string;
  sessionFile: string;
  entries: SessionEntry[];
  calls: ModelCall[];
  controller: AbortController;
  handler: Handler;
  ctx: object;
}> {
  const dir = await mkdtemp(join(tmpdir(), "acp-tier-one-rescue-"));
  const sessionFile = join(dir, "session.jsonl");
  const entries: SessionEntry[] = [
    userEntry("e1", `OLD_ALPHA ${"historical implementation detail ".repeat(180)}`),
    userEntry("e2", `OLD_BETA ${"completed investigation result ".repeat(180)}`),
    userEntry("e3", `OLD_GAMMA ${"durable technical outcome ".repeat(180)}`),
    userEntry("e4", `OLD_DELTA ${"earlier project discussion ".repeat(180)}`),
    userEntry("e5", `RECENT_PROTECTED ${"current working context ".repeat(40)}`),
    userEntry("e6", `CURRENT_REQUEST ${"do not compress this request ".repeat(40)}`),
  ];
  const main = activeModel("openai", "main-model");
  const configured = activeModel("openai", "checkpoint-model");
  const models = [main, configured];
  const calls: ModelCall[] = [];
  const controller = new AbortController();
  const ctx = {
    mode: "rpc",
    hasUI: false,
    ui: {
      notify() {},
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      setStatus() {},
    },
    model: main,
    thinkingLevel: "low",
    modelRegistry: {
      find: (provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
      hasConfiguredAuth: () => true,
      complete: async (
        selected: ReturnType<typeof activeModel>,
        request: {
          systemPrompt?: string;
          messages: Array<{ content: Array<{ type: string; text: string }> }>;
          tools?: unknown;
        },
        options: { cacheRetention?: string; sessionId?: string },
      ) => {
        const payload = JSON.parse(request.messages[0]!.content[0]!.text) as { selectedSource: string };
        calls.push({
          model: `${selected.provider}/${selected.id}`,
          source: payload.selectedSource,
          systemPrompt: request.systemPrompt ?? "",
          hasTools: Object.prototype.hasOwnProperty.call(request, "tools"),
          cacheRetention: options.cacheRetention,
          sessionId: options.sessionId,
        });
        if (calls.length === 1) onRescueCall?.(entries, controller);
        return {
          role: "assistant",
          content: [{
            type: "text",
            text: selected.id === main.id
              ? "The old prefix records completed historical implementation work and its durable technical outcomes."
              : "The checkpoint retains the historical implementation results and the current protected request.",
          }],
          stopReason: "stop",
          usage: USAGE,
          timestamp: Date.now(),
        };
      },
    },
    sessionManager: {
      buildContextEntries: () => entries,
      getBranch: () => entries,
      getSessionId: () => "tier-one-rescue-test",
      getSessionFile: () => sessionFile,
    },
    getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 }),
  };
  const { api, handlers } = captureApi();
  createAcpExtension({
    autoUpdate: false,
    delegate: false,
    preserveRecentMessages: 2,
    clearing: { enabled: false },
    coreOverrides: {
      preserveRecentTokens: 0,
      compress: { minCompressRange: 1_000, minSummaryLength: 50, maxSummaryLength: 20_000 },
    },
    compress: {
      model: "openai/checkpoint-model",
      tier1Compressor,
      checkpointCompressor: "configured",
    },
  })(api);
  const handler = handlers.get("session_before_compact")?.[0];
  assert.ok(handler);
  return { dir, sessionFile, entries, calls, controller, handler, ctx };
}

function compactionEvent(entries: SessionEntry[], controller: AbortController, reason: "manual" | "threshold" = "threshold") {
  const messages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  return {
    type: "session_before_compact",
    reason,
    willRetry: false,
    signal: controller.signal,
    branchEntries: entries,
    preparation: {
      firstKeptEntryId: "e6",
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 150_000,
      fileOps: {},
      settings: {},
    },
  };
}

test("synchronous Tier-1 rescue uses the authenticated configured model before checkpoint fallback", async (t) => {
  const fixture = await rescueFixture();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  const result = await fixture.handler(compactionEvent(fixture.entries, fixture.controller), fixture.ctx) as {
    cancel?: boolean;
    compaction?: { summary: string };
  } | undefined;

  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0]!.model, "openai/checkpoint-model");
  assert.equal(fixture.calls[1]!.model, "openai/checkpoint-model");
  assert.equal(fixture.calls[0]!.hasTools, false, "isolated rescue does not expose tools");
  assert.match(fixture.calls[0]!.systemPrompt, /within 40000 characters/);
  assert.equal(fixture.calls[0]!.cacheRetention, "none");
  assert.notEqual(fixture.calls[0]!.sessionId, "tier-one-rescue-test");
  assert.match(fixture.calls[0]!.source, /OLD_ALPHA/);
  assert.match(fixture.calls[0]!.source, /OLD_DELTA/);
  assert.doesNotMatch(fixture.calls[0]!.source, /RECENT_PROTECTED|CURRENT_REQUEST/);
  assert.equal(result?.cancel, undefined, "uncalibrated rescue cannot cancel host compaction");
  assert.match(result?.compaction?.summary ?? "", /Hybrid ACP checkpoint/);

  const state = JSON.parse(await readFile(`${fixture.sessionFile}.acp.json`, "utf8")) as {
    blocks: Array<{
      tier: number;
      effectiveMessageIds: string[];
      sourceHash?: string;
      summaryHash?: string;
      manifest?: { sourceHash?: string };
      provenance?: { requestedRoute?: string; execution?: string; provider?: string; model?: string; promptVersion?: string };
      quality?: { status?: string };
    }>;
  };
  assert.equal(state.blocks.length, 1);
  const block = state.blocks[0]!;
  assert.equal(block.tier, 1);
  assert.deepEqual(block.effectiveMessageIds, ["e1", "e2", "e3", "e4"]);
  assert.match(block.sourceHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(block.summaryHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(block.manifest?.sourceHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(block.provenance?.requestedRoute, "configured");
  assert.equal(block.provenance?.execution, "isolated-configured");
  assert.equal(block.provenance?.provider, "openai");
  assert.equal(block.provenance?.model, "checkpoint-model");
  assert.equal(block.provenance?.promptVersion, "hybrid-acp-v2-tier-one-rescue");
  assert.ok(block.quality?.status === "passed" || block.quality?.status === "repaired");
});

test("a committed Tier-1 rescue cancels threshold compaction only with a fresh verified safe projection", async (t) => {
  const fixture = await rescueFixture();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));
  const state = createInitialState("tier-one-rescue-test");
  state.policyState.tokenCalibration["openai/main-model"] = {
    samples: 2,
    ratio: 1,
    verified: true,
    anchorProviderTokens: 100_000,
    anchorLocalTokens: 100_000,
    anchorEpoch: 0,
    fixedOverheadTokens: 0,
    lastProviderTokens: 150_000,
    lastEstimatedTokens: 150_000,
    updatedAt: Date.now(),
  };
  await writeFile(`${fixture.sessionFile}.acp.json`, JSON.stringify(state), "utf8");

  const result = await fixture.handler(compactionEvent(fixture.entries, fixture.controller), fixture.ctx) as {
    cancel?: boolean;
    compaction?: { summary: string };
  } | undefined;

  assert.deepEqual(result, { cancel: true });
  assert.equal(fixture.calls.length, 1, "safe rescue cancels before configured checkpoint generation");
  assert.equal(fixture.calls[0]!.model, "openai/checkpoint-model");
});

test("main Tier-1 routing skips configured rescue while configured checkpoint routing remains independent", async (t) => {
  const fixture = await rescueFixture(undefined, "main");
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  const result = await fixture.handler(compactionEvent(fixture.entries, fixture.controller), fixture.ctx) as { compaction?: { summary?: string } } | undefined;
  assert.match(result?.compaction?.summary ?? "", /Hybrid ACP checkpoint/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0]!.model, "openai/checkpoint-model");
  await assert.rejects(readFile(`${fixture.sessionFile}.acp.json`, "utf8"), /ENOENT/);
});

test("manual compaction does not run synchronous model rescue", async (t) => {
  const fixture = await rescueFixture();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  const result = await fixture.handler(compactionEvent(fixture.entries, fixture.controller, "manual"), fixture.ctx);

  assert.equal(result, undefined);
  assert.equal(fixture.calls.length, 0);
});

test("Tier-1 rescue failure falls through to configured checkpoint fallback", async (t) => {
  const fixture = await rescueFixture(() => {
    throw new Error("configured rescue failed");
  });
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  const result = await fixture.handler(compactionEvent(fixture.entries, fixture.controller), fixture.ctx);

  assert.match((result as { compaction?: { summary?: string } } | undefined)?.compaction?.summary ?? "", /Hybrid ACP checkpoint/);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0]!.model, "openai/checkpoint-model");
  assert.equal(fixture.calls[1]!.model, "openai/checkpoint-model");
});

test("Tier-1 rescue abort preserves host compaction without committing a block", async (t) => {
  const fixture = await rescueFixture((_entries, controller) => controller.abort(new Error("stop rescue")));
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  const result = await fixture.handler(compactionEvent(fixture.entries, fixture.controller), fixture.ctx);

  assert.equal(result, undefined);
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(readFile(`${fixture.sessionFile}.acp.json`, "utf8"), /ENOENT/);
});

test("Tier-1 rescue rejects a stale raw prefix and preserves host fallback", async (t) => {
  const fixture = await rescueFixture((entries) => {
    entries[0] = userEntry("e1", `CHANGED_AFTER_SNAPSHOT ${"new branch content ".repeat(180)}`);
  });
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  const result = await fixture.handler(compactionEvent(fixture.entries, fixture.controller), fixture.ctx);

  assert.equal(result, undefined);
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(readFile(`${fixture.sessionFile}.acp.json`, "utf8"), /ENOENT/);
});
