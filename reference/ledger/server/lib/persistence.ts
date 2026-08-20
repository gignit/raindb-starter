// lib/persistence.ts -- ALL RainDB data IO for the Ledger reference bolt.
//
// THE PATTERN TO COPY: every read/write goes through the typed @raindb/bolt-sdk
// `db` binding. The bolt is tenant-scoped automatically -- no tenant plumbing,
// no connection strings, no SQL for CRUD. Capabilities are declared in
// config/capabilities.json and enforced by the runtime (touching an undeclared
// formation throws CapabilityDenied). Keeping ALL IO here is what keeps the app
// explainable: routes never call db.* directly.
//
// Five live native bindings cover the whole Ledger:
//
//   db.readLatest({ formationId, indexId: "by-id", scopeValue })
//       O(1): "the CURRENT revision of entry X." One pointer GET + one GET.
//
//   db.readDroplet({ formationId, dropletId })
//       Read an EXACT historical revision by its dropletId. This is time-travel:
//       every prior version of an entry is still here, addressable, forever.
//
//   db.writeDroplet({ formationId, payload })
//       Append-only. EVERY write (create, edit, restore) is a NEW immutable
//       droplet; the by-id pointer moves to it (newest-wins). There is no
//       UPDATE -- "editing" is writing a new revision, and the chain of droplets
//       IS the version history / audit trail / undo. Zero schema for any of it.
//
//   db.listKeys({ formationId, indexId, opts })
//       O(pageSize) walk of an index WITHOUT reading payloads. The id lives in
//       the key PATH -- parse it out (see listEntryIdsByAuthor). Relay paging.
//
//   db.listSince({ formationId, sinceCursor, opts })
//       The LIVE-FEED primitive over by-update: "give me every droplet written
//       after cursor X, oldest-first, with full payloads." Pair it with a
//       wire-token SSE wakeup and you have real-time with no broker.
//
// The file attachment is versioned by the platform (revisions:true on the
// formation's float field). Uploading a new version is a LOW-FREQUENCY op, so
// it goes over ctx.fetch -> GraphQL (see lib/uploads.ts) -- the intended route
// for infrequent operations, distinct from these hot-path native bindings.
//
// NAMING GOTCHA (a real debugging session): index path templates render payload
// fields by name, but the platform ALSO injects its own template vars -- and
// {{.author}} is the WRITE AUTHOR (the writing principal, e.g. "bolt:<boltId>"),
// which shadows any payload field named `author`. That is why the payload field
// is `authorName`. Treat platform-reserved names (author, tenantId, dropletId,
// yyyy/mm/dd) as off-limits for payload fields you index on.
//
// When you outgrow these (analytics, aggregates, scans), the SAME droplets are
// queryable with SQL via Periscope -- already configured in the formation. Try:
//   raindb-cli sql -c 'SELECT status, COUNT(*) FROM entity."ref-entries" GROUP BY status'

import { db, ids } from "@raindb/bolt-sdk";
import { payload } from "./http.js";

export const FORMATION = "ref-entries";
const IDX_BY_ID = "by-id";
const IDX_BY_AUTHOR = "by-author";

export interface Entry {
  entryId: string;
  authorName: string;
  title: string;
  body: string;
  status: "draft" | "active" | "archived";
  tags?: string[];
  // True when body holds client-side ciphertext (zero-knowledge). The server
  // stores it opaquely; only the client can decrypt with the passphrase.
  encrypted?: boolean;
  createdAt: string;
  updatedAt?: string | null;
  revisionNote?: string | null;
  // Attachment metadata (set once a file version is uploaded via lib/uploads.ts).
  attachmentFilename?: string;
  attachmentContentType?: string;
  attachmentVersionId?: string; // platform-minted per-file version id
}

/** A single revision in an entry's history (from the droplet chain). */
export interface Revision {
  dropletId: string;
  ts: number; // unix ms (the droplet's write time)
  entry: Entry;
}

// ------------------------------------------------------------------ reads

/** Current revision of an entry by id. null when absent. O(1) at any scale. */
export async function readEntry(entryId: string): Promise<Entry | null> {
  const d = await db.readLatest({
    formationId: FORMATION,
    indexId: IDX_BY_ID,
    scopeValue: entryId,
  });
  return (d?.payload as Entry | undefined) ?? null;
}

/** A specific historical revision, by its dropletId. This is time-travel. */
export async function readRevision(dropletId: string): Promise<Entry | null> {
  const d = await db.readDroplet({ formationId: FORMATION, dropletId });
  return (d?.payload as Entry | undefined) ?? null;
}

// ------------------------------------------------------------------ writes

/**
 * Create a brand-new entry. Mints a UUIDv7 entryId (creation-time ordering is
 * free), stamps createdAt, and writes the first immutable droplet.
 */
