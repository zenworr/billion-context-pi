import type { CompressionState, CheckpointRecord } from "./types.js";

export interface CommitCheckpointInput {
  summary: string;
  /** Raw message ids actually included in the checkpoint source. */
  sourceMessageIds?: string[];
  tokensBefore?: number;
  firstKeptEntryId?: string;
  provider?: string;
  model?: string;
  provenance?: CheckpointRecord["provenance"];
  sourceHash?: string;
  coverageComplete?: boolean;
  validationStatus?: CheckpointRecord["validationStatus"];
  createdAt?: number;
}

export interface CommitCheckpointResult {
  state: CompressionState;
  checkpoint: CheckpointRecord;
}

/** Record a successful host checkpoint without deleting any historical block. */
export function commitCheckpointEpoch(state: CompressionState, input: CommitCheckpointInput): CommitCheckpointResult {
  const epoch = state.currentEpoch + 1;
  const createdAt = input.createdAt ?? Date.now();
  const sourceIds = new Set<string>(input.sourceMessageIds ?? []);
  const subsumedBlocks = sourceIds.size === 0
    ? []
    : state.blocks.filter((block) => block.active && block.effectiveMessageIds.every((id) => sourceIds.has(id)));
  const subsumedIds = new Set(subsumedBlocks.map((block) => block.blockId));
  const checkpoint: CheckpointRecord = {
    id: `c${state.nextCheckpointId}`,
    epoch,
    summary: input.summary,
    firstKeptEntryId: input.firstKeptEntryId,
    sourceBlockIds: [...subsumedIds],
    sourceMessageIds: [...sourceIds],
    tokensBefore: input.tokensBefore ?? 0,
    createdAt,
    provider: input.provider,
    model: input.model,
    provenance: input.provenance,
    sourceHash: input.sourceHash,
    coverageVersion: 1,
    coverageComplete: input.coverageComplete ?? false,
    validationStatus: input.validationStatus,
  };
  return {
    checkpoint,
    state: {
      ...state,
      currentEpoch: epoch,
      blocks: state.blocks.map((block) => subsumedIds.has(block.blockId) ? { ...block, active: false } : block),
      checkpoints: [...state.checkpoints, checkpoint],
      nextCheckpointId: state.nextCheckpointId + 1,
      revision: state.revision + 1,
      stats: { ...state.stats, checkpointCount: state.stats.checkpointCount + 1 },
    },
  };
}
