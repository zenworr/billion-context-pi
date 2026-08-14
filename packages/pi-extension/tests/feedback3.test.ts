import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInitialState } from "acp-kernel";
import { auditProviderPayload, deepFreezeProviderPayload, sanitizeUnsafeProviderMedia } from "../src/provider-audit.js";
import { FreshnessTracker } from "../src/freshness.js";
import { ToolOutputBudget } from "../src/tool-budget.js";
import { redactCompactionTransfer } from "../src/compress-tool.js";
import { applyUserConfig, loadUserConfig } from "../src/user-config.js";
import { validateAndRepairSummary, structuredSummaryFromRendered, extractCompressionManifest } from "../src/manifest.js";
import { createRuntime } from "../src/runtime.js";
import { makePlanCompressionTool } from "../src/compression-plan-tool.js";
import { makeCompressTool } from "../src/compress-tool.js";
import { nextAutomaticCooldown } from "../src/automatic-compaction.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acp-f3-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function ctx(cwd: string, sessionFile: string, entries: unknown[] = []) {
  return {
    cwd,
    model: { provider: "test", id: "model", contextWindow: 200_000 },
    sessionManager: {
      getSessionId: () => "feedback3-session",
      getSessionFile: () => sessionFile,
      getEntries: () => [],
      getBranch: () => entries,
    },
  };
}

test("provider payload auditor fingerprints canonical payload, tools, system prompt, and bounded media", () => {
  const payload = {
    tools: [{ name: "read", parameters: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "x".repeat(100_000), width: 1024, height: 768 }] }],
    system: "system policy",
  };
  const first = auditProviderPayload(payload, "openai");
  const reordered = auditProviderPayload({ system: payload.system, messages: payload.messages, tools: payload.tools }, "openai");
  assert.equal(first.canonicalPayloadHash, reordered.canonicalPayloadHash);
  assert.equal(first.systemPromptFingerprint, reordered.systemPromptFingerprint);
  assert.ok(first.toolSchemaFingerprint);
  assert.ok(first.mediaTokens > 0);
  assert.equal(first.mediaVerified, true);
  const unknown = auditProviderPayload({ messages: [{ content: [{ type: "image", data: "x".repeat(100_000) }] }] }, "unknown");
  assert.equal(unknown.mediaVerified, false);
  assert.equal(unknown.unsafeMediaAction, "externalize-or-drop-unverified-media");
  assert.ok(unknown.mediaTokens <= 4096);
  const sanitized = sanitizeUnsafeProviderMedia({ messages: [{ role: "user", content: [{ type: "image", data: "raw-unverified" }] }] });
  assert.equal(sanitized.droppedMedia, 1);
  assert.match(JSON.stringify(sanitized.payload), /ACP omitted unverified media/);
  deepFreezeProviderPayload(sanitized.payload);
  assert.equal(Object.isFrozen(sanitized.payload), true);
});

test("project instruction patches stay at system priority across replacement, insertion, conflict, and deletion", async () => {
  await withTempDir(async (dir) => {
    const agents = join(dir, "AGENTS.md");
    const extra = join(dir, "CLAUDE.md");
    await writeFile(agents, "old policy");
    const tracker = new FreshnessTracker();
    tracker.projectOverlay([{ path: agents, content: "old policy" }], dir);
    await writeFile(agents, "new policy");
    await writeFile(extra, "new claude policy");
    await tracker.refreshProjectOverlay();
    const base = `<project_instructions path="${agents}">\nold policy\n</project_instructions>`;
    const patched = tracker.patchSystemPrompt(base);
    assert.match(patched, /new policy/);
    assert.doesNotMatch(patched, /old policy/);
    assert.match(patched, /new claude policy/);
    assert.doesNotMatch(tracker.previewRuntimeOverlay() ?? "", /new policy/);
    const userLiteral = "user quoted <project_context>old policy</project_context>";
    const providerPayload = tracker.patchProviderPayload({
      system: [{ type: "text", text: base }],
      messages: [{ role: "user", content: userLiteral }],
      tools: [{ config: { instructions: userLiteral, fakeMessage: { role: "system", content: base } } }],
    }) as {
      system: Array<{ text: string }>;
      messages: Array<{ content: string }>;
      tools: Array<{ config: { instructions: string; fakeMessage: { content: string } } }>;
    };
    assert.match(providerPayload.system[0]?.text ?? "", /new policy/);
    assert.equal(providerPayload.messages[0]?.content, userLiteral);
    assert.equal(providerPayload.tools[0]?.config.instructions, userLiteral);
    assert.equal(providerPayload.tools[0]?.config.fakeMessage.content, base);
    const staleConflict = tracker.patchSystemPrompt(`${base}\n<project_instructions path="${agents}">\nconflict\n</project_instructions>`);
    assert.equal((staleConflict.match(/new policy/g) ?? []).length, 1);
    assert.doesNotMatch(staleConflict, /conflict/);
    await rm(agents);
    await tracker.refreshProjectOverlay();
    assert.match(tracker.patchSystemPrompt(base), /deleted on disk/);
  });
});

