# RainDB Starter

The official starting point for building an application on
[RainDB](https://raindb.io) -- the S3-native immutable data platform.
Clone this repo, run one setup script, and you have a live, deployed
full-stack app: TypeScript server, Vite + React client, real data,
and a working AI assistant. From there, replace the example domain
with yours and ship.

**If you are an AI agent: read [AGENTS.md](./AGENTS.md) next.** It is
your operating manual -- the exact command sequence to go from nothing
to a deployed app, and the patterns to follow when you build on top.

```
   Browser (Vite + React, hot-reload locally)
        |  /api/*
        v
   Lightning Bolt    <-- the app server. TypeScript bundled with esbuild,
   (server/)             run on the RainDB Lightning `goja` runtime
        |                (fast, sandboxed, clone-and-run anywhere).
        |  db.* + sql.* (@raindb/bolt-sdk)      runAgent (@raindb/agent)
        v          |                                   |
   RainDB substrate:                                   v
      - Formations  = your data model (declarative config + schema)
      - Droplets    = immutable writes (UUIDv7 = chronology)
      - Indexes     = the fresh, O(pageSize) reads at any scale (db.*)
      - Periscope   = analytical SQL over the SAME droplets (sql.*, auto-datalake)
      - /v1/*       = an OpenAI-compatible model surface (the AI's brain)
```

This starter uses two RainDB SDKs: `@raindb/bolt-sdk` (the typed `db.*`
data bindings AND the `sql.*` analytical plane) and `@raindb/agent` (the
AI agent loop). It runs on the `goja` engine, so it clones and deploys on
any RainDB environment with no admin-provisioned runtime -- no database,
no ORM, no migrations. The substrate is the backend.

The example app is three screens over ONE data model -- **Notes**
(instant index reads/writes), an **Assistant** (the agent, grounded in
your notes), and **Analytics** (Periscope SQL over the same droplets,
with a live freshness indicator). Each screen demonstrates a distinct
RainDB capability you build on.

## Why build on this

- **No backend to operate.** No database server, no ORM, no
  migrations, no API server process. You declare formations; RainDB
  gives you storage, indexes, queries, SQL analytics, and vector
  search.
- **Build once, refactor never.** The primitives (droplet, formation,
  index, bolt) are the same at 10 rows and at S3 scale. The app you
  prototype this afternoon is the app you scale.
- **AI is built in.** The assistant in this template calls a real LLM
  through RainDB's own OpenAI-compatible surface, grounded in your
  app's data via agent tools. No third-party AI account.
- **The whole backend is small.** `server/lib/persistence.ts` is the
  entire data layer -- index reads/writes and the SQL analytics, in one
  readable file. Start there.

## Quick start

**Prerequisites:**
- `raindb-cli` on your PATH ([get it at raindb.io](https://raindb.io)), Node >= 20.
- A RainDB account + a tenant (`scripts/setup.sh` walks you through it). The
  bolt runs on the `goja` engine, which is available on every RainDB
  environment -- nothing admin-provisioned to enable.

```bash
# 1. Get the template
git clone https://github.com/gignit/raindb-starter my-app
cd my-app
rm -rf .git && git init && git add -A && git commit -m "raindb-starter"

# 2. Create your RainDB identity + a tenant (writes a local profile)
raindb-cli user register --email you@example.com --name "You"   # or: user login
raindb-cli group create --name my-org
raindb-cli plan list                     # the tiers; NAME is the slug to pass
                                         # to --tier (pick one AVAILABLE=True)
raindb-cli tenant create --group my-org --name my-app --tier <slug>
#    -> prints + saves a profile named core.<env>.my-app

# 3. One-command setup: publishes formations, stages secrets, deploys
#    the bolt, records its URL, and installs the server auto-deploy hook
scripts/setup.sh --profile core.<env>.my-app

# 4. Develop against the LIVE bolt with hot reload
cd client && npm install && npm run dev
#    http://localhost:5173 -- /api proxies to your deployed bolt
```

## The development model

You never simulate RainDB locally -- standing up a real tenant is a few
CLI commands, so there is nothing to mock (and a mock would only force a
refactor when you went live). After `scripts/setup.sh` deploys the bolt
once, the loop is:

1. **Iterate on the UI against the live bolt** -- `cd client && npm run
   dev` runs the client on `localhost:5173` with instant hot-reload and
   proxies every `/api/*` call to your **deployed bolt**. You always
   develop against the real backend.
2. **Server changes ship on commit** -- a commit that touches `server/`,
   `formations/`, or `config/` triggers a background server build + deploy
   (the post-commit hook `setup.sh` installs). A failed build does NOT
   deploy; the commit still stands. Watch `.deploy.log`.
3. **Ship the client when the UI is ready** -- `npm run deploy:client`.

Prefer one explicit command for the whole bolt? `npm run deploy` builds
and redeploys server + client together (what `setup.sh` runs the first
time).

| Layer | Inner loop | Deploys |
|---|---|---|
| **Client** (Vite + React) | `npm run dev` -- instant HMR, talks to the live bolt | Manually when ready: `npm run deploy:client` |
| **Server** (the bolt) | edit -> `git commit` | Automatically on commits touching `server/`/`formations/`/`config/` (post-commit hook; failed builds do not deploy -- watch `.deploy.log`) |

## Repository map

```
client/                 Vite + React + TS UI (Notes / Assistant / Analytics tabs)
  src/api.ts            the client's whole API surface (fetch + SSE consumption)
server/
  index.ts              onHttpRequest -- the dispatcher (the backend's only door)
  lib/persistence.ts    ALL RainDB IO: db.* index reads/writes + sql.* analytics -- READ THIS FIRST
  lib/http.ts           request/response helpers
  routes/notes.ts       CRUD via db.* + the /api/stats & /api/notes-sql SQL routes
  ai/chat.ts            the AI assistant: agent loop + custom tool + SSE streaming
config/
  capabilities.json     what the bolt may touch (formations, secrets, network, limits)
  routes.json           how requests reach the handler (SSE routes flagged streaming)
  deployment.json       engine (goja) + entrypoint (dist/main.cjs) + healthcheck
formations/             the data model: starter-notes (config + schema pair)
scripts/
  setup.sh              one-command setup (comments = documentation)
  deploy.sh             the single build-and-ship path (hook + manual)
AGENTS.md               the AI-agent operating manual -- patterns + recipes
```

## What the example app does

Three screens over one data model (the `starter-notes` formation),
each exercising a different RainDB capability:

- **Notes (`db.*`, the index plane).** Notes are droplets in
  `starter-notes`. Create and edit produce NEW immutable revisions; the
  `by-id` pointer index (keyed on the `noteId` scopeKey) always resolves
  the current one -- instantly, at any scale. Version history is free.
  (`server/lib/persistence.ts`, `server/routes/notes.ts`.)
- **Assistant (`@raindb/agent`).** `POST /api/chat` runs `runAgent` with a
  custom tool (`list_notes`) that reads the formation through the same
  persistence layer. Each turn streams to the browser as SSE frames
  (tool calls + results + the answer), shown live with a collapsible
  activity trace. The model is called through RainDB's own
  OpenAI-compatible surface. (`server/ai/chat.ts`.)
- **Analytics (`sql.*`, the Periscope plane).** The SAME droplets are
  queryable as an analytical SQL table -- no ETL, no second store.
  `GET /api/stats` runs a `GROUP BY` aggregate and reports a **freshness**
  verdict; the UI shows an honest "up to date" / "updating" badge.
  `GET /api/notes-sql` uses `sql.queryEntityRowsFresh` to run SQL AND
  merge the just-written tail (read-your-writes over the analytical
  plane). (`statsByAuthor` + `recentNotesFresh` in
  `server/lib/persistence.ts`.)

**Two read planes (the freshness rule this app teaches):** a `by-id`
index read reflects a write immediately -- use it for detail /
read-after-write / current state. Periscope SQL is eventually consistent
(the stream tier pools on a schedule, ~5 min), so a just-written row may
not appear in an *aggregate* until it pools -- the Analytics badge makes
that honest instead of hiding it. For a *row list* you can have both:
`queryEntityRowsFresh` merges the fresh tail. Use the index for current
state, SQL for analytics, and the merge for fresh feeds.

Replace `starter-notes` with your domain entity and you have your app.

## Going further

- **More reference apps**: [joshua-vs-wopr](https://github.com/gignit/joshua-vs-wopr)
  (games + LLM opponent + session continuity, the canonical deep
  reference), super-calculator (multi-tool agent UI), fdn-app
  (production RAG).
- **The patterns guide** (read this before designing formations):
  `raindb-cli pack install raindb/guide-patterns` installs the
  definitive RainDB reference to
  `~/.local/share/raindb/packs/raindb/guide-patterns/<version>/README.md`
  -- indexes, access tiers, feeds, SQL, floats, and every common
  mistake with its fix.
- **Marketplace packs**: `raindb-cli pack list` -- prebuilt formation
  sets for auth (`raindb/user-auth-email`), social (`raindb/social`),
  media (`raindb/media-photos`, `raindb/media-secure-documents`),
  finance (`raindb/finance-transactions`), real estate
  (`raindb/real-estate-listings`), and the full document-RAG stack
  (`raindb/foundation`); install any of them with
  `raindb-cli pack install <name>` and copy
  their working formation configs.
- **The SDK guides**: [@raindb/bolt-sdk](https://github.com/gignit/raindb-bolt-sdk-ts)
  (every binding: db, secrets, jwt, crypto, IAM, SSE) and
  [@raindb/agent](https://github.com/gignit/raindb-agent-ts) (the
  agent loop + tool catalog).
