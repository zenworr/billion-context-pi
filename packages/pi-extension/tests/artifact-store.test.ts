import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState, type CoreMessage } from "acp-kernel";
import {
  readArtifact,
  reconcileArtifactSources,
  resolveSafeOutputPath,
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
    assert.equal(result.record.localPath, join(dir, "session-1", `${digest}.gz`));
    assert.equal(result.record.sha256, digest);
    assert.equal(result.record.sourceMessageId, "pending:tc1");
    assert.equal(result.record.toolCallId, "tc1");
    assert.equal(result.record.toolName, "read");
    assert.equal(result.record.mime, "text/plain; charset=utf-8");
    assert.equal(result.record.bytes, Buffer.byteLength(largeText));
    assert.equal(result.record.createdAt, 123);
    assert.equal(result.record.retrievable, true);
    assert.equal((await stat(result.record.localPath)).mode & 0o777, 0o600);
    assert.equal((await readArtifact(result.record)).toString("utf8"), largeText);
    assert.equal(result.state.artifacts.length, 1);
    assert.equal(result.state.stats.rawTokensExternalized, result.record.estimatedTokens);
    const names = await import("node:fs/promises").then((fs) => fs.readdir(join(dir, "session-1")));
    assert.deepEqual(names, [`${digest}.gz`], "atomic temporary file is not left behind");
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
    assert.equal((await stat(result.record.localPath)).mode & 0o777, 0o600);
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

test("private retrieval output uses mode 0600 and safe path restrictions", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "retrieved.txt");
    await writePrivateFile(target, Buffer.from("exact"));
    assert.equal(await readFile(target, "utf8"), "exact");
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  });
  assert.equal(resolveSafeOutputPath("/etc/acp-artifact.txt"), undefined);
  assert.equal(resolveSafeOutputPath(join(tmpdir(), "acp-artifact.txt")), join(tmpdir(), "acp-artifact.txt"));
});
