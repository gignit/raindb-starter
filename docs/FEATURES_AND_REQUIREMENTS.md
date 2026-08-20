# FitLedger -- Features, Requirements & RainDB Primitive Map

The raindb-starter reference bolt. A launchable, white-labelable workout + journal
SaaS: clone it, run setup, deploy for yourself / family / a gym's members. Every
screen showcases a distinct RainDB pattern. One unified app, one shared
persistence/token/feed/AI layer.

Proprietary boundary: NEVER name the analytical engine in any tenant-facing surface;
describe by capability ("RainDB's auto-datalake / analytical SQL"). Family restraint:
hint the redis-replacement via token counters, never name Redis; the full log/stream/
redis stories belong to sibling examples (raindb-logjammer, raindb-kafka, raindb-redis).

## Legend
- **SDK status**: EXISTS (bolt-sdk/agent shipped) | ADDED (built this effort, on
  feat/files-graphql-fallback) | ADD (Phase-1 work) | CLIENT (browser-side, no SDK) |
  CONFIG (formation config only).

---

## Feature -> RainDB primitive -> SDK helper map

| # | Feature / Requirement | RainDB primitive | SDK / helper needed | SDK status |
|---|---|---|---|---|
| **AUTH -- the launch unlock** |
| A1 | Create user (email+password) | droplet formation `ff-users`; `by-email` pointer index; anchor writes on authed userId | `crypto.hashPassword`, `db.writeDroplet`, `ids.uuidv7` | EXISTS |
| A2 | Login -> session cookie | `crypto.verifyPassword`, `jwt.sign`, `cookies.build` | `crypto.verifyPassword`, `jwt.sign`, `cookies.build` | EXISTS |
| A3 | Auth every request | verify JWT from cookie; userId is the authorization anchor | `cookies.parse`, `jwt.verify` | EXISTS |
| A4 | White-label brand (name/logo/theme, invite-only) | one `ff-config` token | `db.writeToken`, `db.readLatest` | EXISTS |
| **REDIS+ TOKEN COUNTERS -- live stats, no Redis** |
| C1 | Community odometer (total workouts / sets / volume / entries) | counter token `ff-stats` (delta/total fold), `autoCache`+`writeDelay` | `db.mutateAndRead` | EXISTS |
| C2 | Active-this-week (windowed) | windowed INCR on login | `db.mutateAndRead` (JSONOpWindowIncrement) | EXISTS |
| C3 | Per-user streak (current/longest) | per-user counter token | `db.mutate` / `db.mutateAndRead` | EXISTS |
| C4 | AI-endpoint rate limit (protect gym LLM budget) | fleet windowed-INCR limiter token | `db.mutateAndRead` (JSONOpWindowIncrement) | EXISTS |
| **JOURNAL (morphed Ledger) -- taggable, optionally client-encrypted, autosaving** |
| J1 | Create / edit journal entry (immutable revisions) | droplet formation `ff-journal`; `by-id`, `by-author`+desc, `by-update`+desc | `db.writeDroplet`, `db.readLatest` | EXISTS |
| J2 | Version history + restore | droplet chain | `db.versionHistory`, `db.readDroplet`, `db.writeDroplet` | ADDED |
| J3 | Off-the-grid client-side encryption (zero-knowledge) | server stores `{encrypted:true, ciphertext:b64, tags[]}` only | Web Crypto (PBKDF2/Argon2 -> AES-GCM) | CLIENT |
| J3a | (i) explainer + irrecoverable warning + passphrase-in-memory + optional hint | -- | CLIENT | CLIENT |
| J3b | Encrypted content INVISIBLE to AI+SQL; tags stay plaintext (escape hatch) | plaintext `tags` field on the droplet; ciphertext body | (enforced by data shape) | CONFIG |
| J4 | Draft autosave (no upsert spam) | `ff-journal-draft` token, `writeDelay`+`autoCache`, `expirationMode:fixed` | `db.writeToken`/`db.mutate` (write); `db.readLatest` (resume); **draft DELETE on publish** | ADD (delete) |
| J5 | Publish draft -> immutable droplet + draft token vanishes | `db.writeDroplet` then delete/expire the draft token | **token delete** | ADD |
| **TAGS -- per-scope managed set, shared shape** |
| T1 | Per-scope tag ledger (journal vs workout share shape, natural-path isolation) | `ff-tags` token, scope `{userId}:{scope}` -> tokens/ff-tags/<user>/journal vs /workout | `db.mutate` (add tag, dedup), `db.readLatest` (list) | EXISTS |
| T2 | Tag UI: "+" list / autocomplete / expand-to-click | read tag token; add on new | (client over T1) | CLIENT |
| **WORKOUT -- the showcase** |
| W1 | Category tree (seeded, add/delete/reshape) | droplet formation `ff-workout-categories`, `by-parent` index; `metricSchema` presenter on payload | `db.writeDroplet`, `db.listKeys` (tree walk), `db.readLatest` | EXISTS |
| W2 | Log a set (canonical typed columns + free-form metrics JSON) | droplet `ff-workout-sets`; typed cols weightKg/reps/distanceM/... + `metrics` JSON; `by-category`(single ptr)+desc, `by-benchmark`+desc, `by-update`+desc | `db.writeBatch` (single, idempotency) or `db.writeDroplet` | EXISTS |
| W3 | "Last set" prefill (instant) | O(1) grab | `db.readLatest` (by-category) | EXISTS |
| W4 | In-progress session (resume, set N) | `ff-workout-session` token | `db.mutateAndRead`, `db.writeToken` | EXISTS |
| W5 | Benchmark flag (intent) + retroactive PR (truth) | `isBenchmark` field; window-fn SQL | `sql.query` | EXISTS |
| **TWO AXES -- charts + leaderboard** |
| X1 | Personal charts (PR / 1RM regression / percentiles) | analytical SQL over typed columns + JSON extraction | `sql.query` (withFreshness) | EXISTS |
| X2 | Gym leaderboard (GROUP BY userId) + owner DAU/WAU | analytical SQL | `sql.query` | EXISTS |
| X3 | Freshness badge ("updating ~Nm") | periscope status bookmark + stream-cron ETA | `sql.query` freshness bookmark; **client ETA-from-cron util + badge** | EXISTS + CLIENT |
| X4 | Fresh entity-row list merge (feed/list read-your-writes) | bookmark harvest of the tail (row-lists only, NOT aggregates) | **`sql.queryEntityRowsFresh`** (fail-loud) | ADD |
| **REAL-TIME** |
| R1 | Live gym feed ("Sarah hit a PR") + unread badge | wire-token SSE on chain-head + descIndex feed | `iam.mintActivitySubscription`, `db.listSince`, `startSSE` + **client `subscribeActivity`** | ADDED + CLIENT |
| R2 | Presence ("3 working out now") | short-TTL presence token per user | `db.writeToken` (expiry), `db.listKeys` | EXISTS |
| **REVISIONS / FILES** |
| F1 | Progress photos, time-travel slider (every version) | `revisions:true` float on `ff-photos`; versioned float path | `files.reserveUpload` (v1 + replace via expectedPriorDropletId), `files.reserveDownload` | ADDED |
| F2 | Optional form-check video (versioned) | same float pattern | `files.reserveUpload/reserveDownload` | ADDED |
| **AI -- 2-plane agent** |
| AI1 | Gratifying report on entry (sees only unencrypted + tags/frequency) | 2-plane: `session_fresh` (today, fresh index) + `history_sql` (pooled aggregate) | `runAgent` + `makeBoltNativeHost` + `startSSE` + 3 custom tools | EXISTS + ADD (tools) |
| AI2 | "Plan my next workout" | custom tool reads recent categories/rest | custom `RegisteredTool` | EXISTS (author tool) |
| AI3 | NL coach ("am I overtraining?") -> deload SQL | custom tool runs the deload window-fn SQL | custom `RegisteredTool` over `sql.query` | EXISTS (author tool) |
| **SERVER / STRUCTURE** |
| S1 | HTTP dispatcher + request/response helpers | bolt `onHttpRequest` (no framework) | hand-rolled `http.ts` + `index.ts` | CONFIG |
| S2 | SSE streaming lifecycle | streaming route | `startSSE` | ADDED |
| S3 | Low-frequency graphql route | `ctx.fetch` -> graphql | `boltGraphQL` | ADDED |
| S4 | `/api/health` real reserve round-trip (fail-loud) | graphql reserve + abandon | `files.reserveUpload` + assert | ADDED |

