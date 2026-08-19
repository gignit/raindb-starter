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
