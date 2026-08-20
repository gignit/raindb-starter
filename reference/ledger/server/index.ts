// server/index.ts -- the Fit bolt entrypoint. onHttpRequest is the single
// handler the RainDB Lightning runtime invokes for every request. There is NO
// separate API server, NO database process, NO ORM, NO migrations: the runtime
// hands us (ctx, req), we dispatch to a handler, and handlers read/write RainDB
// through @raindb/bolt-sdk (capability-gated) and call the model through
// @raindb/agent. The substrate IS the backend.
//
// Dispatch order: the streaming AI route first (it takes the SSE path), then the
// sync routes, then 404. Static assets (the built client) never reach here --
// config/routes.json serves them directly.

import { setCtx, type BoltContext, type BoltRequest, type BoltResponse } from "@raindb/bolt-sdk";
import { bad, notFound } from "./lib/http.js";
import { handleRegister, handleLogin, handleLogout, handleMe } from "./routes/auth.js";
import {
  handleListEntries, handleGetEntry, handleCreateEntry, handleEditEntry,
  handleEntryHistory, handleRestoreEntry, handleAutosaveDraft, handleGetDraft,
  handleDiscardDraft, handleListTags,
} from "./routes/journal.js";
import {
  handleListCategories, handleCreateCategory, handleEditCategory, handleLastSet,
  handleLogSet, handleStartSession, handleGetSession, handleUpdateSession,
  handleCategoryChart, handlePersonalRecords, handleLeaderboard, handleWorkoutTags,
} from "./routes/workout.js";
import { handleOdometer, handleStreak } from "./routes/stats.js";
import { handleChat } from "./ai/chat.js";

// A tiny matcher: segments after /api. Returns the captured param or null.
function seg(path: string, i: number): string | null {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  return parts[i] ?? null;
}

export async function onHttpRequest(ctx: BoltContext, req: BoltRequest): Promise<BoltResponse> {
  // REQUIRED first line: wire the ambient ctx so db.*/log.*/ids.* resolve.
  setCtx(ctx);
  const { method, path } = req;
  ctx.log.info("fit.request", { method, path });

  try {
    // ---- health (deployment healthcheck) ----
    if (path === "/api/health" && method === "GET") {
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "ok", app: "fit" }) };
    }

    // ---- streaming AI (SSE) first ----
    if (path === "/api/ai/chat" && method === "POST") return await handleChat(ctx, req);

    // ---- auth ----
    if (path === "/api/auth/register" && method === "POST") return await handleRegister(req);
    if (path === "/api/auth/login" && method === "POST") return await handleLogin(req);
    if (path === "/api/auth/logout" && method === "POST") return await handleLogout(req);
    if (path === "/api/auth/me" && method === "GET") return await handleMe(req);

    // ---- journal ----
    if (path === "/api/journal/entries" && method === "GET") return await handleListEntries(req);
    if (path === "/api/journal/entries" && method === "POST") return await handleCreateEntry(req);
    if (path === "/api/journal/tags" && method === "GET") return await handleListTags(req);
    if (path === "/api/journal/drafts" && method === "POST") return await handleAutosaveDraft(req);
    if (path.startsWith("/api/journal/drafts/")) {
      const draftId = seg(path, 3) ?? "";
      if (method === "GET") return await handleGetDraft(req, draftId);
      if (method === "DELETE") return await handleDiscardDraft(req, draftId);
    }
    if (path.startsWith("/api/journal/entries/")) {
      const entryId = seg(path, 3) ?? "";
      const sub = seg(path, 4);
      if (!sub) {
        if (method === "GET") return await handleGetEntry(req, entryId);
        if (method === "PUT" || method === "PATCH") return await handleEditEntry(req, entryId);
      }
      if (sub === "history" && method === "GET") return await handleEntryHistory(req, entryId);
      if (sub === "restore" && method === "POST") return await handleRestoreEntry(req, entryId);
    }

    // ---- workout ----
    if (path === "/api/workout/categories" && method === "POST") return await handleCreateCategory(req);
    if (path.startsWith("/api/workout/categories/")) {
      const categoryId = seg(path, 3) ?? "";
      const sub = seg(path, 4);
      if (sub === "children" && method === "GET") return await handleListCategories(req, categoryId);
      if (sub === "last-set" && method === "GET") return await handleLastSet(req, categoryId);
      if (sub === "chart" && method === "GET") return await handleCategoryChart(req, categoryId);
      if (!sub && (method === "PUT" || method === "PATCH")) return await handleEditCategory(req, categoryId);
    }
    if (path === "/api/workout/sets" && method === "POST") return await handleLogSet(req);
    if (path === "/api/workout/sessions" && method === "POST") return await handleStartSession(req);
    if (path.startsWith("/api/workout/sessions/")) {
      const sessionId = seg(path, 3) ?? "";
      if (method === "GET") return await handleGetSession(req, sessionId);
      if (method === "PUT" || method === "PATCH") return await handleUpdateSession(req, sessionId);
    }
    if (path === "/api/workout/records" && method === "GET") return await handlePersonalRecords(req);
    if (path === "/api/workout/leaderboard" && method === "GET") return await handleLeaderboard(req);
    if (path === "/api/workout/tags" && method === "GET") return await handleWorkoutTags(req);

    // ---- stats ----
    if (path === "/api/stats/odometer" && method === "GET") return await handleOdometer(req);
    if (path === "/api/stats/streak" && method === "GET") return await handleStreak(req);

    return notFound(`no route for ${method} ${path}`);
  } catch (e) {
    ctx.log.error("fit.error", { path, err: e instanceof Error ? e.message : String(e) });
    return bad(e instanceof Error ? e.message : "internal error", 500);
  }
}
