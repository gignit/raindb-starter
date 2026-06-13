// server/index.ts -- the bolt entrypoint. Exports onHttpRequest, the single
// handler the RainDB Lightning runtime invokes for every request.
//
// This is the whole backend's front door. There is NO separate API server,
// NO database process, NO ORM, NO migrations. The runtime hands us
// (ctx, req); we dispatch to a handler; handlers read/write RainDB through
// the @raindb/bolt-sdk db.* bindings (capability-gated) and call the model
// through @raindb/agent. The substrate IS the backend.
//
// Dispatch order: streaming (AI) routes first so they take the SSE path,
// then the sync routes, then 404. Static assets (the built client) never
// reach this handler -- config/routes.json serves them directly.

import { setCtx, type BoltContext, type BoltRequest, type BoltResponse } from "@raindb/bolt-sdk";
import { ok, bad } from "./lib/http.js";
import { handleChat } from "./ai/chat.js";
import {
  handleListNotes,
  handleCreateNote,
  handleGetNote,
  handleUpdateNote,
} from "./routes/notes.js";

export async function onHttpRequest(
  ctx: BoltContext,
  req: BoltRequest,
): Promise<BoltResponse> {
  // Wire the ambient ctx so the SDK's db.* / log.* / ids.* wrappers resolve.
  // REQUIRED first line of every handler.
  setCtx(ctx);
  ctx.log.info("starter.request", { method: req.method, path: req.path });

  try {
    const { method, path } = req;

    if (method === "GET" && path === "/api/health") {
      return ok({ status: "ok", service: "raindb-starter", ts: new Date().toISOString() });
    }

    // Streaming AI route (SSE).
    if (method === "POST" && path === "/api/chat") {
      return await handleChat(ctx, req);
    }

    // Sync CRUD routes.
    if (method === "GET" && path === "/api/notes") return await handleListNotes(req);
    if (method === "POST" && path === "/api/notes") return await handleCreateNote(req);
    if (method === "GET" && path.startsWith("/api/notes/")) return await handleGetNote(req);
    if (method === "POST" && path.startsWith("/api/notes/")) return await handleUpdateNote(req);

    return bad("route_not_found: " + path, 404);
  } catch (e) {
    ctx.log.error("starter.request.exception", { err: String(e) });
    return bad(String(e), 500);
  }
}
