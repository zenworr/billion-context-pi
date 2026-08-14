import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState, type CoreMessage } from "acp-kernel";
import {
  artifactSessionDirectory,
  artifactStoreBytes,
  cleanupArtifactStore,
  readArtifact,
  readArtifactSlice,
  reconcileArtifactSources,
  resolveSafeOutputPath,
  resolveSafeOutputPathReal,
  spoolArtifact,
  writePrivateFile,
} from "../src/artifact-store.js";

const largeText = "tool output line\n".repeat(5000);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acp-artifact-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("artifact session identity is collision-resistant", () => {
  assert.notEqual(artifactSessionDirectory("branch/a", "/tmp/root"), artifactSessionDirectory("branch?a", "/tmp/root"));
  assert.equal(artifactSessionDirectory("branch/a", "/tmp/root"), artifactSessionDirectory("branch/a", "/tmp/root"));
});

test("artifact cleanup removes orphaned files but preserves referenced content", async () => {
  await withTempDir(async (dir) => {
    const state = createInitialState("cleanup-session");
    const spooled = await spoolArtifact(state, {
      sessionId: "cleanup-session", sourceMessageId: "m1", toolName: "read", text: largeText,
    }, dir);
    assert.ok(spooled);
    const sessionDir = artifactSessionDirectory("cleanup-session", dir);
    await mkdir(sessionDir, { recursive: true });
    const orphan = join(sessionDir, "orphan.gz");
    await writeFile(orphan, "orphan");
    const result = await cleanupArtifactStore(spooled.state, "cleanup-session", dir);
    assert.equal(result.removed, 1);
    await assert.rejects(stat(orphan));
    assert.equal((await stat(spooled.record.localPath)).isFile(), true);
  });
});

test("artifact quotas fail closed without writing oversized content", async () => {
  await withTempDir(async (dir) => {
    const state = createInitialState("quota-session");
    const oversized = await spoolArtifact(state, {
      sessionId: "quota-session", sourceMessageId: "m1", toolName: "read",
      text: largeText, maxArtifactBytes: 1_000,
    }, dir);
    assert.equal(oversized?.record.status, "unavailable");
    assert.equal(oversized?.record.retrievable, false);
    assert.match(oversized?.record.error ?? "", /per-artifact quota/);
    assert.equal(oversized?.record.localPath, "");

    const sessionLimited = await spoolArtifact({ ...state, artifacts: [{
      id: "a0", status: "ready", sourceMessageId: "m0", mime: "text/plain", sha256: "x",
      bytes: 950, estimatedTokens: 250, localPath: "/private/a0.gz", createdAt: 0, retrievable: true,
    }] }, {
      sessionId: "quota-session", sourceMessageId: "m2", toolName: "read",
      text: largeText, maxArtifactBytes: 1_000_000, maxSessionBytes: 1_000,
    }, dir);
    assert.equal(sessionLimited?.record.status, "unavailable");
    assert.match(sessionLimited?.record.error ?? "", /session artifact quota/);
  });
});

test("artifact spool fails closed at the global quota", async () => {
  await withTempDir(async (dir) => {
    const other = artifactSessionDirectory("other-session", dir);
    const fs = await import("node:fs/promises");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(join(other, "existing.gz"), Buffer.alloc(100));
    const result = await spoolArtifact(createInitialState("session-global"), {
      sessionId: "session-global",
      toolName: "bash",
      toolCallId: "call-global",
      text: largeText,
      maxGlobalBytes: 100,
    }, dir);
    assert.equal(result.record.retrievable, false);
    assert.match(result.record.error ?? "", /global artifact quota/);
  });
});

test("artifact slices are byte-bounded and support offsets", async () => {
  await withTempDir(async (dir) => {
    const result = await spoolArtifact(createInitialState("slice-session"), {
      sessionId: "slice-session", sourceMessageId: "m1", toolName: "read", text: largeText,
    }, dir);
    assert.ok(result);
    const slice = await readArtifactSlice(result.record, 10, 64);
    assert.equal(slice.byteLength, 64);
    assert.deepEqual(slice, Buffer.from(largeText).subarray(10, 74));
  });
});

