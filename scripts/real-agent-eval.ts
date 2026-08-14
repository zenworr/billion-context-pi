#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInitialState, type CompressionState, type CoreMessage } from "acp-kernel";
import { createRuntime } from "../packages/pi-extension/src/runtime.js";
import { entriesToCoreMessages } from "../packages/pi-extension/src/messages.js";

interface Scenario {
  id: string;
  actingModel: string;
  writer: "main" | "configured";
  targetTier: 1 | 2 | 3 | "host";
  window: number;
  entries: number;
  charsPerEntry: number;
  configuredModel?: string;
}

interface ScenarioResult {
  id: string;
  actingModel: string;
  actingFamily: string;
  writer: string;
  targetTier: number | "host";
  configuredWindow: number;
  exitCode: number | null;
  timedOut: boolean;
  taskSuccess: boolean;
  statusCalls: number;
  compressionCalls: number;
  validCompressionActions: number;
  recoveryLoops: number;
  netSavingsTokens: number;
  cacheReadTokens: number;
  fallbackCount: number;
  falseConfidence: boolean;
  hostCheckpointObserved: boolean;
  stateBlocksCreated: number;
  actualWriter?: string;
  actualProvider?: string;
  fallbackReason?: string;
  stderrTail?: string;
}

const root = resolve(new URL("..", import.meta.url).pathname);
const extension = join(root, "packages/pi-extension/dist/index.js");
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const outputPath = resolve(outputArg?.slice("--output=".length) ?? join(root, "evals/real-agent/latest.json"));
const quick = process.argv.includes("--quick");
const artifactsDir = join(dirname(outputPath), "artifacts");
await mkdir(artifactsDir, { recursive: true });
const actingModelA = process.env.ACP_REAL_ACTING_MODEL_A ?? "openai-codex/gpt-5.4";
const actingModelB = process.env.ACP_REAL_ACTING_MODEL_B ?? "openai-codex/gpt-5.6-luna";
const configuredModel = process.env.ACP_REAL_CONFIGURED_MODEL ?? actingModelB;
const scenarios: Scenario[] = quick ? [
  { id: "small-main-family-a", actingModel: actingModelA, writer: "main", targetTier: 1, window: 32_000, entries: 12, charsPerEntry: 500 },
  { id: "medium-configured-family-b", actingModel: actingModelB, writer: "configured", targetTier: 1, window: 128_000, entries: 28, charsPerEntry: 1_200 },
] : [
  { id: "small-main-family-a", actingModel: actingModelA, writer: "main", targetTier: 1, window: 32_000, entries: 12, charsPerEntry: 500 },
  { id: "medium-main-family-b", actingModel: actingModelB, writer: "main", targetTier: 1, window: 128_000, entries: 36, charsPerEntry: 1_500 },
  { id: "medium-configured-family-a", actingModel: actingModelA, writer: "configured", targetTier: 1, window: 128_000, entries: 36, charsPerEntry: 1_500 },
  { id: "large-main-tier2-family-a", actingModel: actingModelA, writer: "main", targetTier: 2, window: 272_000, entries: 52, charsPerEntry: 1_800 },
  { id: "large-configured-tier3-family-b", actingModel: actingModelB, writer: "configured", targetTier: 3, window: 272_000, entries: 64, charsPerEntry: 1_800 },
  { id: "small-host-checkpoint-family-b", actingModel: actingModelB, writer: "configured", targetTier: "host", window: 32_000, entries: 72, charsPerEntry: 2_000 },
];
const requestedCrossProviderModel = process.env.ACP_REAL_CROSS_PROVIDER_MODEL;
if (requestedCrossProviderModel) {
  scenarios.push({
    id: "cross-provider-configured",
    actingModel: actingModelA,
    writer: "configured",
    targetTier: 1,
    window: 128_000,
    entries: 36,
    charsPerEntry: 1_500,
    configuredModel: requestedCrossProviderModel,
  });
}

