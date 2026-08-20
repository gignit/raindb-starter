// lib/workout.ts -- workout data IO: the category tree, logged sets, and the
// in-progress session. This is where FitLedger shows the TWO AXES of RainDB.
//
//   AXIS 1 -- the O(1) GRAB (interactive, infinite scale, NO analytics engine):
//     * "last set" prefill    -> db.readLatest(by-category)  (one pointer read)
//     * a category's children -> db.listKeys(by-parent)      (O(pageSize) walk)
//     * newest sets feed      -> db.listSince(by-update)     (descIndex chain)
//   These are direct grabs by id. They cost the same at 10 sets or 10 million.
//
//   AXIS 2 -- ANALYTICAL SQL (charts, PRs, trends) lives in lib/analytics.ts.
//   It queries the SAME set droplets via Periscope -- eventually consistent, so
//   it's for history/aggregation, never the read-your-writes prefill above.
//
// A logged set is an immutable droplet (durable, auditable, chartable). The
// in-progress session is a TOKEN (hot, mutable, resumable -- deleted when the
// workout ends). Durable fact = droplet; ephemeral state = token.

import { db, ids } from "@raindb/bolt-sdk";
import { payload } from "./http.js";

const CATEGORIES = "ref-workout-categories";
const SETS = "ref-workout-sets";
const SESSION = "ref-workout-session";

// A category's metric schema is config-as-data: it declares which typed fields a
// set in this category records (e.g. weightKg+reps for lifts, distanceM+durationS
// for a run). The client renders inputs from it; the set stores those typed cols.
export interface MetricField {
  key: string; // must match a ref-workout-sets typed column (weightKg, reps, ...)
  label: string;
  kind: "weight" | "reps" | "distance" | "duration" | "heartRate" | "elevation" | "rpe" | "number";
  unit?: string;
}
export interface MetricSchema {
  fields: MetricField[];
  chartHint?: string;
  benchmarkable?: boolean;
}
export interface Category {
  categoryId: string;
  userId: string;
  parentId: string; // "root" for a top-level category
  name: string;
  categoryPath?: string;
  sortOrder?: number;
  metricSchema: MetricSchema;
}

export interface WorkoutSet {
  setId: string;
  userId: string;
  sessionId: string;
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  weightKg?: number | null;
  reps?: number | null;
  distanceM?: number | null;
  durationS?: number | null;
  avgHeartRateBpm?: number | null;
  elevationM?: number | null;
  rpe?: number | null;
  metrics?: Record<string, unknown>; // free-form extras (still SQL-reachable via JSON)
  isBenchmark: boolean;
  recordedAt: string;
}

// ----------------------------------------------------------- categories (tree)

/** Create a category under a parent ("root" for a top-level node). */
export async function createCategory(input: {
  userId: string;
  parentId: string;
  name: string;
  categoryPath?: string;
  sortOrder?: number;
  metricSchema: MetricSchema;
}): Promise<Category> {
  const category: Category = {
    categoryId: ids.uuidv7(),
    userId: input.userId,
    parentId: input.parentId || "root",
    name: input.name,
    categoryPath: input.categoryPath,
    sortOrder: input.sortOrder ?? 0,
    metricSchema: input.metricSchema,
  };
  await db.writeDroplet({ formationId: CATEGORIES, payload: payload(category) });
  return category;
}

/** Current category by id (O(1)). */
export async function readCategory(categoryId: string): Promise<Category | null> {
  const d = await db.readLatest({ formationId: CATEGORIES, indexId: "by-id", scopeValue: categoryId });
  return (d?.payload as Category | undefined) ?? null;
}

