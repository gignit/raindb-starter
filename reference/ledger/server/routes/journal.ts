// routes/journal.ts -- the journal: taggable, optionally client-encrypted,
// autosaving entries with full version history.
//
// ENCRYPTION IS CLIENT-SIDE (zero-knowledge): the server treats an encrypted
// entry as opaque. The client sends { encrypted: true, ciphertext, tags } -- the
// body is already AES-GCM ciphertext the server can NEVER read. So these routes
// store/return whatever bytes they're given; the tags stay plaintext so the AI
// can still find entries by tag. The server does no crypto.
//
// AXIS 1 (grabs): list/read/history are pointer + chain reads (instant, any
// scale). Drafts autosave into a write-behind token (no droplet spam) and vanish
// on publish. Version history is the droplet chain -- edit/restore are free.

import type { BoltRequest, BoltResponse } from "@raindb/bolt-sdk";
import { ok, bad, notFound, readJsonBody } from "../lib/http.js";
import { requireUser, AuthError } from "../lib/auth.js";
import * as store from "../lib/persistence.js";
import * as drafts from "../lib/drafts.js";
import * as tags from "../lib/tags.js";
import { recordActivity, touchStreak } from "../lib/stats.js";
import { historyOf } from "../lib/history.js";

function guard(e: unknown): BoltResponse {
  if (e instanceof AuthError) return bad(e.message, e.status);
  return bad(e instanceof Error ? e.message : "error", 500);
}

// entryId is the URL param; the route pulls the caller from the session.
export async function handleListEntries(req: BoltRequest): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    const ids = await store.listEntryIdsByAuthor(s.name, 200);
    const entries = await store.readEntries(ids);
    return ok({ entries });
  } catch (e) {
    return guard(e);
  }
}

export async function handleGetEntry(req: BoltRequest, entryId: string): Promise<BoltResponse> {
  try {
    await requireUser(req);
    const entry = await store.readEntry(entryId);
    return entry ? ok({ entry }) : notFound("entry not found");
  } catch (e) {
    return guard(e);
  }
}

export async function handleCreateEntry(req: BoltRequest): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    const s = await requireUser(req);
    const entryTags = Array.isArray(b.tags) ? (b.tags as string[]) : [];
    const entry = await store.createEntry({
      authorName: s.name,
      title: String(b.title ?? "Untitled"),
      // Encrypted entries carry ciphertext (opaque); plaintext entries carry body.
      body: b.encrypted ? String(b.ciphertext ?? "") : String(b.body ?? ""),
      tags: entryTags,
    });
    // Remember the tags for the picker, and bump activity + streak.
    if (entryTags.length) await tags.rememberTags(s.userId, "journal", entryTags);
    await recordActivity("journalEntry");
    await touchStreak(s.userId);
    return ok({ entry });
  } catch (e) {
    return guard(e);
  }
}

export async function handleEditEntry(req: BoltRequest, entryId: string): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    const s = await requireUser(req);
    const entryTags = Array.isArray(b.tags) ? (b.tags as string[]) : undefined;
    const next = await store.editEntry(
      entryId,
      {
        title: b.title !== undefined ? String(b.title) : undefined,
        body: b.encrypted ? String(b.ciphertext ?? "") : b.body !== undefined ? String(b.body) : undefined,
        tags: entryTags,
      },
      b.revisionNote ? String(b.revisionNote) : undefined,
    );
    if (!next) return notFound("entry not found");
    if (entryTags?.length) await tags.rememberTags(s.userId, "journal", entryTags);
    return ok({ entry: next });
  } catch (e) {
    return guard(e);
  }
}

/** Version history of an entry (the droplet chain). */
export async function handleEntryHistory(req: BoltRequest, entryId: string): Promise<BoltResponse> {
  try {
    await requireUser(req);
    const revisions = await historyOf(entryId);
    return ok({ revisions });
  } catch (e) {
    return guard(e);
  }
}

/** Restore an older revision (writes it back as a new revision -- auditable). */
export async function handleRestoreEntry(req: BoltRequest, entryId: string): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    await requireUser(req);
    const restored = await store.restoreRevision(entryId, String(b.dropletId ?? ""));
    return restored ? ok({ entry: restored }) : notFound("revision not found");
  } catch (e) {
    return guard(e);
  }
}

// ------------------------------------------------------------------ drafts

/** Autosave a draft (write-behind token; coalesces, no droplet spam). */
export async function handleAutosaveDraft(req: BoltRequest): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    const s = await requireUser(req);
    const draftId = String(b.draftId ?? drafts.newDraftId());
    await drafts.autosave({
      draftId,
      userId: s.userId,
      title: b.title ? String(b.title) : undefined,
      body: b.encrypted ? undefined : b.body ? String(b.body) : undefined,
      ciphertext: b.encrypted ? String(b.ciphertext ?? "") : undefined,
      encrypted: Boolean(b.encrypted),
      tags: Array.isArray(b.tags) ? (b.tags as string[]) : undefined,
    });
    return ok({ draftId });
  } catch (e) {
    return guard(e);
  }
}

export async function handleGetDraft(req: BoltRequest, draftId: string): Promise<BoltResponse> {
  try {
    await requireUser(req);
    const draft = await drafts.readDraft(draftId);
    return draft ? ok({ draft }) : notFound("no draft");
  } catch (e) {
    return guard(e);
  }
}

/** Discard a draft (the token vanishes). */
export async function handleDiscardDraft(req: BoltRequest, draftId: string): Promise<BoltResponse> {
  try {
    await requireUser(req);
    await drafts.discardDraft(draftId);
    return ok({ ok: true });
  } catch (e) {
    return guard(e);
  }
}

// ------------------------------------------------------------------ tags

/** The user's known journal tags (for the picker / autocomplete). */
export async function handleListTags(req: BoltRequest): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    const list = await tags.listTags(s.userId, "journal");
    return ok({ tags: list });
  } catch (e) {
    return guard(e);
  }
}
