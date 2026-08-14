import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpRuntime } from "./runtime.js";
import {
  readArtifactSlice,
  resolveSafeOutputPathReal,
  writeArtifactToFile,
} from "./artifact-store.js";
import { debug, logError, logInfo, logThrow } from "./log.js";
import { forcedCompressionLimit } from "./config.js";
import { parsePublicAcpRef, publicAcpRef } from "./public-refs.js";

const AUTO_DIR = join(homedir() || tmpdir(), ".cache", "pi", "acp-artifacts");
const PREVIEW_CHARS = 600;

const ArtifactParams = Type.Object({
  id: Type.String({ description: 'Artifact id from a cleared result, for example "a12".' }),
  inline: Type.Optional(Type.Boolean({ description: "Return exact artifact text inline. Default: false, which writes a private file." })),
  toFile: Type.Optional(Type.String({ description: "Write the complete exact artifact to a path under /tmp, ~/.cache/opencode, or ~/.cache/pi." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Inline byte offset. Default: 0." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200_000, description: "Maximum inline bytes. Default: 64,000; hard maximum: 200,000." })),
});

type ArtifactArgs = Static<typeof ArtifactParams>;

export function makeArtifactTool(runtime: AcpRuntime): ToolDefinition<typeof ArtifactParams> {
  return {
    name: "acp_artifact",
    label: "ACP Artifact",
    description: "Retrieve an exact historical tool result by artifact id. The default writes a private file and returns its path. Use inline:true only when the exact content must enter the current context. toFile is restricted to safe cache or temporary directories.",
    promptSnippet: 'acp_artifact({ id: "a12" }) — writes to a file by default; add inline: true or toFile: "/tmp/result.txt"',
    promptGuidelines: [
      "Retrieve cleared tool output only when its exact content is needed.",
      "Prefer default file output to avoid adding a large result to context.",
      "Use inline:true only when you accept the context cost.",
    ],
    parameters: ArtifactParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const args = params as ArtifactArgs;
      try {
        const text = await handleArtifact(args, runtime, ctx);
        const parsed = parsePublicAcpRef(args.id);
        return { details: { version: 1, canonicalRef: publicAcpRef("artifact", parsed.rawRef), offset: args.offset ?? 0, limit: args.limit }, content: [{ type: "text", text }] };
      } catch (error) {
        logThrow("artifact", error, { sid: ctx.sessionManager.getSessionId(), artifactId: args.id });
        return {
          details: undefined,
          content: [{ type: "text", text: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}` }],
        };
      }
    },
  };
}

async function handleArtifact(
  args: ArtifactArgs,
  runtime: AcpRuntime,
  ctx: Parameters<ReturnType<typeof makeArtifactTool>["execute"]>[4],
): Promise<string> {
  const { state } = await runtime.stateFor(ctx);
  const artifactId = parsePublicAcpRef(args.id.trim()).rawRef;
  const record = state.artifacts.find((artifact) => artifact.id === artifactId);
  if (!record) {
    const available = state.artifacts.filter((artifact) => artifact.retrievable).map((artifact) => artifact.id);
    return `Artifact ${artifactId} not found. Available artifacts: ${available.join(", ") || "(none)"}.`;
  }

  const offset = args.offset ?? 0;
  const contextWindow = runtime.liveContextLimit(ctx);
  const hardLimit = forcedCompressionLimit(runtime.adapter, contextWindow);
  const projectedTokens = runtime.projectionFor(ctx.sessionManager.getSessionId())?.estimatedTokens ?? 0;
  const dynamicInlineBytes = Math.min(200_000, Math.max(4_000, (hardLimit - projectedTokens) * 2));
  const limit = Math.min(args.limit ?? 64_000, dynamicInlineBytes);
  let previewContent: Buffer;
  try {
    previewContent = await readArtifactSlice(record, offset, args.inline === true ? limit : PREVIEW_CHARS * 4);
  } catch (error) {
    const next = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === record.id
        ? { ...artifact, retrievable: false }
        : artifact),
    };
    await runtime.save(next, ctx).catch(() => undefined);
    throw error;
  }

  if (args.inline === true && !args.toFile) {
    debug.event("artifact-retrieve", { artifactId, mode: "inline", bytes: record.bytes, offset, limit });
    logInfo("artifact", { sid: ctx.sessionManager.getSessionId(), event: "retrieve", artifactId, mode: "inline", bytes: record.bytes, offset, limit });
    const end = Math.min(record.bytes, offset + previewContent.byteLength);
    return `Artifact ${artifactId} (${record.mime}, ${record.bytes} bytes, sha256 ${record.sha256}) bytes ${offset}-${end} restored inline:\n\n${previewContent.toString("utf8")}${end < record.bytes ? "\n\n[bounded artifact slice; request another offset or use toFile]" : ""}`;
  }

  if (args.toFile === undefined && !record.localPath.endsWith(".gz")) {
    debug.event("artifact-retrieve", { artifactId, mode: "file", path: record.localPath, bytes: record.bytes, reusedExistingPath: true });
    logInfo("artifact", { sid: ctx.sessionManager.getSessionId(), event: "retrieve", artifactId, mode: "file", path: record.localPath, bytes: record.bytes, reusedExistingPath: true });
    return [
      `Artifact ${artifactId} (${record.mime}, ${record.bytes} bytes, sha256 ${record.sha256}) is available at ${record.localPath}.`,
      "Use the read tool to access the exact content.",
      "",
      "Preview:",
      preview(previewContent.toString("utf8")),
    ].join("\n");
  }

  const targetPath = args.toFile
    ? await resolveSafeOutputPathReal(args.toFile)
    : await resolveSafeOutputPathReal(join(AUTO_DIR, `${artifactId}-${Date.now()}.txt`));
  if (!targetPath) {
    logError("artifact", { sid: ctx.sessionManager.getSessionId(), event: "path-rejected", artifactId, toFile: args.toFile });
    return `Error: toFile path must be under ${tmpdir()}, ~/.cache/opencode, or ~/.cache/pi. Got: ${args.toFile}`;
  }
  await writeArtifactToFile(record, targetPath);

  debug.event("artifact-retrieve", { artifactId, mode: "file", path: targetPath, bytes: record.bytes });
  logInfo("artifact", { sid: ctx.sessionManager.getSessionId(), event: "retrieve", artifactId, mode: "file", path: targetPath, bytes: record.bytes });
  return [
    `Artifact ${artifactId} (${record.mime}, ${record.bytes} bytes, sha256 ${record.sha256}) written to ${targetPath}.`,
    "Use the read tool to access the exact content.",
    "",
    "Preview:",
    preview(previewContent.toString("utf8")),
  ].join("\n");
}

function preview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  return `${text.slice(0, PREVIEW_CHARS)}\n\n... (truncated; use read for full content)`;
}
