import {
  defaultCountTokens,
  type CompressionState,
  type CoreMessage,
  type TokenCalibrationState,
} from "acp-kernel";

const MIN_CALIBRATION_DELTA_TOKENS = 8_000;
const MIN_DENSITY = 0.75;
const MAX_DENSITY = 2;
const CONSISTENCY_TOLERANCE = 0.15;

export function collectCoveredMessageIds(state: { blocks: { active: boolean; effectiveMessageIds: string[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) ids.add(id);
  }
  return ids;
}

/** Estimate the actual text in the current projection. Historical tag snapshots are display metadata only. */
export function estimateTokens(messages: CoreMessage[], coveredIds?: Set<string>): number {
  let tokens = 0;
  for (const message of messages) {
    if (message.toolName === "compress") continue;
    if (coveredIds?.has(message.id)) continue;
    tokens += defaultCountTokens(message.text ?? "");
  }
  return tokens;
}

export function modelCalibrationKey(model: { provider?: string; id?: string } | undefined): string {
  return `${model?.provider ?? "unknown"}/${model?.id ?? "unknown"}`;
}

/**
 * Update tokenizer density from an anchored delta. `localTokens` must describe
 * the exact previous provider projection represented by `providerTokens`.
 */
export function updateTokenCalibration(
  state: CompressionState,
  modelKey: string,
  localTokens: number,
  providerTokens: number | null | undefined,
  epoch = state.currentEpoch,
  now = Date.now(),
): TokenCalibrationState | undefined {
  if (!providerTokens || providerTokens <= 0 || localTokens <= 0) return state.policyState.tokenCalibration[modelKey];
  const previous = state.policyState.tokenCalibration[modelKey];
  if (!previous || previous.anchorEpoch !== epoch || providerTokens <= previous.anchorProviderTokens || localTokens <= previous.anchorLocalTokens) {
    const anchored: TokenCalibrationState = {
      samples: 0,
      ratio: 1,
      verified: false,
      anchorProviderTokens: providerTokens,
      anchorLocalTokens: localTokens,
      anchorEpoch: epoch,
      fixedOverheadTokens: Math.max(0, providerTokens - localTokens),
      lastProviderTokens: providerTokens,
      lastEstimatedTokens: localTokens,
      updatedAt: now,
    };
    state.policyState.tokenCalibration[modelKey] = anchored;
    return anchored;
  }

  const deltaProvider = providerTokens - previous.anchorProviderTokens;
  const deltaLocal = localTokens - previous.anchorLocalTokens;
  if (deltaLocal < MIN_CALIBRATION_DELTA_TOKENS || deltaProvider <= 0) return previous;
  const observed = clamp(deltaProvider / deltaLocal, MIN_DENSITY, MAX_DENSITY);
  const candidate = previous.candidateRatio ?? observed;
  const hadCandidate = previous.candidateRatio !== undefined;
  const consistent = hadCandidate && Math.abs(observed - candidate) / Math.max(candidate, 0.001) <= CONSISTENCY_TOLERANCE;
  const candidateSamples = consistent ? (previous.candidateSamples ?? 1) + 1 : 1;
  const candidateRatio = consistent ? candidate * 0.5 + observed * 0.5 : observed;
  const verified = candidateSamples >= 2;
  const ratio = verified
    ? clamp(previous.verified ? previous.ratio * 0.8 + candidateRatio * 0.2 : candidateRatio, MIN_DENSITY, MAX_DENSITY)
    : previous.ratio;
  const calibration: TokenCalibrationState = {
    samples: verified ? previous.samples + 1 : previous.samples,
    ratio,
    verified: previous.verified || verified,
    anchorProviderTokens: providerTokens,
    anchorLocalTokens: localTokens,
    anchorEpoch: epoch,
    fixedOverheadTokens: Math.max(0, Math.round(providerTokens - localTokens * ratio)),
    candidateRatio,
    candidateSamples,
    lastProviderTokens: providerTokens,
    lastEstimatedTokens: localTokens,
    updatedAt: now,
  };
  state.policyState.tokenCalibration[modelKey] = calibration;
  return calibration;
}

export function calibratedTokenEstimate(estimatedTokens: number, state: CompressionState, modelKey: string): number {
  const calibration = state.policyState.tokenCalibration[modelKey];
  if (!calibration?.verified) return estimatedTokens;
  return Math.max(0, Math.ceil(estimatedTokens * calibration.ratio + calibration.fixedOverheadTokens));
}

export function conservativeTokenCount(values: Array<number | null | undefined>): number {
  return Math.max(0, ...values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0));
}

export function lastUserMessageId(entries: { id: string; message?: { role?: string } }[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.message?.role === "user") return entry.id;
  }
  return undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
