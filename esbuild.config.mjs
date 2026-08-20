// esbuild.config.mjs -- bundle the TypeScript bolt server into a single
// dist/main.cjs the RainDB Lightning runtime loads.
//
// THE ARTIFACT CONTRACT: the Lightning runtime loads ONE CommonJS file
// (dist/main.cjs) and calls its exported onHttpRequest. No node_modules, no
// loose files ship -- esbuild inlines every import (the @raindb/bolt-sdk and
// @raindb/agent wrappers) into that one file.
//
// format:cjs + a .cjs extension: the starter package.json is
// `"type":"module"`, so a `.js` file would be loaded as ESM. The runtime does
// `require(entrypoint)` and reads `.onHttpRequest`; naming the bundle `.cjs`
// forces CommonJS so the export resolves. Node builtins are kept external --
// the runtime provides them.

import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  outfile: "dist/main.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["node:*"],
  legalComments: "none",
  logLevel: "info",
});

console.log("bolt server bundled -> dist/main.cjs (goja engine; no ORM -- the substrate is the backend)");
