// routes/stats.ts -- the live community odometer + the user's streak. These are
// the redis+ token counters (real-time, fleet-authoritative, no Redis) surfaced
// to the client for the "N workouts logged across the community" ticker and the
// "12-day streak" badge.

import type { BoltRequest, BoltResponse } from "@raindb/bolt-sdk";
import { ok, bad } from "../lib/http.js";
import { requireUser, AuthError } from "../lib/auth.js";
import { readOdometer, readStreak } from "../lib/stats.js";

function guard(e: unknown): BoltResponse {
  if (e instanceof AuthError) return bad(e.message, e.status);
  return bad(e instanceof Error ? e.message : "error", 500);
}

/** The community odometer (running totals folded by the platform). Public-ish. */
export async function handleOdometer(_req: BoltRequest): Promise<BoltResponse> {
  try {
    const odometer = await readOdometer();
    return ok({ odometer });
  } catch (e) {
    return guard(e);
  }
}

/** The caller's streak. */
export async function handleStreak(req: BoltRequest): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    const streak = await readStreak(s.userId);
    return ok({ streak });
  } catch (e) {
    return guard(e);
  }
}
