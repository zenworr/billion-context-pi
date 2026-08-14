export type OptimizationRoute = "main" | "configured";

export interface UsageSample {
  input: number;
  output: number;
  cacheRead?: number;
  cost?: { total: number };
}

export interface RouteTelemetry {
  calls: number;
  cachedInput: number;
  uncachedInput: number;
  output: number;
  cost: number;
}

export interface MutationTelemetry {
  count: number;
  savingsTokens: number;
  latencyMs: number;
  discarded: number;
  shadowed: number;
}

export interface OptimizationTelemetrySnapshot {
  main: RouteTelemetry;
  configured: RouteTelemetry;
  mutation: MutationTelemetry;
}

export class OptimizationTelemetry {
  private readonly routes: Record<OptimizationRoute, RouteTelemetry> = {
    main: emptyRoute(),
    configured: emptyRoute(),
  };
  private readonly mutation: MutationTelemetry = {
    count: 0,
    savingsTokens: 0,
    latencyMs: 0,
    discarded: 0,
    shadowed: 0,
  };

  recordUsage(route: OptimizationRoute, usage: UsageSample): void {
    const target = this.routes[route];
    const cached = Math.max(0, usage.cacheRead ?? 0);
    target.calls += 1;
    target.cachedInput += cached;
    target.uncachedInput += Math.max(0, usage.input - cached);
    target.output += Math.max(0, usage.output);
    target.cost += Math.max(0, usage.cost?.total ?? 0);
  }

  recordMutation(input: { savingsTokens: number; latencyMs: number; discarded?: boolean; shadow?: boolean }): void {
    this.mutation.count += 1;
    this.mutation.savingsTokens += Math.max(0, input.savingsTokens);
    this.mutation.latencyMs += Math.max(0, input.latencyMs);
    if (input.discarded) this.mutation.discarded += 1;
    if (input.shadow) this.mutation.shadowed += 1;
  }

  averageCost(route: OptimizationRoute): number | undefined {
    const value = this.routes[route];
    return value.calls > 0 ? value.cost / value.calls : undefined;
  }

  snapshot(): OptimizationTelemetrySnapshot {
    return {
      main: { ...this.routes.main },
      configured: { ...this.routes.configured },
      mutation: { ...this.mutation },
    };
  }
}

function emptyRoute(): RouteTelemetry {
  return { calls: 0, cachedInput: 0, uncachedInput: 0, output: 0, cost: 0 };
}
