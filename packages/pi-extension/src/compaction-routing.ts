import type { OptimizationRoute } from "./optimization-telemetry.js";
import { OptimizationTelemetry } from "./optimization-telemetry.js";

export interface RoutingInput {
  explicit: OptimizationRoute;
  costAware: boolean;
  configuredAvailable: boolean;
  mainAvailable: boolean;
}

export function routeCompaction(input: RoutingInput, telemetry: OptimizationTelemetry): OptimizationRoute {
  if (!input.costAware) return availableExplicit(input);
  const mainCost = input.mainAvailable ? telemetry.averageCost("main") : undefined;
  const configuredCost = input.configuredAvailable ? telemetry.averageCost("configured") : undefined;
  if (mainCost === undefined || configuredCost === undefined) return availableExplicit(input);
  return configuredCost < mainCost ? "configured" : "main";
}

function availableExplicit(input: RoutingInput): OptimizationRoute {
  if (input.explicit === "configured" && input.configuredAvailable) return "configured";
  if (input.explicit === "main" && input.mainAvailable) return "main";
  if (input.configuredAvailable) return "configured";
  return "main";
}
