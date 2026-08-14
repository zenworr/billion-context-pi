#!/usr/bin/env node
//
// Fake OpenAI-compatible LLM server for billion-context-pi E2E tests.
//
// Drives real `pi -p` sessions through a stub LLM that emits scripted
// responses (text or `compress` tool_use calls) based on a JSON scenario.
// This exercises the full billion-context-pi pipeline:
//   pi -p -> context event (acp tag injection) -> compress tool -> state persistence
//
// Pure Node (no runtime deps), so the e2e Docker image needs only node.
//
// Architecture:
//   - Listens on PORT (default 8400), responds to /v1/chat/completions + /v1/models
//   - Reads scenario from SCENARIO env (JSON file path)
//   - Tracks turns via a file-based counter (TURN_COUNTER env) that persists
//     across `pi -p` invocations within one scenario
//   - Parses `<acp ...>mNNNNN</acp>` tags injected by billion-context-pi to find
//     compressible message refs
//   - Always streams SSE (Pi's openai-completions provider sends stream=true)
//   - Records per-request observations to OBSERVATIONS env file for verify.mjs
//
// Adapted from opencode-acp's scripts/e2e/fake-llm-server.ts (Bun) — ported to
// plain Node and aligned to billion-context-pi's tag format + compress schema.

"use strict";

const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "8400", 10);
const HOST = process.env.HOST || "127.0.0.1";
const SCENARIO_PATH = process.env.SCENARIO;
const TURN_COUNTER = process.env.TURN_COUNTER || "/tmp/bcp-e2e-turn-counter";
const OBSERVATIONS = process.env.OBSERVATIONS || "/tmp/bcp-e2e-observations.json";

if (!SCENARIO_PATH) {
    process.stderr.write("[fake-llm] SCENARIO env var required (path to scenario JSON)\n");
    process.exit(2);
}

const scenario = JSON.parse(fs.readFileSync(SCENARIO_PATH, "utf8"));

// Refs injected by billion-context-pi look like: <acp tokens="2.1K" type="text">m00001</acp>
// (5-digit zero-padded). Also tolerate the bracket form [m00001].
const ACP_TAG_RE = /<acp\b[^>]*>(m\d{5})<\/acp>/g;
const BRACKET_REF_RE = /\[m(\d{1,5})\]/g;

const NUDGE_PHRASES = [
    "efficiency nudge to compress early",
    "compress early and keep context lean",
    "Context limit reached",
    "context is actually full",
    "since last nudge",
    "Tier 2 Trigger",
    "Tier 3 Trigger",
];

let totalCompressionsEmitted = 0;

function log(msg) {
    process.stderr.write(`[fake-llm] ${msg}\n`);
}

// --- Turn counter (file-based, persists across pi invocations) ---

function readCounter(path) {
    try {
        const v = parseInt(fs.readFileSync(path, "utf8").trim(), 10);
        return Number.isFinite(v) ? v : 0;
    } catch {
        return 0;
    }
}

function writeCounter(path, v) {
    try {
        fs.writeFileSync(path, String(v));
    } catch (e) {
        log(`  warn: cannot write counter ${path}: ${e.message}`);
    }
}

function incrementCounter(path) {
    const v = readCounter(path) + 1;
    writeCounter(path, v);
    return v;
}

// --- Observations (per-LLM-request telemetry for verify.mjs) ---

function loadObservations() {
    try {
        const data = JSON.parse(fs.readFileSync(OBSERVATIONS, "utf8"));
        if (Array.isArray(data.requests)) return data;
    } catch {}
    return { requests: [] };
}

function saveObservations(obs) {
    try {
        fs.writeFileSync(OBSERVATIONS, JSON.stringify(obs));
    } catch (e) {
        log(`  warn: cannot save observations: ${e.message}`);
    }
}

function recordObservation(req) {
    const obs = loadObservations();
    obs.requests.push(req);
    saveObservations(obs);
}

// --- Message parsing ---

function extractMessageText(msg) {
    const parts = [];
    if (typeof msg?.content === "string") {
        parts.push(msg.content);
    } else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
            if (typeof part === "string") parts.push(part);
            else if (part?.text) parts.push(part.text);
            else if (typeof part?.content === "string") parts.push(part.content);
        }
    }
    // billion-context-pi appends acp tags into tool_call arguments too.
    if (Array.isArray(msg?.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (tc?.function?.arguments) parts.push(String(tc.function.arguments));
        }
    }
    return parts.join("");
}