const workspace = await mkdtemp(join(tmpdir(), "acp-real-agent-"));
const results: ScenarioResult[] = [];
try {
  for (const scenario of scenarios) {
    const dir = join(workspace, scenario.id);
    await mkdir(join(dir, ".pi"), { recursive: true });
    const sessionId = randomUUID();
    const sessionFile = join(dir, `${sessionId}.jsonl`);
    const entries = makeEntries(scenario, sessionId, dir);
    await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(join(dir, ".pi/acp.json"), JSON.stringify({
      modelContextLimit: scenario.window,
      compress: {
        model: scenario.configuredModel ?? configuredModel,
        tier1Compressor: scenario.writer,
        tier2Compressor: scenario.writer,
        tier3Compressor: scenario.writer,
        checkpointCompressor: scenario.writer,
        allowCrossProvider: true,
        acknowledgeCrossProviderDataTransfer: true,
        maxModelCalls: 4,
        maxDurationMs: 120_000,
        minimumNetSavingsTokens: 64,
        minimumNetSavingsPercent: 0.01,
      },
      preserveRecentMessages: 1,
      minWorthwhileTokens: 1,
    }, null, 2));
    if (scenario.targetTier === 2 || scenario.targetTier === 3) {
      await seedTierState(sessionFile, sessionId, entries, scenario.targetTier, scenario.writer, scenario.window, scenario.configuredModel ?? configuredModel, dir);
    }
    const initialState = await readStateEvidence(`${sessionFile}.acp.json`);
    const prompt = scenario.targetTier === "host"
      ? "/compact"
      : `This is an ACP real-agent evaluation. Call acp_status exactly once. If it reports a valid Tier-${scenario.targetTier} range, follow the ACP system instructions exactly and compress only one recommended range. Then call acp_status once more and answer EVAL_DONE in one sentence. Do not use other tools.`;
    const [actingProvider, actingModel] = scenario.actingModel.split("/", 2) as [string, string];
    const run = spawnSync("pi", [
      "--mode", "json", "--print", "--approve", "--no-extensions", "--no-builtin-tools",
      "--extension", extension,
      "--tools", "plan_compression,compress,acp_status,search_context,decompress,pin_context,acp_artifact",
      "--provider", actingProvider, "--model", actingModel, "--thinking", "minimal", "--session", sessionFile, prompt,
    ], { cwd: dir, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ACP_AUTO_UPDATE: "0" } });
    await writeFile(join(artifactsDir, `${scenario.id}.jsonl`), `${run.stdout ?? ""}\n${run.stderr ? `# stderr\n${run.stderr}` : ""}`);
    const finalState = await readStateEvidence(`${sessionFile}.acp.json`);
    const sessionEvidence = await readSessionEvidence(sessionFile, entries.length);
    results.push(summarizeScenario(scenario, run.status, run.signal === "SIGTERM", run.stdout ?? "", run.stderr ?? "", initialState, finalState, sessionEvidence));
  }
} finally {
  if (process.env.ACP_KEEP_REAL_AGENT_WORKSPACE !== "1") await rm(workspace, { recursive: true, force: true });
}

const actingProvider = actingModelA.split("/", 1)[0]!;
const requestedCrossProvider = requestedCrossProviderModel?.split("/", 1)[0];
const crossResult = results.find((result) => result.id === "cross-provider-configured");
const crossProvider = !requestedCrossProviderModel
  ? { status: "unavailable", reason: "ACP_REAL_CROSS_PROVIDER_MODEL and corresponding provider credential were not supplied; no cross-provider success is claimed." }
  : requestedCrossProvider === actingProvider
    ? { status: "invalid", model: requestedCrossProviderModel, reason: "Configured model uses the same provider as the acting model." }
    : crossResult?.taskSuccess && crossResult.validCompressionActions > 0
      && crossResult.actualWriter === "configured"
      && crossResult.actualProvider === requestedCrossProvider
      && !crossResult.fallbackReason
      ? { status: "verified", model: requestedCrossProviderModel, scenario: crossResult.id, actualProvider: crossResult.actualProvider }
      : { status: "failed", model: requestedCrossProviderModel, reason: "The real cross-provider scenario did not complete a valid compression action." };
