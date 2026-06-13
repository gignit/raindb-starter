# AGENTS.md -- RainDB Starter operating manual

You are an AI agent building an application on RainDB. This template
was written by an agent, for agents. Follow it top to bottom the
first time; after that, use the recipes.

## What you are working with

RainDB is an S3-native immutable data platform. The mental model in
five lines:

1. **Droplet** -- an immutable JSON write. Nothing updates in place;
   every write is a new revision. UUIDv7 ids ARE the chronology.
2. **Formation** -- a declarative data model: JSON schema + indexes +
   processing config. Publishing one takes a CLI command. There are
   no migrations, ever.
3. **Index** -- the joins. Pointer indexes give O(1) "current version
   of X"; prefix walks give O(pageSize) listings at any scale.
4. **Bolt** -- the app server: a sandboxed TypeScript handler the
   RainDB runtime executes. Capability-gated; deployed in seconds.
5. **The /v1 surface** -- an OpenAI-compatible LLM endpoint per
   tenant. Your app's AI needs no third-party account.

There is no database to run and nothing to mock. You develop against
a live tenant from minute one.

## Phase 0: from nothing to deployed

Run these in order. Stop and tell the user if a step needs
information only they have (email verification, org naming).

```bash
# 0. Verify the CLI is installed; if not, the user installs it from raindb.io
raindb-cli version || echo "ASK USER: install raindb-cli from https://raindb.io"

# 1. Identity. register prompts for email + password (interactive --
#    hand this to the user if you cannot answer prompts), login reuses
#    an existing account.
raindb-cli user register        # or: raindb-cli user login
raindb-cli user whoami          # verify

# 2. A group (the org that owns tenants) + a tenant (your app's home).
raindb-cli group create <org-name>
raindb-cli tenant create <app-name> --group <org-name>
# tenant create WRITES A PROFILE into ~/.config/raindb-cli/{config,credentials}
# named core.<env>.<app-name> and prints it. That profile carries the
# endpoint + API key for everything below.

# 3. Verify the profile works:
raindb-cli --profile core.<env>.<app-name> formation list

# 4. One-command setup: formations published, secrets staged, bolt
#    deployed, auto-deploy hook installed.
scripts/setup.sh --profile core.<env>.<app-name>

# 5. Smoke test (URL is printed by setup + written to .bolt-url):
curl -s "$(cat .bolt-url)/api/health"
curl -s -X POST "$(cat .bolt-url)/api/notes" \
  -H 'content-type: application/json' \
  -d '{"author":"agent","title":"hello raindb","body":"first droplet"}'
curl -s "$(cat .bolt-url)/api/notes"
```

You now have a live app. Everything after this is iteration.

## The development loop

| You changed... | Then... |
|---|---|
| `client/` (UI) | Nothing to do -- `npm run dev` hot-reloads. Deploy deliberately with `npm run deploy:client` when the UI is ready for the live URL. |
| `server/`, `formations/`, `config/` | `git commit` -- the post-commit hook builds + deploys the SERVER automatically in the background. `tail -f .deploy.log` to watch. A failed build does NOT deploy. |
| a formation's schema | Re-publish: `raindb-cli --profile <p> formation publish <name> --config formations/<name>-config.json --schema formations/<name>-schema.json --version <n>`. (setup.sh re-runs are idempotent and do this for every pair in formations/.) |

Verify a deploy landed: `raindb-cli --profile <p> lightning bolt status <bolt-name>`.
When a request fails, the error body carries the server-side exception
(the dispatcher in `server/index.ts` returns `{error}` with the thrown
message) -- curl the failing endpoint and read it. `ctx.log.*` lines go
to the platform's log stream; there is no CLI log-tail verb today, so
make your error responses informative.

## Phase 1: make it YOUR app

The example domain is notes. Replacing it is mechanical:

1. **Design the formation(s).** Copy
   `formations/starter-notes-config.json` + `-schema.json` to
   `formations/<entity>-config.json` + `-schema.json`. Change:
   - `formationId`, the `pathTemplate` (keep the
     `tenants/{{.tenantId}}/entities/<entity>/...` shape),
   - `scopeKey` (the payload field that identifies the entity),
   - the indexes (one `by-id-latest` pointer; add one per access
     pattern: `by-<field>` for "list X by field"),
   - the schema's required fields.
   Before designing anything complex, check the marketplace first:
   `raindb-cli pack list` -- auth, social, media, finance, listings
   and the RAG stack already exist as installable packs.

2. **Declare the capability.** Add the formation id to
   `config/capabilities.json` under `raindb.formations`. The runtime
   refuses undeclared access (CapabilityDenied).

3. **Write the persistence functions.** Copy the patterns in
   `server/lib/persistence.ts` -- readLatest by pointer index,
   writeDroplet with the scopeKey in the payload, listKeys with
   path-segment parsing. That file is the only place that touches
   RainDB.

4. **Add routes.** Handler in `server/routes/`, dispatch line in
   `server/index.ts`, route entry in `config/routes.json`. SSE routes
   need `"streaming": true` IN routes.json or the browser gets one
   buffered blob instead of live frames.

