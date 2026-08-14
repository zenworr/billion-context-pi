import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "hybrid-acp-pack-"));
const packs = join(scratch, "packs");
const consumer = join(scratch, "consumer");
mkdirSync(packs);
mkdirSync(consumer);

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function pack(workspace) {
  const result = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packs, "-w", workspace]));
  const filename = result[0]?.filename;
  if (!filename) throw new Error(`npm pack did not return a filename for ${workspace}`);
  return join(packs, filename);
}

try {
  run("npm", ["run", "build"]);
  const extensionTarball = pack("billion-context-pi");
  const entries = run("tar", ["-tf", extensionTarball]).split("\n").filter(Boolean);
  const forbidden = entries.filter((entry) => /(?:^|\/)(?:src|tests?|\.env)(?:\/|$)|\.acp\.json$|session.*\.jsonl$/i.test(entry));
  if (forbidden.length > 0) throw new Error(`packed extension contains forbidden source/state files: ${forbidden.join(", ")}`);
  const packedExtension = JSON.parse(run("tar", ["-xOf", extensionTarball, "package/package.json"]));
  if (packedExtension.dependencies?.["acp-kernel"] !== undefined) {
    throw new Error("packed extension must bundle acp-kernel rather than depend on the unavailable registry package");
  }
  const declarations = run("tar", ["-xOf", extensionTarball, "package/dist/index.d.ts"]);
  if (declarations.includes('from "acp-kernel"') || declarations.includes("from 'acp-kernel'")) {
    throw new Error("packed declarations still import acp-kernel");
  }
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "hybrid-acp-pack-consumer", private: true, type: "module" }, null, 2));
  run("npm", ["install", "--ignore-scripts", extensionTarball, "typescript@5.9.3", "@earendil-works/pi-coding-agent@^0.84.1", "typebox"], consumer);
  writeFileSync(join(consumer, "consumer.ts"), 'import extension, { createAcpExtension, shouldCancelHostCompaction, remainingToolBudgetText } from "billion-context-pi";\nconst factory: typeof createAcpExtension = createAcpExtension;\nif (typeof extension !== "function" || typeof factory !== "function") throw new Error("extension exports are invalid");\nconst safe: boolean = shouldCancelHostCompaction({ reason: "threshold", changed: true, projectedTokens: 1, hostTokensBefore: 2, safeThreshold: 3 });\nconst label: string = remainingToolBudgetText(1, 2);\nvoid safe; void label;\n');
  // Isolate this package's public declarations from unrelated broken optional
  // declarations in Pi's transitive provider SDKs while keeping skipLibCheck off.
  writeFileSync(join(consumer, "pi-stub.d.ts"), 'declare module "@earendil-works/pi-coding-agent" { export type ExtensionFactory = (pi: unknown) => void; }\n');
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022", strict: true, skipLibCheck: false, noEmit: true, baseUrl: ".", paths: { "@earendil-works/pi-coding-agent": ["./pi-stub.d.ts"] } }, include: ["consumer.ts", "pi-stub.d.ts"] }, null, 2));
  run(process.execPath, ["--input-type=module", "-e", 'import extension from "billion-context-pi"; if (typeof extension !== "function") throw new Error("bad extension export"); const api = new Proxy({}, { get: () => () => undefined }); extension(api);'], consumer);
  run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], consumer);
  console.log(`PACK_SMOKE_OK extension=${packedExtension.version} bundled-kernel=ok init=ok types=ok`);
} finally {
  if (process.env.KEEP_PACK_SMOKE !== "1") rmSync(scratch, { recursive: true, force: true });
}
