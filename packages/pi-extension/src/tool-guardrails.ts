import {
  isToolCallEventType,
  type ExtensionAPI,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOL_BASH_TIMEOUT, DEFAULT_TOOL_OUTPUT_MAX_BYTES, forcedCompressionLimit } from "./config.js";
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

const RECOVERY_TOOLS = new Set(["compress", "acp_status", "search_context", "decompress", "acp_artifact"]);

export function forcedCompressionReason(tokens: number, limit: number): string {
  return `⚠️ Context limit reached — compress now, or use a bounded ACP recovery tool. ACP's current compiled projection is ${Math.round(tokens).toLocaleString("en-US")} tokens (active-model hard limit: ${Math.round(limit).toLocaleString("en-US")}). Only compression and bounded ACP recovery tools are allowed until the projection is below the limit.`;
}

export function shouldBlockToolForCompression(toolName: string, tokens: number | undefined, limit: number): boolean {
  return !RECOVERY_TOOLS.has(toolName) && tokens !== undefined && tokens >= limit;
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
  return appendTextNotice(content, buildTimeoutNotice(secs));
}

function appendTextNotice(
  content: ToolResultEvent["content"],
  notice: string,
): ToolResultEvent["content"] {
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
    const projection = runtime.projectionFor(sid);
    const contextWindow = runtime.liveContextLimit(ctx);
    const modelKey = `${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`;
    const fresh = projection
      && projection.modelKey === modelKey
      && projection.contextWindow === contextWindow
      && Date.now() - projection.recordedAt < 10 * 60_000;
    const tokens = fresh ? projection.estimatedTokens : undefined;
    const limit = forcedCompressionLimit(runtime.adapter, contextWindow);
    if (!runtime.compressionGateRelaxed(sid) && shouldBlockToolForCompression(event.toolName, tokens, limit)) {
      const reason = forcedCompressionReason(tokens!, limit);
      debug.event("guardrail-forced-compression", { sid, toolName: event.toolName, tokens, limit, projectionHash: projection?.projectionHash });
      logWarn("guardrail", { event: "forced-compression", sid, toolName: event.toolName, tokens, limit });
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
    if (event.toolName === "compress" && event.isError) runtime.relaxCompressionGate(ctx.sessionManager.getSessionId());
    const fullPath = isBash ? event.details?.fullOutputPath : undefined;
    const timeoutSecs =
      isBash && event.isError ? detectBashTimeout(event.content) : undefined;
    const max = runtime.adapter.toolOutputMaxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
    const textParts = fullPath ? [] : toolResultTextParts(event.content);
    const willCapNonBash = !isBash && max > 0
      && Buffer.byteLength(textParts.join("\n"), "utf8") > max;

    const sid = ctx.sessionManager.getSessionId();
    let spoolFailure: string | undefined;
    let readyArtifactId: string | undefined;
    const release = await runtime.acquireLock(sid);
    try {
      const { state } = await runtime.stateFor(ctx);
      const spooled = await spoolArtifact(state, {
        sessionId: sid,
        sourceMessageId: `pending:${event.toolCallId}`,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        textParts: fullPath ? undefined : textParts,
        bashFullOutputPath: fullPath,
        force: willCapNonBash,
        maxArtifactBytes: runtime.adapter.artifacts?.maxArtifactBytes,
        maxSessionBytes: runtime.adapter.artifacts?.maxSessionBytes,
        maxGlobalBytes: runtime.adapter.artifacts?.maxGlobalBytes,
      });
      if (spooled) {
        if (spooled.record.retrievable) readyArtifactId = spooled.record.id;
        else spoolFailure = spooled.record.error ?? "artifact is unavailable";
      }
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
      spoolFailure = error instanceof Error ? error.message : String(error);
      logWarn("artifact", {
        sid,
        event: "spool-failed",
        toolName: event.toolName,
        error: spoolFailure,
      });
    } finally {
      release();
    }

    let modified: ToolResultEvent["content"] | undefined;
    if (max > 0) {
      const next = capToolOutput(event.content, max, fullPath);
      if (next) {
        modified = next;
        debug.event("guardrail-output-cap", { max, hadPath: !!fullPath });
        logWarn("guardrail", { event: "output-cap", max, hadPath: !!fullPath });
      }
    }

    if (spoolFailure && !isBash) {
      modified = appendTextNotice(
        modified ?? event.content,
        `[ACP guardrail: durable artifact storage failed (${spoolFailure}); output was explicitly capped and the full non-Bash result is unavailable. Retry with narrower output or free artifact quota.]`,
      );
    } else if (modified && readyArtifactId && !isBash) {
      modified = appendTextNotice(
        modified,
        `[ACP artifact: full exact output is available as ${readyArtifactId}. Retrieve it with acp_artifact({ id: "${readyArtifactId}" }).]`,
      );
    }

    if (timeoutSecs !== undefined) {
      modified = appendTimeoutNotice(modified ?? event.content, timeoutSecs);
      debug.event("guardrail-bash-timeout-notice", { secs: timeoutSecs });
      logInfo("guardrail", { event: "bash-timeout-notice", secs: timeoutSecs });
    }

    if (modified) return { content: modified };
  });
}

function toolResultTextParts(content: ToolResultEvent["content"]): string[] {
  return content.flatMap((part) => part.type === "text"
    ? [(part as { text: string }).text]
    : []);
}
