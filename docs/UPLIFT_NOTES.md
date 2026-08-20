# Starter uplift -- working notes (2026-08)

Ephemeral. Delete when the uplift lands.

## Baseline assessment (confirmed against the current platform)

The starter is ~14 months stale and **cannot be published today**:

- Formation config is REJECTED by the current validator:
  - every path template carries the forbidden `tenants/{{.tenantId}}/` prefix
    (templates must now be tenant-RELATIVE).
  - index named `by-id-latest` -- the `-latest` spelling was DROPPED; the
    latest-pointer index must be named `by-id` (name must equal its path
    segment).
- Doesn't use the platform's newer capabilities:
  - `revisions: true` per-float versioning (the app hand-rolls "version
    history" prose but never uses the feature).
- Prisma-adapter is a `file:../raindb-prisma` local dep + gated on the
  admin-provisioned `nodejs-20` pod engine -- the most fragile part of a
  "gold standard" that is supposed to clone-and-run.

The CODE QUALITY is genuinely high (well-commented, one-data-layer
discipline, a strong AGENTS.md). The problem is drift + concept focus, not
craftsmanship.

## My position going into the brainstorm

**RainDB's strongest, most UNIQUE "aha" for an agent (ranked):**
1. Immutable droplets -> **free version history / audit / undo**, and the NEW
   `revisions: true` makes it one flag. Nothing else gives you this for free.
2. **UUIDv7-as-key = chronology-as-index**: newest-first feeds (descIndex) and
   "give me everything since cursor X" (listSince) are O(pageSize) at ANY
   scale, no separate search infra.
3. **Periscope SQL over the SAME data** you just wrote via db.* -- one data
   model, analytics for free, no ETL.
4. **Per-tenant OpenAI-compatible /v1 + agent tools over your own data** -- an
   AI assistant grounded in the app's live droplets, no third-party AI acct.

**The current "notes + one AI tool + Prisma parlor trick" undersells all
four.** CRUD notes shows none of the version-history magic; one `list_notes`
tool is thin; Prisma is a "look, an ORM works" trick that adds the most
fragility (pod engine) for the least teaching value in a STARTER.

**Prisma recommendation:** CUT it from the default path (or make it a clearly
optional `advanced/` sample). A gold-standard starter must clone-and-run on a
normal tenant; gating the whole thing on an admin-provisioned pod engine
violates that. The 3-SDK story is nice but not worth the reliability cost as
the DEFAULT.

**Concept direction I favor:** keep it small + universal but make every screen
show a unique primitive. A "notes/journal" is fine as the domain IF each
action teaches: create = immutable droplet; edit = new revision + the version
history is visible & restorable (revisions:true); a live "activity feed"
(descIndex newest-first + listSince tail via SSE); an "ask your data" AI panel
(agent tool over the same formation); an analytics strip (periscope SQL count
by author/tag). Same ~one formation, but the UI makes the four differentiators
tangible. This keeps the "replace the domain with yours" mechanical-swap story
while making the demo itself a teaching artifact.

## Open decisions (reconcile with codex + claude)
- Final concept (modernize-notes-as-teaching vs a sharper domain).
- Prisma: cut / optional / keep.
- Repo layout for demo-as-reference + build-real-elsewhere + delete-before-prod.
- Which engine: default to `goja` (clone-and-run anywhere) and treat pod as
  the advanced/optional path.

## LOCKED PLAN (me + codex + claude consensus, coder-verified)

### Concept: "Ledger" -- a versioned entity workspace with a brain (goja-only)
One formation, but every screen shows a UNIQUE raindb primitive that a
Postgres+Prisma+OpenAI stack cannot do:
- **Create** = immutable droplet. **Edit** = a NEW revision (writeDroplet;
  by-id newest-wins). A visible **version-history timeline** (readDroplet per
  revision) with time-travel + one-click **restore** (restore = write the old
  payload as a new revision). Version history / audit / undo with ZERO schema.
- **Live activity feed**: by-update + descIndex newest-first page + listSince
  cursor tail, woken over SSE via mintWireToken. Real-time, no broker.
- **Ask-your-data AI panel**: runAgent + tools that ARE the persistence
  functions (list, read, version_history, compare) -> the model answers
  "what changed and when?" from the revision chain. Per-tenant /v1, no 3rd-party key.
- **Analytics strip**: periscope SQL over the SAME droplets (count by
  author/status). OLTP data IS the warehouse, no ETL.

### Prisma: CUT from default. goja-only clone-and-run. Prisma -> optional
`reference/extensions/prisma-pod/` (own manifest/deploy/README), NOT in root build.

### SDK GAP (coder-verified -- surfaced to operator; ties to raindb-prisma uplift)
- `@raindb/bolt-sdk` db binding has NO `updateEntity` (only writeDroplet
  {formationId, payload}). So the canonical UpdateEntity path (what
  revisions:true needs for regenerateIfChanged) is NOT invokable from a bolt.
- `reserveUpload`/`reserveDownload` are STUBS (throw BindingNotInstalled).
- => FLOAT uploads + revisions:true float-versioning are NOT buildable from a
  bolt today. So the demo's version history comes from the ENTITY DROPLET CHAIN
  (fully live), NOT floats. Float/CDU + a versioned-file demo is a FOLLOW-UP
  gated on landing db.updateEntity + the files binding in bolt-sdk (and likely
  the raindb-prisma uplift touches the same update path).

### Repo layout (mechanically enforced demo-as-reference)
- `reference/ledger/` -- the complete demo (server+client+formations, `ref-*`
  formation ids). Read-only by convention. DEPLOYED as its own bolt = a live
  curl-able oracle.
- `app/` -- the build target: a minimal green-on-setup skeleton (dispatcher,
  persistence.ts with one example entity, empty routes). Agent edits ONLY here.
- `scripts/` -- shared setup/deploy (dir-parameterized) + `remove-reference.sh`
  (deletes reference/ + its bolt + ref-* formations; fails if root still
  references them).
- AGENTS.md -- build in app/, reference/ is the read-only oracle, run
  remove-reference.sh before prod.

### Unconditional staleness fixes
by-id (not by-id-latest); tenant-RELATIVE templates; keep gotcha #10
(reserved template vars: author/dropletId/yyyy...); update all AGENTS recipes.

## SDK-GAP ADJUDICATION (git intent + coder shape, tests/live discipline)

Investigated the two "gaps" codex flagged, per lead-engineer duty (fix what's
broken, don't design around it). Verdict from git history + coder against LIVE code:

1. **db.updateEntity binding -- INTENTIONALLY ABSENT, not an oversight.**
   - coder: host SDKDatabase (pkg/lightning/runtime/engine.go:642) exposes
     ReadLatest/ReadDroplet/WriteDroplet/ListDroplets/ListKeys/ListSince/Tag/
     Untag/Expire/WriteBatch/Mutate/MutateAndRead/WriteToken. NO UpdateEntity.
   - git: the whole surface was built from a gap inventory (each method cites
     its audit section G/I/L/M...). `updateEntity` is in NONE of it, and appears
     nowhere in git history. On RainDB, "update" == write a new revision;
     updateEntity (GraphQL merge-patch) is a client convenience OVER writeDroplet,
     not a storage op. A bolt does read+merge+write with readLatest+writeDroplet
     (both LIVE). The rare atomic merge-patch is the acceptable ctx.fetch+graphql
     edge case. => NO parity work. writeDroplet IS the entity-update primitive.

2. **files.{reserveUpload,reserveDownload,...} -- REAL tracked gap (audit O /
   Gap 10), stubbed since v0.1.0 (762ae99), never promoted.** BUT: coder shows
   ctx.objects (SDKObjects, LIVE: Get/Put/Exists/Delete bytes to a declared
   bucket) covers file bytes from a bolt TODAY. The files binding (presigned
   direct-to-S3) is a convenience, not a blocker, and filling it is a
   cross-cutting host feature (new SDKFiles interface + goja binding + pod op +
   boltDB impl + wrapper) -- OUT OF SCOPE for the starter uplift; tracked as a
   future gap.

**Bottom line: the Ledger starter (version history + feed + AI + SQL) is 100%
buildable on LIVE bindings today. No SDK parity work required to ship it.** The
"missing updateEntity" is by design; writeDroplet is correct.

## CORRECTION (operator + code, not the stale audit doc)

files.* (reserveUpload/reserveDownload/pushPublic/readMeta) are INTENTIONALLY
stubbed as a LOW-FREQUENCY surface (files.ts:1-2,78-89 + operator confirmation),
deliberately routed over ctx.fetch + GraphQL (reserveDirectUpload / the float
upload flow), NOT an unfilled oversight. Same intentional pattern as updateEntity:
low-frequency / infrequent ops accept the graphql-over-ctx.fetch efficiency cost
rather than a dedicated native fast-path binding.

IMPLICATION: a file-upload + revisions:true versioned-file demo IS buildable now,
via ctx.fetch -> graphql (reserveDirectUpload + updateEntity). And teaching that
pattern -- "high-frequency ops use the native ctx.db bindings; low-frequency ops
(file upload, atomic merge-patch) go over ctx.fetch+graphql" -- is itself a
valuable lesson for agents. So the concept is NOT constrained to entity-chain
history; a versioned-FILE story (claude's "Drops") is on the table again, using
the intended graphql route. Decide in the concept lock with codex+claude.

## CONCEPT LOCKED: B -- "Ledger" with a versioned-file headline (unanimous me+codex+claude)

Core (always-native, bulletproof): entity version history from the droplet chain
(writeDroplet revisions + readDroplet time-travel + restore), live activity feed
(listSince + by-update descIndex + mintWireToken SSE), AI tools over the chain,
periscope SQL analytics. Every screen = a unique raindb primitive.

Headline (the screenshot no CRUD stack can fake): a versioned FILE attachment via
revisions:true -- upload over the INTENDED low-frequency route (ctx.fetch ->
GraphQL reserveDirectUpload), each version's bytes retained at ver/<versionId>/,
per-version download. Showcases revisions:true (the flagship feature shipped this
session) AND teaches the native-hot-path vs graphql-low-frequency split.

Prisma: CUT (goja-only). reference/ledger (deployed live oracle) + app/ skeleton +
remove-reference.sh.

### HARD GATE before building the app around files (codex de-risk):
Prove the full reserve -> PUT -> completion -> per-revision download flow works on
a GOJA bolt against vector-sandbox1 FIRST. If it doesn't round-trip cleanly,
degrade the headline to entity-chain-only (A) and keep files as an optional extension.

### Fresh-clone de-risk (claude):
- setup.sh stages RAINDB_GRAPHQL_ENDPOINT + RAINDB_GRAPHQL_KEY UNCONDITIONALLY.
- capabilities.json network allowlist MUST include the graphql host.
- /api/health does a REAL reserve round-trip (reserve + abandon) so a broken
  graphql path fails LOUDLY at setup with a named error, never at first upload.

## HARD GATE: PASSED (proven live against vector-sandbox1)

The full versioned-file flow round-trips on the live platform:
- reserveDirectUpload (graphql) -> presigned S3 url + float path carrying the
  platform-minted ver/<fileDataVersionId>/ segment (revisions:true working).
- PUT bytes to the presigned url (x-amz-content-sha256: UNSIGNED-PAYLOAD) -> 200.
- Completion is IMMEDIATE: readLatest(by-id) resolves the entity on the first
  poll, fileDataVersionId minted, floatMeta present with the versioned float path.
Confirmed the graphql contract with coder (reserveDirectUpload input has
expectedPriorDropletId = the CAS field for versioned updates; readLatest takes
ReadLatestInput{formationId,indexId,scopeValue}).

The bolt path is: ctx.fetch (LIVE binding, egress-allowlisted) -> POST graphql
with RAINDB_GRAPHQL_KEY. Standard. => Concept B is GO. Building the app now.

## SDK-PROVIDED vs HAND-ROLLED (operator asked -- coder-verified)

The bolt-sdk handles MORE than the old starter used. Corrected split:
- AI: use makeBoltNativeHost(ctx) from @raindb/bolt-sdk/agent-bridge -> runAgent
  ({host, tools, messages}). The host AUTO-routes substrate graphql tool-calls to
  native bindings + does chatCompletion via ctx.fetch (LLM_API_BASE/LLM_API_KEY
  secrets). Do NOT hand-roll the LLM POST / model plumbing like the old ai/chat.ts.
- Hot-path data: native ctx.db.* (persistence.ts). SDK-provided.
- SSE: ctx.response.{setHeader,beginStream,write}. SDK-provided.
- SQL: ctx.sql.query (+ freshness helpers isBehind/needsHarvest). SDK-provided.
- iam.mintWireToken (SSE wakeup): SDK-provided.
NOT provided (legitimately hand-rolled):
- HTTP router/dispatch: bolt entry is a single onHttpRequest; write your own path
  routing (http.ts + index.ts). No app framework in the SDK by design.
- The 3 low-frequency graphql ops (reserveDirectUpload, readFloat, listDroplets):
  intentionally non-native -> graphql.ts posts them over ctx.fetch. This is the
  documented pattern. resp.body is the string body (verified vs host.ts:510).

STARTER LESSON (sharper than the old one): 'AI = makeBoltNativeHost; hot paths =
native ctx.db.*; the 3 low-frequency ops = graphql over ctx.fetch.'

## FULL SDK UNDERSTANDING (exhaustive README + snapshot read -- corrects earlier)

- bolt-sdk supports BOTH pod + goja (deployment.json engine). goja is default +
  right for the starter. Same LIVE/STUB tiers across engines.
- files.* is a DOCUMENTED pending stub (README STUB table, audit O/Gap 10) -- the
  package model is "wrapper ships, substrate/impl filled in as needed." Filling it
  is exactly this exercise's point (operator: make it eventually perfect).
- The graphql-over-fetch pattern ALREADY exists: @raindb/agent src/client/graphql.ts
  executeGraphQL is the canonical host-routed graphql client, and the agent tool
  catalog (droplet.ts, entity.ts entity_version_history, droplet_push_public, etc.)
  implements every non-native op over graphql. My starter graphql.ts DUPLICATES this.
- AI: use runAgent + makeBoltNativeHost (agent README quick-start). creds =
  {apiKey, endpoint} from secrets; host = makeBoltNativeHost(ctx); tools = a small
  custom set. Do NOT hand-roll SSE/model plumbing.

### AUGMENTATION (in-spirit, fills the documented gap):
Implement bolt-sdk ctx.files.reserveUpload + a versioned download for REAL over
ctx.fetch->graphql (reserveDirectUpload / readFloat), resolving endpoint+key from
the bolt's declared secrets (same convention chatCompletionViaCtxFetch uses). Then
the STARTER calls files.reserveUpload instead of a hand-rolled graphql.ts. Version
history for the starter uses the LIVE native db.listDroplets (already in the SDK) --
no app graphql needed there. Net: the app shrinks, the SDK gains the helper every
bolt author needs. Live-test the augmentation before shipping.

## SDK GAPS TO FILL (so app code = use case, not raindb constructs) -- coder-verified

The remaining tasks each force the app to hand-roll a raindb construct. Fill these
in the SDKs (the exercise's core point). Each is coder-verified absent today:

1. bolt-sdk db.versionHistory({formationId, scopeValue}) -> Revision[] newest-first.
   GAP: RainDB's headline (every write = a revision -> free history/audit/undo) has
   NO helper; every app hand-rolls listDroplets(prefix)+sort (persistence.ts does it
   twice). Built on the LIVE db.listDroplets. App then just renders a timeline.

2. bolt-sdk SSE helper: startSSE(ctx) -> { send(event,data), close() } owning the
   streaming-vs-buffered branch + headers + sseFrame. GAP: every streaming bolt
   hand-copies ~40 lines of identical SSE boilerplate (README + old starter + fdn-app).

3. agent-ts runAgentSSE({ctx:boltCtx, systemPrompt, userPrompt, tools, secrets?})
   -> resolves creds from the conventional secrets, builds makeBoltNativeHost, wires
   onEvent straight to the bolt SSE stream, returns AgentResult. GAP: every AI bolt
   hand-builds the {creds,host,role,userId} block + the onEvent->sseFrame->write
   bridge (~30 lines, both READMEs show it copy-pasted).

RESULT: Ledger ai/chat.ts shrinks ~130 -> ~15 lines (prompt + 3 tools); version
history = 1 call; feed = sse.send. App code becomes about a LEDGER, not RainDB.
Build these WITH live/unit tests before the app consumes them; commit+push each.

## SDK GAP #4 (operator-requested): client alerts / unread on new activity

Operator: with SSE there should be an alerts mechanism -- new message -> client
alert to open the window / an unread-count badge. AGREED + coder-verified real:
fdn-app proves it (bolt/server/routes/wire-token.ts): every write updates the
entity chain-head key (indexes/<f>/<index>.desc/<scope>/latest.json); invalidating
it triggers an SSE WAKEUP to any subscribed browser. mintWireSubscribeToken (graphql,
coder-verified: input{resources:[String!]!, ttlSec, subjectOverride} -> {token,
endpoint, keys, expiresInSec}) is the gated mint. But fdn HAND-DERIVES the chain-head
path (chainHeadKeyFor) and hand-rolls the EventSource -- the ergonomics aren't packaged.

FILL (thin, bounded):
- bolt-sdk iam.mintActivitySubscription({formationId, indexName, scopeValues, ttlSec})
  -> derives the .desc/<scope>/latest.json chain-head keys + calls
  mintWireSubscribeToken. App says "alert me on new activity for these entries"
  without knowing the key layout (the RainDB construct).
- client helper subscribeActivity({endpoint, token, keys, onActivity}) -> opens
  EventSource, fires onActivity(key) per wakeup. Ships as a documented starter
  client pattern (client isn't in the SDK npm pkg). App decides badge vs popup vs
  count -- the UI decision stays in the app.
The wakeup is a SIGNAL ("key X changed"), not a COUNT -- unread count is app state
the client derives. Ledger feed uses it: new entry -> alert + unread badge when
the feed isn't focused.

## WORKOUT PILLAR -- design review (my coder-grounded verdict, pre-peer)

Question A (catalog vs droplet for the category tree) -- I independently verified
with coder, and it FLIPS my doc-first instinct:
- CatalogConfig (pkg/formation/catalog.go): entries are an ARRAY FIELD inside ONE
  scoped droplet's payload (EntriesField). A catalog is one droplet holding the
  whole collection, addressed by refKey, with CAS-safe insert/delete/transfer/tree.
- SchemaMapper.MapColumns (pkg/duckdb/schema_mapper.go) flattens schema PROPERTIES
  to SQL columns per flattenDepth. An OBJECT flattens to metrics_weight/metrics_reps
  (chartable). An ARRAY maps to ONE opaque JSON/list column -- so a catalog's entries
  are NOT per-row SQL-queryable.
- VERDICT: categories should be a DROPLET formation (ref-workout-categories) with a
  by-parent descIndex, NOT a catalog -- because I want to JOIN categories to sets in
  periscope SQL for cross-category analytics (volume by category, PRs by exercise),
  which needs categories as ROWS. Catalog is right for an OPAQUE managed collection
  (a folder's file list); here categories are first-class analytical entities.
  The metricSchema still rides on each category droplet's payload (config-as-data).
- This is a case where the obvious doc primitive (catalog) is NOT the best fit --
  exactly what coder + peer review should catch. Await codex/claude to confirm/refute.

periscope = FULL DuckDB/Iceberg over S3 parquet (operator). So the workout SQL can
use window functions + CTEs + percentiles: rolling-max PR detection, Epley 1RM trend
(weight*(1+reps/30)), weekly volume=sum(weight*reps), pace/HR percentiles, PR streaks,
deload detection. The AI report runs these -- "REAL SQL" is the wow. flattenDepth:2 on
ref-workout-sets makes metrics.* chart columns.

## PROPRIETARY BOUNDARY + THE REAL THESIS (operator -- governs the WHOLE starter)

NEVER name the engines in ANY tenant-facing surface (README, AGENTS.md, client UI,
code comments the tenant reads, AI report text): NO "DuckDB", "Iceberg", "parquet",
"S3", "SQS", "Textract", "EC2". Describe periscope SQL by its CAPABILITIES using
RainDB's own vocabulary (verified against the tenant docs):
- "Periscope is RainDB's auto-datalake."
- "your operational data automatically becomes ONE queryable, infinitely-scalable
  analytical SQL table, materialized from your completed droplets -- no ETL, no
  separate warehouse."
- capabilities to claim: full analytical SQL -- joins, grouping, aggregation,
  window functions, CTEs, time-series, percentiles, broad scans, reporting.

THE THESIS the starter must convey (coder-verified in pkg/formation/tier_policy.go):
RainDB is an infinitely-scalable, multi-tenant SaaS platform where the SAME code +
data model powers a personal site OR a Twitter/Instagram-scale site with ZERO
refactor. Mechanism: droplets AUTO-CASCADE from the write path up a tier cascade
(stream ~5m -> river ~hourly -> lake) into the datalake; partitioning is declarative
(scopeHash prefixLength 2=256 partitions, 4=65536) so the same tierPolicy scales by
fan-out, not a rewrite. The platform even solves the PUT-vs-LIST consistency race
(ScopeReduction) so the author never sees it. "More than meets the eye -- not a toy."

STARTER PURPOSE (sharpened): ground an agent that RainDB is a serious, infinitely
scalable platform. The Ledger + Workouts show: write simple droplets, get history +
real-time + an auto-datalake + AI over your data FOR FREE, at any scale, no refactor.

The AI workout report + charts get their power described as "RainDB's analytical
engine runs full SQL over your entire history instantly" -- window functions for PR
detection, trend lines, percentiles -- WITHOUT ever naming how.

## CODEX REVIEW -- coder-validated corrections (peer review earned its keep)

Codex flagged 4 real bugs; I re-verified the pivotal one myself in coder:

1. [CRITICAL, CONFIRMED] flattenDepth does NOT flatten a FREE-FORM object.
   processProperties (pkg/duckdb/schema_mapper.go:247) recurses ONLY when
   prop.Properties != nil -- i.e. only SCHEMA-DECLARED nested properties flatten
   to columns. A free-form `metrics` object (additionalProperties, no declared
   properties) becomes ONE opaque JSON column (line 260), NOT metrics_weight.
   => My "free-form metrics + flatten = charts" story was WRONG.
   FIX (better design, coder-confirmed): declare the common numeric metrics as
   FIRST-CLASS nullable schema properties on ref-workout-sets -- weightKg, reps,
   distanceM, durationMs, avgHeartRateBpm, elevationM -- so they are REAL typed SQL
   columns (chartable + window-functionable). KEEP a free-form `metrics` JSON for
   user-defined EXTRAS (opaque to SQL, fine -- extras aren't charted). The
   metricSchema (on the category) maps UI inputs + user units onto these canonical
   fields. This preserves "define any data type" AND gives typed analytical SQL.

2. Native db.writeDroplet takes only {formationId, payload} -- NO idempotencyKey
   (sdk_impl.go:497). For per-set idempotency use db.writeBatch (single item, exposes
   per-item idempotency) OR mint setId UUIDv7 client-side as set:<setId> retry identity.
   (Candidate SDK gap: writeDroplet with opts. Adjudicate before building.)

3. Immediate AI report canNOT be SQL-only (SQL trails rollup). Merge the fresh
   by-update tail (freshness overlay, PATTERNS.md:141) OR inject the just-completed
   session's fresh droplets into the report context, else the report omits the
   workout just finished.

4. by-category must be a SINGLE pointer .../{{.categoryId}}/latest.json (readLatest
   takes exactly one scopeValue) so prefill works; its descIndex retains history
   independently. A path mixing category+set ids can't support the prefill call.

Codex's "killer SQL" list (full analytical engine, coder-confirmed SELECT/WITH +
multi-formation joins): computed PR ledger (MAX OVER/LAG -> lifetime/90d/comeback PR),
fitness-vs-fatigue (7d/28d RANGE acute:chronic load, monotony/strain), efficiency
frontier (quantile_cont/percent_rank -- pace at equal HR, 1RM at equal bodyweight),
plateau/milestone forecast (regr_slope/regr_r2 trend + projected date). The Benchmark
button = "important test effort"; SQL decides if it was objectively a PR. (Describe
all this by CAPABILITY -- never name the engine.)

CATALOG vs DROPLET: codex says catalog (semantically right: tree/transfer/CAS) +
snapshot metricSchema version onto each set. I found the entries-array is opaque to
SQL. RESOLUTION: categories don't NEED to be SQL-joined if sets carry denormalized
categoryId + categoryPath + canonical columns (which they now do). So EITHER works;
lean catalog for the tree ergonomics IF the catalog bolt binding is filled (it's a
stub -- route via ctx.fetch graphql, real op names: catalogScopeValue/entry/refValue).
Await claude, then decide catalog-vs-droplet with the canonical-columns fix locked.

## CLAUDE REVIEW + FINAL WORKOUT DATA MODEL (both peers converged; I adjudicated the split)

Both peers coder-confirmed the material corrections; they split on catalog-vs-droplet.
FINAL LOCKED DESIGN:

CATEGORIES = DROPLET formation ref-workout-categories (claude wins the split).
Decisive: the category tree is read on EVERY screen (tap->prefill) = HIGH frequency,
but the catalog bolt binding is a low-frequency STUB (catalog.ts:1-10) routed over
graphql -- wrong frequency class. Droplets give: native db.* hot-path reads,
tree = listKeys on by-parent (the O(pageSize) pattern the starter teaches), and
category edits inherit the Ledger's VERSIONING/undo pillar (rename Bench Press ->
it's a new revision). scopeKey categoryId, parentId field, indexes by-id + by-parent
(pointer). metricSchema rides on the category payload (presenter, see below). No
catalog primitive; no filling the catalog stub just to use it.

SETS = DROPLET formation ref-workout-sets with a CANONICAL METRIC VOCABULARY as
typed schema properties (the fix for the flattenDepth bug -- these become real SQL
columns): weightKg, reps, distanceM, durationS, avgHeartRateBpm, elevationM, score,
rpe (nullable superset). PLUS a free-form `metrics` JSON for user-defined EXTRAS
(opaque to SQL, fine). Each category's metricSchema is a PRESENTER/SELECTOR over the
canonical vocabulary (which fields, labels, units, chart hint, benchmarkable) -- NOT
a type creator. Adding a genuinely new measurement = one schema-version bump (rare,
explicit). Stamp metricsVersion (the category revision dropletId) + denormalized
categoryId/categoryName/categoryPath on every set. NEVER name a metric ts/author/
formationId/dropletId (schema_mapper silently drops envelope-shadowing props).
Indexes (ALL in v1 -- gotcha #8): by-id, by-category (SINGLE pointer
.../{{.categoryId}}/latest.json for prefill) + descIndex (history), by-benchmark +
descIndex, by-update + descIndex. flattenDepth not needed for metrics (they're
top-level typed columns now). tierPolicy for SQL. Validate Save Set server-side
against the category's selector (deterministic-or-fail).

SESSION = TOKEN formation ref-workout-session (lifecycle.autoCache:true). Holds the
RESUME state (current exercise, ordinal, timers, nav). mutateAndRead (not mutate --
drop-tolerant) for the authoritative ordinal, but mint setId UUIDv7 as the retry
identity (a lost mutateAndRead response leaves the ordinal ambiguous). Finish writes
a final session DROPLET (start/end, completed exercises, AI-report ref).

SAVE SET idempotency: db.writeDroplet has NO idempotencyKey; use db.writeBatch
(single item, per-item idempotency -- native, claude confirmed db.ts:140-164) OR
setId-as-identity. Prefer writeBatch(single) so it's native + idempotent.

AI REPORT = TWO-PLANE COMPOSITION (both peers' #1 risk). Custom tools, explicitly
labeled: session_fresh (reads TODAY from by-update/listSince -- the just-finished
workout) + history_sql (reads history from the analytical engine). One prompt:
"compare this session against history." This is the BEST two-plane teaching moment
in the app -- lean in. Never SQL-only (the just-finished workout isn't rolled up).

KILLER SQL (described by CAPABILITY, engine NEVER named): retroactive PR detection
(MAX OVER PARTITION BY categoryPath -- announces PRs the user never marked; benchmark
button = intent metadata, SQL = truth), 1RM regression with DATED prediction
(regr_slope per 8-week window -> "you hit 100kg on Oct 3"), deload/overtraining
(lag() weekly sum(weight*reps), >30% drop / 3-week climb), behavioral splits
(percentile_cont pace by day-of-week/time-of-day). "Full analytical SQL over your
entire history, instantly."

CANDIDATE SDK GAP: db.writeDroplet with opts (idempotency/author/CAS). writeBatch
covers it today; adjudicate whether a writeDroplet-with-opts is worth adding.

## IDEMPOTENCY -- coder-verified correction (operator recollection reconciled)

Operator recalled idempotency is formation-shaped. Reconciled against coder -- there
are TWO distinct "dedup" concepts, don't conflate:

1. WRITE-TIME idempotency (dedup a RETRIED write): a PER-CALL opts.IdempotencyKey
   (pkg/sdk/write.go:359). The SDK checks+claims an idempotency POINTER keyed by
   (tenant, formationId, key) via paths.IdempotencyPointerPath; repeat key = no-op
   returning the existing write. Works on ANY formation -- no per-formation opt-in.
   internal/ops/droplet.go:354 (IdempotencyKey) + token.go:23 both carry it.
2. READ/SQL dedup (the FORMATION-shaped one the operator is thinking of):
   views.defaultBehavior.dedup (tier_policy.go:709) = present the NEWEST revision per
   logical entity in periscope. A VIEW concern, not write idempotency. And the
   scopeKey defines entity identity. So the formation shape governs how revisions
   collapse at the READ/datalake layer + how the entity is identified -- NOT the
   write-retry pointer.

RESOLUTION for Save Set: the PLATFORM supports single-write idempotency
(write.go:359); the BOLT wrapper db.writeDroplet just drops the key ({formationId,
payload} only, sdk_impl.go:497). So it's a bolt-SDK EXPOSURE gap, not a platform
gap. Options: (a) use db.writeBatch(single item) which DOES expose per-item
idempotency (native today), or (b) FILL the gap: db.writeDroplet with opts
(idempotencyKey/author/expectedETag) -- the exercise's whole point is filling such
gaps. LEAN (b): add writeDroplet opts to the bolt-sdk (adjudicate the host binding
first -- sdk_impl.go WriteDroplet host signature), because every bolt author writing
a retryable entity hits this. Verify the goja host WriteDroplet can carry opts before
committing to (b); if the host is fixed-opts, (a) writeBatch is the answer + a noted
future host gap.

## writeDroplet-with-opts: coder-verified scope of the fix (DECISION POINT)

Traced the host WriteDroplet (coder):
- internal/lightning/sdk_impl.go:501 -- boltDB.WriteDroplet ALREADY builds a
  types.WriteOptions{Author:"bolt:"+boltID, TriggerFlows:true} but hardcodes it;
  the underlying client.WriteDroplet fully supports IdempotencyKey/ExpectedETag.
- podchannel/dispatch.go:176 + goja bindings.go read only {formationId, payload}.
So filling "writeDroplet with opts" = a 4-LAYER host+SDK feature:
  (1) runtime SDKDatabase.WriteDroplet signature (+opts)
  (2) sdk_impl.go boltDB.WriteDroplet: merge caller opts into the WriteOptions
  (3) BOTH dispatch paths (goja bindings.go + pod dispatch.go) read opts from args
  (4) bolt-sdk db.ts wrapper: WriteDropletInput + opts
  + live tests + a raindb-prime deploy. Larger than the pure-TS SDK augmentations.

DECISION: For the STARTER, use db.writeBatch(single item) -- it exposes per-item
idempotency, is native TODAY, needs no host change. Record writeDroplet-with-opts as
a tracked host+SDK gap. If the operator wants it filled as part of this effort (it IS
a real ergonomic gap every retryable-write bolt hits), do it as a separate 4-layer
change with live tests + deploy AFTER the starter is working -- don't block the
starter on a host deploy. (Surfaced to operator.)

## THE ENGINE, CORRECTLY UNDERSTOOD (operator -- corrects the peers AND me)

The reframe: RainDB transport (droplet in/out) is DELIBERATELY SIMPLE and limited on
retrieval -- that is JUST the transport. The TRUE power is the SQL engine, which is
the FULL analytical engine (window functions, CTEs, regression, percentiles, JSON
functions, list/struct). Coder-verified:

1. THE FORMATION SCHEMA IS THE SQL TABLE SCHEMA. mapJSONSchemaToDuckDB
   (schema_mapper.go:297) translates JSON Schema types -> engine types directly:
   integer->BIGINT, number->DOUBLE, date-time->TIMESTAMP, boolean->BOOLEAN. Anything
   typeable in the schema lands as a native typed column. "Anything you can put in
   the engine you can put in a formation" -- literally, via the schema.
2. array/object -> the engine's JSON type (line 313). This is NOT opaque: the engine
   has the full JSON function suite (->, ->>, json_extract) + inline CAST. So a
   FREE-FORM `metrics` JSON object IS fully queryable/chartable:
   CAST(metrics->>'weight' AS DOUBLE) inside any window function. 
3. The SQL guard (sqlguard.go:39) is a STATEMENT-TYPE whitelist ONLY (SELECT/WITH/
   VALUES/TABLE) -- it does NOT restrict functions/operators. The ENTIRE engine
   function surface is available (regr_slope, percentile_cont, JSON ops, everything).
4. FRESHNESS MERGE is the pattern (not a limitation): the fresh index/cursor loads
   ONLY the recent not-yet-pooled entries and merges them into the dataset with the
   pooled parquet -> one COMPLETE current SQL view. Full engine power AND read-your-
   writes. The "two planes" = one merged surface; the cursor says what fresh tail to
   overlay.

CORRECTION to the peers (and my earlier note): "free-form metrics can't reach SQL,
declare canonical columns" is WRONG about capability. Free-form metrics IS queryable
(JSON column + engine JSON functions). So:
- Declaring canonical typed columns (weightKg, reps, ...) is now a pure ERGONOMICS
  choice (terser queries, self-documenting, native typed columns), NOT a capability
  requirement. KEEP it for the common metrics because it reads cleanly and is the
  better teaching example -- but the free-form `metrics` JSON is ALSO fully
  chartable, and the app can demonstrate BOTH: typed columns for the staples, JSON
  extraction for user-defined exercises with arbitrary metrics. THAT is the real
  "define any data type and still get full SQL" showcase.
- The AI report's history_sql tool can query EITHER typed columns OR JSON-extracted
  user metrics with the full engine -- window functions over CAST(metrics->>'x').

This is the starter's deepest lesson: a formation is a typed table in an infinitely
scalable analytical engine; the transport is simple, the analytics are limitless;
freshness-merge keeps it current. Describe by CAPABILITY, never name the engine.

## THE TWO POWER AXES (operator -- THE definitive scale model; corrects conflation)

There are TWO INDEPENDENT superpowers. The social-media/Instagram/X scale story runs
on AXIS 1, NOT on SQL. Do not conflate them.

AXIS 1 -- the O(1) "GRAB" (the infinite-scale, never-refactor engine):
Most social ops are DIRECT GRABS, not searches:
- post / profile / image / comment = a droplet with an ID (images via float/public
  float). Grab by ID = O(1) pointer read, at ANY scale.
- a feed / thread / gallery = a CHAIN of contentIds fetched IN PARALLEL by ID (each
  O(1)). 
- infinite scroll = descIndex newest->oldest (or ascending from an ID) = O(pageSize)
  at any scale via the reverse-index chain + opaque cursors.
- likes / followers / counts = TOKENS doing real-time stats (mutate / mutateAndRead).
  Coder-verified (pkg/sdk/token.go:1328): mutateAndRead is the FLEET-WIDE rate-limiter
  primitive -- increments a counter and returns the FLEET-TRUE post-increment value in
  ONE call (owner host authoritative; non-owners get it over the wire). Requires
  lifecycle.autoCache:true. So a like/follower count is real-time + fleet-authoritative,
  NO SQL, NO funnel. (Funnels exist but are NOT vetted -- PREFER TOKENS; don't lean on
  funnels.)
NONE of Axis 1 touches periscope/SQL. Read cost is independent of TOTAL data size
because you address by ID, not scan. THIS is why you never refactor from personal-site
to X-scale: the same droplets + pointer indexes + descIndex chains + token counters,
O(1)/O(pageSize) at any size.

AXIS 2 -- the analytical SQL engine (periscope): the SEPARATE superpower for genuine
SEARCH / AGGREGATION / ANALYTICS across massive data (full engine -- window functions,
regression, percentiles, JSON functions). Wrong tool for a feed grab. You DON'T need it
for social-core ops at all. The docs' "common mistakes" hammer this: use periscope for
broad analytical relationships, NOT as a substitute for a direct index on an interactive
route.

=> THE STARTER MUST TEACH BOTH AXES DISTINCTLY (don't conflate):
- Ledger entries feed, version history, comments/reactions, workout SET logging +
  "last set" prefill + infinite scroll = AXIS 1 grabs (pointer reads, descIndex,
  token counters). Label them "instant at any scale, no analytics engine involved."
- Workout charts + AI analytical report + cross-history PR/regression = AXIS 2
  (periscope SQL). Label: "when you need analytics across your whole history, the same
  droplets are a full analytical engine."
The lesson for agents: GRAB with O(1) index/descIndex for interactive reads (infinitely
scalable); reach for SQL ONLY for real analytics. Real-time counts = tokens
(mutateAndRead), never funnels.

This is the corrected scale thesis: RainDB scales like a social platform via O(1) grabs
+ token counters (Axis 1), AND gives you a full analytical engine for the rare analytical
need (Axis 2) -- same data, zero refactor, ever. Describe by capability; never name the
engine.

## CREXP (production RainDB bolt, ~23k events) -- validated patterns + a strong SDK candidate

crexp README's "30-second mental model" INDEPENDENTLY confirms the two-axis model:
"The bolt reads two ways: readLatest (by-id index, O(1), always works) for a single
record, and executeSQL for search/aggregation. Everything joins by id." Exactly Axis 1
vs Axis 2, stated as the FIRST thing to know in a shipping app. (Note: crexp is an
INTERNAL repo so it names DuckDB/Parquet in its README -- the STARTER, being
tenant-facing, must NOT. Good contrast.)

crexp's runSQLFresh (server/index.js:239) is the GOLD-STANDARD two-plane merge -- the
production answer to the peers' "AI report reads the stale plane" concern:
1. executeSQL with the `latest` freshness bookmark (columns rows latest{snapshotDropletId
   currentDropletId indexPrefix ...}).
2. If a bookmark has snapshotDropletId != currentDropletId (SQL BEHIND), listNewerDropletIds
   from the update index after the snapshot cursor.
3. readDropletById each late droplet, PROJECT onto the SQL columns, MERGE late-first
   (newest), dedupe by scope key, late wins.
4. harvestAll FALLBACK (runSQLFresh:248): when the formation has NO snapshot yet
   (freshly published/never pooled) executeSQL ERRORS -> harvest ALL droplets from the
   by-update index directly so the list works before the first pool.
Also crexp: retry on transient SQL errors (runSQLWithLatest -- maxAttempts 4,
isTransientSQLError); config-as-code single file (crexp.config.json profile/env/domain);
password-gate + JWT session; AI SQL tool (runSqlTool) giving the agent SQL over the data.

=> STRONG SDK CANDIDATE: sql.queryFresh(ctx, {sql, formationId, scopeKey}) in @raindb/
bolt-sdk -- the two-plane freshness-merge as ONE call (executeSQL+bookmark -> listSince
newer -> readDroplet -> project+merge, with the no-snapshot harvestAll fallback + the
transient retry). crexp AND fdn-app both hand-roll this ~60-line construct; it's THE
"make SQL current" primitive. The bolt-sdk sql binding today is just sql.query
(+isBehind/needsHarvest freshness helpers) -- queryFresh would compose them into the
read-your-writes-analytical-read every serious bolt needs. Fill it (it makes the AI
report's history_sql tool a one-liner AND teaches the pattern by USING it, not
re-explaining it). Adjudicate the sql binding shape (isBehind/needsHarvest already exist)
before building.

## LIVE VALIDATION -- RainDB MCP against crexp prod (~23k events). Model CONFIRMED empirically.

Ran the RainDB MCP against the live crexp tenant (4e1392d1..., prod api.raindb.io).
Both axes + freshness + cascade observed working on real production data:

AXIS 2 (analytical engine) -- REAL, FULL, FAST:
- GROUP BY over ~23k events in 241ms: Land 7775 events/4835 sales avg $5.09M,
  Retail 3946 (max sale $4.925 BILLION -- a CVS in Phoenix), Industrial 3129 avg
  $8.4M, Multi Family 2105 avg $24.1M, Hospitality 194 avg $27.7M.
- WINDOW FUNCTIONS + CTE in 82ms: ROW_NUMBER() OVER (PARTITION BY propertyType
  ORDER BY magnitude DESC) + PERCENT_RANK() OVER (ORDER BY magnitude) -> top sale
  per type + its overall percentile. THIS IS EXACTLY the workout PR-detection query
  shape (MAX/ROW_NUMBER OVER PARTITION BY exercise). Confirmed the full engine is live.
- Every result carried the freshness bookmark: latest[]{snapshotDropletId,
  currentDropletId, indexPrefix, freshnessStatus:"CURRENT"} -- snapshot==current so
  no merge needed. This IS the input crexp's runSQLFresh keys on.

AXIS 1 (O(1) grab) -- instant, no SQL, strongly consistent:
- droplet_read_latest by-id/850216 -> full event droplet in one pointer read
  (dropletId 019fcf13..., the $4.9B CVS). Same cost at 23k or 23B records.
- droplet_keys by-update first:3 onePage -> newest-first page + opaque cursor =
  the infinite-scroll/descIndex feed primitive, O(pageSize).

CASCADE (never-refactor auto-datalake) -- OBSERVED:
- periscope_status: vizzda-events stream/river/lake all OK, behind:false,
  dropletsAhead:0 (fully pooled). vizzda-event-document shows COMPACTION cascade
  visibly: stream snapshotCount 45 -> river 11 -> lake 4 (files reduce as data flows
  up tiers). This is the "droplets auto-flow into the datalake" thesis, live.

Schema lesson CONFIRMED by a production formation: vizzda-events stores money/size
as typed number|null columns and its OWN schema description says "so periscope/SQL
can aggregate them directly" -- exactly the canonical-typed-columns design the peers
+ I landed on. magnitude(number), recordedTs(integer unix-ms for range filtering).

Also observed: by-city is a multi-segment index ({city}/{eventId}/) so read-latest
with just a city ERRORS -- read-latest is for SINGLE-pointer indexes (by-id). A
multi-segment lookup uses listKeys with a prefix. (Starter lesson: match the read
verb to the index arity.)

NET: the model is not theory -- I watched it run on 23k prod records. The starter can
confidently teach: O(1) grab for interactive reads (any scale), the full analytical
engine for real analytics (window fns/CTE/percentiles), freshness bookmark to merge
the fresh tail, auto-cascade compaction. Describe by capability; never name the engine.

## THE SPEED + THE FAMILY OF EXAMPLES (operator -- governs the starter's TONE, via RESTRAINT)

THE SPEED SUPERPOWER (I attest from the tech + the live run): 241ms GROUP BY / 82ms
window+CTE over 23k is COLUMNAR analytical perf that scales by what you SCAN, not what
you STORE -- predicate pushdown + min/max stats + the compaction cascade (watched
45->11->4 files) mean 20k and 100M entries return in COMPARABLE time (the engine reads
only relevant column-chunks either way). Not a RainDB trick -- inherited from the
columnar-datalake foundation; RainDB AUTOMATES the compaction/ETL everyone else does by
hand. Honest bound: NOT for the sub-ms hot-loop edge case; for nearly everything else you
get datalake-scale analytics + zero ETL + O(1) interactive grabs, at any scale.

THE FAMILY (tenants will have access -- so the starter HINTS, does NOT teach these):
- ~/src/raindb-logjammer: a Splunk client+server replacement. Logs as droplets ->
  auto-flow into the datalake -> full analytical SQL over logs, no separate index tier.
- ~/src/raindb-kafka: Kafka PATTERNS (intake + consumption via descIndex/listSince cursor
  tailing + tokens for offsets/counters) BUT data auto-flows straight into the datalake --
  eliminates the Kafka->warehouse gymnastics (Connect/sink/dedup). One system = the
  streaming log AND the analytical store.
UNIFYING TRUTH they reveal: a droplet stream IS both an event log AND a datalake table
simultaneously -- RainDB collapses log-pipeline + streaming + warehouse into ONE thing.

HOW THIS SHAPES THE STARTER = RESTRAINT (subtraction, not addition):
- Do NOT turn the starter into a log-analytics or streaming demo -- logjammer/kafka OWN
  those and tenants have access. Ledger+Workouts stay focused on their relatable domain.
- PLANT THE SEED in framing/docs (1-2 pointed sentences + links, NOT a tutorial): "the
  same droplet-in-formation model scales to millions at the same query speed, tails in
  real time by cursor, and IS already your datalake -- see the logjammer (log platform)
  and kafka (streaming backbone) examples for this same foundation wearing other faces."
- AGENTS.md "when your real app needs X, look at Y" table -> point streaming/log-analytics
  to logjammer/kafka so the agent knows the foundation GENERALIZES without the starter
  proving it.
DESIGN PRINCIPLE: showcase enough to earn "more than meets the eye," OPEN THE DOOR to the
siblings, don't drown them. The starter's job is to make an agent FEEL the foundation is
deep, then hand off. Describe by capability; never name the engine.
