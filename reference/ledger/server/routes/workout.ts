// routes/workout.ts -- the workout tracker: category tree, set logging with
// "last set" prefill, the in-progress session, benchmarks, and the analytical
// charts. This is where both AXES are on screen at once.
//
//   AXIS 1 (instant grabs): the category tree, "last set" prefill, session
//     state -- pointer/index reads, fresh, O(1)/O(pageSize) at any scale.
//   AXIS 2 (analytical SQL): progress charts, PRs, the gym leaderboard -- via
//     lib/analytics.ts. Eventually consistent, so the response carries a
//     freshness flag the client turns into an "updating ~a few min" badge.

import type { BoltRequest, BoltResponse } from "@raindb/bolt-sdk";
import { ok, bad, notFound, readJsonBody } from "../lib/http.js";
import { requireUser, AuthError } from "../lib/auth.js";
import * as w from "../lib/workout.js";
import * as analytics from "../lib/analytics.js";
import * as tags from "../lib/tags.js";
import { recordActivity, touchStreak } from "../lib/stats.js";

function guard(e: unknown): BoltResponse {
  if (e instanceof AuthError) return bad(e.message, e.status);
  return bad(e instanceof Error ? e.message : "error", 500);
}

// ---------------------------------------------------------- categories (tree)

/** Children of a parent category ("root" for top-level) -- AXIS 1 tree grab. */
export async function handleListCategories(req: BoltRequest, parentId: string): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    const categories = await w.listChildCategories(s.userId, parentId || "root");
    return ok({ categories });
  } catch (e) {
    return guard(e);
  }
}

export async function handleCreateCategory(req: BoltRequest): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    const s = await requireUser(req);
    const category = await w.createCategory({
      userId: s.userId,
      parentId: String(b.parentId ?? "root"),
      name: String(b.name ?? "Untitled"),
      categoryPath: b.categoryPath ? String(b.categoryPath) : undefined,
      sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : undefined,
      metricSchema: (b.metricSchema as w.MetricSchema) ?? { fields: [] },
    });
    return ok({ category });
  } catch (e) {
    return guard(e);
  }
}

export async function handleEditCategory(req: BoltRequest, categoryId: string): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    await requireUser(req);
    const next = await w.editCategory(categoryId, {
      name: b.name !== undefined ? String(b.name) : undefined,
      parentId: b.parentId !== undefined ? String(b.parentId) : undefined,
      metricSchema: (b.metricSchema as w.MetricSchema) ?? undefined,
      sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : undefined,
    });
    return next ? ok({ category: next }) : notFound("category not found");
  } catch (e) {
    return guard(e);
  }
}

// ------------------------------------------------------------------ sets

/**
 * AXIS 1 -- "last set" prefill. The client calls this when the user opens an
 * exercise, to pre-fill last time's weight/reps. Instant pointer read; always
 * fresh (read-your-writes) -- exactly why this is an index grab, not SQL.
 */
export async function handleLastSet(req: BoltRequest, categoryId: string): Promise<BoltResponse> {
  try {
    await requireUser(req);
    const lastSet = await w.lastSetInCategory(categoryId);
    return ok({ lastSet });
  } catch (e) {
    return guard(e);
  }
}

/** Log a set. Immutable droplet; bumps the odometer + streak. */
export async function handleLogSet(req: BoltRequest): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    const s = await requireUser(req);
    const category = await w.readCategory(String(b.categoryId ?? ""));
    if (!category) return notFound("category not found");
    const num = (v: unknown): number | null => (v === undefined || v === null || v === "" ? null : Number(v));
    const set = await w.logSet({
      userId: s.userId,
      sessionId: String(b.sessionId ?? ""),
      categoryId: category.categoryId,
      categoryName: category.name,
      categoryPath: category.categoryPath ?? category.name,
      weightKg: num(b.weightKg),
      reps: num(b.reps) as number | null,
      distanceM: num(b.distanceM),
      durationS: num(b.durationS),
      avgHeartRateBpm: num(b.avgHeartRateBpm),
      elevationM: num(b.elevationM),
      rpe: num(b.rpe),
      metrics: (b.metrics as Record<string, unknown>) ?? {},
      isBenchmark: Boolean(b.isBenchmark),
    });
    const volume = (set.weightKg ?? 0) * (set.reps ?? 0);
    await recordActivity("set", volume);
    await touchStreak(s.userId);
    return ok({ set });
  } catch (e) {
    return guard(e);
  }
}

// --------------------------------------------------------- session (token)

export async function handleStartSession(req: BoltRequest): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    const session = await w.startSession(s.userId);
    await recordActivity("workout");
    return ok({ session });
  } catch (e) {
    return guard(e);
  }
}

export async function handleGetSession(req: BoltRequest, sessionId: string): Promise<BoltResponse> {
  try {
    await requireUser(req);
    const session = await w.readSession(sessionId);
    return session ? ok({ session }) : notFound("no session");
  } catch (e) {
    return guard(e);
  }
}

export async function handleUpdateSession(req: BoltRequest, sessionId: string): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    await requireUser(req);
    await w.updateSession(sessionId, {
      status: b.status === "finished" ? "finished" : undefined,
      currentCategoryId: b.currentCategoryId ? String(b.currentCategoryId) : undefined,
      setNumber: typeof b.setNumber === "number" ? b.setNumber : undefined,
    });
    return ok({ ok: true });
  } catch (e) {
    return guard(e);
  }
}

// --------------------------------------------------------- analytics (AXIS 2)

/** A category's progress chart + the freshness state for the "updating" badge. */
export async function handleCategoryChart(req: BoltRequest, categoryId: string): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    const { points, freshness } = await analytics.categoryProgress(s.userId, categoryId);
    return ok({ points, freshness });
  } catch (e) {
    return guard(e);
  }
}

/** Retroactive personal records across the user's whole history (window fn SQL). */
export async function handlePersonalRecords(req: BoltRequest): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    const { records, freshness } = await analytics.personalRecords(s.userId);
    return ok({ records, freshness });
  } catch (e) {
    return guard(e);
  }
}

/** The gym leaderboard -- top members by volume this month (GROUP BY userId). */
export async function handleLeaderboard(req: BoltRequest): Promise<BoltResponse> {
  try {
    await requireUser(req);
    const { rows, freshness } = await analytics.volumeLeaderboard();
    return ok({ leaderboard: rows, freshness });
  } catch (e) {
    return guard(e);
  }
}

/** The user's known workout tags. */
export async function handleWorkoutTags(req: BoltRequest): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    return ok({ tags: await tags.listTags(s.userId, "workout") });
  } catch (e) {
    return guard(e);
  }
}