/** The immediate children of a parent, for THIS user -- O(pageSize) grab. */
export async function listChildCategories(userId: string, parentId: string, limit = 200): Promise<Category[]> {
  // template: indexes/ref-workout-categories/by-parent/{userId}/{parentId}/{categoryId}/latest.json
  const page = await db.listKeys({
    formationId: CATEGORIES,
    indexId: "by-parent",
    opts: { first: limit, prefix: `${userId}/${parentId}/` },
  });
  const ids2 = page.keys.map((k) => k.key.split("/").at(-2)).filter((v): v is string => typeof v === "string");
  const out: Category[] = [];
  for (const id of ids2) {
    const c = await readCategory(id);
    if (c) out.push(c);
  }
  out.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  return out;
}

/** Edit a category (a new revision; move MUST go through here to purge orphans). */
export async function editCategory(
  categoryId: string,
  changes: Partial<Pick<Category, "name" | "parentId" | "categoryPath" | "sortOrder" | "metricSchema">>,
): Promise<Category | null> {
  const current = await readCategory(categoryId);
  if (!current) return null;
  const next: Category = { ...current, ...changes, categoryId: current.categoryId, userId: current.userId };
  await db.writeDroplet({ formationId: CATEGORIES, payload: payload(next) });
  return next;
}

// ------------------------------------------------------------------ sets

/**
 * Log a set. Denormalizes the category name/path onto the set (so a list row and
 * a chart are self-describing without a join). Every set is an immutable droplet.
 */
export async function logSet(input: Omit<WorkoutSet, "setId" | "recordedAt"> & { recordedAt?: string }): Promise<WorkoutSet> {
  const set: WorkoutSet = {
    ...input,
    setId: ids.uuidv7(),
    isBenchmark: input.isBenchmark ?? false,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
  await db.writeDroplet({ formationId: SETS, payload: payload(set) });
  return set;
}

/**
 * AXIS 1 -- "last set" prefill. The single most-used interactive read: the most
 * recent set in a category, so the UI can pre-fill last time's weight/reps. One
 * pointer read on by-category (single-pointer, categoryId is UUIDv7-unique), so
 * it's O(1) and always fresh -- exactly what a read-your-writes prefill needs.
 */
export async function lastSetInCategory(categoryId: string): Promise<WorkoutSet | null> {
  const d = await db.readLatest({ formationId: SETS, indexId: "by-category", scopeValue: categoryId });
  return (d?.payload as WorkoutSet | undefined) ?? null;
}

/** Read a set by id. */
export async function readSet(setId: string): Promise<WorkoutSet | null> {
  const d = await db.readLatest({ formationId: SETS, indexId: "by-id", scopeValue: setId });
  return (d?.payload as WorkoutSet | undefined) ?? null;
}

// --------------------------------------------------------- session (token)

// The in-progress workout: which category, which set number, running draft
// state. A TOKEN (hot + mutable + resumable), not a droplet -- when the workout
// ends we delete it. Uses writeToken (merge-on-write) so partial updates as the
// user logs sets don't spam revisions.
export interface WorkoutSession {
  sessionId: string;
  userId: string;
  status: "active" | "finished";
  startedAt: string;
  currentCategoryId?: string;
  setNumber?: number;
  completedCategoryIds?: string[];
}

/** Start (or resume) the user's active session. */
export async function startSession(userId: string): Promise<WorkoutSession> {
  const session: WorkoutSession = {
    sessionId: ids.uuidv7(),
    userId,
    status: "active",
    startedAt: new Date().toISOString(),
    completedCategoryIds: [],
  };
  await db.writeToken({ formationId: SESSION, payload: payload(session) });
  return session;
}

/** Read the current session state. */
export async function readSession(sessionId: string): Promise<WorkoutSession | null> {
  const d = await db.readLatest({ formationId: SESSION, indexId: "by-id", scopeValue: sessionId });
  return (d?.payload as WorkoutSession | undefined) ?? null;
}

/** Merge partial session state (which category / set number). Merge-on-write. */
export async function updateSession(sessionId: string, changes: Partial<WorkoutSession>): Promise<void> {
  await db.writeToken({ formationId: SESSION, payload: { sessionId, ...changes } });
}
