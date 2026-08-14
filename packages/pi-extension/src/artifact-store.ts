import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import {
  defaultCountTokens,
  type ArtifactRecord,
  type CompressionState,
  type CoreMessage,
} from "acp-kernel";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
export const ARTIFACT_MIN_TOKENS = 1000;
export const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_SESSION_ARTIFACT_BYTES = 500 * 1024 * 1024;
export const DEFAULT_MAX_GLOBAL_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

export interface SpoolArtifactInput {
  sessionId: string;
  sourceMessageId: string;
  toolCallId?: string;
  toolName?: string;
  text?: string;
  textParts?: readonly string[];
  /** Exact ordered tool-result blocks. Stored as a versioned JSON envelope. */
  contentParts?: readonly unknown[];
  bashFullOutputPath?: string;
  createdAt?: number;
  maxArtifactBytes?: number;
  maxSessionBytes?: number;
  maxGlobalBytes?: number;
  /** Store below the normal usefulness threshold when visible output will be capped. */
  force?: boolean;
}

export interface SpoolArtifactResult {
  state: CompressionState;
  record: ArtifactRecord;
  reusedExistingPath: boolean;
}

export function artifactStoreRoot(): string {
  return join(homedir(), ".pi", "acp-artifacts");
}

export function artifactSessionDirectory(sessionId: string, root = artifactStoreRoot()): string {
  return join(root, createHash("sha256").update(sessionId).digest("hex"));
}

export interface ArtifactCleanupResult { removed: number; reclaimedBytes: number }

export async function removeArtifactSession(sessionId: string, root = artifactStoreRoot()): Promise<void> {
  const release = await acquireArtifactQuotaLock(root);
  try {
    await fs.rm(artifactSessionDirectory(sessionId, root), { recursive: true, force: true });
    await fs.rm(join(root, ".quota-index.json"), { force: true });
  } finally {
    await release();
  }
}

/** Remove only files not referenced by the current session state. */
export async function cleanupArtifactStore(
  state: CompressionState,
  sessionId: string,
  root = artifactStoreRoot(),
): Promise<ArtifactCleanupResult> {
  const release = await acquireArtifactQuotaLock(root);
  try {
    const sessionDir = artifactSessionDirectory(sessionId, root);
    const referenced = new Set(state.artifacts.filter((artifact) => artifact.localPath).map((artifact) => resolve(artifact.localPath)));
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(sessionDir, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, reclaimedBytes: 0 };
      throw error;
    }
    let removed = 0;
    let reclaimedBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = resolve(sessionDir, entry.name);
      if (referenced.has(path)) continue;
      const stat = await fs.stat(path).catch(() => undefined);
      reclaimedBytes += stat?.size ?? 0;
      await fs.rm(path, { force: true });
      removed += 1;
    }
    if (removed > 0) await fs.rm(join(root, ".quota-index.json"), { force: true });
    return { removed, reclaimedBytes };
  } finally {
    await release();
  }
}

export async function artifactStoreBytes(root = artifactStoreRoot()): Promise<number> {
  const release = await acquireArtifactQuotaLock(root);
  try {
    return await artifactStoreBytesUnlocked(root);
  } finally {
    await release();
  }
}

async function artifactStoreBytesUnlocked(root: string): Promise<number> {
  const indexPath = join(root, ".quota-index.json");
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as { version?: unknown; bytes?: unknown; pending?: unknown };
    if (parsed.version === 1 && parsed.pending === undefined
      && typeof parsed.bytes === "number" && Number.isSafeInteger(parsed.bytes) && parsed.bytes >= 0) return parsed.bytes;
    // A pending reservation means the previous process stopped between the
    // atomic quota reservation and commit. Reconcile the bounded gzip tree.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".gz")) total += await gzipUncompressedBytes(path);
    }
  }
  await recordArtifactStoreBytes(root, total);
  return total;
}

async function recordArtifactStoreBytes(root: string, bytes: number, pending?: { id: string; bytes: number }): Promise<void> {
  await writePrivateFile(join(root, ".quota-index.json"), Buffer.from(`${JSON.stringify({ version: 1, bytes, updatedAt: Date.now(), ...(pending ? { pending } : {}) })}\n`));
}

async function gzipUncompressedBytes(file: string): Promise<number> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < 4) return 0;
    const footer = Buffer.allocUnsafe(4);
    await handle.read(footer, 0, 4, stat.size - 4);
    return footer.readUInt32LE(0);
  } finally {
    await handle.close();
  }
}

