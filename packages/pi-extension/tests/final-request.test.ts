import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "acp-kernel";
import { compileFinalRequestProjection } from "../src/final-request.js";

test("final request projection includes every runtime suffix and calibrated fixed overhead", () => {
  const state = createInitialState("final-request");
  state.policyState.tokenCalibration["openai/model"] = {
    samples: 2,
    ratio: 1,
    verified: true,
    anchorProviderTokens: 10_000,
    anchorLocalTokens: 9_500,
    anchorEpoch: 0,
    fixedOverheadTokens: 500,
    lastProviderTokens: 10_000,
    lastEstimatedTokens: 9_500,
    updatedAt: Date.now(),
  };
  const withoutSuffix = compileFinalRequestProjection({
    baseLocalTokens: 1_000,
    suffixTexts: [],
    state,
    modelKey: "openai/model",
    baseProjectionHash: "base",
  });
  const withSuffix = compileFinalRequestProjection({
    baseLocalTokens: 1_000,
    suffixTexts: ["runtime overlay ".repeat(100), "pin payload ".repeat(100), "compression nudge ".repeat(100)],
    state,
    modelKey: "openai/model",
    baseProjectionHash: "base",
  });
  assert.ok(withSuffix.localTokens > withoutSuffix.localTokens);
  assert.equal(withoutSuffix.estimatedTokens, withoutSuffix.localTokens + 500);
  assert.notEqual(withSuffix.projectionHash, withoutSuffix.projectionHash);
});
