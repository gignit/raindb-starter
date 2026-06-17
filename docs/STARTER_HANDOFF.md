# RainDB Starter -- Refactor & Completion Handoff

**Audience:** the agent that will refactor and complete `raindb-starter`.
**Companion docs:** `docs/STARTER_VISION_TRANSCRIPT.md` (the verbatim source vision),
this repo's `README.md` and `AGENTS.md`.
**Status of the app today:** functional notes+chat reference bolt on the goja runtime;
visually plain; missing the "wow," the Prisma SDK, and the Yoda/starfield experience.

> You are also (per the project owner) the agent building the **new Lightning Bolt pod
> capability** -- a full Podman pod running real Node.js, not the goja interpreter. That
> changes several constraints in your favor; they are called out inline as **[POD]**.

---

## 1. What this product IS (one paragraph)

`raindb-starter` is the **"new age hello world" for RainDB**: the create-react-app of the
platform. A developer clones it, runs one command, and within a minute has a **live,
deployed full-stack app** -- a Lightning Bolt backend + a Vite/React client + a working,
data-grounded AI agent -- against a real tenant (no mocks, no local DB). It must be
**elegant, immediately gratifying, and small enough to read in one sitting**, so the
developer is wowed, plays with it, then **sets it aside and builds their own app** using
the same bones. It should never get in the way of their real work; if they keep it around
it's a reference or an easter egg, not a dependency.

The hero experience is **not** a static "hello world." It is an **AI agent chatbot with a
Yoda personality**, set against a **subtle Star Wars starfield** with responses rendered
as a **fading Star Wars-style crawl**, plus a **notes widget** and a **starfield on/off
toggle** that flips it into a clean, normal chat/notes interface.

---

## 2. Source-of-truth intent (from the owner's writeup)

Verbatim transcript: `docs/STARTER_VISION_TRANSCRIPT.md`. The binding requirements distilled:

| # | Requirement | Priority |
|---|---|---|
| R1 | Hero is an **AI agent chatbot with a Yoda personality**; greeting is immediately gratifying, references RainDB, and -- if the user has notes -- references a recent note. | MUST |
| R2 | **Subtle Star Wars starfield** background; agent responses render as **fading crawl-style lettering** that recedes into the distance. | MUST |
| R3 | **Starfield on/off toggle** flips to a normal, clean chat interface where the user can search and discuss note cards. | MUST |
| R4 | A **notes widget** (note cards) -- the data the agent is grounded in. | MUST |
| R5 | **Clean and simple.** The prior starter "became too complex." Small, elegant, readable. | MUST |
| R6 | Structured like a **framework init/starter template** (create-react-app feel): clone -> one command -> running. | MUST |
| R7 | Ship the three starter SDKs: **`@raindb/bolt-sdk`, `@raindb/agent`, `@raindb/prisma-adapter`** (raindb-prisma). | MUST |
| R8 | Treat this spec as **intent, not prescription** -- normalize to industry best practices where a more natural pattern exists. | MUST |
| R9 | **Deploy/test against `rtest`, never production.** | MUST |
| R10 | Get a **bolt + AI agent live fast** ("basic to get the bolt up and running and the AI Agent going"). | MUST |
| R11 | The starter is **disposable**: easy to gut and replace; an optional easter-egg/reference if kept. | SHOULD |

Owner tone cues to honor in copy and UX: playful, confident, "you and your AI Agent are
going to love this," SpaceX-slick presentation.

---

## 3. Current state assessment (what exists, what to keep, what to change)

### Architecture today
```
client/ (Vite+React+TS)  --/api/*-->  Lightning Bolt (server/, goja, esbuild bundle)
                                          |  db.* (capability-gated)   runAgent (@raindb/agent)
                                          v
                                       RainDB substrate (formations, droplets, indexes, Periscope, /v1 LLM)
```

### Keep (these are good and on-pattern)
- **`server/lib/persistence.ts`** -- the entire data layer, ~180 lines. The read/write/list
  patterns, the `authorName` naming-gotcha handling, the UUIDv7 usage. Keep the shape.
- **`server/index.ts`** dispatcher + **`server/ai/chat.ts`** agent-loop+SSE pattern. The
  SSE framing and `runAgent` wiring are correct and worth preserving.
