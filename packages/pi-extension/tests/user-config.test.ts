import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadUserConfig, applyUserConfig, updateGlobalCompressionConfig, updateProjectCompressionConfig } from "../src/user-config.js";
import type { AdapterConfig } from "../src/config.js";

const CONFIG_DIR_NAME = ".pi";

async function writeConfig(dir: string, data: object): Promise<string> {
  const dirPath = path.join(dir, CONFIG_DIR_NAME);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, "acp.json");
  await fs.writeFile(filePath, JSON.stringify(data), "utf8");
  return filePath;
}

type HomeEnv = { HOME: string | undefined; USERPROFILE: string | undefined };

function snapshotHome(): HomeEnv {
  return { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
}

function setHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

function restoreHome(env: HomeEnv): void {
  process.env.HOME = env.HOME;
  process.env.USERPROFILE = env.USERPROFILE;
}

let savedHome: HomeEnv;
let hookHome: string;

before(async () => {
  savedHome = snapshotHome();
  hookHome = await fs.mkdtemp(path.join(os.tmpdir(), "acp-home-"));
  setHome(hookHome);
});

after(async () => {
  restoreHome(savedHome);
  await fs.rm(hookHome, { recursive: true, force: true });
});

test("loadUserConfig returns empty object when no config files exist", async () => {
  const cwd = path.join(os.tmpdir(), `acp-test-${Date.now()}`);
  await fs.mkdir(cwd, { recursive: true });
  const config = await loadUserConfig(cwd);
  assert.deepEqual(config, {});
  await fs.rm(cwd, { recursive: true, force: true });
});

test("loadUserConfig reads global config from home directory", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    await writeConfig(tmpHome, { debug: true, autoUpdate: false });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, true);
    assert.equal(config.autoUpdate, false);
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig reads project config from cwd", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-project-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, { modelContextLimit: 100_000, delegate: false });
  try {
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.modelContextLimit, 100_000);
    assert.equal(config.delegate, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig project config overrides global config", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-override-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-override-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    await writeConfig(tmpHome, {
      debug: true,
      modelContextLimit: 200_000,
      compress: { model: "openai/luna", tier1Compressor: "configured" },
      clearing: { keepRecentToolUses: 7, excludeTools: ["global_tool"] },
    });
    await writeConfig(tmpCwd, {
      debug: false,
      compress: { nudgeGrowthTokens: 30_000 },
      clearing: { clearAtLeastTokens: 20_000, excludeTools: ["project_tool"] },
    });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, false, "project debug overrides global");
    assert.equal(config.modelContextLimit, 200_000, "global modelContextLimit preserved");
    assert.deepEqual(config.compress, { model: "openai/luna", tier1Compressor: "configured", nudgeGrowthTokens: 30_000 });
    assert.deepEqual(config.clearing, {
      keepRecentToolUses: 7,
      clearAtLeastTokens: 20_000,
      excludeTools: ["global_tool", "project_tool"],
    });
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig and applyUserConfig preserve validated budget and memory settings", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-hybrid-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, {
    budget: { targetActiveTokens: 120_000, outputReserveTokens: 16_384, unsafe: "drop" },
    memory: { mode: "project", projectDirectory: ".pi/memory", automaticPromotion: false, unsafe: true },
  });
  try {
    const loaded = await loadUserConfig(tmpDir);
    const applied = applyUserConfig({}, loaded);
    assert.deepEqual(applied.budget, { targetActiveTokens: 120_000, outputReserveTokens: 16_384 });
    assert.deepEqual(applied.memory, { mode: "project", projectDirectory: ".pi/memory", automaticPromotion: false });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig accepts explicit zero caps and rejects unsafe cross-field order", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-cross-fields-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, {
    toolBashDefaultTimeout: 0,
    toolOutputMaxBytes: 0,
    budget: { targetContextPercent: 0.9, hardContextPercent: 0.8, emergencyContextPercent: 0.95 },
    artifacts: { maxArtifactBytes: 3_000, maxSessionBytes: 2_000, maxGlobalBytes: 4_000 },
    compress: { maxContextLimit: "100.1%", emergencyThresholdPercent: "95%" },
  });
  try {
    const loaded = await loadUserConfig(tmpDir);
    assert.equal(loaded.toolBashDefaultTimeout, 0);
    assert.equal(loaded.toolOutputMaxBytes, 0);
    assert.equal(loaded.budget, undefined);
    assert.equal(loaded.artifacts, undefined);
    assert.deepEqual(loaded.compress, { emergencyThresholdPercent: "95%" });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("applyUserConfig revalidates cross-source thresholds and total reserves", () => {
  const applied = applyUserConfig({
    modelContextLimit: 10_000,
    compress: { maxContextLimit: "90%" },
    budget: { outputReserveTokens: 4_000 },
  }, {
    compress: { emergencyThresholdPercent: "80%" },
    budget: { safetyMarginTokens: 7_000 },
  });
  assert.equal(applied.compress?.maxContextLimit, "90%", "unsafe merged compression relation falls back to adapter values");
  assert.equal(applied.compress?.emergencyThresholdPercent, undefined);
  assert.deepEqual(applied.budget, { outputReserveTokens: 4_000 }, "reserve sum larger than context falls back safely");
});

test("loadUserConfig preserves validated artifact quotas and lifecycle", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-artifacts-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, {
    artifacts: { maxArtifactBytes: 1_000, maxSessionBytes: 2_000, maxGlobalBytes: 3_000, lifecycle: "session", unsafe: true },
  });
  try {
    const loaded = await loadUserConfig(tmpDir);
    const applied = applyUserConfig({}, loaded);
    assert.deepEqual(applied.artifacts, { maxArtifactBytes: 1_000, maxSessionBytes: 2_000, maxGlobalBytes: 3_000, lifecycle: "session" });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig ignores unknown keys", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-unknown-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, { debug: true, unknownKey: "should be ignored", anotherUnknown: 123 });
  try {
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.debug, true);
    assert.equal((config as Record<string, unknown>).unknownKey, undefined, "unknown keys filtered");
    assert.equal((config as Record<string, unknown>).anotherUnknown, undefined, "unknown keys filtered");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig handles bad JSON gracefully", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-badjson-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const cfgDir = path.join(tmpDir, CONFIG_DIR_NAME);
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(path.join(cfgDir, "acp.json"), "{ bad json }", "utf8");
  try {
    const config = await loadUserConfig(tmpDir);
    assert.deepEqual(config, {}, "bad JSON returns empty config");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("applyUserConfig merges user config onto adapter config", () => {
  const adapter: AdapterConfig = {
    modelContextLimit: 200_000,
    delegate: true,
    autoUpdate: true,
    preserveRecentMessages: 5000,
  };
  const user = { debug: true, autoUpdate: false, toolOutputMaxBytes: 50000 };
  const result = applyUserConfig(adapter, user);
  assert.equal(result.debug, true, "user debug applied");
  assert.equal(result.autoUpdate, false, "user autoUpdate overrides adapter");
  assert.equal(result.toolOutputMaxBytes, 50000, "user toolOutputMaxBytes added");
  assert.equal(result.modelContextLimit, 200_000, "adapter modelContextLimit preserved");
  assert.equal(result.delegate, true, "adapter delegate preserved");
});

test("applyUserConfig merges clearing exclusions without dropping adapter policy", () => {
  const result = applyUserConfig(
    { clearing: { keepRecentToolUses: 6, excludeTools: ["adapter_tool"] } },
    { clearing: { clearAtLeastTokens: 25_000, excludeTools: ["user_tool"] } },
  );
  assert.deepEqual(result.clearing, {
    keepRecentToolUses: 6,
    clearAtLeastTokens: 25_000,
    excludeTools: ["adapter_tool", "user_tool"],
  });
});

test("applyUserConfig preserves protected adapter fields", () => {
  const adapter: AdapterConfig = {
    modelContextLimit: 200_000,
    delegate: true,
    preserveRecentMessages: 5000,
    coreOverrides: { someKey: "someValue" },
    protectedTools: ["read", "write"],
  };
  const user = { modelContextLimit: 100_000 };
  const result = applyUserConfig(adapter, user);
  assert.equal(result.modelContextLimit, 100_000, "user modelContextLimit overrides");
  assert.deepEqual(result.coreOverrides, { someKey: "someValue" }, "coreOverrides preserved");
  assert.deepEqual(result.protectedTools, ["read", "write"], "protectedTools preserved");
  assert.equal(result.preserveRecentMessages, 5000, "preserveRecentMessages preserved");
});

test("loadUserConfig rejects malformed nested values before runtime use", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-invalid-config-"));
  await writeConfig(tmpDir, {
    modelContextLimit: "huge",
    compress: { tier1Compressor: "unsafe", thinkingLevel: "infinite", nudgeGrowthTokens: -1, allowCrossProvider: "yes" },
    clearing: { keepRecentToolUses: -4, excludeTools: ["read", 42], reasoning: "erase" },
    optimization: { minimumBlocks: -1, automaticDistillation: "yes" },
    delegate: { enabled: "yes", displayUsage: "combined" },
  });
  const loaded = await loadUserConfig(tmpDir);
  assert.notEqual(typeof loaded.modelContextLimit, "string");
  assert.equal(loaded.compress?.tier1Compressor, undefined);
  assert.equal(loaded.compress?.thinkingLevel, undefined);
  assert.equal(loaded.clearing?.keepRecentToolUses, undefined);
  assert.equal(loaded.optimization?.minimumBlocks, undefined);
  assert.notEqual((loaded.delegate as { enabled?: unknown } | undefined)?.enabled, "yes");
});

test("applyUserConfig with empty user config returns adapter unchanged", () => {
  const adapter: AdapterConfig = {
    modelContextLimit: 200_000,
    delegate: true,
    preserveRecentMessages: 5000,
  };
  const result = applyUserConfig(adapter, {});
  assert.equal(result.modelContextLimit, 200_000);
  assert.equal(result.delegate, true);
  assert.equal(result.preserveRecentMessages, 5000);
});

test("applyUserConfig supports all user config keys", () => {
  const adapter: AdapterConfig = { modelContextLimit: 200_000 };
  const user = {
    debug: true,
    autoUpdate: false,
    modelContextLimit: 50_000,
    delegate: false,
    toolBashDefaultTimeout: 120,
    toolOutputMaxBytes: 100_000,
  };
  const result = applyUserConfig(adapter, user);
  assert.equal(result.debug, true);
  assert.equal(result.autoUpdate, false);
  assert.equal(result.modelContextLimit, 50_000);
  assert.equal(result.delegate, false);
  assert.equal(result.toolBashDefaultTimeout, 120);
  assert.equal(result.toolOutputMaxBytes, 100_000);
});

test("project model updates stay project-local and do not mutate global configuration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-config-scope-"));
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  const globalFile = path.join(home, ".pi", "acp.json");
  await fs.mkdir(path.join(home, ".pi"), { recursive: true });
  await fs.writeFile(globalFile, JSON.stringify({ compress: { model: "global/model" } }), "utf8");
  const before = await fs.readFile(globalFile, "utf8");
  const projectFile = await updateProjectCompressionConfig(project, { model: "project/model" });
  assert.equal(projectFile, path.join(project, ".pi", "acp.json"));
  assert.equal(await fs.readFile(globalFile, "utf8"), before);
  assert.match(await fs.readFile(projectFile, "utf8"), /project\/model/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("updateGlobalCompressionConfig merges compression settings without dropping other keys", async () => {
  await writeConfig(hookHome, {
    debug: true,
    futureKey: { preserved: true },
    compress: { nudgeGrowthTokens: 40_000, tier2Compressor: "main" },
  });
  const file = await updateGlobalCompressionConfig({
    model: "openai/gpt-5.6-luna",
    thinkingLevel: "high",
    tier1Compressor: "configured",
  });
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(persisted.debug, true);
  assert.deepEqual(persisted.futureKey, { preserved: true });
  assert.equal(persisted.compress.nudgeGrowthTokens, 40_000);
  assert.equal(persisted.compress.tier2Compressor, "main");
  assert.equal(persisted.compress.model, "openai/gpt-5.6-luna");
  assert.equal(persisted.compress.thinkingLevel, "high");
  assert.equal(persisted.compress.tier1Compressor, "configured");
});
