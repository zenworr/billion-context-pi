import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitCheckpointEpoch,
  createCore,
  createInitialState,
  defaultConfig,
  defaultPrompts,
  type CoreMessage,
} from "../../packages/kernel/src/index.js";
import { shouldCancelHostCompaction } from "../../packages/pi-extension/src/index.js";
import { conservativeTokenCount } from "../../packages/pi-extension/src/tokens.js";
import {
  CompressionModelError,
  compressWithModel,
  type ModelCompressionInput,
} from "../../packages/pi-extension/src/model-compressor.js";
import { SessionStateStore } from "../../packages/pi-extension/src/state.js";
import { parseEventLine } from "../../packages/pi-extension/src/delegate-events.js";

export interface ProductionCheckReport {
  checks: number;
  passed: number;
  failed: number;
  failures: string[];
  observations: {
    conservativeTokens: number;
    hostCompactionCanceled: boolean;
    maxConfiguredChunkTokens: number;
    configuredRequests: number;
    protocolMessagesCompressed: number;
    checkpoints: number;
    delegateCompletions: number;
  };
}

export async function runProductionChecks(): Promise<ProductionCheckReport> {
  const failures: string[] = [];
  let checks = 0;
  const check = (condition: boolean, message: string): void => {
    checks++;
    if (!condition) failures.push(message);
  };

  const conservativeTokens = conservativeTokenCount([203_000, 417_000, 417_000]);
  const hostCompactionCanceled = shouldCancelHostCompaction({
    reason: "threshold",
    changed: false,
    projectedTokens: 203_000,
    hostTokensBefore: conservativeTokens,
    safeThreshold: 233_616,
  });
  check(conservativeTokens === 417_000, `production token accounting returned ${conservativeTokens}, expected 417000`);
  check(!hostCompactionCanceled, "production host coordinator canceled compaction from a stale unchanged projection");

  const protocolMessages = protocolFixtureMessages();
  const core = createCore();
  const config = defaultConfig(258_000, {
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    compress: { minCompressRange: 0, minSummaryLength: 10, maxSummaryLength: 20_000 },
  });
  const turn = core.processTurn({ messages: protocolMessages, state: createInitialState("eval-protocol"), config, tokenCount: 20_000 });
  const startRef = turn.state.messageRefs.byRaw.assistantCall;
  if (!startRef) {
    check(false, "production kernel did not assign a ref to the protocol boundary message");
  }
  const applied = startRef ? core.applyCompression({
    ranges: [{ startRef, endRef: startRef, summary: "Protocol-safe historical summary." }],
    messages: protocolMessages,
    state: turn.state,
    config,
    atomic: true,
  }) : undefined;
  const protocolIds = new Set(applied?.state.blocks.at(-1)?.effectiveMessageIds ?? []);
  check(applied?.result.blocksCreated === 1, `production kernel created ${applied?.result.blocksCreated ?? 0} protocol blocks`);
  check(["reasoning", "assistantCall", "toolResult"].every((id) => protocolIds.has(id)), "production kernel split a reasoning/assistant/tool-result protocol unit");

  const modelCheck = await checkConfiguredModelPath(check);
  await checkStateStore(check);

  let checkpointState = createInitialState("eval-checkpoint");
  for (let index = 0; index < 3; index++) {
    const result = commitCheckpointEpoch(checkpointState, {
      summary: `Checkpoint ${index + 1}`,
      sourceMessageIds: [],
      tokensBefore: 200_000 - index * 10_000,
      createdAt: index + 1,
    });
    checkpointState = result.state;
  }
  check(checkpointState.currentEpoch === 3 && checkpointState.checkpoints.length === 3, "production checkpoint epochs were not monotonic");

  const delegateLines = ["delegate-c", "delegate-a", "delegate-b"].map((id) => JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", content: id } }));
  const delegateCompletions = delegateLines.map(parseEventLine).filter((event) => event?.kind === "reply-complete").length;
  check(delegateCompletions === 3, `production delegate event parser retained ${delegateCompletions}/3 completions`);

  return {
    checks,
    passed: checks - failures.length,
    failed: failures.length,
    failures,
    observations: {
      conservativeTokens,
      hostCompactionCanceled,
      maxConfiguredChunkTokens: modelCheck.maxInputTokens,
      configuredRequests: modelCheck.requests,
      protocolMessagesCompressed: protocolIds.size,
      checkpoints: checkpointState.checkpoints.length,
      delegateCompletions,
    },
  };
}

async function checkConfiguredModelPath(check: (condition: boolean, message: string) => void): Promise<{ maxInputTokens: number; requests: number }> {
  const observedInputs: number[] = [];
  const usage = {
    input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const ctx = {
    modelRegistry: {
      complete: async (_model: unknown, request: { systemPrompt?: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> }, options: { signal?: AbortSignal }) => {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
        const payload = request.messages[0]?.content[0]?.text ?? "";
        observedInputs.push(Math.ceil(((request.systemPrompt ?? "").length + payload.length) / 3));
        return {
          role: "assistant",
          content: [{ type: "text", text: "A deterministic summary that preserves all required fixture facts and remains materially smaller than its source." }],
          stopReason: "stop",
          usage,
          timestamp: 1,
        };
      },
    },
  } as unknown as ModelCompressionInput["ctx"];
  const model = {
    provider: "fixture",
    id: "configured",
    contextWindow: 300_000,
    maxTokens: 8_192,
    reasoning: false,
  } as unknown as ModelCompressionInput["model"];
  const oversizedSource = "x".repeat(1_590_000);
  await compressWithModel({
    ctx, model, thinkingLevel: "off", tier: 1, source: oversizedSource,
    prompts: defaultPrompts, summaryMaxChars: 20_000, maxInputTokens: 220_000,
  });
  const maxInputTokens = Math.max(...observedInputs);
  check(observedInputs.length > 1, "production configured compressor did not chunk oversized input");
  check(maxInputTokens <= 220_000, `production configured compressor sent a ${maxInputTokens}-token request`);

  const emptyCtx = {
    modelRegistry: {
      complete: async () => ({ role: "assistant", content: [], stopReason: "stop", usage, timestamp: 1 }),
    },
  } as unknown as ModelCompressionInput["ctx"];
  let emptyRejected = false;
  try {
    await compressWithModel({ ctx: emptyCtx, model, thinkingLevel: "off", tier: 1, source: "historical source", prompts: defaultPrompts, summaryMaxChars: 20_000 });
  } catch (error) {
    emptyRejected = error instanceof CompressionModelError;
  }
  check(emptyRejected, "production configured compressor accepted an empty response");

  const controller = new AbortController();
  controller.abort(new Error("fixture abort"));
  let abortRejected = false;
  try {
    await compressWithModel({ ctx, model, thinkingLevel: "off", tier: 1, source: "historical source", prompts: defaultPrompts, summaryMaxChars: 20_000, signal: controller.signal });
  } catch {
    abortRejected = true;
  }
  check(abortRejected, "production configured compressor ignored an aborted signal");
  return { maxInputTokens, requests: observedInputs.length };
}

async function checkStateStore(check: (condition: boolean, message: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-acp-eval-"));
  try {
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "{}\n", "utf8");
    await fs.writeFile(`${sessionFile}.acp.json`, "{broken", "utf8");
    const store = new SessionStateStore();
    const recovered = await store.load(sessionFile, "eval-state");
    const files = await fs.readdir(root);
    check(recovered.revision === 0 && files.some((file) => file.startsWith("session.jsonl.acp.json.corrupt-")), "production state store did not quarantine and rebuild a corrupt sidecar");

    const persisted = await store.save(recovered, sessionFile, "eval-state");
    let staleRejected = false;
    try {
      await store.save(recovered, sessionFile, "eval-state");
    } catch {
      staleRejected = true;
    }
    check(persisted.revision === 1 && staleRejected, "production state store accepted a stale revision");

    const blocker = path.join(root, "blocker");
    await fs.writeFile(blocker, "not a directory", "utf8");
    const failedStore = new SessionStateStore();
    const failedSession = path.join(blocker, "session.jsonl");
    const initial = await failedStore.load(failedSession, "eval-write-failure");
    let writeRejected = false;
    try {
      await failedStore.save(initial, failedSession, "eval-write-failure");
    } catch {
      writeRejected = true;
    }
    const afterFailure = await failedStore.load(failedSession, "eval-write-failure");
    check(writeRejected && afterFailure.revision === initial.revision, "production state write failure changed cached revision or reported success");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function protocolFixtureMessages(): CoreMessage[] {
  return [
    { id: "userOld", role: "user", contentType: "text", text: "Investigate the old protocol trace." },
    { id: "reasoning", role: "assistant", contentType: "reasoning", text: "paired reasoning" },
    { id: "assistantCall", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call-1", text: "src/session.ts" },
    { id: "toolResult", role: "tool", contentType: "tool-result", toolName: "read", toolCallId: "call-1", text: "historical result" },
    { id: "assistantText", role: "assistant", contentType: "text", text: "The old trace completed." },
    { id: "userCurrent", role: "user", contentType: "text", text: "Current request remains visible." },
  ];
}
