import type { CompressionThinkingLevel, CompressionTier } from "./config.js";

export type ValidationOutcome = "passed" | "repaired" | "fallback" | "failed";

export interface QualityPolicy {
  enabled: boolean;
  fallbackAfterFailures: number;
  maxThinking: CompressionThinkingLevel;
}

export interface QualityDecision {
  thinking: CompressionThinkingLevel;
  fallback: boolean;
}

interface QualityState {
  passed: number;
  failed: number;
  consecutiveFailures: number;
}

const LEVELS: CompressionThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export class QualityAdapter {
  private readonly outcomes = new Map<string, QualityState>();

  record(model: string, tier: CompressionTier, outcome: ValidationOutcome): void {
    const key = `${model}\0${tier}`;
    const current = this.outcomes.get(key) ?? { passed: 0, failed: 0, consecutiveFailures: 0 };
    if (outcome === "passed" || outcome === "repaired") {
      current.passed += 1;
      current.consecutiveFailures = 0;
    } else {
      current.failed += 1;
      current.consecutiveFailures += 1;
    }
    this.outcomes.set(key, current);
  }

  decide(
    model: string,
    tier: CompressionTier,
    requested: CompressionThinkingLevel,
    policy: QualityPolicy,
  ): QualityDecision {
    if (!policy.enabled) return { thinking: requested, fallback: false };
    const current = this.outcomes.get(`${model}\0${tier}`);
    const failures = current?.consecutiveFailures ?? 0;
    const requestedIndex = Math.max(0, LEVELS.indexOf(requested));
    const maximumIndex = Math.max(requestedIndex, LEVELS.indexOf(policy.maxThinking));
    const thinking = LEVELS[Math.min(maximumIndex, requestedIndex + failures)] ?? requested;
    return {
      thinking,
      fallback: failures >= Math.max(1, policy.fallbackAfterFailures),
    };
  }

  snapshot(model: string, tier: CompressionTier): Readonly<QualityState> | undefined {
    const value = this.outcomes.get(`${model}\0${tier}`);
    return value ? { ...value } : undefined;
  }
}
