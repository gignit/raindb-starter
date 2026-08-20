// lib/analytics.ts -- AXIS 2: analytical SQL over the SAME workout/journal
// droplets, via Periscope. This is where RainDB stops being a key-value grab and
// becomes a full analytical engine: GROUP BY, window functions, percentiles,
// regression -- over your operational data, with ZERO ETL. A personal site and a
// gym with 100k members run the identical query at the same speed.
//
// TWO-PLANE DISCIPLINE (the #1 thing this file teaches):
//   * The O(1) GRAB (lib/workout.ts lastSetInCategory) answers "show me last
//     time, pre-filled" -- it MUST be fresh, so it's an index read.
//   * SQL here answers "chart my whole history / find my PRs" -- aggregation
//     where a few-minutes lag is fine. The SQL plane is eventually consistent
//     (the columnar snapshot trails live writes by one pool cycle).
//   * So after a workout, the CHART may not yet include the set just logged.
//     That is NOT data loss -- it's the mechanism that makes the analytics scale.
//     We surface the freshness bookmark so the UI shows an honest "updating,
//     your latest workout appears in ~a few minutes" badge, while the set is
//     already visible via the fresh index. NEVER fake a fresh aggregate.

import { sql } from "@raindb/bolt-sdk";

const SETS = "ref-workout-sets";

export interface FreshnessState {
  behind: boolean; // true when live writes have not yet reached the SQL snapshot
  status: string; // CURRENT | BEHIND | UNKNOWN | UNAVAILABLE
}

function freshnessOf(latest: Array<{ formationId: string; freshnessStatus: string }> | undefined, formationId: string): FreshnessState {
  const row = (latest ?? []).find((r) => r.formationId === formationId);
  const status = row?.freshnessStatus ?? "UNKNOWN";
  return { behind: status === "BEHIND", status };
}

export interface ChartPoint {
  day: string;
  topWeightKg: number | null;
  totalVolumeKg: number | null;
  sets: number;
}

/**
 * A category's progress chart: per-day top weight + total volume + set count.
 * Typed columns (weightKg, reps) aggregate directly -- that's why the set schema
 * uses top-level typed columns, not only a free-form blob. Returns the chart
 * plus the freshness state so the UI can show the "updating" badge when BEHIND.
 */
export async function categoryProgress(userId: string, categoryId: string, days = 90): Promise<{ points: ChartPoint[]; freshness: FreshnessState }> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const q = `
    SELECT
      substr(recordedAt, 1, 10) AS day,
      MAX(weightKg)             AS topWeightKg,
      SUM(weightKg * reps)      AS totalVolumeKg,
      COUNT(*)                  AS sets
    FROM entity."${SETS}"
    WHERE userId = '${userId.replace(/'/g, "")}'
      AND categoryId = '${categoryId.replace(/'/g, "")}'
      AND recordedAt >= '${since}'
    GROUP BY day
    ORDER BY day`;
  const r = await sql.query({ sql: q, formationId: SETS, withFreshness: true });
  const points = r.rows.map((row) => ({
    day: String(row.day ?? ""),
    topWeightKg: row.topWeightKg == null ? null : Number(row.topWeightKg),
    totalVolumeKg: row.totalVolumeKg == null ? null : Number(row.totalVolumeKg),
    sets: Number(row.sets ?? 0),
  }));
  return { points, freshness: freshnessOf(r.latest, SETS) };
}

export interface PersonalRecord {
  categoryId: string;
  categoryName: string;
  topWeightKg: number | null;
  estimatedOneRepMaxKg: number | null;
  recordedAt: string;
}

/**
 * Retroactive PR detection across the user's whole history -- the analytical
 * "wow". A window function ranks every set per category by an Epley estimated
 * 1RM (weight * (1 + reps/30)); rank 1 per category is the PR. The benchmark
 * FLAG is user intent; SQL OBJECTIVELY decides the record from the data.
 */
export async function personalRecords(userId: string): Promise<{ records: PersonalRecord[]; freshness: FreshnessState }> {
  const uid = userId.replace(/'/g, "");
  const q = `
    WITH scored AS (
      SELECT
        categoryId, categoryName, weightKg, reps, recordedAt,
        weightKg * (1 + reps / 30.0) AS e1rm,
        ROW_NUMBER() OVER (PARTITION BY categoryId ORDER BY weightKg * (1 + reps / 30.0) DESC) AS rnk
      FROM entity."${SETS}"
      WHERE userId = '${uid}' AND weightKg IS NOT NULL AND reps IS NOT NULL
    )
    SELECT categoryId, categoryName, weightKg AS topWeightKg,
           ROUND(e1rm, 1) AS estimatedOneRepMaxKg, recordedAt
    FROM scored WHERE rnk = 1
    ORDER BY estimatedOneRepMaxKg DESC`;
  const r = await sql.query({ sql: q, formationId: SETS, withFreshness: true });
  const records = r.rows.map((row) => ({
    categoryId: String(row.categoryId ?? ""),
    categoryName: String(row.categoryName ?? ""),
    topWeightKg: row.topWeightKg == null ? null : Number(row.topWeightKg),
    estimatedOneRepMaxKg: row.estimatedOneRepMaxKg == null ? null : Number(row.estimatedOneRepMaxKg),
    recordedAt: String(row.recordedAt ?? ""),
  }));
  return { records, freshness: freshnessOf(r.latest, SETS) };
}

/**
 * A gym leaderboard: top users by total volume this month. The white-label
 * payoff -- one GROUP BY over EVERY member's sets, the same query whether the
 * gym has 5 members or 50,000. (In a real deployment you'd resolve userId ->
 * displayName; here we return the raw ids for the reference.)
 */
export async function volumeLeaderboard(days = 30, limit = 10): Promise<{ rows: Array<{ userId: string; totalVolumeKg: number; sets: number }>; freshness: FreshnessState }> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const q = `
    SELECT userId, SUM(weightKg * reps) AS totalVolumeKg, COUNT(*) AS sets
    FROM entity."${SETS}"
    WHERE recordedAt >= '${since}' AND weightKg IS NOT NULL AND reps IS NOT NULL
    GROUP BY userId
    ORDER BY totalVolumeKg DESC
    LIMIT ${Math.max(1, Math.min(100, limit))}`;
  const r = await sql.query({ sql: q, formationId: SETS, withFreshness: true });
  const rows = r.rows.map((row) => ({
    userId: String(row.userId ?? ""),
    totalVolumeKg: Number(row.totalVolumeKg ?? 0),
    sets: Number(row.sets ?? 0),
  }));
  return { rows, freshness: freshnessOf(r.latest, SETS) };
}
