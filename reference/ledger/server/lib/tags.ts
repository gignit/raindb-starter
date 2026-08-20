// lib/tags.ts -- a per-user, per-SCOPE tag ledger on ONE token formation.
//
// ONE SHAPE, MANY LEDGERS: ref-tags is a single token formation, but its scope
// key is COMPOSITE -- `<userId>:<scope>` -- so journal and workout each get their
// own independent tag list from the same formation and the same code. The
// natural path/id does the isolation; no second formation needed. This is the
// "a token as a per-scope managed set/enum" pattern.
//
// Tags matter most for ENCRYPTED journal entries: the entry body is ciphertext
// the server/AI can never read, but tags stay plaintext -- so tagging an
// encrypted entry is the ONLY way the AI can still help ("find my #gratitude
// entries"). The client is encouraged to tag encrypted entries for this reason.

import { db } from "@raindb/bolt-sdk";

const TAGS = "ref-tags";
export type TagScope = "journal" | "workout";

function scopeId(userId: string, scope: TagScope): string {
  return `${userId}:${scope}`;
}

/** The user's known tags for a scope (for autocomplete / the "+" picker). */
export async function listTags(userId: string, scope: TagScope): Promise<string[]> {
  const d = await db.readLatest({ formationId: TAGS, indexId: "by-id", scopeValue: scopeId(userId, scope) });
  const tags = (d?.payload as { tags?: string[] } | undefined)?.tags ?? [];
  return [...tags].sort();
}

/**
 * Record any new tags the user just used, so they appear in the picker next
 * time. Merge-on-write dedupe: read the current set, union the new ones, write
 * back. Cheap and idempotent.
 */
export async function rememberTags(userId: string, scope: TagScope, used: string[]): Promise<string[]> {
  const clean = used.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (clean.length === 0) return listTags(userId, scope);
  const existing = await listTags(userId, scope);
  const merged = Array.from(new Set([...existing, ...clean])).sort();
  await db.writeToken({
    formationId: TAGS,
    payload: { tagScopeId: scopeId(userId, scope), userId, scope, tags: merged },
  });
  return merged;
}
