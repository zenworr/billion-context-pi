import type { CompressionState, CoreMessage } from "./types.js";

export interface SyncResult {
  state: CompressionState;
  deactivated: string[];
}

export function syncBlocks(
  messages: CoreMessage[],
  state: CompressionState,
): SyncResult {
  const presentIds = new Set(messages.map((message) => message.id));
  const deactivated: string[] = [];
  const result: CompressionState = structuredClone(state);

  const branchEligibleBlockIds = new Set(
    result.blocks
      .filter(
        (block) =>
          block.effectiveMessageIds.length > 0 &&
          block.effectiveMessageIds.every((id) => presentIds.has(id)),
      )
      .map((block) => block.blockId),
  );
  const consumedBlockIds = new Set<string>();
  for (const block of result.blocks) {
    if (!branchEligibleBlockIds.has(block.blockId)) continue;
    for (const consumedId of block.directBlockIds) {
      consumedBlockIds.add(consumedId);
    }
  }

  for (const block of result.blocks) {
    const branchEligible = branchEligibleBlockIds.has(block.blockId);
    block.active = branchEligible && !consumedBlockIds.has(block.blockId);
    if (!branchEligible) deactivated.push(block.blockId);
  }

  return { state: result, deactivated };
}