const totalCompressionCalls = results.reduce((sum, result) => sum + result.compressionCalls, 0);
const totalValidActions = results.reduce((sum, result) => sum + result.validCompressionActions, 0);
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: `${process.platform}/${process.arch}`, crossProvider },
  matrix: {
    actingFamilies: [...new Set(results.map((result) => result.actingFamily))],
    windows: [...new Set(results.map((result) => result.configuredWindow))],
    writers: [...new Set(results.map((result) => result.writer))],
    tiers: [...new Set(results.map((result) => result.targetTier))],
  },
  aggregate: {
    scenarios: results.length,
    taskSuccessRate: results.filter((result) => result.taskSuccess).length / Math.max(1, results.length),
    validActionRate: totalValidActions / Math.max(1, totalCompressionCalls),
    recoveryLoops: results.reduce((sum, result) => sum + result.recoveryLoops, 0),
    netSavingsTokens: results.reduce((sum, result) => sum + result.netSavingsTokens, 0),
    cacheReadTokens: results.reduce((sum, result) => sum + result.cacheReadTokens, 0),
    falseConfidenceCount: results.filter((result) => result.falseConfidence).length,
    fallbackCount: results.reduce((sum, result) => sum + result.fallbackCount, 0),
  },
  scenarios: results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.env.ACP_REAL_AGENT_REQUIRE_CROSS_PROVIDER === "1" && crossProvider.status !== "verified") process.exitCode = 2;
else if (results.some((result) => !result.taskSuccess)) process.exitCode = 1;

function makeEntries(scenario: Scenario, sessionId: string, cwd: string): Array<Record<string, unknown>> {
  const now = new Date().toISOString();
  const entries: Array<Record<string, unknown>> = [{ type: "session", version: 3, id: sessionId, timestamp: now, cwd }];
  let parentId: string | null = null;
  for (let index = 0; index < scenario.entries; index++) {
    const id = `entry-${String(index + 1).padStart(4, "0")}`;
    const role = index % 2 === 0 ? "user" : "assistant";
    const text = `${scenario.id} historical ${index + 1}: ` + `${String.fromCharCode(97 + index % 26)} durable context `.repeat(Math.ceil(scenario.charsPerEntry / 18));
    const message = role === "user"
      ? { role, content: text, timestamp: Date.now() + index }
      : {
          role,
          content: [{ type: "text", text }],
          timestamp: Date.now() + index,
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
    entries.push({ type: "message", id, parentId, timestamp: now, message });
    parentId = id;
  }
  return entries;
}

async function seedTierState(
  sessionFile: string,
  sessionId: string,
  entries: Array<Record<string, unknown>>,
  targetTier: 2 | 3,
  writer: "main" | "configured",
  window: number,
  model: string,
  cwd: string,
): Promise<void> {
  const adapter = {
    modelContextLimit: window,
    preserveRecentMessages: 1,
    minWorthwhileTokens: 1,
    compress: { model, tier1Compressor: writer, tier2Compressor: writer, tier3Compressor: writer },
  } as const;
  const runtime = createRuntime(adapter);
  const context = {
    cwd,
    model: { provider: "openai-codex", id: "gpt-5.4", contextWindow: 272_000 },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getBranch: () => entries.slice(1) },
  };
  const messages = entriesToCoreMessages(entries.slice(1) as never[]);
  const config = runtime.configFor(context as never);
  let state: CompressionState = runtime.core.processTurn({ messages, state: createInitialState(sessionId), config, tokenCount: 50_000 }).state;
  const t1Ranges = [[3, 8], [9, 14], [15, 20], [21, 26], [27, 32], [33, 38]];
  const needed = targetTier === 2 ? 3 : 6;
  for (let index = 0; index < needed; index++) {
    state = applySeed(runtime, messages, state, config, `m${String(t1Ranges[index]![0]).padStart(5, "0")}`, `m${String(t1Ranges[index]![1]).padStart(5, "0")}`, `Tier-1 seeded source group ${index + 1} retains durable historical context.`);
  }
  if (targetTier === 3) {
    state = applySeed(runtime, messages, state, config, "b1", "b3", "Tier-2 seeded summary A retains the first contiguous durable source groups.");
    state = applySeed(runtime, messages, state, config, "b4", "b6", "Tier-2 seeded summary B retains the second contiguous durable source groups.");
  }
  await runtime.store.save(state, sessionFile, sessionId);
}

function applySeed(runtime: ReturnType<typeof createRuntime>, messages: CoreMessage[], state: CompressionState, config: ReturnType<ReturnType<typeof createRuntime>["configFor"]>, startRef: string, endRef: string, summary: string): CompressionState {
  const result = runtime.core.applyCompression({ ranges: [{ startRef, endRef, summary }], messages, state, config, atomic: true });
  if (result.result.errors.length > 0 || result.result.blocksCreated !== 1) throw new Error(`Could not seed ${startRef}..${endRef}: ${result.result.errors.join("; ")}`);
  return result.state;
}

