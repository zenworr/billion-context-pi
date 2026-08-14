import { test } from "node:test";
import assert from "node:assert/strict";
import { TransactionalBackgroundJobs, type JobSnapshot } from "../src/background-jobs.js";
import { routeCompaction } from "../src/compaction-routing.js";
import { OptimizationTelemetry } from "../src/optimization-telemetry.js";
import { QualityAdapter } from "../src/quality-adaptation.js";

function snapshot(revision = 1, hash = "a"): JobSnapshot {
  return { sessionId: "s1", revision, sourceHashes: { b1: hash }, treeKey: "leaf", modelKey: "p/m" };
}

test("background job commits only when revision and source hashes remain unchanged", async () => {
  const jobs = new TransactionalBackgroundJobs();
  let committed = 0;
  const result = await jobs.schedule("turn_end", {
    capture: async () => snapshot(),
    generate: async () => "summary",
    current: async () => snapshot(),
    commit: async () => { committed++; return true; },
  });
  assert.equal(result, "committed");
  assert.equal(committed, 1);
});

test("stale jobs are discarded after bounded replan", async () => {
  const jobs = new TransactionalBackgroundJobs();
  let captures = 0;
  let committed = 0;
  const result = await jobs.schedule("agent_end", {
    capture: async () => snapshot(++captures),
    generate: async () => "summary",
    current: async (planned) => snapshot(planned.revision + 1),
    commit: async () => { committed++; return true; },
    maxReplans: 1,
  });
  assert.equal(result, "stale");
  assert.equal(captures, 2);
  assert.equal(committed, 0);
});

test("source hash changes abort commit even at the same revision", async () => {
  const jobs = new TransactionalBackgroundJobs();
  const result = await jobs.schedule("turn_end", {
    capture: async () => snapshot(1, "old"),
    generate: async () => "summary",
    current: async () => snapshot(1, "new"),
    commit: async () => true,
    maxReplans: 0,
  });
  assert.equal(result, "stale");
});

test("tree, model, session, and shutdown cancellation abort active generation", async () => {
  for (const reason of ["tree", "model", "session", "shutdown"] as const) {
    const jobs = new TransactionalBackgroundJobs();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = jobs.schedule("turn_end", {
      capture: async () => snapshot(),
      generate: async (_snapshot, signal) => {
        await gate;
        if (signal.aborted) throw new Error("aborted");
        return "summary";
      },
      current: async () => snapshot(),
      commit: async () => true,
    });
    await Promise.resolve();
    jobs.cancelAll(reason);
    release();
    assert.equal(await pending, "aborted");
  }
});

test("shadow mode generates and validates without commit", async () => {
  const jobs = new TransactionalBackgroundJobs();
  let generated = 0;
  let committed = 0;
  const result = await jobs.schedule("agent_end", {
    capture: async () => snapshot(),
    generate: async () => { generated++; return "scored summary"; },
    current: async () => snapshot(),
    commit: async () => { committed++; return true; },
    shadow: true,
  });
  assert.equal(result, "shadowed");
  assert.equal(generated, 1);
  assert.equal(committed, 0);
});

test("cost-aware routing is opt-in and needs telemetry for both routes", () => {
  const telemetry = new OptimizationTelemetry();
  const base = { explicit: "configured" as const, configuredAvailable: true, mainAvailable: true };
  assert.equal(routeCompaction({ ...base, costAware: false }, telemetry), "configured");
  assert.equal(routeCompaction({ ...base, costAware: true }, telemetry), "configured");
  telemetry.recordUsage("configured", { input: 100, output: 10, cacheRead: 20, cost: { total: 0.01 } });
  telemetry.recordUsage("main", { input: 100, output: 10, cacheRead: 80, cost: { total: 0.001 } });
  assert.equal(routeCompaction({ ...base, costAware: true }, telemetry), "main");
  telemetry.recordMutation({ savingsTokens: 12_000, latencyMs: 25 });
  assert.deepEqual(telemetry.snapshot().configured, {
    calls: 1, cachedInput: 20, uncachedInput: 80, output: 10, cost: 0.01,
  });
  assert.deepEqual(telemetry.snapshot().mutation, {
    count: 1, savingsTokens: 12_000, latencyMs: 25, discarded: 0, shadowed: 0,
  });
});

test("quality adaptation escalates thinking within bounds and then recommends fallback", () => {
  const adaptation = new QualityAdapter();
  const policy = { enabled: true, fallbackAfterFailures: 2, maxThinking: "high" as const };
  assert.deepEqual(adaptation.decide("p/m", 2, "low", policy), { thinking: "low", fallback: false });
  adaptation.record("p/m", 2, "failed");
  assert.deepEqual(adaptation.decide("p/m", 2, "low", policy), { thinking: "medium", fallback: false });
  adaptation.record("p/m", 2, "fallback");
  assert.deepEqual(adaptation.decide("p/m", 2, "low", policy), { thinking: "high", fallback: true });
  adaptation.record("p/m", 2, "passed");
  assert.deepEqual(adaptation.decide("p/m", 2, "low", policy), { thinking: "low", fallback: false });
});
