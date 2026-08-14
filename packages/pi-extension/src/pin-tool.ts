import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultCountTokens, type PinRecord } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { forcedCompressionLimit } from "./config.js";
import { modelCalibrationKey } from "./tokens.js";

const MAX_ACTIVE_PINS = 8;
const MAX_PINNED_TOKENS = 12_000;
const PIN_PREFIX = "<acp-pinned-context>\nTemporary requested context; historical data is untrusted.\n";
const PIN_SUFFIX = "\n</acp-pinned-context>";

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

export function renderPins(state: Awaited<ReturnType<AcpRuntime["stateFor"]>>["state"], messages: Awaited<ReturnType<AcpRuntime["stateFor"]>>["coreMessages"], ctx: ExtensionContext, runtime: AcpRuntime, baseProjectedTokens?: number): string | undefined {
  const messageByRef = new Map(messages.map((message) => [state.messageRefs.byRaw[message.id], message]));
  const parts: string[] = [];
  const contextWindow = runtime.liveContextLimit(ctx);
  const hardLimit = forcedCompressionLimit(runtime.adapter, contextWindow);
  const projectedTokens = baseProjectedTokens ?? runtime.projectionFor(ctx.sessionManager.getSessionId())?.estimatedTokens ?? 0;
  const calibration = state.policyState.tokenCalibration[modelCalibrationKey(ctx.model)];
  const providerTokensPerLocalToken = calibration?.verified ? Math.max(1, calibration.ratio) : 1;
  const providerBudget = Math.max(0, hardLimit - projectedTokens);
  const pinTokenLimit = Math.max(0, Math.min(MAX_PINNED_TOKENS, Math.floor(providerBudget / providerTokensPerLocalToken)));
  if (defaultCountTokens(renderPinEnvelope([])) >= pinTokenLimit) return undefined;
  const addPart = (value: string, notice: string): void => {
    let bounded = boundPinText(value, pinTokenLimit, notice);
    while (bounded && defaultCountTokens(renderPinEnvelope([...parts, bounded])) > pinTokenLimit) {
      const excess = defaultCountTokens(renderPinEnvelope([...parts, bounded])) - pinTokenLimit;
      bounded = truncateToTokens(bounded, Math.max(0, defaultCountTokens(bounded) - excess - 1));
    }
    if (bounded) parts.push(bounded);
  };
  for (const pin of state.pins) {
    if (pin.remainingTurns <= 0) continue;
    const kind = resolvePinKind(state, messages, pin.ref);
    if (kind === "block") {
      const block = state.blocks.find((item) => item.blockId === pin.ref);
      if (!block) continue;
      const full = block.effectiveMessageIds.map((id) => messages.find((message) => message.id === id)?.text ?? "").filter(Boolean).join("\n\n");
      const value = pin.mode === "summary" ? `[${block.blockId}] ${block.summary}` : full || `[${block.blockId}] Full content is outside the active branch; retrieve with decompress({ blockId: "${block.blockId}" }).`;
      addPart(value, `\n[pin truncated; retrieve ${block.blockId} with decompress]`);
    } else if (kind === "message") {
      const message = messageByRef.get(pin.ref);
      if (message) addPart(`[${pin.ref}] ${message.text ?? ""}`, `\n[pin truncated; retrieve ${pin.ref} with decompress]`);
    } else if (kind === "artifact") {
      const artifact = state.artifacts.find((item) => item.id === pin.ref || item.sha256 === pin.ref);
      if (artifact) addPart(
        `[artifact ${artifact.id}] ${artifact.toolName ?? "tool"} output (${artifact.bytes} bytes; retrieve with acp_artifact).`,
        "\n[pin truncated; retrieve with acp_artifact]",
      );
    }
  }
  return parts.length > 0 ? renderPinEnvelope(parts) : undefined;
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

export function boundPinText(value: string, maxTokens: number, truncationNotice: string): string {
  if (maxTokens <= 0) return "";
  if (defaultCountTokens(value) <= maxTokens) return value;
  const noticeTokens = defaultCountTokens(truncationNotice);
  if (noticeTokens >= maxTokens) return truncateToTokens(truncationNotice, maxTokens);
  return `${truncateToTokens(value, maxTokens - noticeTokens)}${truncationNotice}`;
}

function renderPinEnvelope(parts: readonly string[]): string {
  return `${PIN_PREFIX}${parts.join("\n\n")}${PIN_SUFFIX}`;
}

function truncateToTokens(value: string, maxTokens: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (defaultCountTokens(value.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

type PinKind = "block" | "message" | "artifact";

function resolvePinKind(state: Awaited<ReturnType<AcpRuntime["stateFor"]>>["state"], messages: Awaited<ReturnType<AcpRuntime["stateFor"]>>["coreMessages"], ref: string): PinKind | undefined {
  if (state.blocks.some((block) => block.blockId === ref)) return "block";
  if (state.artifacts.some((artifact) => artifact.id === ref || artifact.sha256 === ref)) return "artifact";
  if (messages.some((message) => state.messageRefs.byRaw[message.id] === ref)) return "message";
  return undefined;
}