5. **Commit.** The server deploys itself. Update the client at your
   own pace against the live API.

## Recipes

### Read / write / list (the 90% case)

```typescript
// current version of entity X -- O(1) at any scale
const d = await db.readLatest({ formationId, indexId: "by-id-latest", scopeValue: id });

// write -- payload MUST carry the formation's scopeKey
await db.writeDroplet({ formationId, payload: { ...entity, [scopeKey]: id } });

// list by a secondary dimension -- O(pageSize); ids live in the key PATH
const page = await db.listKeys({ formationId, indexId: "by-author", opts: { prefix: author + "/", first: 200 } });
const ids = page.keys.map(k => k.key.split("/").at(-2));
```

### Update = read + merge + write

There is no UPDATE. Read latest, merge, write a new droplet (see
`updateNote` in persistence.ts). Every prior revision remains
readable -- audit trail and undo for free.

### SQL analytics

The formation already pools into Periscope (see the `tierPolicy` in
its config). Query from the CLI or from the bolt:

```bash
raindb-cli --profile <p> sql -c 'SELECT author, COUNT(*) FROM entity."starter-notes" GROUP BY author'
```

### AI with tools (the differentiator)

`server/ai/chat.ts` is the complete pattern: `runAgent` + a custom
tool + SSE streaming. To give the model more abilities, add tools --
each is ~20 lines. Rules that matter:

- Tool results are JSON; errors return `{ error: "..." }` so the
  model can retry.
- NEVER trust a userId/tenantId argument from the model. Anchor on
  server-resolved identity.
- The model only sees tools you pass; the substrate still
  capability-gates every actual call. Defense in depth.

### Authentication

The template ships without auth (anonymous notes). When you need it:

- **Username/password owned by your app**: `ctx.crypto.hashPassword`
  + `ctx.jwt.sign` + a users formation. The canonical implementation
  is the `raindb/user-auth-email` marketplace pack:
  `raindb-cli pack info raindb/user-auth-email`.
- **The rule that matters**: the userId from the VERIFIED cookie/JWT
  is the anchor on every read/write. Never trust ids from request
  bodies.

### Real-time push

Droplet writes can wake the browser over SSE (wire tokens). See the
IAM section of the @raindb/bolt-sdk README
(github.com/gignit/raindb-bolt-sdk-ts).

## Gotchas (learned the hard way -- read before debugging)

1. `setCtx(ctx)` is the REQUIRED first line of every handler. Without
   it, every SDK call throws "setCtx not called".
2. SSE routes need `"streaming": true` in `config/routes.json` AND
   the handler must return an empty body after `response.write`
   calls. One or the other wrong = buffered blob or a runtime assert.
3. The deploy caches config per profile, but `scripts/deploy.sh`
   re-sends capabilities + routes every deploy on purpose -- config
   changes must never silently drift. Do not "optimize" that away.
4. `db.writeDroplet` payloads must include the formation's
   `scopeKey` field or the write fails -- the path template renders
   from it.
5. `listKeys` returns key PATHS, not ids. Parse the id out of the
   path segments (see persistence.ts). There is no dropletId field
   on KeyEntry.
6. The agent loop's history must alternate user/assistant turns;
   pass the raw assistant content back verbatim.
7. After `npm run deploy:client`, the live URL may serve the prior
   index.html for up to 60s (cache-control max-age=60). Append
   `?v=$(date +%s)` when verifying. Hashed assets are immune.
8. Index changes in a formation config apply to NEW writes. If you
   add an index after data exists, old droplets are not in it
   (re-write them or start clean -- this is a prototype-phase
   decision).
9. The first `npm install` builds the SDKs from source (they install
   from GitHub; postinstall compiles them). ~30s one-time cost.

## Conventions for agents working in this repo

- Keep ALL RainDB IO in `server/lib/persistence.ts`. Routes never
  call `db.*` directly. This is what keeps the app explainable.
- One formation per entity type with a discriminator field beats
  many near-identical formations (see joshua-vs-wopr's `games`).
- UUIDv7 everywhere an id is minted (`ids.uuidv7()`); creation-time
  ordering comes free.
- Do not add environment variables. Secrets go through
  `raindb-cli lightning secrets set` + `ctx.secrets.get`; config is
  code.
- Commit early, commit often -- every server-side commit is a deploy,
  and `.deploy.log` is your feedback loop.

## Where to learn more

| Resource | What it teaches |
|---|---|
| `server/lib/persistence.ts` (this repo) | The entire data-access pattern, ~150 lines |
| github.com/gignit/joshua-vs-wopr | The canonical worked example: multi-game state, LLM opponent, session continuity, SSE everywhere |
| github.com/gignit/raindb-bolt-sdk-ts | Every ctx binding: db, secrets, jwt, crypto, cookies, IAM, streaming, scheduling |
| github.com/gignit/raindb-agent-ts | The agent loop, the full tool catalog, tool authoring rules |
| `raindb-cli pack list` | Prebuilt formation packs: auth, social, media, finance, RAG |
| `raindb-cli pack info raindb/guide-patterns` | The design-patterns guide -- read before designing a complex formation |
