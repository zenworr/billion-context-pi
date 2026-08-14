import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import {
  extractCompressionManifest,
  mergeCompressionManifests,
  structuredSummaryFromRendered,
  validateAndRepairSummary,
} from "../src/manifest.js";

function manifest(messages: CoreMessage[]) {
  return extractCompressionManifest(
    messages,
    Object.fromEntries(messages.map((message, index) => [message.id, `m${String(index + 1).padStart(5, "0")}`])),
  );
}

test("semantic validation does not truncate retention after 100 required facts", () => {
  const requirements = Array.from({ length: 150 }, (_, index) => `Requirement: Preserve durable fact ${index}.`).join("\n");
  const source = manifest([{ id: "user-many", role: "user", contentType: "text", text: requirements }]);
  const validation = validateAndRepairSummary({
    summary: "Durable requirements were captured.", manifest: source, sourceTokens: 5_000, tier: 1,
  });
  assert.match(validation.renderedSummary, /Preserve durable fact 149\./);
  assert.ok(validation.missingRequiredFacts.length >= 150);
});

test("post-repair size is enforced before commit", () => {
  const source = manifest([{ id: "user-large", role: "user", contentType: "text", text: "Requirement: " + "x".repeat(500) + "." }]);
  assert.throws(() => validateAndRepairSummary({
    summary: "Short.", manifest: source, sourceTokens: 500, tier: 1, summaryMaxChars: 100,
  }), /after required-fact repair; limit is 100/);
});

test("semantic validation repairs an omitted user requirement before commit", () => {
  const source = manifest([{
    id: "user-1",
    role: "user",
    contentType: "text",
    text: "Requirement: Keep audit logging enabled.",
  }]);

  const validation = validateAndRepairSummary({
    summary: "The logging implementation was reviewed.",
    manifest: source,
    sourceTokens: 100,
    tier: 1,
  });

  assert.equal(validation.status, "repaired");
  assert.match(validation.renderedSummary, /Requirement: Keep audit logging enabled\./);
  assert.ok(validation.missingRequiredFacts.includes("Requirement: Keep audit logging enabled."));
  const structured = structuredSummaryFromRendered(validation.renderedSummary, source);
  assert.ok(structured.objective.includes("Keep audit logging enabled."));
  assert.deepEqual(structured.userRequirements[0], {
    text: "Keep audit logging enabled.",
    sourceRefs: ["m00001"],
    verbatim: true,
  });
  assert.notDeepEqual(structured.facts, [validation.renderedSummary]);
});

test("semantic validation preserves a decision and its rationale", () => {
  const source = manifest([{
    id: "assistant-1",
    role: "assistant",
    contentType: "text",
    text: "Decision: Use SQLite because it is local and deterministic.",
  }]);

  const validation = validateAndRepairSummary({
    summary: "Use SQLite for storage.",
    manifest: source,
    sourceTokens: 100,
    tier: 1,
  });

  assert.equal(validation.status, "repaired");
  assert.match(validation.renderedSummary, /rationale: it is local and deterministic/);
  const structured = structuredSummaryFromRendered(validation.renderedSummary, source);
  assert.deepEqual(structured.decisions[0], {
    decision: "Use SQLite",
    rationale: "it is local and deterministic",
    sourceRefs: ["m00001"],
  });
});

test("semantic validation retains unresolved TODO work", () => {
  const source = manifest([{
    id: "assistant-1",
    role: "assistant",
    contentType: "text",
    text: "TODO: Add retry coverage before release.",
  }]);

  const validation = validateAndRepairSummary({
    summary: "The implementation is ready for review.",
    manifest: source,
    sourceTokens: 100,
    tier: 1,
  });

  assert.equal(validation.status, "repaired");
  assert.match(validation.renderedSummary, /Next step: Add retry coverage before release\./);
  const structured = structuredSummaryFromRendered(validation.renderedSummary, source);
  assert.ok(structured.workState.next.includes("Add retry coverage before release."));
});

test("merged higher-tier manifests retain child semantic work state", () => {
  const child = manifest([{
    id: "assistant-1",
    role: "assistant",
    contentType: "text",
    text: "TODO: Verify the checkpoint fallback.",
  }]);
  const merged = mergeCompressionManifests([child], "merged-source-hash");

  const validation = validateAndRepairSummary({
    summary: "The child block records checkpoint work.",
    manifest: merged,
    sourceTokens: 100,
    tier: 2,
  });

  assert.match(validation.renderedSummary, /Next step: Verify the checkpoint fallback\./);
  assert.equal(merged.sourceHash, "merged-source-hash");
});

test("semantic validation retains requirements and unresolved work at Tier 3", () => {
  const source = manifest([{
    id: "user-1",
    role: "user",
    contentType: "text",
    text: "Requirement: Keep local-only execution.\nTODO: Verify fallback behavior.",
  }]);
  const validation = validateAndRepairSummary({
    summary: "Durable checkpoint facts.",
    manifest: source,
    sourceTokens: 100,
    tier: 3,
  });

  assert.match(validation.renderedSummary, /Requirement: Keep local-only execution\./);
  assert.match(validation.renderedSummary, /Next step: Verify fallback behavior\./);
});

