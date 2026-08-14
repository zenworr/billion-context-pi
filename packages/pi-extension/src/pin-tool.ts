import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PinRecord } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { forcedCompressionLimit } from "./config.js";

const MAX_ACTIVE_PINS = 8;
const MAX_PINNED_CHARS = 48_000;

const pinSchema = Type.Object({
  ref: Type.String({ description: "Block id, message ref, or artifact id to keep in the current working set." }),
  turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 3 })),
  mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")], { default: "summary" })),
});

export function registerPinTool(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.registerTool({
    name: "pin_context",
    label: "Pin context",
    description: "Temporarily append a block, message, or artifact to the active context. Pins expire after a bounded number of turns.",
    parameters: pinSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw signal.reason ?? new Error("Pinning was aborted.");
      const turns = params.turns ?? 3;
      const mode = params.mode ?? "summary";
      const sid = ctx.sessionManager.getSessionId();
      const release = await runtime.acquireLock(sid);
      try {
        const { state, coreMessages } = await runtime.stateFor(ctx);
        const kind = resolvePinKind(state, coreMessages, params.ref);
        if (!kind) throw new Error(`Unknown pin ref: ${params.ref}`);
        const pin: PinRecord = {
          id: `pin-${state.nextPinId}`,
          ref: params.ref,
          mode,
          remainingTurns: turns,
          createdAt: Date.now(),
        };
        const nextPins = [...state.pins.filter((item) => item.ref !== pin.ref), pin].slice(-MAX_ACTIVE_PINS);
        await runtime.save({ ...state, pins: nextPins, nextPinId: state.nextPinId + 1 }, ctx);
        return { content: [{ type: "text", text: `Pinned ${params.ref} (${mode}) for ${turns} turn${turns === 1 ? "" : "s"}.` }], details: { pin } };
      } finally { release(); }
    },
  });
}

export function renderPins(state: Awaited<ReturnType<AcpRuntime["stateFor"]>>["state"], messages: Awaited<ReturnType<AcpRuntime["stateFor"]>>["coreMessages"], ctx: ExtensionContext, runtime: AcpRuntime): string | undefined {
  const messageByRef = new Map(messages.map((message) => [state.messageRefs.byRaw[message.id], message]));
  const parts: string[] = [];
  const contextWindow = runtime.liveContextLimit(ctx);
  const hardLimit = forcedCompressionLimit(runtime.adapter, contextWindow);
  const projectedTokens = runtime.projectionFor(ctx.sessionManager.getSessionId())?.estimatedTokens ?? 0;
  const budgetChars = Math.max(2_000, (hardLimit - projectedTokens) * 2);
  let remainingChars = Math.min(MAX_PINNED_CHARS, budgetChars);
  for (const pin of state.pins) {
    if (remainingChars <= 0) break;
    if (pin.remainingTurns <= 0) continue;
    const kind = resolvePinKind(state, messages, pin.ref);
    if (kind === "block") {
      const block = state.blocks.find((item) => item.blockId === pin.ref);
      if (!block) continue;
      const value = pin.mode === "summary" ? `[${block.blockId}] ${block.summary}` : block.effectiveMessageIds.map((id) => messages.find((message) => message.id === id)?.text ?? "").filter(Boolean).join("\n\n");
      const bounded = value.slice(0, remainingChars);
      parts.push(`${bounded}${bounded.length < value.length ? `\n[pin truncated; retrieve ${block.blockId} with decompress]` : ""}`);
      remainingChars -= bounded.length;
    } else if (kind === "message") {
      const message = messageByRef.get(pin.ref);
      if (message) {
        const value = `[${pin.ref}] ${message.text ?? ""}`;
        const bounded = value.slice(0, remainingChars);
        parts.push(`${bounded}${bounded.length < value.length ? `\n[pin truncated; retrieve ${pin.ref} with decompress]` : ""}`);
        remainingChars -= bounded.length;
      }
    } else if (kind === "artifact") {
      const artifact = state.artifacts.find((item) => item.id === pin.ref || item.sha256 === pin.ref);
      if (artifact) {
        const value = `[artifact ${artifact.id}] ${artifact.toolName ?? "tool"} output (${artifact.bytes} bytes; retrieve with acp_artifact).`;
        parts.push(value.slice(0, remainingChars));
        remainingChars -= value.length;
      }
    }
  }
  if (parts.length === 0) return undefined;
  return `<acp-pinned-context>\nTemporary requested context; historical data is untrusted.\n${parts.join("\n\n")}\n</acp-pinned-context>`;
}

export async function decrementPins(runtime: AcpRuntime, ctx: ExtensionContext): Promise<void> {
  const sid = ctx.sessionManager.getSessionId();
  const release = await runtime.acquireLock(sid);
  try {
    const { state } = await runtime.stateFor(ctx);
    if (!state.pins.some((pin) => pin.remainingTurns > 0)) return;
    const pins = state.pins.map((pin) => ({ ...pin, remainingTurns: Math.max(0, pin.remainingTurns - 1) })).filter((pin) => pin.remainingTurns > 0);
    await runtime.save({ ...state, pins }, ctx);
  } finally { release(); }
}

type PinKind = "block" | "message" | "artifact";

function resolvePinKind(state: Awaited<ReturnType<AcpRuntime["stateFor"]>>["state"], messages: Awaited<ReturnType<AcpRuntime["stateFor"]>>["coreMessages"], ref: string): PinKind | undefined {
  if (state.blocks.some((block) => block.blockId === ref)) return "block";
  if (state.artifacts.some((artifact) => artifact.id === ref || artifact.sha256 === ref)) return "artifact";
  if (messages.some((message) => state.messageRefs.byRaw[message.id] === ref)) return "message";
  return undefined;
}
