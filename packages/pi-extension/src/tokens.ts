import {
  defaultCountTokens,
  type CompressionState,
  type CoreMessage,
  type TokenCalibrationState,
} from "acp-kernel";

export function collectCoveredMessageIds(state: { blocks: { active: boolean; effectiveMessageIds: string[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) ids.add(id);
  }
  return ids;
}

export function estimateTokens(
  messages: CoreMessage[],
  coveredIds?: Set<string>,
  snapshots?: Record<string, number>,
): number {
  let tokens = 0;
  for (const message of messages) {
    if (message.toolName === "compress") continue;
    if (coveredIds?.has(message.id)) continue;
    tokens += snapshots?.[message.id] ?? defaultCountTokens(message.text ?? "");
  }
  return tokens;
}

export function modelCalibrationKey(model: { provider?: string; id?: string } | undefined): string {
  return `${model?.provider ?? "unknown"}/${model?.id ?? "unknown"}`;
}

export function updateTokenCalibration(
  state: CompressionState,
  modelKey: string,
  estimatedTokens: number,
  providerTokens: number | null | undefined,
  now = Date.now(),
): TokenCalibrationState | undefined {
  if (!providerTokens || providerTokens <= 0 || estimatedTokens <= 0) {
    return state.policyState.tokenCalibration[modelKey];
  }
  const observed = clamp(providerTokens / estimatedTokens, 0.5, 8);
  const previous = state.policyState.tokenCalibration[modelKey];
  const ratio = previous
    ? clamp(previous.ratio * 0.8 + observed * 0.2, 0.5, 8)
    : observed;
  const calibration: TokenCalibrationState = {
    samples: (previous?.samples ?? 0) + 1,
    ratio,
    lastProviderTokens: providerTokens,
    lastEstimatedTokens: estimatedTokens,
    updatedAt: now,
  };
  state.policyState.tokenCalibration[modelKey] = calibration;
  return calibration;
}

export function calibratedTokenEstimate(
  estimatedTokens: number,
  state: CompressionState,
  modelKey: string,
): number {
  const ratio = state.policyState.tokenCalibration[modelKey]?.ratio ?? 1;
  return Math.ceil(estimatedTokens * Math.max(1, ratio));
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
