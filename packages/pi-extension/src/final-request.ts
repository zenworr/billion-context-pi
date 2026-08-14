import { createHash } from "node:crypto";
import { defaultCountTokens, type CompressionState } from "acp-kernel";
import { calibratedTokenEstimate } from "./tokens.js";

export interface FinalRequestProjection {
  localTokens: number;
  estimatedTokens: number;
  suffixTokens: number;
  projectionHash: string;
}

export function compileFinalRequestProjection(input: {
  baseLocalTokens: number;
  suffixTexts: readonly string[];
  state: CompressionState;
  modelKey: string;
  baseProjectionHash: string;
}): FinalRequestProjection {
  const suffixTokens = input.suffixTexts.reduce((sum, text) => sum + defaultCountTokens(text), 0);
  const localTokens = Math.max(0, input.baseLocalTokens) + suffixTokens;
  return {
    localTokens,
    estimatedTokens: calibratedTokenEstimate(localTokens, input.state, input.modelKey),
    suffixTokens,
    projectionHash: createHash("sha256").update(JSON.stringify({ base: input.baseProjectionHash, suffixes: input.suffixTexts })).digest("hex"),
  };
}
