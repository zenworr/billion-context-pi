import type { Config } from "./types.js";

export function defaultConfig(
  modelContextLimit: number,
  overrides: Partial<Config> = {},
): Config {
  const base: Config = {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.75,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 50000,
      growthCap: 50000,
      minGrowthFloor: 20000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.95,
    },
    promotionThreshold: 5,
    truncate: { threshold: 0.95 },
    clearing: {
      enabled: true,
      keepRecentToolUses: 5,
      clearAtLeastTokens: 16000,
      excludeTools: ["compress", "edit", "write", "memory_write"],
      reasoning: "preserve",
    },
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 20000,
      minSummaryLength: 50,
    },
    protectedTools: [],
    preserveRecentMessages: 5,
    preserveRecentTokens: 5000,
    modelContextLimit,
  };
  return {
    ...base,
    ...overrides,
    tiers: { ...base.tiers, ...overrides.tiers },
    nudge: { ...base.nudge, ...overrides.nudge },
    truncate: { ...base.truncate, ...overrides.truncate },
    clearing: {
      ...base.clearing,
      ...overrides.clearing,
      excludeTools: [...new Set([
        ...base.clearing.excludeTools,
        ...(overrides.clearing?.excludeTools ?? []),
      ])],
    },
    compress: { ...base.compress, ...overrides.compress },
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  const clearing = config.clearing ?? defaultConfig(config.modelContextLimit).clearing;
  if (
    !Number.isFinite(config.modelContextLimit) ||
    config.modelContextLimit <= 0
  ) {
    errors.push("modelContextLimit must be a positive number");
  }
  if (config.nudge.minContextLimitPct > config.nudge.maxContextLimitPct) {
    errors.push(
      "nudge.minContextLimitPct must not exceed nudge.maxContextLimitPct",
    );
  }
  if (config.nudge.maxContextLimitPct > config.nudge.emergencyThresholdPct) {
    errors.push(
      "nudge.maxContextLimitPct must not exceed nudge.emergencyThresholdPct",
    );
  }
  if (config.promotionThreshold < 1) {
    errors.push("promotionThreshold must be >= 1");
  }
  if (config.truncate.threshold <= 0 || config.truncate.threshold > 1) {
    errors.push("truncate.threshold must be in (0, 1]");
  }
  if (!Number.isInteger(clearing.keepRecentToolUses) || clearing.keepRecentToolUses < 0) {
    errors.push("clearing.keepRecentToolUses must be a non-negative integer");
  }
  if (!Number.isFinite(clearing.clearAtLeastTokens) || clearing.clearAtLeastTokens < 0) {
    errors.push("clearing.clearAtLeastTokens must be a non-negative number");
  }
  if (clearing.reasoning !== "safe-only" && clearing.reasoning !== "preserve") {
    errors.push('clearing.reasoning must be "safe-only" or "preserve"');
  }
  for (const tier of [config.tiers.tier2Trigger, config.tiers.tier3Trigger]) {
    if (tier < 1) errors.push("tier triggers must be >= 1");
  }
  if (config.tiers.tier3Trigger <= config.tiers.tier2Trigger) {
    errors.push("tiers.tier3Trigger must be greater than tiers.tier2Trigger");
  }
  return errors;
}
