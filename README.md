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
   (server/)             run on the RainDB Lightning POD runtime (real
        |                Node.js 20 + native WASM).
        |  db.* (@raindb/bolt-sdk)   runAgent (@raindb/agent)   PrismaClient (@raindb/prisma-adapter)
        v          |                        |                        |
   RainDB substrate:                        v                        v
     - Formations  = your data model (declarative config + schema)
     - Droplets    = immutable writes (UUIDv7 = chronology)
     - Indexes     = the joins (O(pageSize) reads at any scale)
     - Periscope   = SQL over the same data (DuckDB + Parquet)
     - /v1/*       = an OpenAI-compatible model surface (the AI's brain)
```

This starter ships and exercises **all three RainDB SDKs** on the pod
runtime: `@raindb/bolt-sdk` (the typed `db.*` bindings), `@raindb/agent`
(the AI agent loop), and `@raindb/prisma-adapter` (standard Prisma over
RainDB -- which is why it runs on the **pod** engine: Prisma 7's WASM query
compiler needs real Node + WebAssembly, which the legacy `goja` engine
cannot provide).

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
- **The whole backend is ~400 lines.** `server/lib/persistence.ts` is
  the entire data layer. Read it in five minutes.

## Quick start

**Prerequisites:**
- `raindb-cli` on your PATH ([get it at raindb.io](https://raindb.io)), Node >= 20.
- **A RainDB environment whose Lightning hosts have the `nodejs-20` pod engine
  enabled** (rtest today; other environments once their hosts are
  pod-provisioned). The pod engine registry is platform/admin-managed
  (Private-tier `capabilities.pod.engines`) -- a tenant does **not** self-enable
  it. As a tenant you simply set `engine: nodejs-20` in `config/deployment.json`
  and deploy; it works if your host has the engine. (To enable pod on an
  environment that lacks it, a platform admin registers `nodejs-20` on that
  env's Lightning hosts.) The 3rd SDK (Prisma) requires the pod runtime; the
  notes + AI features alone also run on the legacy `goja` engine.

```bash
# 1. Get the template
git clone https://github.com/gignit/raindb-starter my-app
cd my-app
rm -rf .git && git init && git add -A && git commit -m "raindb-starter"

# 2. Create your RainDB identity + a tenant (writes a local profile)
raindb-cli user register                 # or: raindb-cli user login
raindb-cli group create my-org
raindb-cli tenant create my-app --group my-org
#    -> prints + saves a profile named core.<env>.my-app

# 3. One-command setup: publishes formations, stages secrets,
#    deploys the bolt, installs the auto-deploy hook
scripts/setup.sh --profile core.<env>.my-app

# 4. Develop
cd client && npm install && npm run dev
#    http://localhost:5173 -- /api proxies to your LIVE deployed bolt
```

## The development model

You never simulate RainDB locally. Standing up a real tenant is three
CLI commands, so there is nothing to mock -- and a mock would only
force a refactor when you went live.

| Layer | Inner loop | Deploys |
|---|---|---|
| **Client** (Vite + React) | `npm run dev` -- instant HMR, talks to the live bolt | **Manually**, when the UI is ready: `npm run deploy:client` |
| **Server** (the bolt) | edit -> `git commit` | **Automatically** on every commit that touches `server/`, `formations/`, or `config/` (post-commit hook; failed builds do not deploy -- watch `.deploy.log`) |

## Repository map

```
client/                 Vite + React + TS UI (notes board + AI chat)
  src/api.ts            the client's whole API surface (fetch + SSE consumption)
server/
  index.ts              onHttpRequest -- the dispatcher (the backend's only door)
  lib/persistence.ts    ALL RainDB IO, via typed db.* bindings -- READ THIS FIRST
  lib/prisma.ts         the @raindb/prisma-adapter surface (SDK #3): PrismaClient on RainDB
  lib/http.ts           request/response helpers
  routes/notes.ts       the example CRUD surface via db.* (replace with your domain)
  routes/prisma-notes.ts  the SAME notes via Prisma (create/findUnique/findMany)
  routes/pod-info.ts    GET /api/pod-info -- runtime + 3-SDK certification probe
  ai/chat.ts            the AI assistant: agent loop + custom tool + SSE streaming
prisma/
  schema.prisma         one Note model mapped onto the starter-notes formation
config/
  capabilities.json     what the bolt may touch (formations, secrets, network, limits)
  routes.json           how requests reach the handler (SSE routes flagged streaming)
  deployment.json       engine (nodejs-20 pod) + entrypoint (dist/main.cjs) + healthcheck
formations/             the data model: starter-notes (config + schema pair)
scripts/
  setup.sh              one-command setup (comments = documentation)
  deploy.sh             the single build-and-ship path (hook + manual)
AGENTS.md               the AI-agent operating manual -- patterns + recipes
```

## What the example app does

A notes board with an AI assistant, exercising all three SDKs over **one
data model with two surfaces**:

- **Notes via `db.*`** (`@raindb/bolt-sdk`) are droplets in the
  `starter-notes` formation. Create and edit produce NEW immutable
  revisions; the `by-id-latest` pointer index always resolves the current
  one. Version history is free. (`server/lib/persistence.ts`,
  `server/routes/notes.ts`.)
- **The same notes via Prisma** (`@raindb/prisma-adapter`):
  `POST/GET /api/prisma/notes` run standard `prisma.note.create` /
  `findUnique` / `findMany` against the **same** formation -- a note written
  with Prisma is readable via `db.*` and vice versa. This is the headline
  "bring your ORM, keep RainDB" demo, and it's why the app runs on the pod
  (Prisma's WASM compiler). (`server/lib/prisma.ts`, `prisma/schema.prisma`.)
- **The assistant** (`POST /api/chat`) is `@raindb/agent`'s `runAgent`
  loop with one custom tool (`list_notes`) that reads the formation.
  Progress streams to the browser as SSE frames -- thinking, tool
  calls, final answer, live. The UI keeps each turn's thinking trace in a
  collapsible section.
- **`GET /api/pod-info`** is a one-call certification probe: Node version,
  WebAssembly, which SDKs loaded, and a live Prisma round-trip.
- **SQL for free**: the formation has a Periscope tier configured, so
  once data flows you can `raindb-cli sql -c 'SELECT authorName, COUNT(*)
  FROM entity."starter-notes" GROUP BY authorName'`.

**Consistency note (important for Prisma):** `findUnique`/`findFirst` by id
read the **resolution plane** -- immediate and authoritative. `findMany` /
`count` / aggregates read the **Periscope columnar plane**, which is
**eventually consistent** (the stream tier pools on a schedule, default ~5
min). So a just-written row appears instantly via `findUnique` but may lag in
`findMany` until the pool materializes it. This is by design today (the
host's instant-merge overlay is a future feature); for read-your-writes on a
single record, read it by id.

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
  sets for auth (`raindb/user-auth-email`), social, media, finance,
  real estate, and the full document-RAG stack (`raindb/foundation`);
  install any of them with `raindb-cli pack install <name>` and copy
  their working formation configs.
- **The SDK guides**: [@raindb/bolt-sdk](https://github.com/gignit/raindb-bolt-sdk-ts)
  (every binding: db, secrets, jwt, crypto, IAM, SSE),
  [@raindb/agent](https://github.com/gignit/raindb-agent-ts) (the
  agent loop + tool catalog), and
  [@raindb/prisma-adapter](https://github.com/gignit/raindb-prisma)
  (standard Prisma over RainDB -- reads route to the resolution plane or
  Periscope SQL; writes become immutable droplets).
