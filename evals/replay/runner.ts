import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptyMetrics, replayFixture } from "./engine.js";
import { runProductionChecks } from "./production-checks.js";
import type { EvaluationMetrics, ReplayCaseResult, ReplayEvent, ReplayFixture } from "./types.js";

const evalsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(evalsRoot, "fixtures");
const fixtureFilter = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
const reliabilityCounterKeys = [
  "invariantFailures", "malformedOutputsRejected", "timeoutAbortCommitsPrevented", "stateWriteFailuresRolledBack",
  "staleProposalsRejected", "providerSwitchesHandled", "protocolPairViolations", "sidecarRecoveries", "checkpoints",
  "delegateCompletionsRetained", "extensionMutationsRecompiled", "hostCheckpointAllowed", "hostCompactionCanceled",
  "shadowCommitsPrevented", "networkRequests",
] as const;
const eventTypes = new Set([
  "turn", "usage", "host-compaction", "mutation", "compactor", "state-write", "proposal-start", "proposal-complete",
  "branch-switch", "provider-switch", "configured-chunk", "protocol-range", "sidecar", "checkpoint",
  "delegate-completion", "extension-context-mutation", "shadow-proposal", "quality", "quality-content", "baseline",
]);
const assertionOps = new Set(["eq", "lte", "gte"]);
let networkRequests = 0;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: (): never => {
    networkRequests++;
    throw new Error("Network access is disabled in the replay harness.");
  },
});

const files = (await fs.readdir(fixtureRoot))
  .filter((name) => name.endsWith(".json"))
  .filter((name) => fixtureFilter.length === 0 || fixtureFilter.some((filter) => name.includes(filter)))
  .sort();

