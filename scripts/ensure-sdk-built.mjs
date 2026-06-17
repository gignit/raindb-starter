// scripts/ensure-sdk-built.mjs -- postinstall: build the RainDB SDKs if the
// git-installed copies arrived without their compiled dist/.
//
// The three SDKs are installed from GitHub (see package.json). Git installs
// ship the repo as-is; the SDKs gitignore their dist/, so a fresh install has
// TypeScript sources but no compiled output. This script detects that and
// builds each so imports resolve:
//   - @raindb/agent, @raindb/bolt-sdk -> plain `tsc -p` (agent first, bolt-sdk
//     peer-depends on it)
//   - @raindb/prisma-adapter -> `tsup` (its build tool; provided as a starter
//     devDependency so it's available for the git-installed copy)
//
// When the SDKs gain a `prepare` script or land on npm, this becomes a no-op
// (dist exists, nothing runs) and can be deleted.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = (name) => path.join(root, "node_modules", ".bin", name);

// 1. tsc-built SDKs.
const tscPackages = ["@raindb/agent", "@raindb/bolt-sdk"];
for (const pkg of tscPackages) {
  const dir = path.join(root, "node_modules", pkg);
  if (!existsSync(dir)) {
    console.warn(`[ensure-sdk-built] ${pkg} not installed; skipping`);
    continue;
  }
  if (existsSync(path.join(dir, "dist", "index.js"))) continue; // already built
  console.log(`[ensure-sdk-built] building ${pkg} (git install ships no dist/)...`);
  execSync(`"${bin("tsc")}" -p "${dir}"`, { stdio: "inherit" });
}

// 2. @raindb/prisma-adapter -- normally built by its own `prepare` script on
// install. If that did not run (older copy, or dist missing), build it with
// the starter's tsup as a fallback. tsup needs the adapter's config + src,
// which the git install includes.
const prismaDir = path.join(root, "node_modules", "@raindb/prisma-adapter");
if (existsSync(prismaDir) && !existsSync(path.join(prismaDir, "dist", "index.js"))) {
  if (existsSync(bin("tsup")) && existsSync(path.join(prismaDir, "src", "index.ts"))) {
    console.log("[ensure-sdk-built] building @raindb/prisma-adapter with tsup (fallback)...");
    execSync(`"${bin("tsup")}"`, { cwd: prismaDir, stdio: "inherit" });
  } else {
    console.warn(
      "[ensure-sdk-built] @raindb/prisma-adapter has no dist/ and cannot be built here. " +
        "Ensure the adapter's `prepare` script ran on install (it builds dist via tsup).",
    );
  }
}
