// lib/http.ts -- request/response helpers over the BoltResponse shape.
//
// A bolt handler returns { status, headers, body }. These helpers keep the
// route code one-liners. Nothing RainDB-specific here -- copy or replace
// freely.

import type { BoltRequest, BoltResponse } from "@raindb/bolt-sdk";

export function ok(body: unknown, extraHeaders?: Record<string, string>): BoltResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  };
}

export function bad(msg: string, code = 400): BoltResponse {
  return {
    status: code,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: msg }),
  };
}

export function notFound(msg = "not found"): BoltResponse {
  return bad(msg, 404);
}

/** Parse the request JSON body. Returns {} for empty, null on bad JSON. */
export function readJsonBody(req: BoltRequest): Record<string, unknown> | null {
  if (req.json && typeof req.json === "object") return req.json as Record<string, unknown>;
  if (!req.body) return {};
  try {
    return JSON.parse(req.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}
