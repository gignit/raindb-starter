import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// THE DEV MODEL -- the whole point of this template:
//
//  1. You NEVER simulate RainDB locally. Standing up a real tenant is a few
//     raindb-cli commands (see scripts/setup.sh), so there is nothing to
//     mock -- and a mock would only force a refactor when you went live.
//
//  2. `npm run dev` runs the UI locally with hot-module-reload and PROXIES
//     every /api/* request to your LIVE deployed bolt. You always develop
//     against the real backend.
//
//  3. `npm run build` emits ./dist -- the static assets the bolt serves.
//     scripts/deploy.sh ships them.
//
// The proxy target is written to the repo-root .bolt-url by setup.sh after
// the first deploy. Override with BOLT_URL=https://... if needed.

function resolveBoltUrl(): string {
  if (process.env.BOLT_URL) return process.env.BOLT_URL;
  const urlFile = path.resolve(__dirname, "..", ".bolt-url");
  if (fs.existsSync(urlFile)) {
    const u = fs.readFileSync(urlFile, "utf8").trim();
    if (u) return u;
  }
  // No deployment yet: the proxy has nowhere to go. Run scripts/setup.sh.
  return "http://localhost:1";
}

const BOLT_URL = resolveBoltUrl();

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    // Emit every asset as a hashed FILE under dist/assets/ instead of
    // inlining small assets as data: URLs -- the bolt mirrors dist/assets/
    // to S3 as static droplets, so they must be files.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BOLT_URL, changeOrigin: true, secure: true },
    },
  },
});
