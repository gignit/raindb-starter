// routes/prisma-notes.ts -- the Prisma (SDK #3) surface over the SAME
// starter-notes data the raw db.* routes use.
//
// These endpoints exist to CERTIFY that standard Prisma runs on the pod:
//   POST /api/prisma/notes      -> prisma.note.create   (droplet write)
//   GET  /api/prisma/notes/:id  -> prisma.note.findUnique (resolution plane)
//   GET  /api/prisma/notes      -> prisma.note.findMany + count (Periscope SQL)
//
// Each one drives Prisma's WASM query compiler. If these return data on the
// pod, SDK #3 is certified (and we've proven the thing goja cannot do).
//
// Note the "two surfaces, one model": a note created here via Prisma is
// readable by GET /api/notes/:id (raw db.*), and vice-versa -- it's the same
// `starter-notes` formation. That's the headline demo.

import type { BoltContext, BoltRequest, BoltResponse } from "@raindb/bolt-sdk";
import { ok, bad, notFound, readJsonBody } from "../lib/http.js";
import { getPrisma } from "../lib/prisma.js";

/** POST /api/prisma/notes {author,title,body} -- create via Prisma. */
export async function handlePrismaCreateNote(
  ctx: BoltContext,
  req: BoltRequest,
): Promise<BoltResponse> {
  const body = readJsonBody(req);
  if (!body) return bad("invalid JSON body");
  const authorName = typeof body.author === "string" ? body.author.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.body === "string" ? body.body : "";
  if (!authorName || !title) return bad("author and title are required");

  const prisma = await getPrisma(ctx);
  const now = new Date().toISOString();
  // noteId omitted -> Prisma mints a UUIDv7 via @default(uuid(7)).
  const note = await prisma.note.create({
    data: { authorName, title, body: text, createdAt: now, updatedAt: null },
  });
  return ok({ note, via: "prisma.note.create -> droplet write" });
}

/** GET /api/prisma/notes/:id -- point read via Prisma (resolution plane). */
export async function handlePrismaGetNote(
  ctx: BoltContext,
  req: BoltRequest,
): Promise<BoltResponse> {
  const noteId = req.path.slice("/api/prisma/notes/".length);
  if (!noteId) return bad("noteId required");
  const prisma = await getPrisma(ctx);
  const note = await prisma.note.findUnique({ where: { noteId } });
  if (!note) return notFound("note " + noteId + " not found (via prisma)");
  return ok({ note, via: "prisma.note.findUnique -> resolution plane" });
}

/**
 * GET /api/prisma/notes[?author=x] -- list + count via Prisma.
 * findMany / count compile to SQL and route to Periscope (columnar). This
 * is the analytical surface: same data the raw index-walk lists, but through
 * standard Prisma with a WHERE clause and an aggregate.
 */
export async function handlePrismaListNotes(
  ctx: BoltContext,
  req: BoltRequest,
): Promise<BoltResponse> {
  const raw = req.query?.["author"];
  const authorName = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const where = authorName ? { authorName } : undefined;

  const prisma = await getPrisma(ctx);
  const [notes, total] = await Promise.all([
    prisma.note.findMany({
      ...(where ? { where } : {}),
      orderBy: { noteId: "desc" },
      take: 50,
    }),
    prisma.note.count(where ? { where } : undefined),
  ]);
  return ok({
    notes,
    total,
    via: "prisma.note.findMany + count -> Periscope SQL",
  });
}
