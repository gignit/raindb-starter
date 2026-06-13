// esbuild.config.mjs -- bundle the TypeScript bolt server into a single
// dist/main.js the RainDB Lightning runtime (goja) loads.
//
// Why a bundle: the bolt runs inside goja, a Go-embedded JS VM. It has no
// node_modules resolution and no ESM loader -- it loads ONE CommonJS file
// and calls the exported handler (onHttpRequest). esbuild inlines every
// import (@raindb/bolt-sdk, @raindb/agent, your code) into that one file.
// The SDK's db.* / runAgent / etc. resolve at runtime to the native
// bindings the host injects -- esbuild just bundles the typed wrappers.

import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  outfile: "dist/main.js",
  platform: "neutral",
  format: "cjs",
  target: "es2020",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  legalComments: "none",
  logLevel: "info",
});

console.log("bolt server bundled -> dist/main.js");
