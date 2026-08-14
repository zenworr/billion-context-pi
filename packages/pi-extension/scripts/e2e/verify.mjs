#!/usr/bin/env node
//
// Assertion checker for billion-context-pi E2E scenarios.
//
// Reads the persisted ACP state file (<pi-session>.jsonl.acp.json) and checks
// expectations declared in the scenario's "verify" block. Also reads the
// per-request observations file written by the fake LLM server to assert on
// nudge detection, compress-call visibility, etc.
//
// Usage: node verify.mjs <state-file> <scenario-file> [acp-dir]
//
// Adapted from opencode-acp's verify.ts, but aligned to billion-context-pi's
// CompressionState shape (state.blocks[], state.nudge.*, state.messageRefs)
// rather than opencode's nested prune.messages.blocksById layout.

import { readFileSync, readdirSync, existsSync } from "fs";

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch (e) {
        console.error(`FAIL: cannot read ${path}: ${e.message}`);
        process.exit(1);
    }
}

const statePath = process.argv[2];
const scenarioPath = process.argv[3];
const acpDir = process.argv[4];
const observationsPath = process.env.OBSERVATIONS || "/tmp/bcp-e2e-observations.json";

if (!statePath || !scenarioPath) {
    process.stderr.write("Usage: verify.mjs <state-file> <scenario-file> [acp-dir]\n");
    process.exit(2);
}

const state = readJson(statePath);
const scenario = readJson(scenarioPath);
const expect = scenario.verify || {};

function readObservations() {
    if (!existsSync(observationsPath)) return [];
    try {
        const data = JSON.parse(readFileSync(observationsPath, "utf-8"));
        return Array.isArray(data.requests) ? data.requests : [];
    } catch {
        return [];
    }
}

const observations = readObservations();
let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
    if (condition) {
        console.log(`  \u2713 ${name}`);
        passed++;
    } else {
        console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
        failed++;
    }
}

// billion-context-pi state shape:
//   state.blocks: CompressionBlock[] { blockId, active, tier, summary, directMessageIds, effectiveMessageIds, compressedTokens, ... }
//   state.nudge: { lastPerMessageNudgeTokens, baselineTokens, lastShownByTier, ... }
//   state.messageRefs: { byRaw, byRef }
//   state.stats: { tokensCompressed, compressionCount }
const blocks = Array.isArray(state.blocks) ? state.blocks : [];
const activeBlocks = blocks.filter((b) => b && b.active !== false);
const nudge = state.nudge || {};
const stats = state.stats || {};

// Covered (compressed) message ids = union of effectiveMessageIds over active blocks.
function coveredMessageIds() {
    const ids = new Set();
    for (const b of activeBlocks) {
        for (const id of b.effectiveMessageIds || []) ids.add(id);
    }
    return ids;
}
const compressedIds = coveredMessageIds();

// Child state files (subagent sessions) — if acpDir provided, scan siblings.
let childStateFiles = [];
let childBlocks = [];
if (acpDir) {
    try {
        const all = readdirSync(acpDir).filter((f) => f.endsWith(".acp.json")).map((f) => `${acpDir}/${f}`);
        childStateFiles = all.filter((f) => f !== statePath);
        for (const f of childStateFiles) {
            try {
                const cs = readJson(f);
                childBlocks = childBlocks.concat(cs.blocks || []);
            } catch {}
        }
    } catch {}
}

const parentObs = observations.filter((o) => !o.isAuxiliary);
const maxCompressCalls = parentObs.length > 0 ? Math.max(...parentObs.map((o) => o.compressCallCount)) : 0;
const lastCompressCalls = parentObs.length > 0 ? parentObs[parentObs.length - 1].compressCallCount : 0;
const nudgeCount = parentObs.filter((o) => o.nudgeDetected).length;

console.log(`\nVerifying: ${scenarioPath}`);
console.log(`  state file: ${statePath}`);
console.log(`  blocks: ${blocks.length} (active: ${activeBlocks.length})`);
console.log(`  stats: tokensCompressed=${stats.tokensCompressed || 0}, compressionCount=${stats.compressionCount || 0}`);
console.log(`  nudge.lastPerMessageNudgeTokens: ${nudge.lastPerMessageNudgeTokens ?? "null"}`);
console.log(`  nudge.lastShownByTier: ${JSON.stringify(nudge.lastShownByTier || {})}`);
if (observations.length > 0) {
    console.log(`  observations: ${observations.length} requests`);
    console.log(`    maxCompressCallsVisible: ${maxCompressCalls}`);
    console.log(`    lastRequestCompressCalls: ${lastCompressCalls}`);
    console.log(`    nudgeDetections: ${nudgeCount}`);
}
if (childStateFiles.length > 0) {
    console.log(`  child state files: ${childStateFiles.length}, child blocks: ${childBlocks.length}`);
}
console.log("");