---

## SDK gap summary (drives Phase 1)

**Already shipped (EXISTS):** auth (`hashPassword`/`verifyPassword`/`jwt`/`cookies`),
tokens/counters (`db.mutate`/`mutateAndRead`/`writeToken`), reads (`readLatest`/
`readDroplet`/`listKeys`/`listSince`), `sql.query`(+freshness helpers), `runAgent`+
`makeBoltNativeHost`, `iam.mintWireToken`.

**Added this effort (ADDED, on `feat/files-graphql-fallback`, 129 tests):**
`files.reserveUpload`/`reserveDownload`, `db.versionHistory`, `startSSE`+`sseFrame`,
`iam.mintActivitySubscription`, `boltGraphQL`.

**Phase 1 -- to ADD (with tests/live proof):**
1. **`sql.queryEntityRowsFresh({sql, formationId, scopeKey})`** -- row-list-only
   freshness merge (harvest the tail after the snapshot cursor, project, merge
   newest-wins, dedupe by scope key). FAIL-LOUD on harvest error. NOT for aggregates.
2. **Draft-token delete-on-publish** -- resolve the delete path: either promote a
   `token.delete` (currently STUB) to a graphql-backed op, OR use `entity.expire` /
   a short `expirationMode:fixed` on the draft formation so publish just stops writing
   and the token self-expires. Decide + prove in tests/live.