export async function ensureArtifactStore(root = artifactStoreRoot()): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.chmod(root, PRIVATE_DIR_MODE);
  const probe = join(root, `.health-${process.pid}-${randomUUID()}`);
  await writePrivateFile(probe, Buffer.from("ok"));
  await fs.rm(probe, { force: true });
}

export async function spoolArtifact(
  state: CompressionState,
  input: SpoolArtifactInput,
  root = artifactStoreRoot(),
): Promise<SpoolArtifactResult | undefined> {
  const reusable = input.bashFullOutputPath
    ? await inspectReusableBashOutput(input.bashFullOutputPath)
    : undefined;
  const textParts = input.textParts ?? [input.text ?? ""];
  const textTokens = textParts.reduce((sum, part) => sum + defaultCountTokens(part), 0);
  const estimatedTokens = reusable?.estimatedTokens ?? textTokens;
  if (estimatedTokens < ARTIFACT_MIN_TOKENS && input.force !== true) return undefined;
  const structuredContent = !reusable && input.contentParts
    ? Buffer.from(JSON.stringify({ version: 1, kind: "tool-result-content", content: input.contentParts }), "utf8")
    : undefined;
  const storedParts = structuredContent ? [structuredContent.toString("utf8")] : textParts;
  const artifactMime = structuredContent
    ? "application/vnd.billion-context-pi.tool-result+json; version=1"
    : "text/plain; charset=utf-8";

  const contentHash = reusable ? undefined : hashTextParts(storedParts);
  const existing = contentHash ? state.artifacts.find((artifact) => (
    input.toolCallId !== undefined
    && artifact.toolCallId === input.toolCallId
    && artifact.toolName === input.toolName
    && artifact.sha256 === contentHash
    && artifact.retrievable
  )) : undefined;
  if (existing) return { state, record: existing, reusedExistingPath: true };

  const bytes = reusable?.bytes ?? storedParts.reduce((sum, part) => sum + Buffer.byteLength(part, "utf8"), 0);
  const maxArtifactBytes = input.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maxSessionBytes = input.maxSessionBytes ?? DEFAULT_MAX_SESSION_ARTIFACT_BYTES;
  const maxGlobalBytes = input.maxGlobalBytes ?? DEFAULT_MAX_GLOBAL_ARTIFACT_BYTES;
  const sessionBytes = state.artifacts.filter((artifact) => artifact.retrievable).reduce((sum, artifact) => sum + artifact.bytes, 0);
  const releaseQuota = await acquireArtifactQuotaLock(root);
  try {
  const globalBytes = await artifactStoreBytesUnlocked(root);
  const next = structuredClone(state);
  const id = `a${Math.max(1, next.nextArtifactId)}`;
  next.nextArtifactId = Math.max(1, next.nextArtifactId) + 1;
  if (bytes > maxArtifactBytes || sessionBytes + bytes > maxSessionBytes) {
    const error = bytes > maxArtifactBytes
      ? `artifact exceeds per-artifact quota (${bytes}/${maxArtifactBytes} bytes)`
      : `session artifact quota exceeded (${sessionBytes + bytes}/${maxSessionBytes} bytes)`;
    const record: ArtifactRecord = {
      id, status: "unavailable", error, sha256: contentHash ?? "unavailable",
      sourceMessageId: input.sourceMessageId, toolCallId: input.toolCallId, toolName: input.toolName,
      mime: artifactMime, bytes, estimatedTokens, localPath: "",
      createdAt: input.createdAt ?? Date.now(), retrievable: false,
    };
    next.artifacts.push(record);
    return { state: next, record, reusedExistingPath: false };
  }

  // Reserve the full logical size atomically before finalizing the gzip blob.
  // A crash can now only overcount. A later reader sees `pending` and
  // reconciles the tree; it can never trust an index that omits a new blob.
  const reservation = { id: randomUUID(), bytes };
  await recordArtifactStoreBytes(root, globalBytes + bytes, reservation);
  let stored: Awaited<ReturnType<typeof storeCompressedParts>>;
  try {
    // Stream Bash files into private gzip storage; never duplicate a huge
    // output into a JavaScript string or depend on an ephemeral host path.
    stored = reusable
      ? await storeCompressedFile(root, input.sessionId, reusable.localPath, reusable.bytes)
      : await storeCompressedParts(root, input.sessionId, storedParts);
  } catch (error) {
    await recordArtifactStoreBytes(root, globalBytes).catch(() => undefined);
    throw error;
  }
  const physicalDelta = stored.reusedExistingPath ? 0 : stored.bytes;
  if (globalBytes + physicalDelta > maxGlobalBytes) {
    if (!stored.reusedExistingPath) await fs.rm(stored.localPath, { force: true });
    await recordArtifactStoreBytes(root, globalBytes);
    const record: ArtifactRecord = {
      id, status: "unavailable", error: `global artifact quota exceeded (${globalBytes + physicalDelta}/${maxGlobalBytes} bytes)`,
      sha256: stored.sha256, sourceMessageId: input.sourceMessageId, toolCallId: input.toolCallId, toolName: input.toolName,
      mime: artifactMime, bytes: stored.bytes, estimatedTokens, localPath: "", createdAt: input.createdAt ?? Date.now(), retrievable: false,
    };
    next.artifacts.push(record);
    return { state: next, record, reusedExistingPath: false };
  }
  const record: ArtifactRecord = {
    id,
    status: "ready",
    sha256: stored.sha256,
    sourceMessageId: input.sourceMessageId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    mime: artifactMime,
    bytes: stored.bytes,
    estimatedTokens,
    localPath: stored.localPath,
    createdAt: input.createdAt ?? Date.now(),
    retrievable: true,
  };
  next.artifacts.push(record);
  next.stats.rawTokensExternalized += estimatedTokens;
  await recordArtifactStoreBytes(root, globalBytes + physicalDelta);
  return { state: next, record, reusedExistingPath: stored.reusedExistingPath };
  } finally {
    await releaseQuota();
  }
}

