import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CompressionManifest, CompressionTier } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { compressorModeForTier } from "./config.js";
import { extractCompressionManifest, mergeCompressionManifests, sha256 } from "./manifest.js";
import { estimateTokens } from "./tokens.js";

const PLAN_TTL_MS = 5 * 60_000;
const MAX_PLAN_RANGES = 4;

const PlanRange = Type.Object({
  startId: Type.String(),
  endId: Type.String(),
  topic: Type.Optional(Type.String()),
  preserve: Type.Optional(Type.Array(Type.String())),
  rationale: Type.Optional(Type.String()),
});

const PlanParams = Type.Object({
  content: Type.Array(PlanRange, { minItems: 1, maxItems: MAX_PLAN_RANGES }),
});

type PlanArgs = Static<typeof PlanParams>;

export interface FrozenCompressionRange {
  startId: string;
  endId: string;
  outputTier: CompressionTier;
  writer: "main" | "configured";
  sourceMessageIds: string[];
  sourceBlockIds: string[];
  sourceHash: string;
  sourceTokens: number;
  manifest: CompressionManifest;
}

export interface CompressionPlanTransaction {
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  stateRevision: number;
  graphRevision: number;
  policyRevision: string;
  sourceHash: string;
  ranges: FrozenCompressionRange[];
}

const transactions = new Map<string, CompressionPlanTransaction>();

export function makePlanCompressionTool(runtime: AcpRuntime): ToolDefinition<typeof PlanParams> {
  return {
    name: "plan_compression",
    label: "Plan compression",
    description: "Freeze exact normalized compression sources before an inline main-model summary. Returns an opaque one-use transaction ID, source manifest, tier, writer, and savings basis. Configured-writer ranges do not accept caller summaries.",
    promptSnippet: 'plan_compression({ content: [{ startId: "m00010", endId: "m00040" }] })',
    promptGuidelines: [
      "Call plan_compression before supplying a main-model summary to compress.",
      "Use exactly the returned normalized ranges and transactionId; never summarize a different source.",
      "For a configured writer, omit summary and call compress directly.",
    ],
    parameters: PlanParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (signal?.aborted) throw signal.reason ?? new Error("Compression planning was aborted.");
      const args = params as PlanArgs;
      const sid = ctx.sessionManager.getSessionId();
      const release = await runtime.acquireLock(sid);
      try {
        const loaded = await runtime.stateFor(ctx);
        const coreMessages = loaded.coreMessages;
        const config = runtime.configFor(ctx);
        const synchronized = runtime.core.processTurn({
          messages: coreMessages,
          state: loaded.state,
          config,
          tokenCount: estimateTokens(coreMessages),
        }).state;
        const state = synchronized.graphRevision !== loaded.state.graphRevision
          || synchronized.metadataRevision !== loaded.state.metadataRevision
          ? await runtime.save(synchronized, ctx)
          : synchronized;
        const planned = runtime.core.planCompression({ ranges: args.content.map((range) => ({
          startRef: range.startId,
          endRef: range.endId,
          topic: range.topic,
          preserve: range.preserve,
          rationale: range.rationale,
        })), messages: coreMessages, state, config });
        if (!planned.plan || planned.errors.length > 0 || planned.plan.ranges.length !== args.content.length) {
          throw new Error(`Compression plan rejected: ${planned.errors.join("; ") || "not every range normalized"}`);
        }
        const messageById = new Map(coreMessages.map((message) => [message.id, message]));
        const ranges = planned.plan.ranges.map((range, index): FrozenCompressionRange => {
          const requested = args.content[index]!;
          const rawManifest = extractCompressionManifest(
            range.sourceMessageIds.flatMap((id) => {
              const message = messageById.get(id);
              return message ? [message] : [];
            }),
            state.messageRefs.byRaw,
          );
          const manifest = mergeCompressionManifests([
            rawManifest,
            ...range.sourceBlockIds.flatMap((blockId) => {
              const block = state.blocks.find((candidate) => candidate.blockId === blockId);
              return block?.manifest ? [block.manifest] : [];
            }),
          ], range.sourceHash, range.outputTier);
          return {
            startId: requested.startId,
            endId: requested.endId,
            outputTier: range.outputTier,
            writer: compressorModeForTier(runtime.adapter, range.outputTier),
            sourceMessageIds: [...range.sourceMessageIds],
            sourceBlockIds: [...range.sourceBlockIds],
            sourceHash: range.sourceHash,
            sourceTokens: range.sourceTokens,
            manifest,
          };
        });
        const now = Date.now();
        const transaction: CompressionPlanTransaction = {
          id: `cp_${randomUUID()}`,
          sessionId: sid,
          createdAt: now,
          expiresAt: now + PLAN_TTL_MS,
          stateRevision: state.revision,
          graphRevision: state.graphRevision,
          policyRevision: compressionPolicyRevision(runtime),
          sourceHash: planned.plan.sourceHash,
          ranges,
        };
        transactions.set(transaction.id, transaction);
        pruneTransactions(now);
        const details = {
          transactionId: transaction.id,
          oneUse: true,
          expiresAt: transaction.expiresAt,
          policyRevision: transaction.policyRevision,
          sourceHash: transaction.sourceHash,
          ranges: ranges.map((range) => ({
            startId: range.startId,
            endId: range.endId,
            tier: range.outputTier,
            writer: range.writer,
            sourceMessageIds: range.sourceMessageIds,
            sourceBlockIds: range.sourceBlockIds,
            sourceHash: range.sourceHash,
            exactCompiledTokensBefore: range.sourceTokens,
            sourceManifest: range.manifest,
          })),
        };
        return { details, content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
      } finally {
        release();
      }
    },
  };
}

export function consumeCompressionPlan(id: string, sessionId: string): CompressionPlanTransaction {
  const transaction = transactions.get(id);
  transactions.delete(id);
  if (!transaction || transaction.sessionId !== sessionId) throw new Error("Compression transaction is unknown, expired, already used, or belongs to another session.");
  if (transaction.expiresAt < Date.now()) throw new Error("Compression transaction expired; plan again with current refs.");
  return transaction;
}

export function compressionPolicyRevision(runtime: AcpRuntime): string {
  return sha256(JSON.stringify({
    compress: runtime.adapter.compress ?? null,
    budget: runtime.adapter.budget ?? null,
    optimization: runtime.adapter.optimization ?? null,
    prompts: runtime.prompts,
  }));
}

function pruneTransactions(now: number): void {
  for (const [id, transaction] of transactions) if (transaction.expiresAt < now) transactions.delete(id);
}