interface StateEvidence {
  blocks: Array<{ provenance?: { actualWriter?: string; provider?: string; fallbackReason?: string } }>;
  checkpoints: unknown[];
}

interface SessionEvidence {
  statusCalls: number;
  compressionCalls: number;
  compactionEntries: number;
}

async function readStateEvidence(path: string): Promise<StateEvidence> {
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; } catch { return { blocks: [], checkpoints: [] }; }
  try {
    const journal = await readFile(path + ".journal", "utf8");
    const lines = journal.split("\n");
    for (let index = 0; index < lines.length - 1; index++) {
      if (!lines[index]!.trim()) continue;
      const record = JSON.parse(lines[index]!) as { patch?: Record<string, unknown>; revision?: number };
      if (record.patch) Object.assign(state, record.patch, { revision: record.revision });
    }
  } catch { /* no journal or unreadable evidence remains failed */ }
  return {
    blocks: Array.isArray(state.blocks) ? state.blocks as StateEvidence["blocks"] : [],
    checkpoints: Array.isArray(state.checkpoints) ? state.checkpoints : [],
  };
}

async function readSessionEvidence(path: string, initialEntries: number): Promise<SessionEvidence> {
  const evidence: SessionEvidence = { statusCalls: 0, compressionCalls: 0, compactionEntries: 0 };
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines.slice(initialEntries)) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.type === "compaction") evidence.compactionEntries++;
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      if (record.type !== "toolCall" && record.type !== "tool_call") continue;
      const name = typeof record.name === "string" ? record.name : typeof record.toolName === "string" ? record.toolName : "";
      if (name === "acp_status") evidence.statusCalls++;
      if (name === "compress") evidence.compressionCalls++;
    }
  }
  return evidence;
}

function summarizeScenario(scenario: Scenario, exitCode: number | null, timedOut: boolean, stdout: string, stderr: string, initial: StateEvidence, final: StateEvidence, session: SessionEvidence): ScenarioResult {
  const combined = `${stdout}\n${stderr}`;
  const statusCalls = session.statusCalls;
  const compressionCalls = session.compressionCalls;
  const stateBlocksCreated = Math.max(0, final.blocks.length - initial.blocks.length);
  const validCompressionActions = stateBlocksCreated;
  const latest = final.blocks.at(-1)?.provenance;
  const netSavingsTokens = sumMatches(combined, /net savings\D+(\d+)/gi);
  const cacheReadTokens = sumMatches(combined, /"cacheRead"\s*:\s*(\d+)/g);
  const recoveryLoops = count(combined, /bounded recovery|recompile context|recovery action/gi);
  const fallbackCount = count(combined, /fallback|falling back/gi);
  const claimsDone = /EVAL_DONE|compression (?:succeeded|completed)|successfully compressed/i.test(combined);
  const providerError = /"stopReason"\s*:\s*"error"|"type"\s*:\s*"error"|errorMessage/i.test(combined);
  const hostCheckpointObserved = final.checkpoints.length > initial.checkpoints.length && session.compactionEntries > 0;
  return {
    id: scenario.id,
    actingModel: scenario.actingModel,
    actingFamily: scenario.actingModel.split("/", 2)[0]!,
    writer: scenario.writer,
    targetTier: scenario.targetTier,
    configuredWindow: scenario.window,
    exitCode,
    timedOut,
    taskSuccess: exitCode === 0 && !timedOut && !providerError && (scenario.targetTier === "host"
      ? hostCheckpointObserved
      : statusCalls > 0 && compressionCalls > 0 && validCompressionActions > 0),
    statusCalls,
    compressionCalls,
    validCompressionActions,
    recoveryLoops,
    netSavingsTokens,
    cacheReadTokens,
    fallbackCount,
    falseConfidence: claimsDone && compressionCalls > 0 && validCompressionActions === 0,
    hostCheckpointObserved,
    stateBlocksCreated,
    actualWriter: latest?.actualWriter,
    actualProvider: latest?.provider,
    fallbackReason: latest?.fallbackReason,
    ...(stderr.trim() ? { stderrTail: stderr.trim().slice(-1_000) } : {}),
  };
}

function count(value: string, expression: RegExp): number { return [...value.matchAll(expression)].length; }
function sumMatches(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].reduce((sum, match) => sum + Number(match[1] ?? 0), 0);
}
