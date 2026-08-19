// lib/graphql.ts -- the LOW-FREQUENCY route: ctx.fetch -> RainDB GraphQL.
//
// THE LESSON THIS FILE TEACHES: RainDB gives a bolt fast NATIVE bindings for
// hot-path ops (ctx.db.readLatest/writeDroplet/listSince -- see persistence.ts).
// A few INFREQUENT ops (file upload/download, exact version-history listing) are
// intentionally NOT native bindings -- they ride the GraphQL API over ctx.fetch.
// This is a deliberate design tradeoff: a per-request HTTP hop costs more than a
// native binding, but for low-frequency operations that cost is irrelevant and
// it keeps the native surface small. When you need an op the ctx.db binding
// doesn't have, this is the pattern: POST it to GraphQL over ctx.fetch.
//
// ctx.fetch is egress-allowlisted: the GraphQL host MUST be in
// config/capabilities.json network.egress[] / fetch.allowedHosts[], and the API
// key comes from a declared secret (never an env var).

import { fetch as ctxFetch, secrets } from "@raindb/bolt-sdk";

// Resolved once from secrets. The endpoint is the full .../graphql url; the key
// is a tenant-scoped grant. Both are staged by scripts/setup.sh and declared in
// capabilities.json.
async function gqlConfig(): Promise<{ endpoint: string; key: string; host: string }> {
  const endpoint = await secrets.get("RAINDB_GRAPHQL_ENDPOINT");
  const key = await secrets.get("RAINDB_GRAPHQL_KEY");
  if (!endpoint || !key) {
    throw new Error(
      "GraphQL route not configured: stage RAINDB_GRAPHQL_ENDPOINT + RAINDB_GRAPHQL_KEY " +
        "(scripts/setup.sh does this) and declare them in capabilities.json raindb.secrets.names.",
    );
  }
  const host = new URL(endpoint).host;
  return { endpoint, key, host };
}

/** POST a GraphQL query/mutation over ctx.fetch. Throws on transport or GQL errors. */
export async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const { endpoint, key } = await gqlConfig();
  const res = await ctxFetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let parsed: { data?: T; errors?: Array<{ message: string }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`GraphQL non-JSON response (status ${res.status}): ${text.slice(0, 300)}`);
  }
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`GraphQL error: ${parsed.errors.map((e) => e.message).join("; ")}`);
  }
  if (!parsed.data) throw new Error("GraphQL response had no data");
  return parsed.data;
}

// --------------------------------------------------------- file upload (reserve)

export interface UploadReservation {
  scopeValue: string;
  dropletId: string;
  uploadUrl: string;
  floatPath: string;
  expiresAt: string;
}

/**
 * Reserve a presigned direct-upload URL for a new (or replacement) file version.
 * The client PUTs bytes straight to uploadUrl (no proxy through the bolt). The
 * formation's `revisions:true` means the platform mints a new attachmentVersionId
 * and lands the bytes at ver/<versionId>/ -- every version stays downloadable.
 *
 * expectedPriorDropletId is the CAS guard for a REPLACEMENT (pass the current
 * entry's dropletId); omit for a first upload.
 */
export async function reserveUpload(input: {
  formationId: string;
  payload: Record<string, unknown>;
  filename: string;
  contentType: string;
  fileSize: number;
  author: string;
  expectedPriorDropletId?: string;
}): Promise<UploadReservation> {
  const data = await gql<{ reserveDirectUpload: UploadReservation }>(
    `mutation($in: ReserveDirectUploadInput!) {
       reserveDirectUpload(input: $in) {
         scopeValue dropletId uploadUrl floatPath expiresAt
       }
     }`,
    {
      in: {
        formationId: input.formationId,
        payload: input.payload,
        filename: input.filename,
        contentType: input.contentType,
        fileSize: input.fileSize,
        author: input.author,
        ...(input.expectedPriorDropletId
          ? { expectedPriorDropletId: input.expectedPriorDropletId }
          : {}),
      },
    },
  );
  return data.reserveDirectUpload;
}

// --------------------------------------------------------- version history

export interface RevisionMeta {
  dropletId: string;
  ts: number; // unix ms
  payload: Record<string, unknown>;
}

/**
 * The full revision history of one entity, newest-first: list every droplet
 * under the entity's path prefix. Each carries its dropletId, write time, and
 * the payload as it was AT that revision. This is the audit trail + the source
 * for time-travel + restore. A list op -- low frequency -- so it rides GraphQL.
 */
export async function versionHistory(
  formationId: string,
  entryId: string,
): Promise<RevisionMeta[]> {
  const data = await gql<{
    listDroplets: { droplets: Array<{ dropletId: string; ts: number; payload: Record<string, unknown> }> };
  }>(
    `query($in: ListDropletsInput!) {
       listDroplets(input: $in) { droplets { dropletId ts payload } }
     }`,
    { in: { formationId, prefix: `${entryId}/`, pageSize: 200 } },
  );
  return data.listDroplets.droplets
    .map((d) => ({ dropletId: d.dropletId, ts: d.ts, payload: d.payload }))
    .sort((a, b) => b.ts - a.ts); // newest first
}

// --------------------------------------------------------- versioned download

export interface FloatBytes {
  contentType: string;
  size: number;
  dataBase64: string;
}

/**
 * Download the floated attachment AS IT WAS at a specific revision (dropletId).
 * Because every version's bytes are retained (revisions:true), you can fetch
 * ANY past version, not just the current one -- the headline capability.
 */
export async function downloadFloatAt(
  formationId: string,
  dropletId: string,
): Promise<FloatBytes | null> {
  const data = await gql<{
    readFloat: { contentType: string; size: number; dataBase64: string } | null;
  }>(
    `query($in: ReadFloatInput!) {
       readFloat(input: $in) { contentType size dataBase64 }
     }`,
    { in: { formationId, dropletId } },
  );
  return data.readFloat ?? null;
}