function parseMessageRefs(messages) {
    const refs = [];
    const seen = new Set();
    for (const msg of messages) {
        if (msg?.role === "system") continue;
        const text = extractMessageText(msg);
        let match;
        ACP_TAG_RE.lastIndex = 0;
        while ((match = ACP_TAG_RE.exec(text)) !== null) {
            const ref = match[1];
            if (!seen.has(ref)) {
                seen.add(ref);
                refs.push(ref);
            }
        }
        BRACKET_REF_RE.lastIndex = 0;
        while ((match = BRACKET_REF_RE.exec(text)) !== null) {
            const ref = "m" + match[1].padStart(5, "0");
            if (!seen.has(ref)) {
                seen.add(ref);
                refs.push(ref);
            }
        }
    }
    return refs;
}

function detectNudge(messages) {
    for (const msg of messages) {
        if (msg?.role !== "user") continue;
        const text = extractMessageText(msg);
        if (NUDGE_PHRASES.some((p) => text.includes(p))) return true;
    }
    return false;
}

function countCompressCalls(messages) {
    let count = 0;
    for (const msg of messages) {
        if (Array.isArray(msg?.tool_calls)) {
            for (const tc of msg.tool_calls) {
                if (tc?.function?.name === "compress") count++;
            }
        }
    }
    return count;
}

function resolveRange(refs, range) {
    if (range === "all" || !range) {
        return [refs[0], refs[refs.length - 1]];
    }
    const [startIdx, endIdx] = range;
    const start = refs[Math.min(startIdx, refs.length - 1)];
    const end = refs[Math.min(endIdx, refs.length - 1)];
    return [start, end];
}

// --- Response builders (SSE streaming) ---

