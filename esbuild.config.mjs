// esbuild.config.mjs -- bundle the TypeScript bolt server into a single
// dist/main.js the RainDB Lightning runtime loads.
//
// THE ARTIFACT CONTRACT: the Lightning runtime file-drops ONE CommonJS file
// (dist/main.js) and calls its exported onHttpRequest. No node_modules, no
// loose .wasm files ship. esbuild inlines every import -- including Prisma's
// generated client AND its base64-embedded WASM query compiler -- into that
// one file.
//
// WHY platform:node (not neutral): the Prisma 7 generated client does
// require('path') and uses bigint literals. platform:neutral can't resolve
// node builtins (errors on "path"); platform:node handles them, and the pod
// runtime (full Node 20) provides them. target:node20 matches the pod and
// avoids the es2017 bigint warning. The node builtins are kept external
// (--packages? no -- explicit node:* external) so the bundle references the
// runtime's modules rather than trying to polyfill them.
//
// This single bundle runs on BOTH engines: the pod (Node 20, where the
// Prisma WASM actually executes) and goja (where the notes+chat paths run;
// Prisma is only invoked on the /api/prisma/* + /api/pod-info routes, which
// the pod serves). One artifact, two engines.

import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  // .cjs extension: the starter package.json is `"type":"module"`, so a `.js`
  // file would be loaded as ESM. The pod supervisor does `require(entrypoint)`
  // and reads `.onHttpRequest`; naming the bundle `.cjs` forces Node to treat
  // it as CommonJS so the export resolves. (goja loads the same file as CJS.)
  outfile: "dist/main.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  // Keep Node builtins external -- the runtime provides them. Prisma's
  // client imports node:path/node:fs/etc; referencing them (vs bundling) is
  // correct on a real Node pod.
  external: ["node:*"],
  legalComments: "none",
  logLevel: "info",
});

console.log("bolt server bundled -> dist/main.cjs (platform=node, Prisma WASM inlined)");
