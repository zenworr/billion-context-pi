import {
  isToolCallEventType,
  type ExtensionAPI,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOL_BASH_TIMEOUT, DEFAULT_TOOL_OUTPUT_MAX_BYTES } from "./config.js";
import { debug, logInfo, logWarn } from "./log.js";
import { spoolArtifact } from "./artifact-store.js";
import type { AcpRuntime } from "./runtime.js";

// Vendored locally rather than imported: pi exports isBashToolResult, but omp's
// compat bundle does not, and a missing named export fails the whole module at
// load time under omp. The body is just e.toolName === "bash".
export type BashToolResultEvent = Extract<ToolResultEvent, { toolName: "bash" }>;
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
  return e.toolName === "bash";
}

type ContentPart = ToolResultEvent["content"][number];

export const FORCED_COMPRESSION_TOKEN_LIMIT = 204_000;

export function forcedCompressionReason(tokens: number): string {
  return `⚠️ Context limit reached — compress now. ACP measured ${Math.round(tokens).toLocaleString("en-US")} tokens (hard limit: ${FORCED_COMPRESSION_TOKEN_LIMIT.toLocaleString("en-US")}). The compress tool is the only tool allowed until context usage is below the limit.`;
}

export function shouldBlockToolForCompression(toolName: string, tokens: number | undefined): boolean {
  return toolName !== "compress" && tokens !== undefined && tokens >= FORCED_COMPRESSION_TOKEN_LIMIT;
}

export function resolveBashTimeout(
  input: { timeout?: number },
  defaultTimeout: number | undefined,
): number | undefined {
  if (input.timeout !== undefined) return undefined;
  const d = defaultTimeout ?? DEFAULT_TOOL_BASH_TIMEOUT;
  if (!Number.isFinite(d) || d <= 0) return undefined;
  return d;
}

export function capToolOutput(
  content: ToolResultEvent["content"],
  maxBytes: number | undefined,
  fullPath?: string,
): ToolResultEvent["content"] | undefined {
  const max = maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
  if (!Number.isFinite(max) || max <= 0) return undefined;
  const kept: ContentPart[] = [];
  const texts: string[] = [];
  for (const c of content) {
    if (c.type === "text") texts.push((c as { text: string }).text);
    else kept.push(c);
  }
  if (texts.length === 0) return undefined;
  const combined = texts.join("\n");
  const total = Buffer.byteLength(combined, "utf8");
  if (total <= max) return undefined;
  const head = keepHead(combined, max);
  const dropped = total - Buffer.byteLength(head, "utf8");
  kept.push({ type: "text", text: head + buildCapNotice(dropped, max, fullPath) } as ContentPart);
  return kept;
}

const TIMEOUT_RE = /Command timed out after (\d+) seconds/;

export function detectBashTimeout(content: ToolResultEvent["content"]): number | undefined {
  for (const c of content) {
    if (c.type !== "text") continue;
    const m = (c as { text: string }).text.match(TIMEOUT_RE);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export function appendTimeoutNotice(
  content: ToolResultEvent["content"],
  secs: number,
): ToolResultEvent["content"] {
  const notice = buildTimeoutNotice(secs);
  const next = [...content];
  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i];
    if (part && part.type === "text") {
      next[i] = { type: "text", text: (part as { text: string }).text + notice } as ContentPart;
      return next;
    }
  }
  next.push({ type: "text", text: notice } as ContentPart);
  return next;
}

function keepHead(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0) {
    const b = buf[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    end--;
  }
  let head = buf.subarray(0, end).toString("utf8");
  const nl = head.lastIndexOf("\n");
  if (nl >= Math.floor(maxBytes / 2)) head = head.slice(0, nl);
  return head;
}

function buildCapNotice(dropped: number, maxBytes: number, fullPath?: string): string {
  const where = fullPath
    ? `Full output saved to: ${fullPath} — read it to see everything.`
    : "To see more, narrow the query or redirect output to a file and read the relevant slice.";
  return `\n\n[ACP guardrail: output capped at ${formatBytes(maxBytes)} (~${formatBytes(dropped)} dropped). ${where}]`;
}