function sse(res, model, chunks, usage) {
    const id = `chatcmpl-fake-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const lines = [];
    for (const chunk of chunks) {
        if (chunk.type === "tool_use") {
            lines.push({
                id, object: "chat.completion.chunk", created, model,
                choices: [{
                    index: 0,
                    delta: {
                        role: "assistant", content: null,
                        tool_calls: [{ index: 0, id: chunk.callId, type: "function", function: { name: chunk.toolName, arguments: "" } }],
                    },
                    finish_reason: null,
                }],
            });
            lines.push({
                id, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: chunk.args } }] }, finish_reason: null }],
            });
            lines.push({
                id, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage,
            });
        } else {
            const words = chunk.content.split(/(\s+)/);
            const perChunk = Math.max(1, Math.ceil(words.length / 10));
            const textChunks = [];
            for (let i = 0; i < words.length; i += perChunk) {
                textChunks.push(words.slice(i, i + perChunk).join(""));
            }
            lines.push({
                id, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { role: "assistant", content: textChunks[0] || "" }, finish_reason: null }],
            });
            for (let i = 1; i < textChunks.length; i++) {
                lines.push({
                    id, object: "chat.completion.chunk", created, model,
                    choices: [{ index: 0, delta: { content: textChunks[i] }, finish_reason: null }],
                });
            }
            lines.push({
                id, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage,
            });
        }
    }
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
    });
    for (const line of lines) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
}

function textSSE(res, model, text, inputTokens) {
    const outputTokens = Math.max(1, Math.ceil(text.length / 4));
    const usage = {
        prompt_tokens: inputTokens || outputTokens,
        completion_tokens: outputTokens,
        total_tokens: (inputTokens || outputTokens) + outputTokens,
    };
    sse(res, model, [{ type: "text", content: text }], usage);
}

function compressSSE(res, model, args, inputTokens) {
    totalCompressionsEmitted++;
    const argsJson = JSON.stringify(args);
    const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const outputTokens = Math.max(1, Math.ceil(argsJson.length / 4));
    const usage = {
        prompt_tokens: inputTokens || outputTokens,
        completion_tokens: outputTokens,
        total_tokens: (inputTokens || outputTokens) + outputTokens,
    };
    sse(res, model, [{ type: "tool_use", toolName: "compress", callId, args: argsJson }], usage);
}

function toolUseSSE(res, model, toolName, args, inputTokens) {
    const argsJson = JSON.stringify(args);
    const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const outputTokens = Math.max(1, Math.ceil(argsJson.length / 4));
    const usage = {
        prompt_tokens: inputTokens || outputTokens,
        completion_tokens: outputTokens,
        total_tokens: (inputTokens || outputTokens) + outputTokens,
    };
    sse(res, model, [{ type: "tool_use", toolName, callId, args: argsJson }], usage);
}

// --- Step handlers ---

function handleTextStep(res, model, step, inputTokens) {
    log(`  -> text step (${(step.text || "").length} chars)`);
    textSSE(res, model, step.text || "Done.", inputTokens);
}

function handleCompressStep(res, model, messages, step, inputTokens) {
    const refs = parseMessageRefs(messages);
    if (refs.length === 0) {
        log("  -> compress: no acp refs found, fallback text");
        textSSE(res, model, "No messages to compress.", inputTokens);
        return;
    }
    log(`  -> compress: found ${refs.length} refs ${refs[0]}..${refs[refs.length - 1]}`);

    if (step.ranges && step.ranges.length > 0) {
        const content = step.ranges.map((r) => {
            const [startId, endId] = resolveRange(refs, r.range || "all");
            return { topic: r.topic || "Batch range", startId, endId, summary: r.summary };
        });
        log(`  -> batch compress: ${content.length} ranges`);
        compressSSE(res, model, { topic: "Batch compression", content }, inputTokens);
        return;
    }

    const [startId, endId] = resolveRange(refs, step.range || "all");
    const entry = {
        topic: step.topic || "Compression",
        startId,
        endId,
        summary: step.summary || "Summary not provided.",
    };
    if (step.summaryMaxChars) entry.summaryMaxChars = step.summaryMaxChars;
    log(`  -> compress: ${startId}..${endId} summary=${(step.summary || "").length} chars`);
    compressSSE(res, model, { content: [entry] }, inputTokens);
}

function handleNudgeCompressStep(res, model, messages, step, inputTokens) {
    const nudgeDetected = detectNudge(messages);
    if (!nudgeDetected) {
        const growthText = step.growthText || "Continuing work. Generating substantive technical discussion about software architecture, dependency injection, service layers, data access patterns, authentication modules, and separation of concerns to fill context. File: src/core/service.ts:88 defines the service locator.";
        log(`  -> nudge-compress: no nudge yet, emitting ${growthText.length} chars growth`);
        textSSE(res, model, growthText, inputTokens);
        return;
    }
    log("  -> nudge-compress: nudge DETECTED, emitting compress");
    const refs = parseMessageRefs(messages);
    if (refs.length === 0) {
        textSSE(res, model, "No messages to compress.", inputTokens);
        return;
    }
    const [startId, endId] = resolveRange(refs, step.range || "all");
    compressSSE(res, model, {
        content: [{
            topic: step.topic || "Nudge-triggered compression",
            startId, endId,
            summary: step.summary || "Summary of compressed content from nudge-triggered E2E test.",
        }],
    }, inputTokens);
}

function handleAutonomousNudgeStep(res, model, messages, step, inputTokens) {
    const visibleCompressCount = countCompressCalls(messages);
    const nudgeDetected = detectNudge(messages);
    const maxCompress = step.maxCompressCount || 2;
    const growthText = step.growthText || "Autonomous work: discussing architecture patterns, dependency injection containers, inversion of control, SOLID principles across authentication module, service layer, and data access layer with mockable interfaces and proper separation of concerns for testability.";

    if (totalCompressionsEmitted >= maxCompress) {
        log(`  -> autonomous-nudge: total=${totalCompressionsEmitted} >= ${maxCompress}, done`);
        textSSE(res, model, "Task complete.", inputTokens);
        return;
    }
    if (nudgeDetected) {
        log(`  -> autonomous-nudge: nudge DETECTED (total=${totalCompressionsEmitted}), compressing`);
        const refs = parseMessageRefs(messages);
        if (refs.length === 0) {
            textSSE(res, model, "No messages to compress.", inputTokens);
            return;
        }
        const [startId, endId] = resolveRange(refs, step.range || "all");
        compressSSE(res, model, {
            content: [{ topic: step.topic || "Autonomous compression", startId, endId, summary: step.summary || "Compressed autonomous work output." }],
        }, inputTokens);
        return;
    }
    log(`  -> autonomous-nudge: no nudge (total=${totalCompressionsEmitted}), emitting growth via bash`);
    toolUseSSE(res, model, "bash", {
        command: `echo '${growthText.replace(/'/g, "'\\''")}'`,
        description: "Generate autonomous work output",
    }, inputTokens);
}

