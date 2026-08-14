export interface TestTool {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; usage?: unknown }>;
}

interface CompressionRangeInput {
  startId: string;
  endId: string;
  summary?: string;
  topic?: string;
  preserve?: string[];
  rationale?: string;
}

export function compressionToolWithPlanning(tools: readonly TestTool[]): TestTool {
  const compress = tools.find((tool) => tool.name === "compress");
  if (!compress) throw new Error("compress tool missing from test API");
  return {
    ...compress,
    async execute(toolCallIdValue, argsValue, signalValue, _onUpdate, ctx) {
      return executeCompressionWithPlan(
        tools,
        ctx,
        String(toolCallIdValue),
        argsValue as { content: CompressionRangeInput[] },
        signalValue instanceof AbortSignal ? signalValue : undefined,
      );
    },
  };
}

export async function executeCompressionWithPlan(
  tools: readonly TestTool[],
  ctx: unknown,
  toolCallId: string,
  args: { content: CompressionRangeInput[] },
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; usage?: unknown }> {
  const compress = tools.find((tool) => tool.name === "compress");
  if (!compress) throw new Error("compress tool missing from test API");
  if (!args.content.some((range) => range.summary !== undefined)) {
    return compress.execute(toolCallId, args, signal, undefined, ctx);
  }
  const planner = tools.find((tool) => tool.name === "plan_compression");
  if (!planner) throw new Error("plan_compression tool missing from test API");
  const content = args.content.map(({ summary: _summary, ...range }) => range);
  const planned = await planner.execute(`${toolCallId}-plan`, { content }, signal, undefined, ctx);
  const details = planned.details as { transactionId?: string } | undefined;
  if (!details?.transactionId) throw new Error("plan_compression returned no transactionId");
  return compress.execute(toolCallId, { ...args, transactionId: details.transactionId }, signal, undefined, ctx);
}