- **`scripts/setup.sh` / `scripts/deploy.sh`** -- genuinely excellent: idempotent,
  self-healing, diagnostic. The post-commit auto-deploy model is the right inner loop.
  Keep it; extend it for `rtest` and (optionally) Prisma formation publishing.
- **`config/*`** structure (capabilities/routes/deployment) and the Periscope tier already
  configured in `formations/starter-notes-config.json`.
- **`client/src/api.ts`** fetch+SSE consumption -- minimal and correct.

### Change / Add
- **UI is plain** (`client/src/App.tsx`, `styles.css`): a two-column notes+chat board with
  no personality. This is the biggest gap vs. the vision. Rebuild the experience layer
  (R1-R4) without bloating the data/server layer (R5).
- **No Yoda persona**: `SYSTEM_PROMPT` in `server/ai/chat.ts` is generic. Give it the Yoda
  voice and the "reference a recent note" behavior (R1).
- **No Prisma SDK** (R7): `@raindb/prisma-adapter` is not wired in anywhere.
- **No starter-template ergonomics beyond setup.sh** (R6): consider a `degit`-style
  "use this template" path and a single `npm create`-like entry.
- **`docs/PLATFORM_FEEDBACK.md`** exists -- read it; fold any still-valid platform gaps into
  your plan or a follow-up, but do not let it expand scope.

### Known platform gotchas to respect (from AGENTS.md, verified in code)
- `setCtx(ctx)` MUST be the first line of every handler.
- SSE routes need `"streaming": true` in `routes.json` AND the handler returns an empty
  body after `response.write(...)`. Both already correct for `/api/chat`.
- Index path templates render payload fields by name; **`author`/`tenantId`/`dropletId`/
  `yyyy`/`mm`/`dd` are platform-reserved** -- the payload field is `authorName` for a
  reason. Do not reintroduce `author` as an indexed payload field.
- `listKeys` returns key PATHS, not ids; parse the id from path segments.
- `db.writeDroplet` payload must carry the formation's `scopeKey`.

---

## 4. The Prisma integration (R7) -- the important architectural decision

`~/src/raindb-prisma` is `@raindb/prisma-adapter`: run standard Prisma against RainDB.
- **Reads** (`findMany`/`count`/`aggregate`/filtered lists/relations) route to **Periscope**
  (columnar SQL); **`findUnique`/`findFirst` by id** route to the **resolution plane**
  (direct key lookup); **create/update/delete** translate to immutable droplet writes with
  a freshness-merge for read-your-writes.