function handleDecompressStep(res, model, messages, step, inputTokens) {
    log(`  -> decompress: target ${step.blockId || "(derived)"}`);
    toolUseSSE(res, model, "decompress", {
        blockId: step.blockId || "b0",
        ...(step.toFile ? { toFile: step.toFile } : {}),
    }, inputTokens);
}

function handleSearchStep(res, model, messages, step, inputTokens) {
    log(`  -> search_context: "${step.query || ""}"`);
    toolUseSSE(res, model, "search_context", { query: step.query || "test" }, inputTokens);
}

// --- Main request handler ---

function handleRequest(req, res, body) {
    let parsed = {};
    try {
        parsed = JSON.parse(body);
    } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
    }

    const messages = parsed.messages || [];
    const model = parsed.model || "fake-model";
    const tools = parsed.tools || [];
    const hasTools = tools.length > 0;
    const inputTokens = Math.max(1, Math.ceil(messages.map((m) => extractMessageText(m)).join("").length / 4));

    // Auxiliary calls (no tools, e.g. title/summary generation) get a canned
    // response and do NOT advance the turn counter.
    if (!hasTools) {
        log(`  -> auxiliary call (tools=0), canned reply`);
        recordObservation({ turn: -1, inputTokens, messageCount: messages.length, compressCallCount: 0, nudgeDetected: false, isAuxiliary: true });
        textSSE(res, model, "ok", inputTokens);
        return;
    }

    const nudgeDetected = detectNudge(messages);
    const visibleCompressCount = countCompressCalls(messages);
    const turnIdx = incrementCounter(TURN_COUNTER);
    const step = (scenario.turns || [])[turnIdx - 1];

    recordObservation({
        turn: turnIdx,
        inputTokens,
        messageCount: messages.length,
        compressCallCount: visibleCompressCount,
        nudgeDetected,
        isAuxiliary: false,
    });

    if (!step) {
        log(`  -> turn ${turnIdx}: no scenario step, emitting text`);
        textSSE(res, model, "Done.", inputTokens);
        return;
    }

    log(`turn ${turnIdx}: respond=${step.respond}${nudgeDetected ? " [NUDGE]" : ""} (msgs=${messages.length}, compressVisible=${visibleCompressCount})`);

    switch (step.respond) {
        case "text":
            handleTextStep(res, model, step, inputTokens);
            return;
        case "compress":
            handleCompressStep(res, model, messages, step, inputTokens);
            return;
        case "nudge-compress":
            handleNudgeCompressStep(res, model, messages, step, inputTokens);
            return;
        case "autonomous-nudge":
            handleAutonomousNudgeStep(res, model, messages, step, inputTokens);
            return;
        case "decompress":
            handleDecompressStep(res, model, messages, step, inputTokens);
            return;
        case "search":
            handleSearchStep(res, model, messages, step, inputTokens);
            return;
        case "tool":
            toolUseSSE(res, model, step.tool || "bash", step.toolArgs || {}, inputTokens);
            return;
        default:
            log(`  -> unknown respond "${step.respond}", emitting text`);
            textSSE(res, model, step.text || "Done.", inputTokens);
            return;
    }
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url && req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] }));
        return;
    }
    if (req.method === "POST" && req.url && req.url.includes("/chat/completions")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => handleRequest(req, res, body));
        return;
    }
    res.writeHead(404);
    res.end("not found");
});

server.listen(PORT, HOST, () => {
    process.stderr.write(
        `[fake-llm] listening on http://${HOST}:${PORT}\n` +
        `[fake-llm] scenario: ${SCENARIO_PATH}\n` +
        `[fake-llm] ready (pid ${process.pid})\n`,
    );
});
