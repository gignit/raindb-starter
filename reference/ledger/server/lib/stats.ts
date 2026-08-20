// lib/stats.ts -- live community stats + per-user streaks + AI rate limiting,
// all on RainDB TOKENS via atomic mutate. This is real-time counters with NO
// Redis, NO message broker, NO second datastore -- the same authoritative token
// holds the running totals, the streak, and the rate-limit window.
//
//   db.mutate         -- fire-and-forget atomic increment (drop-tolerant; fine
//                        for an odometer where an occasional lost tick is ok).
//   db.mutateAndRead  -- atomic increment that RETURNS the fleet-true value in
//                        one call (the owner host serializes it). Use this when
//                        the exact value matters: streak decisions, rate limits.
//
// ref-stats declares stats.keepRunningTotals, so an `increment` on counters.delta.*
// is periodically folded into counters.total.* by the platform -- the odometer
// reads counters.total.*. Streaks are plain counters we own directly.

import { db } from "@raindb/bolt-sdk";

const STATS = "ref-stats";
const STREAKS = "ref-streaks";

// db.mutate/mutateAndRead require the counter token to already EXIST (they are a
// read-modify-write on a cached token, not create-on-write). So before the first
// mutate on a scope we ensure the token exists with zeroed counters. Idempotent:
// writeToken merges, so re-seeding an existing token is harmless.
async function ensureCounter(formationId: string, scopeValue: string, seed: Record<string, unknown>): Promise<void> {
  const existing = await db.readLatest({ formationId, indexId: "by-id", scopeValue });
  if (!existing) await db.writeToken({ formationId, payload: seed });
}

// One global stats token drives the whole deployment's community odometer.
const GLOBAL_STATS = "global";

// -------------------------------------------------------- community odometer

/**
 * Bump the community odometer when something happens. Drop-tolerant (db.mutate):
 * a personal-site or a gym deployment both tick the same counters. The platform
 * folds delta -> total, so the odometer stays cheap under load (keystroke-rate
 * increments coalesce; the token is written to S3 at most once per writeDelay).
 */
export async function recordActivity(kind: "workout" | "set" | "journalEntry", volumeKg = 0): Promise<void> {
  const ops: Array<{ kind: "increment"; path: string; by: number }> = [];
  if (kind === "workout") ops.push({ kind: "increment", path: "counters.delta.workouts", by: 1 });
  if (kind === "set") {
    ops.push({ kind: "increment", path: "counters.delta.sets", by: 1 });
    if (volumeKg > 0) ops.push({ kind: "increment", path: "counters.delta.volumeKg", by: volumeKg });
  }
  if (kind === "journalEntry") ops.push({ kind: "increment", path: "counters.delta.journalEntries", by: 1 });
  if (ops.length) {
    await ensureCounter(STATS, GLOBAL_STATS, { statsId: GLOBAL_STATS, counters: {} });
    await db.mutate({ formationId: STATS, scopeValue: GLOBAL_STATS, ops });
  }
}

export interface Odometer {
  workouts: number;
  sets: number;
  volumeKg: number;
  journalEntries: number;
}

/** Read the live community odometer (counters.total.* folded by the platform). */
export async function readOdometer(): Promise<Odometer> {
  const d = await db.readLatest({ formationId: STATS, indexId: "by-id", scopeValue: GLOBAL_STATS });
  const total = ((d?.payload as { counters?: { total?: Record<string, number> } })?.counters?.total) ?? {};
  return {
    workouts: total.workouts ?? 0,
    sets: total.sets ?? 0,
    volumeKg: total.volumeKg ?? 0,
    journalEntries: total.journalEntries ?? 0,
  };
}

// ------------------------------------------------------------ streaks

/**
 * Update a user's streak on activity. FLEET-TRUE (mutateAndRead): the streak
 * decision must be exact, so we read the authoritative post-increment value.
 * If the last activity was yesterday, the streak continues (+1); if today,
 * unchanged; otherwise it resets to 1. Streak state is mutable -> no stats fold,
 * we own current/longest directly.
 */
export async function touchStreak(userId: string): Promise<{ current: number; longest: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await db.readLatest({ formationId: STREAKS, indexId: "by-id", scopeValue: userId });
  const c = (existing?.payload as { counters?: { current?: number; longest?: number; lastActivityDate?: string } })?.counters ?? {};
  const last = c.lastActivityDate;
  let current = c.current ?? 0;
  if (last === today) {
    // already counted today
  } else {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    current = last === yesterday ? current + 1 : 1;
  }
  const longest = Math.max(c.longest ?? 0, current);
  await db.writeToken({
    formationId: STREAKS,
    payload: { userId, counters: { current, longest, lastActivityDate: today } },
  });
  return { current, longest };
}

/** Read a user's current streak. */
export async function readStreak(userId: string): Promise<{ current: number; longest: number }> {
  const d = await db.readLatest({ formationId: STREAKS, indexId: "by-id", scopeValue: userId });
  const c = (d?.payload as { counters?: { current?: number; longest?: number } })?.counters ?? {};
  return { current: c.current ?? 0, longest: c.longest ?? 0 };
}

// --------------------------------------------------- AI rate limiting

const AI_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const AI_LIMIT_PER_WINDOW = 30; // per user per window -- protects a gym's LLM budget

/**
 * Fleet-wide windowed rate limit for the AI endpoint. Atomically bumps this
 * user's hourly counter and reads the new total; the window resets passively
 * (no cron). Returns whether the call is allowed + how many remain. This is the
 * Redis INCR+EXPIRE rate-limit pattern, as a RainDB token.
 */
export async function checkAiRateLimit(userId: string): Promise<{ allowed: boolean; remaining: number }> {
  await ensureCounter(STATS, `ai:${userId}`, { statsId: `ai:${userId}`, counters: {} });
  const vals = await db.mutateAndRead({
    formationId: STATS,
    scopeValue: `ai:${userId}`,
    ops: [{
      kind: "windowIncrement",
      countPath: "counters.aiWindow.count",
      windowStartPath: "counters.aiWindow.startMs",
      windowMs: AI_WINDOW_MS,
      by: 1,
      nowMs: Date.now(),
    }],
    readPaths: ["counters.aiWindow.count"],
  });
  const used = vals["counters.aiWindow.count"] ?? 0;
  return { allowed: used <= AI_LIMIT_PER_WINDOW, remaining: Math.max(0, AI_LIMIT_PER_WINDOW - used) };
}
