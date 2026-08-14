import type { CompressConfig } from "./config.js";
import type { CompressionUsage } from "./model-compressor.js";

export class CompressionCallBudget {
  private calls = 0;
  private reservedInput = 0;
  private reservedOutput = 0;
  private reservedCost = 0;

  constructor(private readonly config: CompressConfig | undefined) {}

  reserve(source: string, maxChars: number): void {
    this.reserveEstimated(Math.max(1, Math.ceil(source.length / 4)), Math.max(1, Math.ceil(maxChars / 4)));
  }

  reserveEstimated(input: number, output: number): void {
    input = Math.max(1, Math.ceil(input));
    output = Math.max(1, Math.ceil(output));
    const cost = (input * 0.02 + output * 0.06) / 1_000;
    if (this.calls + 1 > (this.config?.maxModelCalls ?? 6)) throw new Error("Compression model-call budget exhausted before provider request.");
    if (this.reservedInput + input > (this.config?.maxInputTokens ?? 400_000)) throw new Error("Compression input-token budget exhausted before provider request.");
    if (this.reservedOutput + output > (this.config?.maxOutputTokens ?? 40_000)) throw new Error("Compression output-token budget exhausted before provider request.");
    if (this.reservedCost + cost > (this.config?.maxCostUsd ?? 5)) throw new Error("Compression conservative cost budget exhausted before provider request.");
    this.calls += 1;
    this.reservedInput += input;
    this.reservedOutput += output;
    this.reservedCost += cost;
  }

  observe(usage: CompressionUsage | undefined): void {
    if (!usage) return;
    if (usage.input > (this.config?.maxInputTokens ?? 400_000)) throw new Error("Compression actual input-token budget exceeded.");
    if (usage.output > (this.config?.maxOutputTokens ?? 40_000)) throw new Error("Compression actual output-token budget exceeded.");
    if ((usage.cost?.total ?? 0) > (this.config?.maxCostUsd ?? 5)) throw new Error("Compression actual cost budget exceeded.");
  }
}
