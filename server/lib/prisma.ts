// lib/prisma.ts -- the @raindb/prisma-adapter surface (SDK #3).
//
// This is the ONLY place the Prisma client is constructed. It wires a
// standard PrismaClient to RainDB through @raindb/prisma-adapter:
//
//   const adapter = new PrismaRainDB({ endpoint, apiKey, models, author });
//   const prisma  = new PrismaClient({ adapter });
//
// The adapter translates Prisma's compiled SQL into RainDB ops:
//   - findUnique / findFirst by id  -> resolution plane (direct key read)
//   - findMany / count / aggregate  -> Periscope SQL (columnar)
//   - create / update / delete      -> immutable droplet writes
//
// RUNTIME REQUIREMENT: Prisma 7 compiles queries with a WASM query
// compiler. This works ONLY on the Lightning POD runtime (full Node.js +
// native WebAssembly), never on goja. The generated client (prisma/
// generated/) inlines the WASM as base64; esbuild --platform=node bundles
// it into dist/main.js. See prisma/schema.prisma.
//
// Lazy singleton: the client (and its WASM compiler) is created on first
// use, inside a request, so ctx.secrets is available. Reused across
// requests within a warm pod.

import type { BoltContext } from "@raindb/bolt-sdk";
import { PrismaRainDB } from "@raindb/prisma-adapter";
import { PrismaClient } from "../../prisma/generated/client.js";
import { FORMATION_NOTES } from "./persistence.js";

// The generated PrismaClient type, narrowed to what we use. The generated
// client is JS (no ambient types at this import path until generate runs),
// so we describe the slice we call.
export interface StarterPrisma {
  note: {
    create(args: { data: Record<string, unknown> }): Promise<NoteRow>;
    findUnique(args: { where: { noteId: string } }): Promise<NoteRow | null>;
    findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, "asc" | "desc">;
      take?: number;
    }): Promise<NoteRow[]>;
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
  };
  $disconnect(): Promise<void>;
}

export interface NoteRow {
  noteId: string;
  authorName: string | null;
  title: string | null;
  body: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

let _prisma: StarterPrisma | null = null;

/**
 * Get the lazily-constructed PrismaClient. First call instantiates the
 * RainDB adapter (with the tenant's GraphQL endpoint + key) and the Prisma
 * WASM query compiler. Subsequent calls reuse it.
 */
export async function getPrisma(ctx: BoltContext): Promise<StarterPrisma> {
  if (_prisma) return _prisma;

  const endpoint = await ctx.secrets.get("RAINDB_GRAPHQL_ENDPOINT");
  const apiKey = await ctx.secrets.get("RAINDB_GRAPHQL_KEY");

  const adapter = new PrismaRainDB({
    endpoint,
    apiKey,
    // 'merge' gives read-your-writes on list reads: when Periscope's
    // columnar snapshot lags a just-written droplet, the adapter merges the
    // newer droplets in. Exactly what a demo needs (write a note, list it,
    // see it immediately) without waiting for a pool cycle.
    freshness: "merge",
    // The generator emits this from schema.prisma; supplied by hand here so
    // the adapter resolves the hyphenated formation name + scope key.
    models: {
      formations: [FORMATION_NOTES],
      scopeKeys: { [FORMATION_NOTES]: "noteId" },
    },
    author: "raindb-starter-prisma",
  });

  // PrismaClient({ adapter }) -- the driver-adapter path. No DATABASE_URL.
  _prisma = new PrismaClient({ adapter }) as unknown as StarterPrisma;
  return _prisma;
}
