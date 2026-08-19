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
