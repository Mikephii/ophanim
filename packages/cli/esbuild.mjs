import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

// No server config is baked in: the CLI finds its (self-hosted) server at runtime, see src/server.ts.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  external: ["better-sqlite3"], // native module -- must stay external
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  // ESM dependencies (e.g. `open`) read import.meta.url, which esbuild empties in CJS output.
  banner: { js: '#!/usr/bin/env node\nconst __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
  define: {
    "process.env.OPHAN_CLI_VERSION": JSON.stringify(version),
    "import.meta.url": "__importMetaUrl",
  },
});
