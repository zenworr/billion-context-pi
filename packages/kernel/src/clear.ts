import type { ArtifactRecord, ClearingConfig, CoreMessage } from "./types.js";

export const CLEARED_TOOL_RESULT_MARKER = "[ACP cleared historical tool result]";
export const CLEARED_REASONING_MARKER = "[ACP cleared historical plaintext reasoning]";

export interface ClearHistoricalResult {
  messages: CoreMessage[];
  clearedCount: number;
  savedTokens: number;
}

interface Candidate {
  index: number;
  originalTokens: number;
  replacement: string;
  savedTokens: number;
}

export function clearHistoricalContent(
  messages: CoreMessage[],
  artifacts: readonly ArtifactRecord[],
  config: ClearingConfig,
  countTokens: (text: string) => number,
): ClearHistoricalResult {
  if (!config.enabled) return unchanged(messages);

  const recentToolCallIds = collectRecentToolUses(messages, config.keepRecentToolUses);
  const excluded = new Set([
    "compress",
    "edit",
    "write",
    "memory_write",
    ...config.excludeTools,
  ]);
  const candidates: Candidate[] = [];
  let currentTurnStart = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "user" && !messages[index]!.synthetic) { currentTurnStart = index; break; }
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (isSafePlaintextReasoning(message, config, index, currentTurnStart, messages)) {
      addCandidate(candidates, index, message.text ?? "", CLEARED_REASONING_MARKER, countTokens);
      continue;
    }
    if (message.contentType !== "tool-result") continue;
    if (message.text?.includes(CLEARED_TOOL_RESULT_MARKER)) continue;
    if (message.toolName && excluded.has(message.toolName)) continue;
    if (message.toolCallId && recentToolCallIds.has(message.toolCallId)) continue;

    const artifact = findArtifact(message, artifacts);
    if (!artifact) continue;
    const originalTokens = countTokens(message.text ?? "");
    const replacement = renderClearedToolResult(message, artifact, originalTokens);
    const savedTokens = Math.max(0, originalTokens - countTokens(replacement));
    if (savedTokens <= 0) continue;
    candidates.push({ index, originalTokens, replacement, savedTokens });
  }

  const savedTokens = candidates.reduce((total, candidate) => total + candidate.savedTokens, 0);
  if (savedTokens < config.clearAtLeastTokens) return unchanged(messages);

  const replacements = new Map(candidates.map((candidate) => [candidate.index, candidate.replacement]));
  return {
    messages: messages.map((message, index) => {
      const replacement = replacements.get(index);
      return replacement === undefined ? message : { ...message, text: replacement };
    }),
    clearedCount: candidates.length,
    savedTokens,
  };
}

function isSafePlaintextReasoning(
  message: CoreMessage,
  config: ClearingConfig,
  index: number,
  currentTurnStart: number,
  messages: readonly CoreMessage[],
): boolean {
  const group = message.protocolGroupId ?? message.id.split("#", 1)[0]!;
  const hasExplicitGroup = message.protocolGroupId !== undefined || message.id.includes("#");
  const companionComplete = messages.some((candidate, candidateIndex) => candidateIndex > index
    && (!hasExplicitGroup || (candidate.protocolGroupId ?? candidate.id.split("#", 1)[0]!) === group)
    && candidate.role === "assistant"
    && (candidate.contentType === "text" || candidate.contentType === "tool-call"));
  return config.reasoning === "safe-only"
    && index < currentTurnStart
    && !message.hardProtected
    && companionComplete
    && message.role === "assistant"
    && message.contentType === "reasoning"
    && message.reasoningKind === "plaintext-provider-agnostic"
    && message.reasoningSignature === undefined
    && (message.text?.length ?? 0) > 0
    && !message.text?.includes(CLEARED_REASONING_MARKER);
}

function addCandidate(
  candidates: Candidate[],
  index: number,
  original: string,
  replacement: string,
  countTokens: (text: string) => number,
): void {
  const originalTokens = countTokens(original);
  const savedTokens = Math.max(0, originalTokens - countTokens(replacement));
  if (savedTokens > 0) {
    candidates.push({ index, originalTokens, replacement, savedTokens });
  }
}

function collectRecentToolUses(messages: readonly CoreMessage[], keep: number): Set<string> {
  if (keep <= 0) return new Set();
  const recent = new Set<string>();
  for (let index = messages.length - 1; index >= 0 && recent.size < keep; index--) {
    const message = messages[index]!;
    if (message.contentType !== "tool-call" && message.contentType !== "tool-result") continue;
    if (message.toolCallId) recent.add(message.toolCallId);
  }
  return recent;
}

function findArtifact(
  message: CoreMessage,
  artifacts: readonly ArtifactRecord[],
): ArtifactRecord | undefined {
  return artifacts.find((artifact) => artifact.retrievable && (
    artifact.sourceMessageId === message.id
    || (message.toolCallId !== undefined && artifact.toolCallId === message.toolCallId)
  ));
}

function renderClearedToolResult(
  message: CoreMessage,
  artifact: ArtifactRecord,
  originalTokens: number,
): string {
  return [
    CLEARED_TOOL_RESULT_MARKER,
    `tool: ${message.toolName ?? artifact.toolName ?? "unknown"}`,
    `original: ~${originalTokens} tokens`,
    `artifact: ${artifact.id}`,
    `sha256: ${artifact.sha256}`,
    `Retrieve: acp_artifact({ id: "${artifact.id}" })`,
  ].join("\n");
}

function unchanged(messages: CoreMessage[]): ClearHistoricalResult {
  return { messages, clearedCount: 0, savedTokens: 0 };
}