export async function createEntry(input: {
  authorName: string;
  title: string;
  body: string;
  status?: Entry["status"];
  tags?: string[];
  encrypted?: boolean;
}): Promise<Entry> {
  const now = new Date().toISOString();
  const entry: Entry = {
    entryId: ids.uuidv7(),
    authorName: input.authorName,
    title: input.title,
    body: input.body,
    status: input.status ?? "active",
    tags: input.tags ?? [],
    encrypted: input.encrypted ?? false,
    createdAt: now,
    updatedAt: null,
    revisionNote: null,
  };
  await db.writeDroplet({ formationId: FORMATION, payload: payload(entry) });
  return entry;
}

/**
 * Edit = read the current revision, merge the changes, write a NEW droplet.
 * There is no UPDATE. The prior revision stays readable forever (audit + undo).
 * createdAt/entryId carry forward unchanged; updatedAt stamps this revision.
 */
export async function editEntry(
  entryId: string,
  changes: Partial<Pick<Entry, "authorName" | "title" | "body" | "status" | "tags" | "encrypted">>,
  revisionNote?: string,
): Promise<Entry | null> {
  const current = await readEntry(entryId);
  if (!current) return null;
  const next: Entry = {
    ...current,
    ...changes,
    entryId: current.entryId, // never let a change touch the scopeKey
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    revisionNote: revisionNote ?? null,
  };
  await db.writeDroplet({ formationId: FORMATION, payload: payload(next) });
  return next;
}

/**
 * Restore an older revision: read that exact droplet, write its payload back as
 * a NEW revision (so the restore itself is auditable -- history only grows).
 */
export async function restoreRevision(
  entryId: string,
  dropletId: string,
): Promise<Entry | null> {
  const old = await readRevision(dropletId);
  if (!old || old.entryId !== entryId) return null;
  const restored: Entry = {
    ...old,
    updatedAt: new Date().toISOString(),
    revisionNote: `restored from revision ${dropletId}`,
  };
  await db.writeDroplet({ formationId: FORMATION, payload: payload(restored) });
  return restored;
}

// ------------------------------------------------------------------ history

/**
 * The version history of one entry, newest-first: every revision droplet in the
 * entry's chain, with its dropletId + write time. Uses the entity version
 * history over GraphQL (a low-frequency op) via lib/uploads.ts's graphql helper
 * is one option; here we use the native listKeys walk of the by-update index and
 * filter to this entry -- but the simplest, exact source is the GraphQL
 * entityVersionHistory. See lib/history.ts for the chosen implementation.
 */

// ------------------------------------------------------------------ lists

/** Recent entries for one author, newest-first -- O(pageSize).
 *
 *  We list the by-update index (its leaf is the entryId, a raw UUID) rather than
 *  by-author: a by-author prefix would need the author name, and NATURAL-STRING
 *  path segments are hash-encoded in storage ("Test Athlete" -> a ~b64 segment),
 *  so a raw-name prefix never matches. Listing by-update (UUID leaf) is prefix-
 *  safe; we read the payloads and filter by authorName. (A real RainDB lesson:
 *  prefix-match only on raw/UUID segments, not natural-string ones.)
 */
export async function listEntryIdsByAuthor(
  authorName: string,
  limit = 200,
): Promise<string[]> {
  const page = await db.listKeys({
    formationId: FORMATION,
    indexId: "by-update",
    opts: { first: limit },
  });
  // template: indexes/ref-entries/by-update/{entryId}/latest.json
  const ids = page.keys
    .map((k) => k.key.split("/").at(-2))
    .filter((v): v is string => typeof v === "string");
  // Filter to this author (read the current revision of each).
  const out: string[] = [];
  for (const id of ids) {
    const e = await readEntry(id);
    if (e && e.authorName === authorName) out.push(id);
  }
  return out;
}

/** Read the current revision of many entries (for a list view). */
export async function readEntries(entryIds: string[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const id of entryIds) {
    const e = await readEntry(id);
    if (e) out.push(e);
  }
  return out;
}

// ------------------------------------------------------------------ live feed

export interface FeedPage {
  entries: Entry[];
  nextCursor: string;
}

/**
 * The live activity feed: every write after `sinceCursor`, oldest-first, with
 * full payloads -- the newest-first descIndex on by-update makes this O(pageSize)
 * at any scale. Pass "" for the beginning; persist nextCursor to tail. A wire
 * token (ctx.iam.mintWireToken) can wake the browser to call this on each write.
 */
export async function feedSince(sinceCursor: string, limit = 50): Promise<FeedPage> {
  const page = await db.listSince({
    formationId: FORMATION,
    sinceCursor,
    opts: { first: limit },
  });
  return {
    entries: page.droplets.map((d) => d as unknown as Entry),
    nextCursor: page.nextCursor ?? sinceCursor,
  };
}