if (files.length === 0) {
  console.error("No replay fixtures matched.");
  process.exitCode = 1;
} else {
  const results: ReplayCaseResult[] = [];
  const fixtures: ReplayFixture[] = [];
  for (const file of files) {
    const fixture = await loadFixture(path.join(fixtureRoot, file));
    fixtures.push(fixture);
    results.push(replayFixture(fixture));
  }
  const production = await runProductionChecks();
  const failed = results.filter((result) => !result.passed);
  const totalFailures = failed.length + production.failed + networkRequests;
  const output = {
    schemaVersion: 1,
    runner: "hybrid-acp-no-network-replay",
    deterministic: true,
    network: "disabled",
    summary: {
      fixtures: results.length,
      passed: results.length - failed.length,
      failed: totalFailures,
    },
    metrics: aggregateMetrics(results, fixtures, networkRequests),
    production,
    baselines: Object.fromEntries(results.filter((result) => result.id.startsWith("baseline-")).map((result) => [result.id, result.metrics])),
    cases: results,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (totalFailures > 0) process.exitCode = 1;
}

async function loadFixture(file: string): Promise<ReplayFixture> {
  const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: fixture root must be an object`);
  const candidate = parsed as Partial<ReplayFixture>;
  if (candidate.schemaVersion !== 1 || typeof candidate.id !== "string" || !Array.isArray(candidate.events) || !Array.isArray(candidate.assertions)) {
    throw new Error(`${file}: invalid replay fixture schema`);
  }
  if (candidate.mode !== "authoritative" && candidate.mode !== "shadow") throw new Error(`${file}: invalid replay mode`);
  if (!candidate.initial || typeof candidate.initial !== "object") throw new Error(`${file}: initial state is required`);
  if (candidate.events.length === 0 || candidate.assertions.length === 0) throw new Error(`${file}: fixtures need events and assertions`);
  for (const event of candidate.events) {
    if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string" || !eventTypes.has(event.type)) throw new Error(`${file}: unknown replay event`);
  }
  for (const assertion of candidate.assertions) {
    if (!assertion || typeof assertion.path !== "string" || !assertionOps.has(assertion.op)) throw new Error(`${file}: invalid assertion`);
  }
  return candidate as ReplayFixture;
}

function aggregateMetrics(results: ReplayCaseResult[], fixtures: ReplayFixture[], observedNetworkRequests: number): EvaluationMetrics {
  const output = emptyMetrics();
  const activeInputs = fixtures.flatMap((fixture) => fixture.events.flatMap((event) => event.type === "turn" ? [event.activeInputTokens] : []));
  const turns = activeInputs.length;
  const mutations = fixtures.flatMap((fixture) => fixture.events).filter((event) => event.type === "mutation");
  const allEvents = fixtures.flatMap((fixture) => fixture.events);
  const quality = allEvents.filter((event) => event.type === "quality");
  const qualityContent = allEvents.filter((event) => event.type === "quality-content");
  const latencies = allEvents.flatMap((event) => event.type === "compactor" ? [event.latencyMs] : []);
  for (const result of results) {
    const metrics = result.metrics;

    output.context.cachedInputTokens += metrics.context.cachedInputTokens;
    output.context.uncachedInputTokens += metrics.context.uncachedInputTokens;
    output.context.tokensReclaimed += metrics.context.tokensReclaimed;

    output.context.emergencyCheckpointFrequency += metrics.context.emergencyCheckpointFrequency;
    output.cost.mainCompactionOutputTokens += metrics.cost.mainCompactionOutputTokens;
    output.cost.configuredInputTokens += metrics.cost.configuredInputTokens;
    output.cost.configuredOutputTokens += metrics.cost.configuredOutputTokens;
    output.cost.compactionLatencyMs += metrics.cost.compactionLatencyMs;
    output.quality.repeatedRetrievalCount += metrics.quality.repeatedRetrievalCount;
    output.quality.falseConfidenceCount += metrics.quality.falseConfidenceCount;
    for (const key of reliabilityCounterKeys) output.reliability[key] += metrics.reliability[key];
    output.reliability.maxConfiguredChunkTokens = Math.max(output.reliability.maxConfiguredChunkTokens, metrics.reliability.maxConfiguredChunkTokens);
  }
  output.context.activeInputP50 = percentile(activeInputs, 0.5);
  output.context.activeInputP90 = percentile(activeInputs, 0.9);
  output.context.activeInputP95 = percentile(activeInputs, 0.95);
  output.context.tokensReclaimedPerMutation = rounded(output.context.tokensReclaimed / Math.max(1, mutations.length));
  output.context.mutationsPer100Turns = rounded(mutations.length * 100 / Math.max(1, turns));
  output.context.cacheHitBefore = rounded(mutations.reduce((sum, event) => sum + event.cacheHitBefore, 0) / Math.max(1, mutations.length));
  output.context.cacheHitAfter = rounded(mutations.reduce((sum, event) => sum + event.cacheHitAfter, 0) / Math.max(1, mutations.length));
  output.cost.compactionLatencyP50Ms = percentile(latencies, 0.5);
  output.cost.compactionLatencyP95Ms = percentile(latencies, 0.95);
  output.quality.exactUserConstraintRetention = combinedRate(quality, "constraintsRetained", "constraintsTotal", qualityContent, "userConstraints");
  output.quality.exactFactRetention = combinedRate(quality, "exactFactsRetained", "exactFactsTotal", qualityContent, "exactFacts");
  output.quality.unresolvedWorkRetention = combinedRate(quality, "unresolvedRetained", "unresolvedTotal", qualityContent, "unresolvedWork");
  output.quality.contradictionRate = rate(quality, "contradictions", "summaries");
  output.quality.retrievalSuccessRate = rate(quality, "retrievalSuccesses", "retrievalAttempts");
  output.quality.continuationSuccessRate = rate(quality, "continuationSuccesses", "continuationAttempts");
  output.quality.testCompletionRate = rate(quality, "testsCompleted", "testsAttempted");
  output.reliability.networkRequests += observedNetworkRequests;
  return output;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function rate(
  events: Array<Extract<ReplayEvent, { type: "quality" }>>,
  numerator: keyof Extract<ReplayEvent, { type: "quality" }>,
  denominator: keyof Extract<ReplayEvent, { type: "quality" }>,
): number {
  const top = events.reduce((sum, event) => sum + numericField(event[numerator]), 0);
  const bottom = events.reduce((sum, event) => sum + numericField(event[denominator]), 0);
  return rounded(top / Math.max(1, bottom));
}

function combinedRate(
  events: Array<Extract<ReplayEvent, { type: "quality" }>>,
  numerator: keyof Extract<ReplayEvent, { type: "quality" }>,
  denominator: keyof Extract<ReplayEvent, { type: "quality" }>,
  contentEvents: Array<Extract<ReplayEvent, { type: "quality-content" }>>,
  contentKey: "userConstraints" | "exactFacts" | "unresolvedWork",
): number {
  const claimedTop = events.reduce((sum, event) => sum + numericField(event[numerator]), 0);
  const claimedBottom = events.reduce((sum, event) => sum + numericField(event[denominator]), 0);
  const contentTop = contentEvents.reduce((sum, event) => sum + event[contentKey].filter((value) => event.summary.includes(value)).length, 0);
  const contentBottom = contentEvents.reduce((sum, event) => sum + event[contentKey].length, 0);
  return rounded((claimedTop + contentTop) / Math.max(1, claimedBottom + contentBottom));
}

function numericField(value: string | number): number {
  return typeof value === "number" ? value : 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}
