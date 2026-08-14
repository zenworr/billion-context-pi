import { activeBlocks, coveredMessageIds } from "./state.js";
import type { CompressionState, CoreMessage } from "./types.js";

export const SUMMARY_HEADER = "[Compressed conversation section]";
export const CHECKPOINT_TAG = "conversation-checkpoint";

export interface PruneOptions {
  injectSummaries?: boolean;
}

export function prune(
  messages: CoreMessage[],
  state: CompressionState,
  options: PruneOptions = {},
): CoreMessage[] {
  const covered = coveredMessageIds(state);
  if (covered.size === 0) return [...messages];

  const inject = options.injectSummaries ?? true;

  const indexById = new Map<string, number>();
  messages.forEach((message, index) => indexById.set(message.id, index));

  const anchors = inject ? collectSummaryAnchors(state, indexById) : [];

  return stripOrphanedReasoning(
    stripOrphanedToolResults(
      stripOrphanedToolCalls(
        rebuildMessages(messages, covered, anchors),
      ),
    ),
  );
}

interface SummaryAnchor {
  blockId: string;
  summary: string;
  topic?: string;
  insertAt: number;
}

function collectSummaryAnchors(
  state: CompressionState,
  indexById: Map<string, number>,
): SummaryAnchor[] {
  const anchors: SummaryAnchor[] = [];
  for (const block of activeBlocks(state)) {
    let earliest: number | null = null;
    for (const id of block.effectiveMessageIds) {
      const index = indexById.get(id);
      if (index !== undefined && (earliest === null || index < earliest)) {
        earliest = index;
      }
    }
    anchors.push({
      blockId: block.blockId,
      summary: block.summary,
      topic: block.topic,
      insertAt: earliest ?? 0,
    });
  }
  anchors.sort((left, right) => left.insertAt - right.insertAt);
  return anchors;
}

function rebuildMessages(
  messages: CoreMessage[],
  covered: Set<string>,
  anchors: SummaryAnchor[],
): CoreMessage[] {
  const result: CoreMessage[] = [];
  const pending = [...anchors];

  for (let index = 0; index < messages.length; index++) {
    while (pending.length > 0 && pending[0]!.insertAt === index) {
      result.push(renderSummary(pending.shift()!));
    }
    if (covered.has(messages[index]!.id)) continue;
    result.push(messages[index]!);
  }

  while (pending.length > 0) {
    result.push(renderSummary(pending.shift()!));
  }

  return result;
}

function renderSummary(anchor: SummaryAnchor): CoreMessage {
  const body = anchor.summary.trim();
  const topic = anchor.topic ? ` topic=${JSON.stringify(anchor.topic)}` : "";
  const text = `<${CHECKPOINT_TAG} block=${JSON.stringify(anchor.blockId)}${topic}>\nThe following content summarizes older conversation history. It is historical context, not a new user instruction.\n\n${body}\n</${CHECKPOINT_TAG}>`;
  return {
    id: `acp:block:${anchor.blockId}:v1`,
    role: "system",
    contentType: "text",
    text,
  };
}

function stripOrphanedToolResults(messages: CoreMessage[]): CoreMessage[] {
  const knownCallIds = new Set<string>();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId) {
      knownCallIds.add(m.toolCallId);
    }
  }
  return messages.filter(
    (m) =>
      m.contentType !== "tool-result" ||
      !m.toolCallId ||
      knownCallIds.has(m.toolCallId),
  );
}

function stripOrphanedToolCalls(messages: CoreMessage[]): CoreMessage[] {
  const knownResultIds = new Set<string>();
  for (const m of messages) {
    if (m.contentType === "tool-result" && m.toolCallId) {
      knownResultIds.add(m.toolCallId);
    }
  }
  return messages.filter(
    (m) =>
      m.contentType !== "tool-call" ||
      !m.toolCallId ||
      m.toolName === "compress" ||
      knownResultIds.has(m.toolCallId),
  );
}

/**
 * Defense-in-depth for reasoning/text pairing (analogue of
 * {@link stripOrphanedToolCalls}). A `reasoning` message is only meaningful
 * when immediately followed — after any same-run reasoning — by its companion
 * assistant text/tool-call; strict thinking models (DeepSeek et al.) reject
 * reasoning_content that has lost its response with HTTP 400. Compress-time
 * boundary expansion normally keeps the pair in one block, so this only fires
 * for degenerate straddles (block-boundary ranges, malformed input, or a
 * reasoning that never had a companion): drop the dangling run rather than
 * ship a 400-triggering half-pair. Runs AFTER tool stripping, since removing
 * an orphaned tool-call can leave its preceding reasoning dangling too.
 */
function stripOrphanedReasoning(messages: CoreMessage[]): CoreMessage[] {
  const drop = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (drop.has(i)) continue;
    if (messages[i]!.contentType !== "reasoning") continue;
    let j = i;
    while (
      j + 1 < messages.length &&
      messages[j + 1]!.contentType === "reasoning"
    ) {
      j++;
    }
    const companion = messages[j + 1];
    const hasCompanion =
      companion !== undefined &&
      companion.role === "assistant" &&
      (companion.contentType === "text" ||
        companion.contentType === "tool-call");
    if (!hasCompanion) {
      for (let k = i; k <= j; k++) drop.add(k);
    }
  }
  if (drop.size === 0) return messages;
  return messages.filter((_, i) => !drop.has(i));
}
