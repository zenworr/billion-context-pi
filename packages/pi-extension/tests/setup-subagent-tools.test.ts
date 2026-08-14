import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSubagentAcpTools } from "../src/setup-subagent-tools.js";

const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status", "acp_artifact"];

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "acp-setup-"));
}

function writeSettings(dir: string, obj: unknown): string {
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function allAgentsHaveAcp(path: string): boolean {
  const s = readSettings(path);
  const o = (s.subagents as Record<string, unknown> | undefined)?.agentOverrides as Record<string, { tools?: string[] }> | undefined;
  if (!o) return false;
  const names = ["advisor", "context-builder", "delegate", "oracle", "planner", "researcher", "reviewer", "scout", "worker"];
  return names.every((n) => Array.isArray(o[n]?.tools) && ACP_TOOLS.every((t) => o[n]!.tools!.includes(t)));
}

test("creates overrides for all builtin agents when settings has no subagents", async () => {
  const dir = tmpDir();
  const path = writeSettings(dir, { theme: "dark", defaultModel: "gpt-4" });
  const result = await ensureSubagentAcpTools(path);
  assert.equal(result.action, "updated");
  assert.ok(allAgentsHaveAcp(path), "all agents should have ACP tools");
  const s = readSettings(path);
  assert.equal(s.theme, "dark", "preserves existing fields");
  assert.equal(s.defaultModel, "gpt-4", "preserves existing fields");
  rmSync(dir, { recursive: true, force: true });
});

test("is idempotent — second run skips and does not rewrite file", async () => {
  const dir = tmpDir();
  const path = writeSettings(dir, { theme: "dark" });
  const first = await ensureSubagentAcpTools(path);
  assert.equal(first.action, "updated");
  const firstMtime = statSync(path).mtimeMs;
  const second = await ensureSubagentAcpTools(path);
  assert.equal(second.action, "skipped");
  assert.match(second.reason!, /already have ACP tools/);
  assert.equal(statSync(path).mtimeMs, firstMtime, "file not rewritten on skip");
  rmSync(dir, { recursive: true, force: true });
});

test("preserves user-customized override tools and appends ACP", async () => {
  const dir = tmpDir();
  const path = writeSettings(dir, {
    subagents: {
      agentOverrides: {
        delegate: { tools: ["read", "bash", "myCustomTool"] },
      },
    },
  });
  const result = await ensureSubagentAcpTools(path);
  assert.equal(result.action, "updated");
  const s = readSettings(path);
  const tools = (s.subagents as Record<string, unknown>).agentOverrides.delegate.tools as string[];
  assert.ok(tools.includes("myCustomTool"), "preserves user custom tool");
  assert.ok(ACP_TOOLS.every((t) => tools.includes(t)), "has ACP tools");
  assert.ok(tools.includes("read") && tools.includes("bash"), "preserves original tools");
  rmSync(dir, { recursive: true, force: true });
});

test("does not duplicate ACP tools when already partially present", async () => {
  const dir = tmpDir();
  const path = writeSettings(dir, {
    subagents: {
      agentOverrides: {
        delegate: { tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor", ...ACP_TOOLS] },
      },
    },
  });
  const result = await ensureSubagentAcpTools(path);
  assert.equal(result.action, "updated");
  const s = readSettings(path);
  const delegateTools = (s.subagents as Record<string, unknown>).agentOverrides.delegate.tools as string[];
  assert.equal(delegateTools.length, 8 + ACP_TOOLS.length, "delegate unchanged (no duplicate added)");
  rmSync(dir, { recursive: true, force: true });
});

test("preserves other override fields (model, thinking)", async () => {
  const dir = tmpDir();
  const path = writeSettings(dir, {
    subagents: {
      agentOverrides: {
        delegate: { model: "custom-model", thinking: "high", tools: ["read", "bash"] },
      },
    },
  });
  const result = await ensureSubagentAcpTools(path);
  assert.equal(result.action, "updated");
  const s = readSettings(path);
  const delegate = (s.subagents as Record<string, unknown>).agentOverrides.delegate as Record<string, unknown>;
  assert.equal(delegate.model, "custom-model", "preserves model override");
  assert.equal(delegate.thinking, "high", "preserves thinking override");
  rmSync(dir, { recursive: true, force: true });
});

test("returns failed on invalid JSON without modifying file", async () => {
  const dir = tmpDir();
  const path = join(dir, "settings.json");
  writeFileSync(path, "{ not valid json");
  const before = statSync(path).mtimeMs;
  const result = await ensureSubagentAcpTools(path);
  assert.equal(result.action, "failed");
  assert.match(result.reason!, /not valid JSON/);
  assert.equal(statSync(path).mtimeMs, before, "file untouched on parse failure");
  rmSync(dir, { recursive: true, force: true });
});

test("returns skipped when settings.json does not exist", async () => {
  const dir = tmpDir();
  const path = join(dir, "settings.json");
  const result = await ensureSubagentAcpTools(path);
  assert.equal(result.action, "skipped");
  assert.match(result.reason!, /not found/);
  rmSync(dir, { recursive: true, force: true });
});

test("creates backup on first write, not on subsequent skips", async () => {
  const dir = tmpDir();
  const original = { theme: "light", customField: 42 };
  const path = writeSettings(dir, original);
  const backupPath = `${path}.acp-bak`;

  const first = await ensureSubagentAcpTools(path);
  assert.equal(first.action, "updated");

  const backupContent = readSettings(backupPath);
  assert.deepEqual(backupContent, original, "backup contains pre-edit content");

  const backupMtime = statSync(backupPath).mtimeMs;
  const second = await ensureSubagentAcpTools(path);
  assert.equal(second.action, "skipped");
  assert.equal(statSync(backupPath).mtimeMs, backupMtime, "backup not rewritten");
  rmSync(dir, { recursive: true, force: true });
});
