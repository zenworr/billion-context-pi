import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import type { CompressConfig, CompressionThinkingLevel, CompressionTier, CompressorMode } from "./config.js";
import { compressionThinkingLevel, compressorModeForTier, parseCompressionModel } from "./config.js";
import { updateProjectCompressionConfig } from "./user-config.js";
import { defaultCountTokens, parseBlockIdArg, collectBlockContent, formatRanges } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { getDelegateUsage } from "./delegate-tool.js";
import { formatCompactTokens } from "./footer-status.js";
import { promoteBlock } from "./project-memory.js";
import { cleanupArtifactStore } from "./artifact-store.js";

declare const CURRENT_VERSION: string;

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function makeCommands(runtime: AcpRuntime): Array<{ name: string; options: CommandOptions }> {
  return [
    {
      name: "acp",
      options: {
        description: "Show ACP status, or explicitly promote a block with /acp promote bN.",
        handler: async (args, ctx) => {
          const [subcommand, ref] = args.trim().split(/\s+/, 2);
          if (subcommand === "promote") {
            if (!ref) { ctx.ui.notify("Usage: /acp promote <blockId>", "error"); return; }
            try { ctx.ui.notify(await promoteBlock(runtime, ctx, ref)); }
            catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
            return;
          }
          if (subcommand === "artifacts-cleanup") {
            try {
              const { state } = await runtime.stateFor(ctx);
              const cleaned = await cleanupArtifactStore(state, ctx.sessionManager.getSessionId());
              ctx.ui.notify(`Artifact cleanup removed ${cleaned.removed} orphaned files (${cleaned.reclaimedBytes} bytes).`);
            } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
            return;
          }
          ctx.ui.notify(await statusReport(runtime, ctx));
        },
      },
    },
    {
      name: "acp-status",
      options: {
        description: "Detailed ACP status (block tiers, token breakdown, delegate usage).",
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-decompress",
      options: {
        description: "Restore a compressed block's content (shown here, block stays folded). Usage: /acp-decompress b3",
        handler: async (args, ctx) => {
          const blockId = parseBlockIdArg(args);
          if (!blockId) {
            ctx.ui.notify('Usage: /acp-decompress <blockId> (e.g. "b3")');
            return;
          }
          const { state, coreMessages } = await runtime.stateFor(ctx);
          const block = state.blocks.find((b) => b.blockId === blockId);
          if (!block) {
            ctx.ui.notify(`Block ${blockId} not found.`);
            return;
          }
          const { text, count } = collectBlockContent(state, block, coreMessages, { full: false });
          if (count === 0) {
            ctx.ui.notify(`Block ${blockId} has no restorable message content.`);
            return;
          }
          ctx.ui.notify(`Block ${blockId} (${count} items):\n\n${text}`);
        },
      },
    },
    {
      name: "acp-search",
      options: {
        description: "Search compressed block summaries. Usage: /acp-search auth token",
        handler: async (args, ctx) => {
          const query = args.trim();
          if (!query) {
            ctx.ui.notify("Usage: /acp-search <query>");
            return;
          }
          const { state } = await runtime.stateFor(ctx);
          const hits = runtime.core.search(query, state);
          if (hits.length === 0) {
            ctx.ui.notify("No matching blocks.");
            return;
          }
          const lines = hits.map((b) => `[${b.blockId}] (t${b.tier}) ${b.topic ?? ""}`.trim());
          ctx.ui.notify(lines.join("\n"));
        },
      },
    },
    {
      name: "acp-model",
      options: {
        description: "Select the model used by configured ACP compressors.",
        handler: async (_args, ctx) => selectCompressionModel(runtime, ctx),
      },
    },
    {
      name: "acp-settings",
      options: {
        description: "Configure ACP compression model routing and thinking level.",
        handler: async (_args, ctx) => configureCompressionTiers(runtime, ctx),
      },
    },
  ];
}

async function selectCompressionModel(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/acp-model requires an interactive UI.", "error");
    return;
  }
  const models = ctx.modelRegistry.getAvailable();
  const ids = [...new Set(models.map((model) => `${model.provider}/${model.id}`))].sort();
  if (ids.length === 0) {
    ctx.ui.notify("No authenticated models are available.", "warning");
    return;
  }
  const current = runtime.adapter.compress?.model;
  const selected = await ctx.ui.select(
    current ? `ACP compression model (current: ${current})` : "ACP compression model",
    ids,
  );
  if (!selected) return;
  const selectedModel = models.find((model) => `${model.provider}/${model.id}` === selected);
  const levels: CompressionThinkingLevel[] = selectedModel ? thinkingLevelsForModel(selectedModel) : ["off"];
  const currentThinking = compressionThinkingLevel(runtime.adapter);
  const thinkingLevel = levels.includes(currentThinking)
    ? currentThinking
    : levels.includes("medium")
      ? "medium"
      : levels[0]!;
  await persistCompressionPatch(runtime, ctx, { model: selected, thinkingLevel });
  ctx.ui.notify(`ACP compression model set to ${selected}.`, "info");
}

