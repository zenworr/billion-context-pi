import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createGunzip, gzip as gzipCallback } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  defaultCountTokens,
  type ArtifactRecord,
  type CompressionState,
  type CoreMessage,
} from "acp-kernel";

const gzip = promisify(gzipCallback);
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
export const ARTIFACT_MIN_TOKENS = 1000;

export interface SpoolArtifactInput {
  sessionId: string;
  sourceMessageId: string;
  toolCallId?: string;
  toolName?: string;
  text: string;
  bashFullOutputPath?: string;
  createdAt?: number;
}

export interface SpoolArtifactResult {
  state: CompressionState;
  record: ArtifactRecord;
  reusedExistingPath: boolean;
}

export function artifactStoreRoot(): string {
  return join(homedir(), ".pi", "acp-artifacts");
}

export async function spoolArtifact(
  state: CompressionState,
  input: SpoolArtifactInput,
  root = artifactStoreRoot(),
): Promise<SpoolArtifactResult | undefined> {
  const existing = state.artifacts.find((artifact) => (
    input.toolCallId !== undefined
    && artifact.toolCallId === input.toolCallId
    && artifact.toolName === input.toolName
    && artifact.retrievable
  ));
  if (existing) return { state, record: existing, reusedExistingPath: !existing.localPath.endsWith(".gz") };

  const reusable = input.bashFullOutputPath
    ? await inspectReusableBashOutput(input.bashFullOutputPath)
    : undefined;
  const textTokens = defaultCountTokens(input.text);
  const estimatedTokens = reusable?.estimatedTokens ?? textTokens;
  if (estimatedTokens < ARTIFACT_MIN_TOKENS) return undefined;

  // A host Bash path can disappear after reboot or temporary-file cleanup.
  // Use it for sizing only; the private content-addressed copy is authoritative.
  const sourceText = reusable ? await fs.readFile(reusable.localPath, "utf8") : input.text;
  const stored = await storeCompressedText(root, input.sessionId, sourceText);
  const next = structuredClone(state);
  const id = `a${Math.max(1, next.nextArtifactId)}`;
  next.nextArtifactId = Math.max(1, next.nextArtifactId) + 1;
  const record: ArtifactRecord = {
    id,
    sha256: stored.sha256,
    sourceMessageId: input.sourceMessageId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    mime: "text/plain; charset=utf-8",
    bytes: stored.bytes,
    estimatedTokens,
    localPath: stored.localPath,
    createdAt: input.createdAt ?? Date.now(),
    retrievable: true,
  };
  next.artifacts.push(record);
  next.stats.rawTokensExternalized += estimatedTokens;
  return { state: next, record, reusedExistingPath: false };
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

/** Resolve the parent after symlinks are followed, preventing lexical-prefix escapes. */
export async function resolveSafeOutputPathReal(targetPath: string): Promise<string | undefined> {
  const lexical = resolveSafeOutputPath(targetPath);
  if (!lexical) return undefined;
  const parent = dirname(lexical);
  await fs.mkdir(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
  const realParent = await fs.realpath(parent);
  for (const allowed of ALLOWED_OUTPUT_DIRS) {
    await fs.mkdir(allowed, { recursive: true, mode: PRIVATE_DIR_MODE });
    const realAllowed = await fs.realpath(allowed);
    const rel = relative(realAllowed, realParent);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return join(realParent, basename(lexical));
  }
  return undefined;
}

async function storeCompressedText(
  root: string,
  sessionId: string,
  text: string,
): Promise<{ sha256: string; bytes: number; localPath: string }> {
  const content = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const sessionDir = join(root, safeSessionComponent(sessionId));
  const localPath = join(sessionDir, `${sha256}.gz`);
  try {
    const stat = await fs.stat(localPath);
    if (stat.isFile()) {
      const existing = await gunzipFile(localPath);
      const existingHash = createHash("sha256").update(existing).digest("hex");
      if (existingHash === sha256 && existing.byteLength === content.byteLength) return { sha256, bytes: content.byteLength, localPath };
      await fs.rename(localPath, `${localPath}.corrupt-${Date.now()}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const compressed = await gzip(content, { level: 6 });
  await writePrivateFile(localPath, compressed);
  return { sha256, bytes: content.byteLength, localPath };
}

async function inspectReusableBashOutput(
  candidatePath: string,
): Promise<{ sha256: string; bytes: number; estimatedTokens: number; localPath: string } | undefined> {
  if (!isAbsolute(candidatePath)) return undefined;
  try {
    const stat = await fs.stat(candidatePath);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    const sha256 = await hashFile(candidatePath);
    return {
      sha256,
      bytes: stat.size,
      estimatedTokens: Math.ceil(stat.size / 4),
      localPath: candidatePath,
    };
  } catch {
    return undefined;
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function gunzipFile(file: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<never, void, unknown> {
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
  };
  await pipeline(createReadStream(file), createGunzip(), sink);
  return Buffer.concat(chunks);
}

function safeSessionComponent(sessionId: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId !== "." && sessionId !== "..") {
    return sessionId;
  }
  return createHash("sha256").update(sessionId).digest("hex");
}
