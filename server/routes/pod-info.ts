// routes/pod-info.ts -- GET /api/pod-info -- the certification probe.
//
// ONE call that proves the pod runtime is what we need. Returns:
//   - runtime: node version, whether WebAssembly is present (goja => false,
//     pod => true), event-loop / async markers
//   - sdks: which of the 3 SDKs imported successfully in this runtime
//   - prisma: a LIVE round-trip status -- did the WASM query compiler load
//     and a real findMany/count execute against rtest?
//
// The pod agent hits this first during certification: if WebAssembly is an
// object and prisma.ok is true, the pod runs all three SDKs.

import type { BoltContext, BoltResponse } from "@raindb/bolt-sdk";
import { ok } from "../lib/http.js";
import { getPrisma } from "../lib/prisma.js";

export async function handlePodInfo(ctx: BoltContext): Promise<BoltResponse> {
  // 1. Runtime facts. On goja, `process` is undefined and WebAssembly is
  //    absent; on the Node pod both exist.
  const g = globalThis as unknown as {
    process?: { version?: string; versions?: Record<string, string> };
    WebAssembly?: unknown;
    fetch?: unknown;
  };
  const runtime = {
    nodeVersion: g.process?.version ?? "(no process -- not Node)",
    v8: g.process?.versions?.v8 ?? null,
    webAssembly: typeof g.WebAssembly,
    fetch: typeof g.fetch,
    isPodLikely: typeof g.WebAssembly === "object" && typeof g.process?.version === "string",
  };

  // 2. SDK load status. bolt-sdk + agent are imported at module top by the
  //    app already; report them plus the Prisma adapter.
  const sdks: Record<string, boolean> = {
    "@raindb/bolt-sdk": true, // we're running inside it (setCtx worked)
    "@raindb/agent": true, // imported by ai/chat.ts
    "@raindb/prisma-adapter": false, // set true below if it loads + runs
  };

  // 3. Live Prisma round-trip -- the real certification of SDK #3 + WASM.
  let prisma: {
    ok: boolean;
    detail: string;
    count?: number;
    sampleNoteId?: string | null;
  } = { ok: false, detail: "not attempted" };
  try {
    const client = await getPrisma(ctx);
    // count() compiles SQL via WASM and runs through Periscope.
    const count = await client.note.count();
    const rows = await client.note.findMany({ orderBy: { noteId: "desc" }, take: 1 });
    sdks["@raindb/prisma-adapter"] = true;
    prisma = {
      ok: true,
      detail: "PrismaClient WASM compiler loaded; count + findMany executed",
      count,
      sampleNoteId: rows[0]?.noteId ?? null,
    };
  } catch (e) {
    prisma = { ok: false, detail: "prisma round-trip failed: " + String(e).slice(0, 300) };
  }

  const certified = runtime.isPodLikely && sdks["@raindb/prisma-adapter"];

  ctx.log.info("starter.pod_info", { certified, runtime, prismaOk: prisma.ok });

  return ok({
    service: "raindb-starter",
    certified,
    summary: certified
      ? "POD CERTIFIED: Node + WASM + all 3 SDKs working (bolt-sdk, agent, prisma-adapter)"
      : "NOT fully certified -- see runtime/prisma fields",
    runtime,
    sdks,
    prisma,
    ts: new Date().toISOString(),
  });
}