3. **AI custom tools** (`session_fresh`, `history_sql`, `plan_next`, `nl_coach`) --
   authored in the app using `RegisteredTool` (agent SDK supports it; author, don't
   add to the SDK) -- but confirm the 2-plane composition in tests/live.
4. **Client-only helpers** (not SDK): `subscribeActivity` (EventSource), the
   freshness-badge + ETA-from-cron util, Web-Crypto encrypt/decrypt. Ship as starter
   client patterns.

**Also confirm in tests/live (proof, not new code):** the redis+ counter token
(mutateAndRead delta/total + windowed INCR), the draft writeDelay+autoCache coalescing
(N writes -> few S3 PUTs), the per-scope tag token isolation, `revisions:true` v1+v2
replace, and the two-plane freshness merge behavior.

---

## Phase plan
- **Phase 1 (now, with codex in tandem):** augment + PROVE the SDK primitives above in
  `~/src/raindb-prime/tests/live/` per its README methodology. Merge bolt-sdk
  feat -> main + pin. Nothing in the app is built until its primitives are green in
  tests/live.
- **Phase 2:** formations (all `ff-*`) + walking skeleton on vector-sandbox1.
- **Phase 3+:** build features top-to-bottom against proven primitives; deploy;
  chrome-devtools e2e; peer review.

## SDK primitives surfaced DURING the build (fill back into the SDK -- the objective)

The app must be about the USE CASE, not RainDB constructs. Anything reusable hand-rolled
while building the app is a signal it belongs in `@raindb/bolt-sdk` / `@raindb/agent`:

- **`createSessionAuth(config)` [bolt-sdk, TO ADD]** -- app-level email/password accounts with
  REVOCABLE sessions. raindb-app AND FitLedger both hand-roll this identical machinery
  (register/login/logout/requireUser: hashPassword -> user droplet; JWT-carries-sessionId +
  a session TOKEN with autoExtend for a sliding, revocable window; extractToken from
  Bearter-or-cookie; requireUser verifies JWT + reads/extends the session). The existing SDK
  `auth` binding is the TENANT-grant context (infra plane), NOT app users -- so this is a NEW
  capability. Design: a factory configured with { usersFormation, sessionFormation,
  jwtSecretName, cookieName, ttlSec } returning the typed register/login/logout/requireUser
  fns. Modeled on the proven raindb-app bolt/server/auth.ts pattern (platform_user +
  platform_session, recycle 30d + autoExtend). FitLedger's lib/auth.ts is the first consumer
  and refactors to just configure it once the SDK primitive lands + is unit-tested.
- **`iam.mintActivitySubscription` [bolt-sdk, DONE]** -- already added (real-time alerts grant).
- Continue adding as the build surfaces gaps (the SDK becomes eventually-perfect).