function check(name, expected, actual, ok) {
    if (expected !== undefined) {
        assert(name, ok, `got ${JSON.stringify(actual)}`);
    }
}

check("blockCount === " + expect.blockCount, expect.blockCount, blocks.length, blocks.length === expect.blockCount);
if (expect.minBlockCount !== undefined) assert(`blockCount >= ${expect.minBlockCount}`, blocks.length >= expect.minBlockCount, `got ${blocks.length}`);
if (expect.maxBlockCount !== undefined) assert(`blockCount <= ${expect.maxBlockCount}`, blocks.length <= expect.maxBlockCount, `got ${blocks.length}`);
if (expect.activeBlockCount !== undefined) assert(`activeBlockCount === ${expect.activeBlockCount}`, activeBlocks.length === expect.activeBlockCount, `got ${activeBlocks.length}`);

if (expect.minCompressedCount !== undefined) assert(`compressedCount >= ${expect.minCompressedCount}`, compressedIds.size >= expect.minCompressedCount, `got ${compressedIds.size}`);
if (expect.maxCompressedCount !== undefined) assert(`compressedCount <= ${expect.maxCompressedCount}`, compressedIds.size <= expect.maxCompressedCount, `got ${compressedIds.size}`);

if (expect.nudgeBaselineSet !== undefined) {
    const isSet = nudge.lastPerMessageNudgeTokens != null && nudge.lastPerMessageNudgeTokens > 0;
    assert(`nudgeBaselineSet === ${expect.nudgeBaselineSet}`, isSet === expect.nudgeBaselineSet, `got ${nudge.lastPerMessageNudgeTokens ?? "null"}`);
}
if (expect.tier2BaselineSet !== undefined) {
    const isSet = nudge.lastShownByTier != null && nudge.lastShownByTier[2] != null;
    assert(`tier2BaselineSet === ${expect.tier2BaselineSet}`, isSet === expect.tier2BaselineSet, `got ${JSON.stringify(nudge.lastShownByTier || {})}`);
}

if (expect.summaryContains !== undefined) {
    const found = blocks.some((b) => (b.summary || "").includes(expect.summaryContains));
    assert(`summary contains "${expect.summaryContains}"`, found, "no block summary contains the expected text");
}

if (expect.childBlockCount !== undefined) {
    assert(`childBlockCount === ${expect.childBlockCount}`, childBlocks.length === expect.childBlockCount, `got ${childBlocks.length} across ${childStateFiles.length} child state file(s)`);
}

if (expect.maxCompressCallsVisible !== undefined) {
    assert(`maxCompressCallsVisible <= ${expect.maxCompressCallsVisible}`, maxCompressCalls <= expect.maxCompressCallsVisible, `got max ${maxCompressCalls}`);
}
if (expect.lastRequestCompressCalls !== undefined) {
    assert(`lastRequestCompressCalls === ${expect.lastRequestCompressCalls}`, lastCompressCalls === expect.lastRequestCompressCalls, `got ${lastCompressCalls}`);
}
if (expect.maxNudgeCount !== undefined) {
    assert(`nudgeCount <= ${expect.maxNudgeCount}`, nudgeCount <= expect.maxNudgeCount, `got ${nudgeCount} across ${parentObs.length} requests`);
}
if (expect.minNudgeCount !== undefined) {
    assert(`nudgeCount >= ${expect.minNudgeCount}`, nudgeCount >= expect.minNudgeCount, `got ${nudgeCount}`);
}
if (expect.compressionCount !== undefined) {
    assert(`stats.compressionCount === ${expect.compressionCount}`, (stats.compressionCount || 0) === expect.compressionCount, `got ${stats.compressionCount || 0}`);
}

if (expect.toolInvoked !== undefined) {
    // The session log lives next to the state file: drop the ".acp.json"
    // suffix to recover the "<timestamp>_<uuid>.jsonl" session file.
    const sessionLog = statePath.endsWith(".acp.json") ? statePath.slice(0, -9) : statePath;
    let invoked = false;
    try {
        const raw = readFileSync(sessionLog, "utf-8");
        const nameRe = new RegExp(`"name"\\s*:\\s*"${expect.toolInvoked.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`);
        const toolNameRe = new RegExp(`"toolName"\\s*:\\s*"${expect.toolInvoked.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`);
        invoked = nameRe.test(raw) || toolNameRe.test(raw);
    } catch {}
    assert(`toolInvoked "${expect.toolInvoked}"`, invoked, `no "${expect.toolInvoked}" tool call found in session log`);
}

console.log();
if (failed > 0) {
    console.error(`FAIL: ${failed} assertion(s) failed, ${passed} passed`);
    process.exit(1);
}
console.log(`PASS: ${passed} assertion(s) passed`);
