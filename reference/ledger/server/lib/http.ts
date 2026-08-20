// lib/http.ts -- request/response helpers over the BoltResponse shape. A bolt
// handler returns { status, headers, body }; these keep route code to one-liners.
// Nothing RainDB-specific here -- copy or replace freely.

import type { BoltRequest, BoltResponse } from "@raindb/bolt-sdk";

export function ok(body: unknown, extraHeaders?: Record<string, string>): BoltResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  };
}

export function bad(msg: string, code = 400): BoltResponse {
  return { status: code, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: msg }) };
}

export function notFound(msg = "not found"): BoltResponse {
  return bad(msg, 404);
}

/**
 * Cast a typed domain object to the SDK's `Record<string, unknown>` payload
 * type. The SDK write bindings accept an open record; our domain interfaces are
 * closed (better for our code), so this is the single, intentional bridge at the
 * write boundary -- keeps the typed model AND satisfies the binding.
 */
export function payload<T extends object>(x: T): Record<string, unknown> {
  return x as unknown as Record<string, unknown>;
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