test("artifact store writes content-addressed gzip files atomically with mode 0600", async () => {
  await withTempDir(async (dir) => {
    const state = createInitialState("session-1");
    const result = await spoolArtifact(state, {
      sessionId: "session-1",
      sourceMessageId: "pending:tc1",
      toolCallId: "tc1",
      toolName: "read",
      text: largeText,
      createdAt: 123,
    }, dir);
    assert.ok(result);
    const digest = createHash("sha256").update(largeText).digest("hex");
    assert.equal(result.record.localPath, join(artifactSessionDirectory("session-1", dir), `${digest}.gz`));
    assert.equal(result.record.sha256, digest);
    assert.equal(result.record.sourceMessageId, "pending:tc1");
    assert.equal(result.record.toolCallId, "tc1");
    assert.equal(result.record.toolName, "read");
    assert.equal(result.record.mime, "text/plain; charset=utf-8");
    assert.equal(result.record.bytes, Buffer.byteLength(largeText));
    assert.equal(result.record.createdAt, 123);
    assert.equal(result.record.retrievable, true);
    if (process.platform !== "win32") assert.equal((await stat(result.record.localPath)).mode & 0o777, 0o600);
    assert.equal((await readArtifact(result.record)).toString("utf8"), largeText);
    assert.equal(result.state.artifacts.length, 1);
    assert.equal(result.state.stats.rawTokensExternalized, result.record.estimatedTokens);
    const names = await import("node:fs/promises").then((fs) => fs.readdir(artifactSessionDirectory("session-1", dir)));
    assert.deepEqual(names, [`${digest}.gz`], "atomic temporary file is not left behind");
  });
});

test("reused provider call ids cannot alias different artifact content", async () => {
  await withTempDir(async (dir) => {
    const first = await spoolArtifact(createInitialState("reuse-session"), {
      sessionId: "reuse-session",
      sourceMessageId: "pending:shared",
      toolCallId: "shared",
      toolName: "read",
      text: largeText,
    }, dir);
    assert.ok(first);
    const secondText = `${largeText}\ndifferent branch output`;
    const second = await spoolArtifact(first.state, {
      sessionId: "reuse-session",
      sourceMessageId: "pending:shared",
      toolCallId: "shared",
      toolName: "read",
      text: secondText,
    }, dir);
    assert.ok(second);
    assert.notEqual(second.record.id, first.record.id);
    assert.notEqual(second.record.sha256, first.record.sha256);
    assert.equal(second.state.artifacts.length, 2);
  });
});

test("global quota counts deduplicated physical content once", async () => {
  await withTempDir(async (dir) => {
    const bytes = Buffer.byteLength(largeText);
    const first = await spoolArtifact(createInitialState("dedupe-session"), {
      sessionId: "dedupe-session", sourceMessageId: "m1", toolCallId: "c1", toolName: "read", text: largeText,
      maxGlobalBytes: bytes + 1,
    }, dir);
    assert.equal(first?.record.status, "ready");
    const second = await spoolArtifact(first!.state, {
      sessionId: "dedupe-session", sourceMessageId: "m2", toolCallId: "c2", toolName: "read", text: largeText,
      maxGlobalBytes: bytes + 1, maxSessionBytes: bytes * 3,
    }, dir);
    assert.equal(second?.record.status, "ready");
    assert.equal(second?.reusedExistingPath, true);
    assert.equal(await artifactStoreBytes(dir), bytes);
  });
});

test("stale quota-lock recovery serializes concurrent contenders", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, ".quota.lock");
    await writeFile(lockPath, `stale-owner:999999999\n0\n`);
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(lockPath, old, old);
    const firstText = `${largeText}first`;
    const secondText = `${largeText}second`;
    const [first, second] = await Promise.all([
      spoolArtifact(createInitialState("lock-a"), { sessionId: "lock-a", sourceMessageId: "m1", toolName: "read", text: firstText }, dir),
      spoolArtifact(createInitialState("lock-b"), { sessionId: "lock-b", sourceMessageId: "m2", toolName: "read", text: secondText }, dir),
    ]);
    assert.equal(first?.record.status, "ready");
    assert.equal(second?.record.status, "ready");
    assert.equal(await artifactStoreBytes(dir), Buffer.byteLength(firstText) + Buffer.byteLength(secondText));
  });
});