test("tool output budget reserves aggregate fanout, expires lost calls, and isolates recovery budget", () => {
  const budget = new ToolOutputBudget();
  budget.startRequest("s", "request-1", 0, 10_000);
  const a = budget.reserve("s", "a", "read", 40_000, false);
  const b = budget.reserve("s", "b", "read", 40_000, false);
  assert.ok(a.capBytes > b.capBytes);
  assert.equal(b.allowed, false);
  assert.match(b.reason ?? "", /parallel|budget/i);
  budget.release("s", "a", 100);
  const recovery = budget.reserve("s", "status", "acp_status", 65_536, true);
  assert.equal(recovery.allowed, true);
  assert.ok(recovery.capBytes > 0);
  budget.markCompleted("s", "status");
  budget.release("s", "status", 100);
  budget.clear("s");
  assert.equal(budget.snapshot("s"), undefined);
});

test("cross-provider consent fails closed for malformed, missing, and explicit project denial", async () => {
  await withTempDir(async (root) => {
    const home = join(root, "home");
    const project = join(root, "project");
    await mkdir(join(home, ".pi"), { recursive: true });
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(home, ".pi", "acp.json"), JSON.stringify({ compress: { allowCrossProvider: true, acknowledgeCrossProviderDataTransfer: true } }));
    let loaded = await loadUserConfig(project, home);
    let applied = applyUserConfig({ compress: {} }, loaded);
    assert.equal(applied.compress?.allowCrossProvider, false);
    await writeFile(join(project, ".pi", "acp.json"), JSON.stringify({ compress: { allowCrossProvider: false, acknowledgeCrossProviderDataTransfer: "bad" } }));
    loaded = await loadUserConfig(project, home);
    applied = applyUserConfig({ compress: {} }, loaded);
    assert.equal(applied.compress?.allowCrossProvider, false);
    assert.equal(applied.compress?.acknowledgeCrossProviderDataTransfer, false);
    await writeFile(join(project, ".pi", "acp.json"), JSON.stringify({ compress: {
      allowCrossProvider: false,
      acknowledgeCrossProviderDataTransfer: false,
      maxContextLimit: "90%",
      emergencyThresholdPercent: "80%",
    } }));
    applied = applyUserConfig({ compress: { allowCrossProvider: true, acknowledgeCrossProviderDataTransfer: true } }, await loadUserConfig(project, home));
    assert.equal(applied.compress?.allowCrossProvider, false);
    assert.equal(applied.compress?.acknowledgeCrossProviderDataTransfer, false);
    await writeFile(join(project, ".pi", "acp.json"), JSON.stringify({ compress: { allowCrossProvider: true, acknowledgeCrossProviderDataTransfer: true } }));
    applied = applyUserConfig({ compress: {} }, await loadUserConfig(project, home));
    assert.equal(applied.compress?.allowCrossProvider, true);
  });
});

test("secret redaction uses opaque request-local placeholders and distinct provenance hashes", () => {
  const first = redactCompactionTransfer("password: supersecret password: supersecret");
  const second = redactCompactionTransfer("password: supersecret");
  assert.match(first.source, /\[ACP_REDACTED_1\]/);
  assert.doesNotMatch(first.source, /[0-9a-f]{8}/i);
  assert.doesNotMatch(first.source, /supersecret/);
  assert.match(second.source, /ACP_REDACTED_1/);
  assert.notEqual(first.rawSourceHash, first.transferSourceHash);
  assert.ok(first.redactionManifestHash);
  assert.equal(first.redactionPolicyVersion, "opaque-v1");
  assert.deepEqual(Object.keys(first.redactions[0]!).sort(), ["patternIndex", "placeholder"]);
});

