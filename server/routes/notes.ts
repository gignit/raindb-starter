// routes/notes.ts -- the example CRUD surface. Replace with YOUR domain.
//
// Each handler is: parse input -> call persistence -> return JSON. The
// persistence layer (lib/persistence.ts) is the only place that touches
// RainDB, so swapping notes for your own entity means: new formation
// config + schema in formations/, new persistence functions, new routes.

import type { BoltRequest, BoltResponse } from "@raindb/bolt-sdk";
import { ok, bad, notFound, readJsonBody } from "../lib/http.js";
import {
  createNote,
  readNote,
  updateNote,
  listAllNoteIds,
  listNoteIdsByAuthor,
  readNotes,
  statsByAuthor,
  recentNotesFresh,
} from "../lib/persistence.js";

/** GET /api/notes[?author=x] -- list notes (newest first; UUIDv7 sorts). */
export async function handleListNotes(req: BoltRequest): Promise<BoltResponse> {
  const raw = req.query?.["author"];
  const authorName = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const idsAsc = authorName ? await listNoteIdsByAuthor(authorName) : await listAllNoteIds();
  const notes = await readNotes(idsAsc.sort().reverse());
  return ok({ notes });
}

/** POST /api/notes {author, title, body, tags?} -- create. */
export async function handleCreateNote(req: BoltRequest): Promise<BoltResponse> {
  const body = readJsonBody(req);
  if (!body) return bad("invalid JSON body");
  const authorName = typeof body.author === "string" ? body.author.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.body === "string" ? body.body : "";
  if (!authorName || !title) return bad("author and title are required");
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
  const note = await createNote({ authorName, title, body: text, tags });
  return ok({ note });
}

/** GET /api/notes/:id -- read latest revision. */
export async function handleGetNote(req: BoltRequest): Promise<BoltResponse> {
  const noteId = req.path.slice("/api/notes/".length);
  if (!noteId) return bad("noteId required");
  const note = await readNote(noteId);
  if (!note) return notFound("note " + noteId + " not found");
  return ok({ note });
}

/**
 * GET /api/stats -- AXIS 2: analytical SQL (count notes by author) over the
 * SAME droplets, plus the freshness verdict. The response's `freshness.behind`
 * drives the client's "updating..." badge -- the honest way to present an
 * eventually-consistent aggregate.
 */
export async function handleStats(_req: BoltRequest): Promise<BoltResponse> {
  const { stats, freshness } = await statsByAuthor();
  return ok({ stats, freshness });
}

/**
 * GET /api/notes-sql -- recent notes as a SQL row list with the fresh tail
 * MERGED in (read-your-writes over the analytical plane). Contrast /api/notes
 * (pure index reads): this shows the merge pattern for a list.
 */
export async function handleRecentNotesSql(_req: BoltRequest): Promise<BoltResponse> {
  const notes = await recentNotesFresh(20);
  return ok({ notes });
}

/** POST /api/notes/:id {title?, body?, tags?} -- update (new revision). */
export async function handleUpdateNote(req: BoltRequest): Promise<BoltResponse> {
  const noteId = req.path.slice("/api/notes/".length);
  if (!noteId) return bad("noteId required");
  const body = readJsonBody(req);
  if (!body) return bad("invalid JSON body");
  const updates: { title?: string; body?: string; tags?: string[] } = {};
  if (typeof body.title === "string") updates.title = body.title;
  if (typeof body.body === "string") updates.body = body.body;
  if (Array.isArray(body.tags)) updates.tags = body.tags.filter((t): t is string => typeof t === "string");
  const note = await updateNote(noteId, updates);
  if (!note) return notFound("note " + noteId + " not found");
  return ok({ note });
}