test("pending quota reservation is reconciled after an interrupted transaction", async () => {
  await withTempDir(async (dir) => {
    const bytes = Buffer.byteLength(largeText);
    const result = await spoolArtifact(createInitialState("journal-session"), {
      sessionId: "journal-session", sourceMessageId: "m1", toolName: "read", text: largeText,
    }, dir);
    assert.equal(result?.record.status, "ready");
    await writeFile(join(dir, ".quota-index.json"), JSON.stringify({
      version: 1,
      bytes: 0,
      pending: { id: "interrupted", bytes },
    }));
    assert.equal(await artifactStoreBytes(dir), bytes);
    const rebuilt = JSON.parse(await readFile(join(dir, ".quota-index.json"), "utf8")) as { version: number; bytes: number; updatedAt: number; pending?: unknown };
    assert.deepEqual(rebuilt, { version: 1, bytes, updatedAt: rebuilt.updatedAt });
    assert.equal(rebuilt.pending, undefined);
  });
});

test("valid Bash fullOutputPath is copied into the durable private store", async () => {
  await withTempDir(async (dir) => {
    const fullOutputPath = join(dir, "pi-bash-full.log");
    await writeFile(fullOutputPath, largeText, { mode: 0o600 });
    const storeRoot = join(dir, "store");
    const result = await spoolArtifact(createInitialState("session-2"), {
      sessionId: "session-2",
      sourceMessageId: "pending:tc2",
      toolCallId: "tc2",
      toolName: "bash",
      text: "host-visible truncated text",
      bashFullOutputPath: fullOutputPath,
    }, storeRoot);
    assert.ok(result);
    assert.equal(result.reusedExistingPath, false);
    assert.notEqual(result.record.localPath, fullOutputPath);
    assert.match(result.record.localPath ?? "", /\.gz$/);
    assert.equal(result.record.bytes, Buffer.byteLength(largeText));
    assert.equal((await readArtifact(result.record)).toString("utf8"), largeText);
    if (process.platform !== "win32") assert.equal((await stat(result.record.localPath)).mode & 0o777, 0o600);
  });
});

test("artifact source metadata reconciles from pending call id to the exact session message id", async () => {
  await withTempDir(async (dir) => {
    const result = await spoolArtifact(createInitialState("session-3"), {
      sessionId: "session-3",
      sourceMessageId: "pending:tc3",
      toolCallId: "tc3",
      toolName: "grep",
      text: largeText,
    }, dir);
    assert.ok(result);
    const messages: CoreMessage[] = [{
      id: "session-entry-result-3",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "tc3",
      toolName: "grep",
      text: largeText,
    }];
    const reconciled = reconcileArtifactSources(result.state, messages);
    assert.equal(reconciled.artifacts[0]?.sourceMessageId, "session-entry-result-3");
    assert.equal(result.state.artifacts[0]?.sourceMessageId, "pending:tc3", "input state is not mutated");
  });
});

test("artifact integrity verification rejects changed content", async () => {
  await withTempDir(async (dir) => {
    const fullOutputPath = join(dir, "full.log");
    await writeFile(fullOutputPath, largeText);
    const result = await spoolArtifact(createInitialState("session-4"), {
      sessionId: "session-4",
      sourceMessageId: "pending:tc4",
      toolCallId: "tc4",
      toolName: "bash",
      text: largeText,
      bashFullOutputPath: fullOutputPath,
    }, join(dir, "store"));
    assert.ok(result);
    await writeFile(result.record.localPath, "changed");
    await assert.rejects(readArtifact(result.record), /artifact|gzip|integrity/i);
  });
});

test("real output-path validation rejects symlink escapes before creating descendants", async () => {
  const outside = await mkdtemp(join(homedir(), "acp-outside-"));
  const link = join(tmpdir(), `acp-link-${Date.now()}`);
  try {
    await symlink(outside, link);
    assert.equal(await resolveSafeOutputPathReal(join(link, "nested", "result.txt")), undefined);
    await assert.rejects(stat(join(outside, "nested")));
  } finally {
    await rm(link, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("private retrieval output uses mode 0600 and safe path restrictions", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "retrieved.txt");
    await writePrivateFile(target, Buffer.from("exact"));
    assert.equal(await readFile(target, "utf8"), "exact");
    if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);
  });
  assert.equal(resolveSafeOutputPath("/etc/acp-artifact.txt"), undefined);
  assert.equal(resolveSafeOutputPath(join(tmpdir(), "acp-artifact.txt")), join(tmpdir(), "acp-artifact.txt"));
});