async function configureCompressionTiers(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/acp-settings requires an interactive UI.", "error");
    return;
  }
  while (true) {
    const rows = ([1, 2, 3] as const).map((tier) =>
      `Tier-${tier} compressor: ${displayCompressor(runtime, tier)}`,
    );
    const thinkingRow = `Configured model thinking: ${compressionThinkingLevel(runtime.adapter)}`;
    const selected = await ctx.ui.select("ACP compression settings", [...rows, thinkingRow, "Done"]);
    if (!selected || selected === "Done") return;
    if (selected === thinkingRow) {
      const level = await ctx.ui.select("Configured model thinking level", availableThinkingLevels(runtime, ctx));
      if (level && isCompressionThinkingLevel(level)) {
        await persistCompressionPatch(runtime, ctx, { thinkingLevel: level });
      }
      continue;
    }
    const index = rows.indexOf(selected);
    if (index < 0) return;
    const tier = (index + 1) as CompressionTier;
    const modeLabel = await ctx.ui.select(`Tier-${tier} compressor`, ["main model", "configured model"]);
    if (!modeLabel) continue;
    const mode: CompressorMode = modeLabel === "configured model" ? "configured" : "main";
    if (mode === "configured" && !configuredModelAvailable(runtime, ctx)) {
      ctx.ui.notify("Select an authenticated compression model with /acp-model first.", "warning");
      continue;
    }
    await persistCompressionPatch(runtime, ctx, compressorPatchForTier(tier, mode));
  }
}

function displayCompressor(runtime: AcpRuntime, tier: CompressionTier): string {
  const mode = compressorModeForTier(runtime.adapter, tier);
  if (mode === "main") return "main model";
  return `configured model (${runtime.adapter.compress?.model ?? "not selected"})`;
}

function configuredModelAvailable(runtime: AcpRuntime, ctx: ExtensionCommandContext): boolean {
  const ref = parseCompressionModel(runtime.adapter.compress?.model);
  if (!ref) return false;
  const model = ctx.modelRegistry.find(ref.provider, ref.id);
  return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
}

function availableThinkingLevels(runtime: AcpRuntime, ctx: ExtensionCommandContext): CompressionThinkingLevel[] {
  const ref = parseCompressionModel(runtime.adapter.compress?.model);
  const model = ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
  return model ? thinkingLevelsForModel(model) : ["off"];
}

function thinkingLevelsForModel(model: NonNullable<ExtensionCommandContext["model"]>): CompressionThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  const levels: CompressionThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
  if (model.thinkingLevelMap?.xhigh !== undefined && model.thinkingLevelMap.xhigh !== null) levels.push("xhigh");
  if (model.thinkingLevelMap?.max !== undefined && model.thinkingLevelMap.max !== null) levels.push("max");
  return levels.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

function isCompressionThinkingLevel(value: string): value is CompressionThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function compressorPatchForTier(tier: CompressionTier, mode: CompressorMode): Partial<CompressConfig> {
  if (tier === 1) return { tier1Compressor: mode };
  if (tier === 2) return { tier2Compressor: mode };
  return { tier3Compressor: mode };
}

