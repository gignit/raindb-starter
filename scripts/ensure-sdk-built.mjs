// scripts/ensure-sdk-built.mjs -- postinstall: build the RainDB SDKs if the
// git-installed copies arrived without their compiled dist/.
//
// @raindb/bolt-sdk and @raindb/agent are installed from GitHub (see
// package.json). Git installs ship the repo as-is; the SDKs gitignore their
// dist/ and (today) declare no `prepare` script, so a fresh install has
// TypeScript sources but no compiled output. This script detects that and
// runs `tsc` inside each package so imports resolve.
//
// When the SDKs gain a `prepare` script or land on npm, this becomes a no-op
// (dist exists, nothing runs) and can be deleted.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packages = ["@raindb/agent", "@raindb/bolt-sdk"]; // agent first: bolt-sdk peer-depends on it

for (const pkg of packages) {
  const dir = path.join(root, "node_modules", pkg);
  if (!existsSync(dir)) {
    console.warn(`[ensure-sdk-built] ${pkg} not installed; skipping`);
    continue;
  }
  if (existsSync(path.join(dir, "dist", "index.js"))) {
    continue; // already built (npm tarball or prior run)
  }
  console.log(`[ensure-sdk-built] building ${pkg} (git install ships no dist/)...`);
  // Use the starter's own typescript; the SDK's devDependencies are not
  // installed for git deps.
  const tsc = path.join(root, "node_modules", ".bin", "tsc");
  execSync(`"${tsc}" -p "${dir}"`, { stdio: "inherit" });
}