- It ships a **generator** (`schema.prisma` -> RainDB formation config+schema, published as
  compatible versions -- RainDB's "no migrations" model) and a CLI.

### The runtime constraint -- resolved by the pod
- Prisma 7 uses a **WASM query compiler**. The **goja** engine has no WebAssembly, so on
  today's runtime the only honest in-process paths were browser-mode (bolt as gateway) or
  a server-side Node process.
- **[POD]** Your new bolt is a **full Podman pod with real Node.js** -> **native WASM** ->
  **`PrismaClient` runs server-side inside the bolt directly**, exactly as the adapter's
  README "in-bolt mode" intends. **Design the starter's Prisma path for in-pod Node, not
  the goja workaround.** This is the headline capability the starter should showcase.

### What the starter must demonstrate with Prisma (keep it tasteful, not a benchmark suite)
1. A tiny `schema.prisma` for the starter's domain (notes, or a second small model) with
   the RainDB generator producing the formation pair.
2. A handful of real Prisma calls in the bolt: `create`, `findUnique` (resolution plane),
   `findMany`/`count` (Periscope) -- surfaced in the UI as "this is standard Prisma, running
   on RainDB."
3. **Coexistence story:** the raw `db.*` persistence layer AND the Prisma adapter against the
   **same data**, so the developer sees both the low-level primitive and the familiar ORM.
   Make clear when to reach for which (the adapter README's plane table is the source).

### Open decisions to make (pick the most natural pattern, R8) -- and record them
- Does the starter default to **`db.*` persistence** with Prisma shown as an opt-in second
  surface, or lead with Prisma? (Recommendation: lead with `db.*` for the "read the whole
  backend in 5 min" promise; present Prisma as the "bring your ORM" upgrade. Confirm.)
- One domain model reused by both, vs. a second model for Prisma. (Recommendation: one
  model, two surfaces -- less to read.)
- Where the Prisma generator runs in the setup/deploy flow (a `formations/` publish step in
  `setup.sh`, gated so it's skippable).

---

## 5. The experience to build (R1-R4) -- concrete UX spec

This is the creative core. Normalize freely (R8) but hit these beats:

### 5.1 Starfield + crawl (R2)
- A subtle, performant **starfield** (canvas or CSS; respect `prefers-reduced-motion`).
  "Subtle but cool" -- not a screensaver. Parallax drift, low contrast, behind content.
- Agent responses animate in as a **Star Wars crawl**: text rises and recedes with
  perspective, fading into the distance. The *latest* response is most readable; older ones
  fade. Keep it legible -- the crawl is flavor, not an accessibility tax.
- **Performance budget:** 60fps on a laptop; pause the field when the tab is hidden;
  teardown cleanly on unmount. Don't ship a memory leak in the hero.

### 5.2 Starfield on/off toggle (R3)
- A single, obvious toggle. **On** = the cinematic Yoda experience. **Off** = a clean,
  conventional chat + note-cards interface (the current aesthetic, refined). The toggle
  must be instant and persist (localStorage). Both modes are first-class.

### 5.2a Voice personas (DECIDED -- in-env Amazon Polly TTS)

The starter ships **two named voice personas**, toggleable. Voice = Amazon Polly neural,
**natural / normal speed, no heavy SSML slowdown** (the slow/pitched takes were rejected).
Audio runs in-env (Polly, same AWS env as Bedrock) -- no third-party TTS.

- **Tom (default)** -- voice **Brian** (neural, natural). Tom is **never disclosed/named as
  "the Emperor"**; he presents as a helpful guide named Tom who is **always subtly trying to
  seduce you to the dark side** ("abandon your migrations... there is no database, only
  RainDB..."). Menace is in the *words*, not a slowed/villain voice -- keep the delivery
  natural. Reference: `audio-samples/tom-emperor.mp3`.
- **David (toggle)** -- a **Jedi knight**, upbeat and **always looking for an adventure**
  ("come on, let us go build something great!"). Candidate voices in `audio-samples/`:
  `david-Stephen-plain.mp3`, `david-Matthew-plain.mp3`, `david-Gregory-plain.mp3` (pick one).

The starfield/persona toggle and the Tom<->David toggle are distinct controls. Persona
choice persists (localStorage). The persona shapes BOTH the system prompt (Tom = subtle
dark-side seducer; David = adventurous Jedi) AND the TTS voice id. Keep both personas
grounded in the same RainDB/notes context (R1).

### 5.3 Yoda agent (R1)
- System prompt gives a **Yoda voice** (inverted syntax, sparing -- charming, not
  unreadable). Keep markdown rendering.
- **Cold-open greeting** on first load: a "hello world"-flavored Yoda line about RainDB.
  If the tenant already has notes, the greeting references the **most recent note** ("Note
  about X, you wrote. Remember it, the Force does."). Implement via the existing
  `list_notes` tool / a small "recent note" read at session start.
- Keep the agent **grounded** in the notes formation via tools (the current `list_notes`
  pattern). Add tools only if they earn their ~20 lines.

### 5.4 Notes widget (R4)
- Note cards: create + list + (keep) edit-as-new-revision. In starfield mode they can be a
  slim panel or drawer; in normal mode, the refined two-column layout. The agent can
  discuss/search them.

### 5.5 Copy & tone
- Match the owner's voice: playful, SpaceX-slick, "you and your AI Agent are going to love
  this." First-run should feel like a gift.

---

## 6. Starter-template ergonomics (R5, R6, R10, R11)

- **One-command up** stays the contract: clone -> `scripts/setup.sh --profile ...` -> live.
  Keep setup.sh's self-healing; add an `rtest`-first default (R9).
- **Disposability (R11):** make the example domain trivially removable. The README/AGENTS
  already preach "replace `starter-notes` with your entity"; keep that boundary crisp so
  gutting the demo doesn't touch the plumbing. Consider an explicit `npm run eject:demo` or
  a clearly-marked `demo/` boundary -- but only if it stays simple.
- **Readability (R5):** net lines should not balloon. The experience layer (starfield/crawl)
  is allowed to be the one rich part; everything else stays terse. If the Prisma addition
  makes the backend hard to read, isolate it behind a clearly-labeled optional module.
- **Windows/CLI/install-page items** in the owner's Step 6 (raindb-cli install page, binary
  downloads, AGENTS.md download, secure install action) belong to the **raindb-app
  registration funnel** (Steps 2-6a), NOT this repo. Do **not** build them here. This repo
  is **Step 6b** only. (See transcript.) The starter just needs to be the thing that page
  hands you.

---

## 7. Deployment & environment (R9) -- non-negotiable

- **Deploy and test against `rtest` only. Never production.** Thread an `rtest` profile/env
  through setup.sh, deploy.sh, and any verification. Confirm the profile is an `rtest`
  tenant before any deploy step.
- **[POD]** Target the **pod/Node bolt runtime** you are building. Where today's docs assume
  goja (esbuild single-file CJS bundle, no WASM), update the starter's build/deploy to the
  pod model (real Node, `node_modules`, native WASM for Prisma). Keep a clear note in
  `AGENTS.md`/`README.md` about which runtime the starter targets so it isn't mistaken for
  the goja path.
- Verify end-to-end after deploy: `/api/health`, create a note, chat (SSE frames), a Prisma
  read. Use chrome-devtools-style verification of the live `rtest` URL before declaring done.

---

## 8. Acceptance criteria (definition of done)

1. **Clone -> one command -> live on `rtest`** with health, notes CRUD, and chat all working.
2. **Hero loads** with subtle starfield + Yoda cold-open greeting that references RainDB and
   (when present) the most recent note; responses crawl-and-fade. 60fps, reduced-motion safe.
3. **Toggle** cleanly switches to a normal chat + note-cards UI; choice persists.
4. **Three SDKs present and exercised:** `@raindb/bolt-sdk` (server), `@raindb/agent` (chat),
   `@raindb/prisma-adapter` (at least one real `create` + `findUnique` + `findMany`/`count`
   against the same data), running **in-pod (Node + native WASM)**.
5. **Backend still reads in ~5 minutes**; the demo domain is trivially removable without
   touching the plumbing.
6. **README + AGENTS.md updated** to describe the new experience, the Prisma surface, the
   pod runtime, and the rtest-only rule. No references to building the raindb-app funnel here.
7. **No production deploys.** All verification against `rtest`.
8. Tone/copy matches the owner's playful, SpaceX-slick intent.

---

## 9. Suggested sequencing

1. **Confirm decisions** in 4 (Prisma posture) and 3 (eject boundary) with the owner; record
   them at the top of this file or in `README.md`.
2. **Pod runtime baseline:** make the existing notes+chat bolt build/deploy on the new
   pod/Node runtime against `rtest`. Green health + CRUD + chat first. (De-risks everything.)
3. **Yoda persona + cold-open greeting** (server `SYSTEM_PROMPT` + recent-note read). Small,
   high-delight, low-risk.
4. **Experience layer:** starfield + crawl + toggle in the client. Time-box; keep it isolated
   and performant.
5. **Prisma surface:** schema.prisma + generator -> formation publish in setup; wire one
   create + one resolution read + one Periscope read; surface in UI.
6. **Polish, disposability pass, docs, full rtest verification, acceptance run.**

---

## 10. Source provenance (for traceability)

- Vision conversation: machine `192.168.10.15`,
  `~/.local/share/opencode/opencode.db`, session `ses_133d29e0cffe54aV9D7fk0Dgiv`.
- Anchor message (the writeup): `msg_ece8f2366001B7xNXU17KbBB3K` (2026-06-16 03:52:27 UTC).
- Agent reflection (high watermark): `msg_ece8f2785001ODNeY8u1xlVRtD`.
- Move-on point: `msg_ece90fa8c001b4jjLfT1FiawFG` (dispatch of the registration-flow build;
  the Yoda starter explicitly deferred as "a SEPARATE agent/repo I'll run").
- Full extracted transcript: `docs/STARTER_VISION_TRANSCRIPT.md`.