async function acquireArtifactQuotaLock(root: string): Promise<() => Promise<void>> {
  await fs.mkdir(root, { recursive: true, mode: PRIVATE_DIR_MODE });
  const lockPath = join(root, ".quota.lock");
  const recoveryPath = join(root, ".quota-recovery.lock");
  const owner = `${randomUUID()}:${process.pid}`;
  const startedAt = Date.now();
  for (;;) {
    if (await fs.stat(recoveryPath).then(() => true, (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    })) {
      if (Date.now() - startedAt > 5_000) throw new Error("Artifact quota recovery lock is unavailable; refusing an unsafe concurrent write.");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      continue;
    }
    try {
      const handle = await createOwnedLock(lockPath, owner);
      return ownedLockRelease(handle, lockPath, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 10 * 60_000) {
        let recoveryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          recoveryHandle = await createOwnedLock(recoveryPath, owner);
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code !== "EEXIST") throw recoveryError;
        }
        if (recoveryHandle) {
          const releaseRecovery = ownedLockRelease(recoveryHandle, recoveryPath, owner);
          try {
            // Only the recovery-lock owner may remove a dead main owner. All
            // normal acquirers wait while this guard exists, so a late stale
            // observer cannot delete a replacement lock.
            const current = await fs.readFile(lockPath, "utf8").catch(() => "");
            const currentStat = await fs.stat(lockPath).catch(() => undefined);
            if (currentStat && Date.now() - currentStat.mtimeMs > 10 * 60_000 && !lockOwnerAlive(current)) {
              await fs.rm(lockPath, { force: true });
              try {
                const handle = await createOwnedLock(lockPath, owner);
                await releaseRecovery();
                return ownedLockRelease(handle, lockPath, owner);
              } catch (replacementError) {
                if ((replacementError as NodeJS.ErrnoException).code !== "EEXIST") throw replacementError;
              }
            }
          } finally {
            await releaseRecovery();
          }
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
}

async function createOwnedLock(path: string, owner: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const handle = await fs.open(path, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${owner}\n${Date.now()}\n`);
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

function ownedLockRelease(handle: Awaited<ReturnType<typeof fs.open>>, path: string, owner: string): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close().catch(() => undefined);
    const current = await fs.readFile(path, "utf8").catch(() => "");
    if (current.startsWith(`${owner}\n`)) await fs.rm(path, { force: true });
  };
}

function lockOwnerAlive(content: string): boolean {
  const pid = Number(content.split(":", 2)[1]?.split("\n", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reconcileArtifactSources(
  state: CompressionState,
  messages: readonly CoreMessage[],
): CompressionState {
  let changed = false;
  const artifacts = state.artifacts.map((artifact) => {
    if (!artifact.toolCallId) return artifact;
    const source = messages.find((message) => (
      message.contentType === "tool-result"
      && message.toolCallId === artifact.toolCallId
      && (artifact.toolName === undefined || message.toolName === artifact.toolName)
    ));
    if (!source || source.id === artifact.sourceMessageId) return artifact;
    changed = true;
    return { ...artifact, sourceMessageId: source.id };
  });
  return changed ? { ...state, artifacts } : state;
}

export async function readArtifact(record: ArtifactRecord): Promise<Buffer> {
  if (!record.retrievable) throw new Error(`Artifact ${record.id} is marked unavailable.`);
  try {
    const content = record.localPath.endsWith(".gz")
      ? await gunzipFile(record.localPath)
      : await fs.readFile(record.localPath);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== record.sha256 || content.byteLength !== record.bytes) throw new Error("hash or size mismatch");
    return content;
  } catch (error) {
    throw new Error(`Artifact ${record.id} failed integrity verification: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readArtifactSlice(record: ArtifactRecord, offset: number, limit: number): Promise<Buffer> {
  if (!record.retrievable) throw new Error(`Artifact ${record.id} is marked unavailable.`);
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let position = 0;
  let bytes = 0;
  const sink = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<never, void, unknown> {
    for await (const chunk of source) {
      hash.update(chunk); bytes += chunk.byteLength;
      const start = Math.max(0, offset - position);
      const end = Math.min(chunk.byteLength, offset + limit - position);
      if (end > start) chunks.push(Buffer.from(chunk.subarray(start, end)));
      position += chunk.byteLength;
    }
  };
  if (record.localPath.endsWith(".gz")) await pipeline(createReadStream(record.localPath), createGunzip(), sink);
  else await pipeline(createReadStream(record.localPath), sink);
  if (hash.digest("hex") !== record.sha256 || bytes !== record.bytes) throw new Error(`Artifact ${record.id} failed integrity verification.`);
  return Buffer.concat(chunks);
}

export async function writeArtifactToFile(record: ArtifactRecord, targetPath: string): Promise<void> {
  if (!record.retrievable) throw new Error(`Artifact ${record.id} is marked unavailable.`);
  const dir = dirname(targetPath);
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const temporary = join(dir, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); bytes += chunk.byteLength; callback(null, chunk); } });
  try {
    if (record.localPath.endsWith(".gz")) await pipeline(createReadStream(record.localPath), createGunzip(), verifier, createWriteStream(temporary, { flags: "wx", mode: PRIVATE_FILE_MODE }));
    else await pipeline(createReadStream(record.localPath), verifier, createWriteStream(temporary, { flags: "wx", mode: PRIVATE_FILE_MODE }));
    if (hash.digest("hex") !== record.sha256 || bytes !== record.bytes) throw new Error(`Artifact ${record.id} failed integrity verification.`);
    await fs.rename(temporary, targetPath);
    await fs.chmod(targetPath, PRIVATE_FILE_MODE);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writePrivateFile(targetPath: string, content: Buffer): Promise<void> {
  const dir = dirname(targetPath);
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const temporary = join(dir, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(temporary, PRIVATE_FILE_MODE);
    await fs.rename(temporary, targetPath);
    await fs.chmod(targetPath, PRIVATE_FILE_MODE);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const ALLOWED_OUTPUT_DIRS = [
  tmpdir(),
  join(homedir(), ".cache", "opencode"),
  join(homedir(), ".cache", "pi"),
];

export function resolveSafeOutputPath(targetPath: string): string | undefined {
  const expanded = targetPath.startsWith("~/")
    ? join(homedir(), targetPath.slice(2))
    : targetPath;
  const resolved = resolve(expanded);
  return ALLOWED_OUTPUT_DIRS.some((dir) => {
    const rel = relative(dir, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }) ? resolved : undefined;
}

/** Resolve and create a parent one component at a time without following symlinks outside an allowed root. */
export async function resolveSafeOutputPathReal(targetPath: string): Promise<string | undefined> {
  const lexical = resolveSafeOutputPath(targetPath);
  if (!lexical) return undefined;
  const lexicalParent = dirname(lexical);
  for (const allowed of ALLOWED_OUTPUT_DIRS) {
    const rel = relative(allowed, lexicalParent);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    await fs.mkdir(allowed, { recursive: true, mode: PRIVATE_DIR_MODE });
    const realAllowed = await fs.realpath(allowed);
    let current = realAllowed;
    const components = rel === "" ? [] : rel.split(/[\\/]+/).filter(Boolean);
    for (const component of components) {
      const candidate = join(current, component);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.mkdir(candidate, { mode: PRIVATE_DIR_MODE });
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
      }
      current = await fs.realpath(candidate);
      const realRel = relative(realAllowed, current);
      if (realRel.startsWith("..") || isAbsolute(realRel)) return undefined;
    }
    return join(current, basename(lexical));
  }
  return undefined;
}

async function storeCompressedText(
  root: string,
  sessionId: string,
  text: string,
): Promise<{ sha256: string; bytes: number; localPath: string; reusedExistingPath: boolean }> {
  return storeCompressedParts(root, sessionId, [text]);
}

async function storeCompressedParts(
  root: string,
  sessionId: string,
  parts: readonly string[],
): Promise<{ sha256: string; bytes: number; localPath: string; reusedExistingPath: boolean }> {
  const bytes = parts.reduce((sum, part) => sum + Buffer.byteLength(part, "utf8"), 0);
  return storeCompressedStream(root, sessionId, Readable.from(parts), hashTextParts(parts), bytes);
}

function hashTextParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

async function storeCompressedFile(
  root: string,
  sessionId: string,
  sourcePath: string,
  bytes: number,
): Promise<{ sha256: string; bytes: number; localPath: string; reusedExistingPath: boolean }> {
  const sessionDir = artifactSessionDirectory(sessionId, root);
  await fs.mkdir(sessionDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const temporary = join(sessionDir, `.stream-${process.pid}-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let observedBytes = 0;
  const hasher = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    hash.update(chunk);
    observedBytes += chunk.byteLength;
    callback(null, chunk);
  } });
  try {
    await pipeline(createReadStream(sourcePath), hasher, createGzip({ level: 6 }), createWriteStream(temporary, { flags: "wx", mode: PRIVATE_FILE_MODE }));
    if (observedBytes !== bytes) throw new Error(`Bash full-output file changed while spooling (${observedBytes}/${bytes} bytes).`);
    const sha256 = hash.digest("hex");
    const localPath = join(sessionDir, `${sha256}.gz`);
    try {
      const existing = await hashGunzipFile(localPath);
      if (existing.sha256 === sha256 && existing.bytes === bytes) {
        await fs.rm(temporary, { force: true });
        return { sha256, bytes, localPath, reusedExistingPath: true };
      }
      await fs.rename(localPath, `${localPath}.corrupt-${Date.now()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.chmod(temporary, PRIVATE_FILE_MODE);
    await fs.rename(temporary, localPath);
    await fs.chmod(localPath, PRIVATE_FILE_MODE);
    return { sha256, bytes, localPath, reusedExistingPath: false };
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function storeCompressedStream(
  root: string,
  sessionId: string,
  source: NodeJS.ReadableStream,
  sha256: string,
  bytes: number,
): Promise<{ sha256: string; bytes: number; localPath: string; reusedExistingPath: boolean }> {
  const sessionDir = artifactSessionDirectory(sessionId, root);
  await fs.mkdir(sessionDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const localPath = join(sessionDir, `${sha256}.gz`);
  try {
    const stat = await fs.stat(localPath);
    if (stat.isFile()) {
      const existing = await hashGunzipFile(localPath);
      if (existing.sha256 === sha256 && existing.bytes === bytes) return { sha256, bytes, localPath, reusedExistingPath: true };
      await fs.rename(localPath, `${localPath}.corrupt-${Date.now()}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(sessionDir, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await pipeline(source, createGzip({ level: 6 }), createWriteStream(temporary, { flags: "wx", mode: PRIVATE_FILE_MODE }));
    await fs.chmod(temporary, PRIVATE_FILE_MODE);
    await fs.rename(temporary, localPath);
    await fs.chmod(localPath, PRIVATE_FILE_MODE);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { sha256, bytes, localPath, reusedExistingPath: false };
}

async function hashGunzipFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const sink = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<never, void, unknown> {
    for await (const chunk of source) { hash.update(chunk); bytes += chunk.byteLength; }
  };
  await pipeline(createReadStream(file), createGunzip(), sink);
  return { sha256: hash.digest("hex"), bytes };
}

async function inspectReusableBashOutput(
  candidatePath: string,
): Promise<{ bytes: number; estimatedTokens: number; localPath: string } | undefined> {
  if (!isAbsolute(candidatePath)) return undefined;
  try {
    const stat = await fs.stat(candidatePath);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    return {
      bytes: stat.size,
      estimatedTokens: Math.ceil(stat.size / 4),
      localPath: candidatePath,
    };
  } catch {
    return undefined;
  }
}

async function gunzipFile(file: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<never, void, unknown> {
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
  };
  await pipeline(createReadStream(file), createGunzip(), sink);
  return Buffer.concat(chunks);
}