test("merged manifests expose contradictions across child blocks", () => {
  const disabled = manifest([{ id: "user-1", role: "user", contentType: "text", text: "Constraint: Cache must remain disabled." }]);
  const enabled = manifest([{ id: "user-2", role: "user", contentType: "text", text: "Requirement: Cache must remain enabled." }]);
  const merged = mergeCompressionManifests([disabled, enabled], "merged");

  assert.equal(merged.semanticFacts?.contradictions.length, 1);
  const validation = validateAndRepairSummary({
    summary: "Cache policy changed during the source range.",
    manifest: merged,
    sourceTokens: 100,
    tier: 2,
  });
  assert.match(validation.renderedSummary, /Contradiction: Cache must remain disabled\. <> Cache must remain enabled\./);
});

test("semantic validation rejects a detectable contradiction", () => {
  const source = manifest([{
    id: "user-1",
    role: "user",
    contentType: "text",
    text: "Constraint: Cache must remain disabled.",
  }]);

  assert.throws(
    () => validateAndRepairSummary({
      summary: "Cache is now enabled for performance.",
      manifest: source,
      sourceTokens: 100,
      tier: 1,
    }),
    /Summary contradicts source fact: "Cache must remain disabled\." with "Cache is now enabled for performance\."/,
  );
});

test("semantic validation rejects negation that reverses a positive requirement", () => {
  const source = manifest([{
    id: "user-1",
    role: "user",
    contentType: "text",
    text: "Requirement: Encrypt backups at rest.",
  }]);

  assert.throws(
    () => validateAndRepairSummary({
      summary: "Do not encrypt backups at rest.",
      manifest: source,
      sourceTokens: 100,
      tier: 1,
    }),
    /Summary contradicts source fact/,
  );
});

test("negated file operations do not become completed modifications", () => {
  const source = manifest([{
    id: "user-1",
    role: "user",
    contentType: "text",
    text: "Constraint: Do not modify packages/pi-extension/src/config.ts.",
  }]);
  const file = source.semanticFacts?.files.find((item) => item.path.startsWith("packages/pi-extension/src/config.ts"));

  assert.equal(file?.status, "read");
});

test("structured semantic provenance stays attached to its source message", () => {
  const source = manifest([
    { id: "user-1", role: "user", contentType: "text", text: "Requirement: Keep audit logs." },
    { id: "assistant-1", role: "assistant", contentType: "text", text: "Fact: unrelated implementation note." },
  ]);
  const structured = structuredSummaryFromRendered("Requirement: Keep audit logs. Fact: unrelated implementation note.", source);

  assert.deepEqual(structured.userRequirements[0]?.sourceRefs, ["m00001"]);
});

test("structured summaries classify source and validated-summary state", () => {
  const source = manifest([
    { id: "user-1", role: "user", contentType: "text", text: "Goal: Make compression safe.\nConstraint: Do not use the network." },
    { id: "assistant-1", role: "assistant", contentType: "text", text: "Decision: Use deterministic checks because provider output is untrusted.\nModified packages/pi-extension/src/manifest.ts.\nnpm test passed exit code 0\nError: build failed because config was missing; status unresolved.\nOpen question: Should fallback use the main model?\nNext step: Run typecheck.\nFact: issue #122 remains open." },
  ]);
  const validation = validateAndRepairSummary({
    summary: "Goal: Make compression safe. Constraint: Do not use the network. Decision: Use deterministic checks because provider output is untrusted. Open question: Should fallback use the main model? Next step: Run typecheck. packages/pi-extension/src/manifest.ts npm test Error: build failed because config was missing; status unresolved. Fact: issue #122 remains open.",
    manifest: source,
    sourceTokens: 200,
    tier: 1,
  });
  const structured = structuredSummaryFromRendered(validation.renderedSummary, source);

  assert.ok(structured.objective.includes("Make compression safe."));
  assert.ok(structured.userRequirements.some((requirement) => requirement.text === "Do not use the network."));
  assert.ok(structured.decisions.some((decision) => decision.rationale === "provider output is untrusted"));
  assert.ok(structured.files.some((file) => file.path.startsWith("packages/pi-extension/src/manifest.ts") && file.status === "modified"));
  assert.ok(structured.commands.some((command) => command.command.startsWith("npm test") && command.result === "passed"));
  assert.ok(structured.errors.some((error) => error.cause === "config was missing" && error.status === "unresolved"));
  assert.ok(structured.workState.blocked.includes("Should fallback use the main model?"));
  assert.ok(structured.workState.next.includes("Run typecheck."));
  assert.ok(structured.facts.includes("issue #122 remains open."));
  assert.ok(structured.facts.includes("#122"));
  assert.ok(structured.facts.every((fact) => !fact.includes("Retained semantic facts:")));
});
