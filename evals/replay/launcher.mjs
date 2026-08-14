import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./runner.ts", import.meta.url));
const result = spawnSync(process.execPath, [
  "--permission",
  "--allow-worker",
  "--allow-child-process",
  "--allow-fs-read=.",
  `--allow-fs-read=${tmpdir()}`,
  `--allow-fs-write=${tmpdir()}`,
  "--import",
  "tsx",
  runner,
  ...process.argv.slice(2),
], { stdio: "inherit", shell: false });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