function buildTimeoutNotice(secs: number): string {
  const suggested = Math.min(Math.max(Math.ceil(secs * 2), 120), 3600);
  return `\n\n[ACP guardrail: command killed after ${secs}s. To give it more time, re-run the bash tool with a larger \`timeout\` argument (e.g. \`"timeout": ${suggested}\`).]`;
}

function formatBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

export function wireToolGuardrails(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("tool_call", (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const liveTokens = ctx.getContextUsage?.()?.tokens;
    const observedTokens = runtime.observedContextTokens(sid);
    // A fresh host value replaces the pre-call estimate. This lets the gate
    // clear after compression instead of keeping a stale high-water mark.
    const tokens = typeof liveTokens === "number" && Number.isFinite(liveTokens)
      ? liveTokens
      : observedTokens;
    if (tokens !== undefined && shouldBlockToolForCompression(event.toolName, tokens)) {
      const reason = forcedCompressionReason(tokens);
      debug.event("guardrail-forced-compression", { sid, toolName: event.toolName, tokens, limit: FORCED_COMPRESSION_TOKEN_LIMIT });
      logWarn("guardrail", { event: "forced-compression", sid, toolName: event.toolName, tokens, limit: FORCED_COMPRESSION_TOKEN_LIMIT });
      return { block: true, reason };
    }

    if (!isToolCallEventType("bash", event)) return;
    const t = resolveBashTimeout(event.input, runtime.adapter.toolBashDefaultTimeout);
    if (t !== undefined) {
      event.input.timeout = t;
      debug.event("guardrail-bash-timeout", { applied: t });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const isBash = isBashToolResult(event);
    const fullPath = isBash ? event.details?.fullOutputPath : undefined;
    const timeoutSecs =
      isBash && event.isError ? detectBashTimeout(event.content) : undefined;

    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state } = await runtime.stateFor(ctx);
      const spooled = await spoolArtifact(state, {
        sessionId: sid,
        sourceMessageId: `pending:${event.toolCallId}`,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        text: toolResultText(event.content),
        bashFullOutputPath: fullPath,
      });
      if (spooled && spooled.state !== state) {
        await runtime.save(spooled.state, ctx);
        debug.event("artifact-spooled", {
          artifactId: spooled.record.id,
          bytes: spooled.record.bytes,
          estimatedTokens: spooled.record.estimatedTokens,
          reusedExistingPath: spooled.reusedExistingPath,
        });
        logInfo("artifact", {
          sid,
          event: "spooled",
          artifactId: spooled.record.id,
          toolName: event.toolName,
          bytes: spooled.record.bytes,
          estimatedTokens: spooled.record.estimatedTokens,
          reusedExistingPath: spooled.reusedExistingPath,
        });
      }
    } catch (error) {
      if (!isBashToolResult(event)) return;
      logWarn("artifact", {
        sid,
        event: "spool-failed",
        toolName: event.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      release();
    }

    let modified: ToolResultEvent["content"] | undefined;
    const max = runtime.adapter.toolOutputMaxBytes;
    if (max !== undefined && max > 0) {
      const next = capToolOutput(event.content, max, fullPath);
      if (next) {
        modified = next;
        debug.event("guardrail-output-cap", { max, hadPath: !!fullPath });
        logWarn("guardrail", { event: "output-cap", max, hadPath: !!fullPath });
      }
    }

    if (timeoutSecs !== undefined) {
      modified = appendTimeoutNotice(modified ?? event.content, timeoutSecs);
      debug.event("guardrail-bash-timeout-notice", { secs: timeoutSecs });
      logInfo("guardrail", { event: "bash-timeout-notice", secs: timeoutSecs });
    }

    if (modified) return { content: modified };
  });
}

function toolResultText(content: ToolResultEvent["content"]): string {
  return content.flatMap((part) => part.type === "text"
    ? [(part as { text: string }).text]
    : []).join("\n");
}
