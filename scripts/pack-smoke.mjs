import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
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
  writeFileSync(join(consumer, "consumer.ts"), 'import extension from "billion-context-pi";\nif (typeof extension !== "function") throw new Error("extension export is not a function");\n');
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022", strict: true, skipLibCheck: true, noEmit: true }, include: ["consumer.ts"] }, null, 2));
  run(process.execPath, ["--input-type=module", "-e", 'import extension from "billion-context-pi"; if (typeof extension !== "function") throw new Error("bad extension export"); const api = new Proxy({}, { get: () => () => undefined }); extension(api);'], consumer);
  run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], consumer);
  console.log(`PACK_SMOKE_OK extension=${packedExtension.version} bundled-kernel=ok init=ok types=ok`);
} finally {
  if (process.env.KEEP_PACK_SMOKE !== "1") rmSync(scratch, { recursive: true, force: true });
}
