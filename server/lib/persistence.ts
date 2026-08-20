// lib/persistence.ts -- ALL RainDB data IO for this bolt.
//
// THE PATTERN TO COPY: every read/write goes through the typed
// @raindb/bolt-sdk `db` binding. The bolt is tenant-scoped automatically --
// no tenant plumbing, no connection strings, no SQL strings for CRUD.
// Capabilities are declared in config/capabilities.json and enforced by the
// runtime; touching an undeclared formation throws CapabilityDenied.
//
// Three primitives cover almost everything (the full decision tree is in
// the patterns guide: `raindb-cli pack install raindb/guide-patterns`):
//
//   db.readLatest({ formationId, indexId, scopeValue })
//       O(1): one pointer GET + one entity GET. "Give me the current
//       version of entity X." Works at any scale.
//
//   db.writeDroplet({ formationId, payload })
//       Append-only: every write is a NEW immutable droplet. The payload
//       must carry the formation's scopeKey (here: noteId). Indexes update
//       automatically per the formation config.
//
//   db.listKeys({ formationId, indexId, opts: { prefix, first, after } })
//       O(pageSize) listing over an index. The key PATH carries the ids --
//       parse them out of the path segments (see listNoteIdsByAuthor).
//
// NAMING GOTCHA (cost us a debugging session): index path templates render
// payload fields by name, but the platform ALSO injects template variables
// of its own -- and `{{.author}}` is the WRITE AUTHOR (the writing
// principal, e.g. "bolt:<boltId>"), which shadows any payload field named
// `author`. That is why the payload field here is `authorName`. Treat
// platform-reserved names (author, tenantId, dropletId, yyyy/mm/dd) as
// off-limits for payload fields you want to index on.
//
// When you outgrow these (analytics, aggregations, full scans), the same
// formation is queryable with SQL via Periscope -- no schema work, it is
// already configured in formations/starter-notes-config.json. Try it:
//   raindb-cli sql -c 'SELECT authorName, COUNT(*) FROM entity."starter-notes" GROUP BY authorName'

import { db, ids, sql, isBehind } from "@raindb/bolt-sdk";

export const FORMATION_NOTES = "starter-notes";

export interface Note {
  noteId: string;
  authorName: string;
  title: string;
  body: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string | null;
}

/** Read the latest revision of a note by id. null when absent. */
export async function readNote(noteId: string): Promise<Note | null> {
  const d = await db.readLatest({
    formationId: FORMATION_NOTES,
    indexId: "by-id",
    scopeValue: noteId,
  });
  return (d?.payload as Note | undefined) ?? null;
}

/**
 * Create a note. Mints the UUIDv7 noteId (which IS the chronological
 * order -- no created_at sorting needed). Returns the full note.
 */
export async function createNote(fields: {
  authorName: string;
  title: string;
  body: string;
  tags?: string[];
}): Promise<Note> {
  const note: Note = {
    noteId: ids.uuidv7(),
    authorName: fields.authorName,
    title: fields.title,
    body: fields.body,
    tags: fields.tags ?? [],
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
  await db.writeDroplet({
    formationId: FORMATION_NOTES,
    payload: note as unknown as Record<string, unknown>,
  });
  return note;
}

/**
 * Update a note: read latest, SPREAD THE FULL PRIOR PAYLOAD, apply
 * changes, write a NEW droplet. There is no in-place (or partial)
 * update in RainDB -- if you spread only your changes, every field you
 * didn't mention is silently dropped from the current view. Every
 * revision is preserved; the by-id pointer moves to the newest.
 * This is your undo log, audit trail, and version history for free.
 */
export async function updateNote(
  noteId: string,
  updates: Partial<Pick<Note, "title" | "body" | "tags">>,
): Promise<Note | null> {
  const prior = await readNote(noteId);
  if (!prior) return null;
  const next: Note = {
    ...prior,
    ...updates,
    noteId,
    updatedAt: new Date().toISOString(),
  };
  await db.writeDroplet({
    formationId: FORMATION_NOTES,
    payload: next as unknown as Record<string, unknown>,
  });
  return next;
}

/**
 * List a single author's noteIds by walking the by-author index.
 *
 * Index templates put the ids IN THE KEY PATH:
 *   .../indexes/starter-notes/by-author/{authorName}/{noteId}/latest.json
 * so a prefix walk on "{authorName}/" returns one key per note, and the
 * noteId is the second-to-last path segment. O(pageSize) regardless of
 * how many notes exist in the tenant.
 */
export async function listNoteIdsByAuthor(authorName: string): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.listKeys({
      formationId: FORMATION_NOTES,
      indexId: "by-author",
      opts: {
        first: 200,
        prefix: authorName + "/",
        ...(cursor ? { after: cursor } : {}),
      },
    });
    for (const k of page.keys) {
      const segs = k.key.split("/");
      const noteId = segs[segs.length - 2];
      if (noteId) found.push(noteId);
    }
    if (!page.hasMore) break;
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return found;
}

/**
 * List every note's id by walking the primary index. Same path-parsing
 * pattern as above against by-id:
 *   .../indexes/starter-notes/by-id/{noteId}/latest.json
 */
