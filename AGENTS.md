# AGENTS.md -- `fit` (the RainDB starter) operating manual

You are an AI agent building an application on RainDB using this starter.
Read this once. It gives you the mental model, the task-to-file map, the
deploy contract, and the gotchas that will otherwise cost you hours.

## The one rule that matters most

**Reusable logic belongs in the SDK, not the app.** `@raindb/bolt-sdk`
and `@raindb/agent` hold every RainDB construct (db, tokens, files, jwt,
crypto, cookies, SSE, the agent loop). Your app code should be about the
USE CASE. If you catch yourself hand-rolling something reusable (a
session helper, a freshness merge, a counter pattern), stop -- add it to
the SDK. That is how the SDK becomes "eventually perfect" and how the
next app starts from more.

## Mental model (the two axes)

RainDB has two ways to read the same data; using the right one is the
whole skill:

1. **The O(1) grab (interactive, any scale, never touches SQL).** Read a
   droplet by id; list a newest-first feed via a descIndex; keep
   real-time counts in tokens (`db.mutate`/`mutateAndRead` -- the "Redis
   but better" primitive). This is what `fit`'s "last set" prefill,
   community odometer, and streak use. Always fresh.
2. **The analytical plane (periscope SQL).** GROUP BY, window functions,
   percentiles over the same droplets, with zero ETL. Eventually
   consistent -- it trails live writes by one rollup cycle, so it is for
   charts/trends, never read-your-writes. Surface the freshness bookmark
   as an honest "updating..." badge (see `lib/analytics.ts`).

Never name the engine internals in user-facing text -- it is "periscope"
/ "auto-datalake", not the underlying tech.

## Structure + task-to-file map

Read `reference/ledger/` (the complete worked app). Build in `app/`.

| I want to...                          | Read / edit                                            |
| ------------------------------------- | ------------------------------------------------------ |
| Understand auth + revocable sessions  | `reference/ledger/server/lib/auth.ts`                  |
| See the O(1) grab + two-axis pattern  | `reference/ledger/server/lib/workout.ts`               |
| See analytical SQL + freshness badge  | `reference/ledger/server/lib/analytics.ts`             |
| See real-time counters (no Redis)     | `reference/ledger/server/lib/stats.ts`                 |
| See version history / restore         | `reference/ledger/server/lib/history.ts` + persistence |
| See client-side zero-knowledge crypto | `client/src/crypto.ts`                                 |
| See draft autosave (write-behind)     | `reference/ledger/server/lib/drafts.ts`                |
| See per-scope tag tokens              | `reference/ledger/server/lib/tags.ts`                  |
| See the SSE AI agent (two-plane)      | `reference/ledger/server/ai/chat.ts`                   |
| See the HTTP dispatcher               | `reference/ledger/server/index.ts`                     |
| See a formation (schema + indexes)    | `reference/ledger/formations/ref-*.json`               |
| Declare formation ops + secrets       | `config/capabilities.json`                             |
| Add/So change a route                 | `config/routes.json` + the dispatcher                  |
| Build my OWN app                      | `app/` -- then `bash scripts/remove-reference.sh`      |

## The deploy contract (learned the hard way)

- The platform **re-builds the bolt from `--source` with its own
  esbuild**. `--entry` is RELATIVE to `--source` and must be `index.ts`
  (NOT a prebuilt `dist/`). `--client-dist` is joined onto `--source`
  (so it is a relative hop). `scripts/deploy.sh` already does this.
- **Secrets gate:** the server verifies every secret named in
  `config/capabilities.json` (`raindb.secrets.names`) is staged on the
  tenant. A deploy without them fails (often as an opaque 500). Put the
  values in a gitignored `.<bolt-name>-secrets.json` (flat
  `{"NAME":"value"}`); `deploy.sh` passes `--from-secrets` automatically.
- Engine is **goja** (`config/deployment.json`).

## Gotchas that will bite you (all fixed in the reference)

- **Index prefixes: natural-string path segments are hash-encoded** in
  storage (`"root"` -> `cm9vdA~b64`, a display name -> `...~b64`). A raw
  prefix like `${userId}/root/` will NEVER match. Prefix only on
  raw/UUID segments; filter the natural-string dimension from payloads.
  See `workout.ts::listChildCategories` and `persistence.ts`.
- **Counters must exist before you mutate.** `db.mutate`/`mutateAndRead`
  are read-modify-write, not create-on-write -- seed the token first
  (see `stats.ts::ensureCounter`).
- **`ctx.db.writeToken` returns only the dropletId** (not the minted
  scopeValue), so mint an autoGen id yourself when you need it for a
  follow-up read (see `auth.ts::createSession`). (Platform gap; the SDK
  wrapper surfaces the envelope where the host provides it.)
- **`Time!` GraphQL scalars are Unix-ms NUMBERS**, not strings -- decode
  as number.
- **SQL is eventually consistent.** An empty aggregate right after a
  write usually means "not pooled yet", not "no data". Use the fresh
  index for read-your-writes; the SQL plane for history.

## Verify your work

- `npm run build` -- tsc + esbuild the bolt (must be green).
- `cd client && npm run build` -- tsc + vite the SPA.
- Deploy (`scripts/deploy.sh`) then drive the live app; runtime bugs
  (schema, index prefix, counter cold-miss) only surface against the
  real platform. `curl <bolt-url>/api/health` must return `{status:ok}`.
