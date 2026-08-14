import { promises as fs } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import * as path from "node:path";
import {
  createInitialState,
  type CompressionBlock,
  type CompressionState,
} from "acp-kernel";
import { logInfo, logWarn } from "./log.js";

const STATE_SUFFIX = ".acp.json";
const STATE_MODE = 0o600;

export interface LiveRefOrigin {
  rawId: string;
  identity: string;
}

interface StateCacheSlot {
  state: CompressionState;
  liveRefOrigins: LiveRefOrigin[];
}

interface StoredState extends CompressionState {
  liveRefOrigins?: LiveRefOrigin[];
}

function stateFileFor(sessionFile: string | undefined): string | null {
  return sessionFile ? sessionFile + STATE_SUFFIX : null;
}

export async function readParentSessionPath(sessionFile: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(sessionFile, "r");
    try {
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead === 0) return undefined;
      const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
      if (!firstLine.startsWith("{")) return undefined;
      const header = JSON.parse(firstLine) as { parentSession?: unknown };
      return typeof header.parentSession === "string" ? header.parentSession : undefined;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logWarn("state", {
        event: "read-parent-header-failed",
        file: sessionFile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  }
}

function cacheKey(sessionFile: string | undefined, sessionId: string): string {
  return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
}

class FutureSchemaError extends Error {}

export class SessionStateStore {
  private cache = new Map<string, StateCacheSlot>();

  async load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState> {
    const file = stateFileFor(sessionFile);
    const key = cacheKey(sessionFile, sessionId);
    const cached = this.cache.get(key);
    if (cached) return structuredClone(cached.state);

    let state = createInitialState(sessionId);
    let liveRefOrigins: LiveRefOrigin[] = [];
    let migrated = false;

    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!isStoredState(parsed)) throw new Error("State root is not an ACP state object");
        const schemaVersion = numberValue(parsed.schemaVersion, 1);
        if (schemaVersion > 2) {
          throw new FutureSchemaError(`ACP state schema ${schemaVersion} is newer than supported schema 2; refusing to load or overwrite it.`);
        }
        liveRefOrigins = parseLiveRefOrigins(parsed.liveRefOrigins);
        migrated = schemaVersion < 2;
        state = migrateState(parsed, sessionId);
        if (migrated) {
          await backupLegacyState(file, raw);
          await persistStateFile(file, state, liveRefOrigins);
          logInfo("state", { event: "migrated", file, schemaVersion: 2 });
        }
      } catch (error) {
        if (error instanceof FutureSchemaError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          if (error instanceof SyntaxError) await quarantineCorruptState(file);
          logWarn("state", {
            event: "load-failed",
            file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (state.blocks.length === 0 && sessionFile) {
        const parentState = await this.tryLoadParentState(sessionFile, sessionId);
        if (parentState) state = parentState;
      }
    }

    this.cache.set(key, { state: structuredClone(state), liveRefOrigins });
    return structuredClone(state);
  }

  async save(
    state: CompressionState,
    sessionFile: string | undefined,
    sessionId: string,
  ): Promise<CompressionState> {
    const file = stateFileFor(sessionFile);
    if (!file) return structuredClone(state);
    const key = cacheKey(sessionFile, sessionId);
    const slot = this.cache.get(key);
    if (slot && state.revision !== slot.state.revision) {
      throw new Error(
        `ACP state revision changed during the operation (planned ${state.revision}, current ${slot.state.revision}). Replan and retry.`,
      );
    }

    const graphChanged = slot ? graphSignature(slot.state) !== graphSignature(state) : true;
    const metadataChanged = slot ? metadataSignature(slot.state) !== metadataSignature(state) : true;
    const preparedState = slot ? {
      ...state,
      graphRevision: slot.state.graphRevision + (graphChanged ? 1 : 0),
      metadataRevision: slot.state.metadataRevision + (metadataChanged ? 1 : 0),
    } : state;
    const liveRefOrigins = slot?.liveRefOrigins ?? [];
    const persisted = await withStateFileLock(file, async () => {
      try {
        const disk = JSON.parse(await fs.readFile(file, "utf8")) as { schemaVersion?: unknown; revision?: unknown };
        if (typeof disk.schemaVersion === "number" && disk.schemaVersion > 2) {
          throw new FutureSchemaError(`ACP state schema ${disk.schemaVersion} is newer than supported schema 2; refusing overwrite.`);
        }
        if (typeof disk.revision === "number" && disk.revision !== preparedState.revision) {
          throw new Error(`ACP on-disk state revision conflict: planned ${preparedState.revision}, current ${disk.revision}.`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = migrateState({ ...preparedState, revision: preparedState.revision + 1 }, sessionId);
      await persistStateFile(file, next, liveRefOrigins);
      return next;
    });
    this.cache.set(key, { state: structuredClone(persisted), liveRefOrigins });
    return structuredClone(persisted);
  }

  getLiveRefOrigins(sessionFile: string | undefined, sessionId: string): LiveRefOrigin[] {
    return [...(this.cache.get(cacheKey(sessionFile, sessionId))?.liveRefOrigins ?? [])];
  }

  setLiveRefOrigins(sessionFile: string | undefined, sessionId: string, origins: LiveRefOrigin[]): void {
    const key = cacheKey(sessionFile, sessionId);
    const slot = this.cache.get(key);
    if (slot) this.cache.set(key, { state: slot.state, liveRefOrigins: [...origins] });
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async tryLoadParentState(
    sessionFile: string,
    sessionId: string,
  ): Promise<CompressionState | undefined> {
    const maxChainDepth = 8;
    let current = sessionFile;
    for (let depth = 0; depth < maxChainDepth; depth++) {
      const parentJsonl = await readParentSessionPath(current);
      if (!parentJsonl) return undefined;
      const parentAcp = stateFileFor(parentJsonl);
      if (!parentAcp) return undefined;
      try {
        const raw = await fs.readFile(parentAcp, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && "schemaVersion" in parsed) {
          const schema = (parsed as { schemaVersion?: unknown }).schemaVersion;
          if (typeof schema === "number" && schema > 2) {
            throw new FutureSchemaError(`Parent ACP state schema ${schema} is newer than supported schema 2; refusing inheritance.`);
          }
        }
        if (isStoredState(parsed) && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
          const inherited = migrateState(parsed, sessionId);
          inherited.revision = 0;
          inherited.sessionId = sessionId;
          logInfo("state", {
            event: "inherited-parent-state",
            file: parentAcp,
            depth,
            blocks: inherited.blocks.length,
            tokensCompressed: inherited.stats.tokensCompressed,
          });
          return inherited;
        }
      } catch (error) {
        if (error instanceof FutureSchemaError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", {
            event: "parent-state-load-failed",
            file: parentAcp,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      }
      current = parentJsonl;
    }
    logWarn("state", {
      event: "parent-chain-exhausted",
      file: sessionFile,
      maxDepth: maxChainDepth,
    });
    return undefined;
  }
}

function isStoredState(value: unknown): value is Record<string, unknown> & { blocks: unknown[] } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { blocks?: unknown }).blocks));
}

function parseLiveRefOrigins(value: unknown): LiveRefOrigin[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is LiveRefOrigin => {
    if (!item || typeof item !== "object") return false;
    const origin = item as { rawId?: unknown; identity?: unknown };
    return typeof origin.rawId === "string" && typeof origin.identity === "string";
  });
}

function migrateState(parsed: Record<string, unknown>, sessionId: string): CompressionState {
  const fresh = createInitialState(sessionId);
  const blocks = Array.isArray(parsed.blocks)
    ? parsed.blocks.map((block) => migrateBlock(block, numberValue(parsed.currentEpoch, 0)))
    : [];
  const refs = objectValue(parsed.messageRefs);
  const nudge = objectValue(parsed.nudge);
  const stats = objectValue(parsed.stats);
  const policy = objectValue(parsed.policyState);
  const calibration = objectValue(policy.tokenCalibration);

  return {
    schemaVersion: 2,
    graphRevision: numberValue(parsed.graphRevision, numberValue(parsed.revision, fresh.graphRevision)),
    metadataRevision: numberValue(parsed.metadataRevision, 0),
    revision: numberValue(parsed.revision, fresh.revision),
    sessionId: stringValue(parsed.sessionId, sessionId),
    currentEpoch: numberValue(parsed.currentEpoch, fresh.currentEpoch),
    blocks,
    messageRefs: {
      byRaw: stringRecord(refs.byRaw),
      byRef: stringRecord(refs.byRef),
    },
    tokenSnapshots: numberRecord(parsed.tokenSnapshots),
    artifacts: Array.isArray(parsed.artifacts) ? structuredClone(parsed.artifacts) as CompressionState["artifacts"] : [],
    checkpoints: Array.isArray(parsed.checkpoints) ? structuredClone(parsed.checkpoints) as CompressionState["checkpoints"] : [],
    pins: Array.isArray(parsed.pins) ? structuredClone(parsed.pins) as CompressionState["pins"] : [],
    nudge: {
      ...fresh.nudge,
      ...nudge,
      anchors: objectValue(nudge.anchors),
      lastShownByTier: numberRecord(nudge.lastShownByTier),
    },
    policyState: {
      nudgeBaselines: numberRecord(policy.nudgeBaselines),
      lastActionAt: numberRecord(policy.lastActionAt),
      recentRetrievals: numberRecord(policy.recentRetrievals),
      tokenCalibration: Object.fromEntries(
        Object.entries(calibration).flatMap(([key, value]) => {
          if (!value || typeof value !== "object") return [];
          const item = value as Record<string, unknown>;
          return [[key, {
            samples: numberValue(item.samples, 0),
            ratio: numberValue(item.ratio, 1),
            verified: item.verified === true,
            anchorProviderTokens: numberValue(item.anchorProviderTokens, numberValue(item.lastProviderTokens, 0)),
            anchorLocalTokens: numberValue(item.anchorLocalTokens, numberValue(item.lastEstimatedTokens, 0)),
            anchorEpoch: numberValue(item.anchorEpoch, numberValue(parsed.currentEpoch, 0)),
            fixedOverheadTokens: numberValue(item.fixedOverheadTokens, 0),
            candidateRatio: optionalNumber(item.candidateRatio),
            candidateSamples: optionalNumber(item.candidateSamples),
            lastProviderTokens: numberValue(item.lastProviderTokens, 0),
            lastEstimatedTokens: numberValue(item.lastEstimatedTokens, 0),
            updatedAt: numberValue(item.updatedAt, 0),
          }]];
        }),
      ),
    },
    stats: {
      ...fresh.stats,
      ...Object.fromEntries(
        Object.entries(stats).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      ),
    },
    nextBlockId: numberValue(parsed.nextBlockId, fresh.nextBlockId),
    nextRunId: numberValue(parsed.nextRunId, fresh.nextRunId),
    nextArtifactId: numberValue(parsed.nextArtifactId, fresh.nextArtifactId),
    nextCheckpointId: numberValue(parsed.nextCheckpointId, fresh.nextCheckpointId),
    nextPinId: numberValue(parsed.nextPinId, fresh.nextPinId),
  };
}

function migrateBlock(value: unknown, currentEpoch: number): CompressionBlock {
  const block = objectValue(value);
  const summary = stringValue(block.renderedSummary, stringValue(block.summary, ""));
  const directMessageIds = stringArray(block.directMessageIds);
  const effectiveMessageIds = stringArray(block.effectiveMessageIds);
  const directBlockIds = stringArray(block.directBlockIds);
  const compressedTokens = numberValue(block.compressedTokens, 0);
  const sourceHash = stringValue(
    block.sourceHash,
    sha256(JSON.stringify({ directMessageIds, effectiveMessageIds, directBlockIds })),
  );
  return {
    blockId: stringValue(block.blockId, "b0"),
    runId: stringValue(block.runId, "r0"),
    epoch: numberValue(block.epoch, currentEpoch),
    tier: tierValue(block.tier),
    topic: optionalString(block.topic),
    summary,
    renderedSummary: summary,
    structuredSummary: isObject(block.structuredSummary)
      ? structuredClone(block.structuredSummary) as unknown as CompressionBlock["structuredSummary"]
      : undefined,
    manifest: isObject(block.manifest)
      ? structuredClone(block.manifest) as unknown as CompressionBlock["manifest"]
      : undefined,
    sourceHash,
    summaryHash: stringValue(block.summaryHash, sha256(summary)),
    provenance: isObject(block.provenance)
      ? structuredClone(block.provenance) as unknown as CompressionBlock["provenance"]
      : {
          requestedRoute: "main",
          execution: "inline-main",
          provider: "unknown",
          model: "legacy",
          thinking: "unknown",
          promptVersion: "legacy-v1",
        },
    quality: isObject(block.quality)
      ? structuredClone(block.quality) as unknown as CompressionBlock["quality"]
      : {
          status: "unverified",
          missingRequiredFacts: [],
          compressionRatio: compressedTokens > 0 ? Math.max(0, summary.length / 4 / compressedTokens) : 0,
          attempts: 0,
        },
    directMessageIds,
    effectiveMessageIds,
    directBlockIds,
    compressedTokens,
    createdAt: numberValue(block.createdAt, Date.now()),
    survivedCount: numberValue(block.survivedCount, 0),
    generation: block.generation === "old" ? "old" : "young",
    active: block.active !== false,
    durationMs: optionalNumber(block.durationMs),
    compressCallId: optionalString(block.compressCallId),
    startRef: optionalString(block.startRef),
    endRef: optionalString(block.endRef),
    supersededBy: optionalString(block.supersededBy),
  };
}

function graphSignature(state: CompressionState): string {
  return JSON.stringify({
    blocks: state.blocks.map(({ survivedCount: _survivedCount, ...block }) => block),
    checkpoints: state.checkpoints,
    artifacts: state.artifacts,
    pins: state.pins,
    currentEpoch: state.currentEpoch,
    messageRefs: state.messageRefs,
  });
}

function metadataSignature(state: CompressionState): string {
  return JSON.stringify({
    nudge: state.nudge,
    policyState: state.policyState,
    stats: state.stats,
    tokenSnapshots: state.tokenSnapshots,
    survivedCount: state.blocks.map((block) => [block.blockId, block.survivedCount]),
  });
}

async function withStateFileLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const lockFile = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt++) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockFile, "wx", STATE_MODE);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await handle.sync();
      return await operation();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockFile);
        if (Date.now() - stat.mtimeMs > 30_000) await fs.rm(lockFile, { force: true });
      } catch { /* lock owner released between checks */ }
      await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 2));
    } finally {
      await handle?.close().catch(() => undefined);
      if (handle) await fs.rm(lockFile, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Timed out acquiring ACP state lock ${lockFile}.`);
}

async function persistStateFile(
  file: string,
  state: CompressionState,
  liveRefOrigins: LiveRefOrigin[],
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", STATE_MODE);
  try {
    await handle.writeFile(JSON.stringify({ ...state, liveRefOrigins }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(temporary, STATE_MODE);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function backupLegacyState(file: string, raw: string): Promise<void> {
  const backup = `${file}.v1.backup`;
  try {
    await fs.writeFile(backup, raw, { encoding: "utf8", flag: "wx", mode: STATE_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function quarantineCorruptState(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
}

function tierValue(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