async function persistCompressionPatch(
  runtime: AcpRuntime,
  ctx: ExtensionCommandContext,
  patch: Partial<CompressConfig>,
): Promise<void> {
  try {
    await updateProjectCompressionConfig(ctx.cwd, patch);
    runtime.setAdapter({
      ...runtime.adapter,
      compress: { ...runtime.adapter.compress, ...patch },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not save ACP compression settings: ${message}`, "error");
    throw error;
  }
}

function fmtTokens(n: number): string {
  return formatCompactTokens(n);
}

function bar(value: number, total: number, width: number = 20): string {
  if (total === 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((value / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function statusReport(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Use pi's real context usage (anchored on provider usage) instead of a
  // chars/4 estimate — matches the footer percentage and the nudge decision
  // the context transform computes.
  const realUsage = ctx.getContextUsage?.();
  const tokenCount = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : defaultCountTokens(coreMessages.map((m) => m.text ?? "").join("\n"));

  const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
  const nudge = turn.nudge;
  const bd = nudge?.contextBreakdown;
  const limit = config.modelContextLimit;
  // displayTotal must reflect the REAL context size (what the footer shows),
  // not just the sum of message-text categories. contextBreakdown only
  // classifies message text via chars/4 and never sees pi's system prompt
  // or tool schemas, so summing its fields undercounts. Split the gap into
  // the real system prompt (measured) and the rest (tool schemas + the
  // inevitable chars/4-vs-real-tokenizer drift).
  const classified = bd ? bd.system + bd.tool + bd.summaries + bd.code + bd.text : 0;
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const framework = bd ? Math.max(0, tokenCount - classified - systemPromptTokens) : 0;
  const displayTotal = tokenCount;
  const displayPct = limit > 0 ? Math.round((displayTotal / limit) * 100) : 0;
  const activeBlocksList = state.blocks.filter((b) => b.active);
  const totalBlocksList = state.blocks;

  const lines: string[] = [];

  const versionStr = CURRENT_VERSION ? `billion-context-pi@${CURRENT_VERSION}` : "";

  lines.push("╭─────────────────────────────────────────────╮");
  lines.push("│           ACP Context Analysis              │");
  lines.push("╰─────────────────────────────────────────────╯");
  if (versionStr) lines.push(versionStr);
  lines.push("");
  lines.push(`Context: ${displayPct}% (${fmtTokens(displayTotal)} / ${fmtTokens(limit)})`);

  if (nudge && bd) {
    const growth = bd.growth;
    if (growth > 0 && displayTotal > 0) {
      lines.push(`Growth: +${fmtTokens(growth)} since last nudge`);
    }
    if (displayTotal > 0) {
      lines.push("");
      lines.push("Token Breakdown:");

      const categories: Array<{ label: string; value: number }> = [
        { label: "Tool", value: bd.tool },
        { label: "SysPrompt", value: systemPromptTokens },
        { label: "Framework", value: framework },
        { label: "Text", value: bd.text },
        { label: "Code", value: bd.code },
        { label: "Summaries", value: bd.summaries },
      ];

      for (const cat of categories) {
        if (cat.value <= 0) continue;
        const pct = displayTotal > 0 ? Math.round((cat.value / displayTotal) * 100) : 0;
        const b = bar(cat.value, displayTotal);
        lines.push(`  ${cat.label.padEnd(10)} ${b} ${String(pct).padStart(3)}%  ${fmtTokens(cat.value)}`);
      }
    }
  }

  lines.push("");

  if (nudge) {
    if (nudge.shouldInject) {
      const tierInfo = nudge.tier ? ` [T${nudge.tier} distillation]` : "";
      lines.push(`Nudge: ACTIVE${tierInfo} — ${nudge.reason}`);
    } else {
      lines.push(`Nudge: idle — ${nudge.reason}`);
    }
  }

  const ranges = nudge?.compressibleRanges ?? [];
  const protectedRanges = nudge?.protectedRanges ?? [];
  if (ranges.length > 0 || protectedRanges.length > 0) {
    lines.push("");
    lines.push(formatRanges(ranges, protectedRanges));
  }

  if (activeBlocksList.length > 0) {
    lines.push("");
    lines.push(`Blocks: ${activeBlocksList.length} active / ${totalBlocksList.length} total (${fmtTokens(state.stats.tokensCompressed)} tokens compressed)`);
    for (const b of activeBlocksList) {
      const topic = b.topic ? `: ${b.topic}` : "";
      const summaryTok = defaultCountTokens(b.summary || "");
      const origTok = b.compressedTokens > 0 ? b.compressedTokens : summaryTok;
      lines.push(`  [${b.blockId}] T${b.tier} ${fmtTokens(origTok)}\u2192${fmtTokens(summaryTok)}${topic}`);
    }
  } else if (totalBlocksList.length > 0) {
    lines.push("");
    lines.push(`Blocks: 0 active / ${totalBlocksList.length} total (${fmtTokens(state.stats.tokensCompressed)} tokens compressed)`);
  } else {
    lines.push("");
    lines.push("Blocks: none (nothing compressed yet)");
  }

  lines.push("");
  const delegateUsage = getDelegateUsage();
  if (delegateUsage && delegateUsage.totalTokens > 0) {
    lines.push("");
    const cost = delegateUsage.cost.total;
    const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";
    lines.push("── Session delegate usage (excluded from main totals) ──");
    lines.push(`Tokens: ${delegateUsage.input.toLocaleString()} in, ${delegateUsage.output.toLocaleString()} out (${delegateUsage.totalTokens.toLocaleString()} total)${costStr}`);
  }
  lines.push("");
  lines.push("Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.");

  return lines.join("\n");
}
