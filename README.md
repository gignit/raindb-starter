# fit -- the RainDB starter

The official starting point for building an application on
[RainDB](https://raindb.io) -- the S3-native immutable data platform.
Clone this repo, run one setup script, and you have a **live, deployed
full-stack app**: a TypeScript Lightning bolt server, a Vite + React
client, real data, real auth, and a working AI agent -- with **no
database to run, no ORM, no migrations, no Redis, no message broker.**
The substrate is the backend.

**If you are an AI agent: read [AGENTS.md](./AGENTS.md) next.** It is the
operating manual -- the command sequence to a deployed app and the
task-to-file map.

---

## What you get: a complete, deployed reference app

This starter ships as **`fit`** -- a real, white-labelable workout +
private-journal SaaS -- so you learn every RainDB pattern from a working
example instead of a toy. It is live, mobile-first, and readable:

- **Auth** -- email/password accounts with revocable sessions (a signed
  JWT + a session token you can delete to log out everywhere).
- **Workout tracking** -- a category tree, big-button set logging with
  instant "last set" prefill, benchmarks, and analytical charts/PRs.
- **Private journal** -- entries with **off-the-grid, zero-knowledge
  client-side encryption** (the server only ever sees ciphertext), full
  version history + restore (every edit is an immutable revision), and
  draft autosave.
- **Live community stats + streaks** -- real-time counters (the "Redis,
  but better" pattern) with no Redis.
- **An AI coach** -- a streamed (SSE) agent that reasons over your data
  on two planes: instant reads for what you just did, analytical SQL for
  long-term trends.

It demonstrates RainDB's **two axes**: the O(1) interactive grab (feeds,
prefill, counters -- Instagram-scale, never touches SQL) and the
analytical plane (charts, PRs, leaderboards -- a full auto-datalake over
the same data, with an honest "updating..." badge when it trails).

---

## The structure: read `reference/`, build in `app/`

```
reference/ledger/     the COMPLETE worked app ("fit"). Read it. It is the
  formations/         living documentation -- 13 formations + a full bolt
  server/             server. A pre-commit guard keeps it read-only.
app/                  YOUR app starts here. A tiny green skeleton (one
  formations/         formation + a CRUD server) wired to build + deploy
  server/             once you graduate.
client/               the Vite + React SPA (mobile-first).
config/               capabilities (formation ops + secrets), routes,
                      deployment -- the bolt's contract with the platform.
scripts/              setup.sh, deploy.sh, remove-reference.sh.
```

When you are ready to build your own: `bash scripts/remove-reference.sh`
deletes the reference + the guard and points the build at `app/`.

---

## Quick start

```bash
# 1. One-time setup: stores your RainDB profile, publishes formations,
#    stages secrets, deploys the bolt, and health-checks it.
bash scripts/setup.sh --profile <your-raindb-profile>

# 2. Develop the UI locally (hot-reload; /api proxies to your live bolt):
cd client && npm run dev

# 3. Ship server changes: just commit (the post-commit hook deploys).
#    Ship the client when ready:
npm run deploy:client
```

The bolt re-builds from source on the platform's own esbuild; the deploy
stages the secrets your `config/capabilities.json` declares (see
[AGENTS.md](./AGENTS.md) for the exact contract).

---

## Why this is the model

Everything reusable lives in the **SDKs**, not the app: `@raindb/bolt-sdk`
(db, tokens, files, jwt, crypto, cookies, SSE, the agent bridge) and
`@raindb/agent` (the LLM loop). The app code is about the **use case**.
When building `fit` surfaced a missing primitive, we added it to the SDK
rather than working around it in the app -- so your app starts from a more
complete SDK. That is the standard to hold: if you hand-roll something
reusable, it belongs in the SDK.

See the sibling examples for other patterns: a Splunk-style log platform
and Kafka-style event streams that flow into the same auto-datalake with
zero ETL.
