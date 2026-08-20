// lib/history.ts -- an entry's version history: every revision in its droplet
// chain, newest-first. This is RainDB's headline made trivial: because every
// edit is an immutable droplet (never an in-place update), the chain of droplets
// IS the version history / audit trail / undo -- for free, with zero extra
// schema or bookkeeping.
//
// db.versionHistory({ formationId, scopeValue }) walks the entity's droplet
// chain and returns [{ dropletId, ts, payload }], newest-first. (The bolt-sdk
// resolves the entity's canonically-encoded storage prefix from the semantic
// scopeValue, so you pass the plain entryId -- not a hand-built path.)

import { db } from "@raindb/bolt-sdk";
import { FORMATION, type Entry } from "./persistence.js";

export interface Revision {
  dropletId: string;
  ts: number; // unix ms (this revision's write time)
  entry: Entry;
}

/** The full version history of one entry, newest-first. */
export async function historyOf(entryId: string): Promise<Revision[]> {
  const chain = await db.versionHistory({ formationId: FORMATION, scopeValue: entryId });
  return chain.map((r) => ({ dropletId: r.dropletId, ts: r.ts, entry: r.payload as unknown as Entry }));
}
