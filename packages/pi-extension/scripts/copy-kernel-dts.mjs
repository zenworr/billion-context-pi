import { copyFile, mkdir } from "node:fs/promises";

// rollup-plugin-dts follows acp-kernel's relative declaration exports but does
// not inline these standalone files. Ship them beside index.d.ts; the runtime
// kernel remains fully bundled in index.js.
await mkdir(new URL("../dist/filter/", import.meta.url), { recursive: true });
await Promise.all([
  copyFile(new URL("../../kernel/dist/types.d.ts", import.meta.url), new URL("../dist/types.d.ts", import.meta.url)),
  copyFile(new URL("../../kernel/dist/prompts.d.ts", import.meta.url), new URL("../dist/prompts.d.ts", import.meta.url)),
  copyFile(new URL("../../kernel/dist/filter/types.d.ts", import.meta.url), new URL("../dist/filter/types.d.ts", import.meta.url)),
]);
