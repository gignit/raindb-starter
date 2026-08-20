// lib/drafts.ts -- autosave-as-you-type WITHOUT droplet spam, via a write-behind
// DRAFT TOKEN. This is a creative use of RainDB that a naive design gets wrong.
//
// THE PROBLEM: if every keystroke wrote a journal droplet, one entry would leave
// hundreds of revisions. THE PATTERN: an in-progress draft is a TOKEN on
// ref-journal-draft, which declares lifecycle.autoCache + writeDelay -- so
// keystroke-frequency saves COALESCE in cache and flush to S3 at most once per
// window (proven in raindb-prime tests/live/tests/drafts). On PUBLISH we write
// the durable journal droplet and DELETE the draft token (token.delete) -- the
// draft vanishes, leaving exactly one clean entry + zero draft litter. An
// abandoned draft self-expires via the fixed TTL.
//
// ZERO-KNOWLEDGE NOTE: the client encrypts BEFORE autosaving, so an encrypted
// draft stores only ciphertext in the token -- the server never sees plaintext,
// even mid-edit.

import { db, token, ids } from "@raindb/bolt-sdk";
import { payload } from "./http.js";

const DRAFTS = "ref-journal-draft";

export interface Draft {
  draftId: string;
  userId: string;
  title?: string;
  body?: string;
  ciphertext?: string;
  encrypted?: boolean;
  tags?: string[];
}

/** Start a new draft (mints a draftId). */
export function newDraftId(): string {
  return ids.uuidv7();
}

/**
 * Autosave the draft. Merge-on-write into the write-behind token: called on a
 * debounce as the user types; the platform coalesces the writes. Cheap enough to
 * call every few seconds.
 */
export async function autosave(draft: Draft): Promise<void> {
  await db.writeToken({ formationId: DRAFTS, payload: payload(draft) });
}

/** Resume a draft (e.g. the user reopens the editor). null when none/expired. */
export async function readDraft(draftId: string): Promise<Draft | null> {
  const d = await db.readLatest({ formationId: DRAFTS, indexId: "by-id", scopeValue: draftId });
  return (d?.payload as Draft | undefined) ?? null;
}

/**
 * Discard a draft (explicit cancel, or after publishing). Deletes the token so
 * it vanishes immediately -- proven to remove the token object from storage in
 * the live contract. Idempotent: deleting an already-gone draft is fine.
 */
export async function discardDraft(draftId: string): Promise<void> {
  await token.delete(DRAFTS, draftId);
}