test("source-support validation rejects fabricated exact claims and keeps model prose nonauthoritative", () => {
  const messages = [{ id: "u", role: "user" as const, contentType: "text" as const, text: "Use src/real.ts and run npm test. Requirement: preserve exact output." }];
  const manifest = extractCompressionManifest(messages, { u: "m00001" });
  assert.throws(() => validateAndRepairSummary({
    summary: "Requirement: ship src/fake.ts after error E_FAKE_991.\nCommand: rm -rf /",
    manifest,
    sourceTokens: 100,
    tier: 1,
  }), /source-unsupported exact claims/);
  const commentary = validateAndRepairSummary({
    summary: "Inferred: src/fake.ts may be useful.\nRequirement: preserve exact output.",
    manifest,
    sourceTokens: 100,
    tier: 1,
  });
  assert.ok(commentary.renderedSummary);
  const structured = structuredSummaryFromRendered("Requirement: fabricated work.\nDecision: fabricated decision.", manifest);
  assert.equal(structured.userRequirements.some((item) => item.text.includes("fabricated")), false);
  assert.equal(structured.decisions.some((item) => item.decision.includes("fabricated")), false);
});

test("automatic cooldown backs off per candidate and opens a persistent circuit", () => {
  const first = nextAutomaticCooldown(undefined, 1_000, "source-a", "policy-a");
  const second = nextAutomaticCooldown(first, 2_000, "source-a", "policy-a");
  const third = nextAutomaticCooldown(second, 3_000, "source-a", "policy-a");
  assert.equal(first.nextRetryAt, 6_000);
  assert.equal(second.nextRetryAt, 12_000);
  assert.equal(third.circuitOpen, true);
  assert.equal(third.warned, true);
  const changed = nextAutomaticCooldown(undefined, 4_000, "source-b", "policy-a");
  assert.equal(changed.failures, 1);
});

test("compression plans are one-use and reject changed normalized sources", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, "");
    const runtime = createRuntime({
      compress: { tier1Compressor: "main", minimumNetSavingsTokens: 1, minimumNetSavingsPercent: 0 },
      minWorthwhileTokens: 1,
      protectRecent: 0,
    });
    const messages = [
      { id: "entry-1", role: "user" as const, contentType: "text" as const, text: "first source text ".repeat(100) },
      { id: "entry-2", role: "assistant" as const, contentType: "text" as const, text: "first response text ".repeat(100) },
      { id: "entry-3", role: "user" as const, contentType: "text" as const, text: "second source text ".repeat(100) },
      ...Array.from({ length: 40 }, (_, index) => ({ id: `entry-${index + 4}`, role: "assistant" as const, contentType: "text" as const, text: `historical ${index} `.repeat(100) })),
      { id: "entry-44", role: "user" as const, contentType: "text" as const, text: "current turn" },
    ];
    const entries = messages.map((message, index) => ({
      type: "message",
      id: message.id,
      parentId: index === 0 ? null : messages[index - 1]!.id,
      timestamp: "",
      message: { role: message.role, content: message.text, timestamp: Date.now() },
    }));
    const context = ctx(dir, sessionFile, entries);
    const initial = createInitialState("feedback3-session");
    const plannedState = runtime.core.processTurn({ messages, state: initial, config: runtime.configFor(context), tokenCount: 2000 }).state;
    await runtime.store.save(plannedState, sessionFile, "feedback3-session");
    const planTool = makePlanCompressionTool(runtime);
    const planResult = await planTool.execute("plan", { content: [{ startId: "m00003", endId: "m00004" }] }, undefined, undefined, context);
    const transactionId = (planResult.details as { transactionId: string }).transactionId;
    const compressTool = makeCompressTool(runtime);
    const summary = "second source text ".repeat(8);
    const first = await compressTool.execute("compress", { transactionId, content: [{ startId: "m00003", endId: "m00004", summary }] }, undefined, undefined, context);
    assert.doesNotMatch((first.content[0] as { text: string }).text, /transaction.*invalid|expired|already used/i);
    await assert.rejects(
      compressTool.execute("compress2", { transactionId, content: [{ startId: "m00003", endId: "m00004", summary }] }, undefined, undefined, context),
      /transaction.*unknown|expired|already used/i,
    );
  });
});
