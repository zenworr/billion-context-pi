#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const workerArg = process.argv.find((arg) => arg.startsWith("--worker="));
if (workerArg) {
  const count = Number(workerArg.slice("--worker=".length));
  const { assignRefs, emptyRefMap, rawForRef } = await import("../packages/kernel/dist/index.js");
  const started = performance.now();
  const messages = Array.from({ length: count }, (_, index) => ({
    id: `history-${index + 1}`,
    role: index % 3 === 0 ? "user" : "assistant",
    contentType: "text",
    text: `synthetic history message ${index + 1}`,
  }));
  const allocated = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 1 });
  let lookupChecksum = 0;
  const lookupStarted = performance.now();
  for (let index = 1; index <= count; index += Math.max(1, Math.floor(count / 10_000))) {
    if (rawForRef(allocated.map, `m${String(index).padStart(5, "0")}`)) lookupChecksum++;
  }
  const memory = process.memoryUsage();
  process.stdout.write(JSON.stringify({
    messages: count,
    assigned: allocated.newlyAssigned,
    nextIndex: allocated.nextIndex,
    buildMs: Math.round((lookupStarted - started) * 100) / 100,
    lookupMs: Math.round((performance.now() - lookupStarted) * 100) / 100,
    lookupChecksum,
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
  }));
  process.exit(0);
}

const sizesArg = process.argv.find((arg) => arg.startsWith("--sizes="));
const sizes = (sizesArg?.slice("--sizes=".length) ?? "10000,100000,1000000").split(",").map(Number);
const results = [];
for (const size of sizes) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Invalid history size: ${size}`);
  const run = spawnSync(process.execPath, [new URL(import.meta.url).pathname, `--worker=${size}`], {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`History benchmark ${size} failed: ${run.stderr || run.stdout}`);
  results.push(JSON.parse(run.stdout));
}
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  scenarios: results,
};
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
if (outputArg) {
  const output = resolve(outputArg.slice("--output=".length));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
