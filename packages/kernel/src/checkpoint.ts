import type { CompressionState, CheckpointRecord } from "./types.js";

export interface CommitCheckpointInput {
  summary: string;
  /** Raw message ids actually included in this checkpoint source. */
  sourceMessageIds?: string[];
  /** ACP blocks captured before Pi mutates the active branch. An explicit empty array means no block coverage. */
  sourceBlockIds?: string[];
  tokensBefore?: number;
  firstKeptEntryId?: string;
  entryId?: string;
  parentCheckpointId?: string;
  provider?: string;
  model?: string;
  provenance?: CheckpointRecord["provenance"];
  sourceHash?: string;
  rawSourceHash?: string;
  transferSourceHash?: string;
  redactionManifestHash?: string;
  redactionPolicyVersion?: string;
  policyRevision?: string;
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
  const explicitBlockIds = new Set(input.sourceBlockIds ?? []);
  const subsumedBlocks = input.sourceBlockIds !== undefined
    ? state.blocks.filter((block) => explicitBlockIds.has(block.blockId))
    : sourceIds.size === 0
      ? []
      : state.blocks.filter((block) => block.active && block.effectiveMessageIds.every((id) => sourceIds.has(id) || sourceIds.has(id.split("#", 1)[0]!)));
  const subsumedIds = new Set(subsumedBlocks.map((block) => block.blockId));
  const checkpoint: CheckpointRecord = {
    id: `c${state.nextCheckpointId}`,
    epoch,
    summary: input.summary,
    firstKeptEntryId: input.firstKeptEntryId,
    entryId: input.entryId,
    sourceBlockIds: [...subsumedIds],
    sourceMessageIds: [...sourceIds],
    parentCheckpointId: input.parentCheckpointId ?? state.currentCheckpointId,
    directSourceBlockIds: [...subsumedIds],
    directSourceMessageIds: [...sourceIds],
    tokensBefore: input.tokensBefore ?? 0,
    createdAt,
    provider: input.provider,
    model: input.model,
    provenance: input.provenance,
    sourceHash: input.sourceHash,
    rawSourceHash: input.rawSourceHash,
    transferSourceHash: input.transferSourceHash,
    redactionManifestHash: input.redactionManifestHash,
    redactionPolicyVersion: input.redactionPolicyVersion,
    policyRevision: input.policyRevision,
    coverageVersion: 1,
    coverageComplete: input.coverageComplete ?? false,
    validationStatus: input.validationStatus,
  };
  return {
    checkpoint,
    state: {
      ...state,
      currentEpoch: epoch,
      currentCheckpointId: checkpoint.id,
      blocks: state.blocks.map((block) => subsumedIds.has(block.blockId) ? { ...block, active: false } : block),
      checkpoints: [...state.checkpoints, checkpoint],
      nextCheckpointId: state.nextCheckpointId + 1,
      revision: state.revision + 1,
      stats: { ...state.stats, checkpointCount: state.stats.checkpointCount + 1 },
    },
  };
}