export async function listAllNoteIds(): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.listKeys({
      formationId: FORMATION_NOTES,
      indexId: "by-id",
      opts: { first: 200, ...(cursor ? { after: cursor } : {}) },
    });
    for (const k of page.keys) {
      const segs = k.key.split("/");
      const noteId = segs[segs.length - 2];
      if (noteId) found.push(noteId);
    }
    if (!page.hasMore) break;
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return found;
}

/** Hydrate a list of noteIds into full notes (skipping any that vanished). */
export async function readNotes(noteIds: string[]): Promise<Note[]> {
  const out: Note[] = [];
  for (const id of noteIds) {
    const n = await readNote(id);
    if (n) out.push(n);
  }
  return out;
}

// ===========================================================================
// AXIS 2 -- ANALYTICAL SQL over the SAME droplets (Periscope / auto-datalake)
//
// Everything above reads the INDEX plane: a pointer/prefix lookup by id, always
// fresh, O(1) or O(pageSize), right after a write. That is the interactive path.
//
// The functions below read the SQL plane. The exact same note droplets ALSO
// cascade -- automatically, no ETL -- through the formation's periscope tiers
// (stream -> river -> lake, configured in starter-notes-config.json) into one
// queryable analytical table `entity."starter-notes"`. You get GROUP BY, window
// functions, and full scans over your whole history, at any scale.
//
// THE ONE RULE THAT MATTERS: the SQL plane is EVENTUALLY CONSISTENT. It trails
// live writes by one pool cycle (this formation's stream tier pools every ~5
// min). So a note you just wrote is instantly visible via readNote() (index)
// but may not appear in a SQL result until the next pool. That is not data loss
// -- it is the mechanism that makes the analytics scale. `withFreshness: true`
// returns a bookmark telling you exactly how far behind the snapshot is, so the
// UI can show an honest "updating..." badge instead of pretending.
// ===========================================================================

/** A freshness verdict distilled for the client (from the SQL bookmark). */
export interface Freshness {
  status: string; // CURRENT | BEHIND | UNKNOWN | UNAVAILABLE
  behind: boolean; // true when live writes have not reached the SQL snapshot yet
}

export interface AuthorStat {
  authorName: string;
  notes: number;
  latest: string | null;
}

/**
 * Count notes per author via analytical SQL, and report freshness.
 *
 * This is the canonical "your operational data IS your warehouse" demo: no ETL,
 * no separate store -- just SQL over the droplets you already wrote. An aggregate
 * like COUNT/GROUP BY reads the pooled snapshot; you CANNOT merge a late row into
 * a GROUP BY (adding one row does not re-aggregate), so instead of faking it we
 * return the freshness bookmark and let the UI show a badge when BEHIND.
 */
export async function statsByAuthor(): Promise<{ stats: AuthorStat[]; freshness: Freshness }> {
  const result = await sql.query({
    sql: `SELECT authorName, COUNT(*) AS notes, MAX(createdAt) AS latest
          FROM entity."${FORMATION_NOTES}"
          GROUP BY authorName
          ORDER BY notes DESC`,
    formationId: FORMATION_NOTES,
    withFreshness: true,
  });
  const stats = result.rows.map((r) => ({
    authorName: String(r.authorName ?? ""),
    notes: Number(r.notes ?? 0),
    latest: r.latest == null ? null : String(r.latest),
  }));
  // The bookmark carries a server-computed verdict; read it, don't compare
  // cursors yourself. sql.isBehind() is the SDK helper for exactly this.
  const bm = result.latest?.find((f) => f.formationId === FORMATION_NOTES);
  const freshness: Freshness = {
    status: bm?.freshnessStatus ?? "UNKNOWN",
    behind: bm ? isBehind(bm) : false,
  };
  return { stats, freshness };
}

/**
 * Recent notes as an analytical ROW LIST, with the fresh tail MERGED in.
 *
 * A row list (SELECT the entities themselves) is the one shape you CAN safely
 * freshen: `sql.queryEntityRowsFresh` runs the SQL, checks the bookmark, and if
 * the snapshot is behind it harvests the un-pooled tail from the by-update index
 * and merges it in (newest wins) -- so you get analytical SQL AND read-your-writes
 * in one call. (This is the RIGHT tool for a feed/list; it is NOT for aggregates
 * -- use statsByAuthor for those and show the freshness badge.)
 */
export async function recentNotesFresh(limit = 20): Promise<Note[]> {
  const result = await sql.queryEntityRowsFresh({
    sql: `SELECT noteId, authorName, title, body, tags, createdAt, updatedAt
          FROM entity."${FORMATION_NOTES}"
          ORDER BY noteId DESC
          LIMIT ${Math.max(1, Math.min(200, limit))}`,
    formationId: FORMATION_NOTES,
    scopeKey: "noteId",
  });
  return result.rows.map((r) => ({
    noteId: String(r.noteId ?? ""),
    authorName: String(r.authorName ?? ""),
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    createdAt: String(r.createdAt ?? ""),
    updatedAt: r.updatedAt == null ? null : String(r.updatedAt),
  }));
}
