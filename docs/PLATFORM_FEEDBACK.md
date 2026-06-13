# About this document

Friction log from building the raindb-starter template (the agent-first onboarding experience). Each section is one issue found while wiring the template against the real CLI + SDKs, with what was done about it and what the platform should change to make the agent path smoother. States: open (needs platform work), proposed (suggestion, not blocking), fixed (resolved during template work), wontfix.

# SDK repos: default branch pointed at the v0.1 scaffold branch

Symptom: `npm install github:gignit/raindb-bolt-sdk-ts` silently resolved commit 762ae99 (version 0.1.0, the feat/v0.1-package-scaffold branch) instead of main, because GitHub's default branch was still the scaffold branch. The installed package was missing the agent-bridge export and half the bindings.

Fix applied: `gh repo edit gignit/raindb-bolt-sdk-ts --default-branch main`. Agent repo was already on main.

Platform takeaway: any repo agents will `npm install` from GitHub must keep its default branch at the release line. A CI check or a repo-settings checklist for public SDK repos would prevent recurrence.

# SDK git installs shipped no dist (no prepare script)

Symptom: both @raindb/bolt-sdk and @raindb/agent gitignore dist/ and had no `prepare` script, so a GitHub install delivered package.json + README only -- every import failed. npm also pruned src/ and tsconfig.json on install (the `files` whitelist applies to git installs), so the consumer could not even build them in place.

Fix applied: added `"prepare": "npm run build"` to both packages (committed + pushed). npm runs prepare for git deps in a temp checkout with devDependencies installed, so dist/ now ships compiled. Also bumped @raindb/agent 0.6.0 -> 0.7.0 to satisfy bolt-sdk's `peerDependencies: ^0.7.0` range, which otherwise sent npm to the (nonexistent) npm registry entry and hard-failed the install.

Residual: the starter keeps scripts/ensure-sdk-built.mjs as a postinstall safety net; it is a no-op when prepare worked. Delete it once the SDKs are published to npm.

Platform takeaway: publish both SDKs to npm. Git installs work now but cost ~30s of tsc per consumer install and depend on repo state; npm tarballs with prebuilt dist are the real fix. Until then, keep `prepare` intact and keep versions in lockstep with the peer range.

# raindb-cli init: the verb this template exists to become

The operator's target UX is `raindb-cli init <project>` -- scaffold a project the way `npm create vite` does. Today the template is cloned by hand (README step 1: git clone + rm -rf .git + git init).

Proposed verb behavior:
1. `raindb-cli init <name>` clones/downloads github.com/gignit/raindb-starter into ./<name>, strips .git, runs git init + first commit.
2. Prints the next three commands (user register/login, group create, tenant create) and offers to run them.
3. If a profile already exists, offers `scripts/setup.sh --profile <detected>` directly.
4. `--template <repo>` flag for alternative templates later (server-only bolt, RAG app, etc.).

Until the verb exists, the README's clone instructions are the contract. When the verb lands, update README quick start step 1 and AGENTS.md Phase 0.

# user register is interactive-only (agents cannot complete it)

RESOLVED ON VERIFICATION: `user register` DOES support headless flags (--email, --name, --password) -- the whole Phase 0 chain (register -> group create -> tenant create) ran non-interactively during the live walkthrough. The original note assumed prompts-only from the help text's prompt wording.

Two real issues remain (split out):
1. The CLI ships with NO default portal URL: bare `user register` fails with "PortalURL is empty -- set --portal flag, RAINDB_PORTAL_URL env, or profile portal_url field". A fresh user must already know https://raindb.io is the portal. The CLI should default to https://raindb.io (production) so the documented first command works out of the box. (The help text even references the old devx portal as the default, which no longer resolves.)
2. AGENTS.md + setup.sh now document the --portal flag in the Phase 0 chain as the workaround.

# Profile endpoint + api_key only readable by parsing INI files

setup.sh needs the profile's endpoint and api_key to stage the bolt's LLM secrets. The only way today is awk-parsing ~/.config/raindb-cli/{config,credentials} (pattern copied from joshua-vs-wopr's setup.sh). Fragile: breaks if the INI format gains quoting, multiple spaces, or includes.

Proposed: `raindb-cli profile show [--profile <p>] -o json` returning {name, endpoint, portal, hasApiKey} and a deliberate `raindb-cli profile export-key` (or `--with-secrets`) for the key. Then setup.sh becomes two clean CLI calls and the secret never transits awk.

Even better: a single `raindb-cli lightning secrets seed-llm` verb that stages LLM_API_BASE + LLM_API_KEY from the active profile server-side -- the most common bolt setup step becomes one idempotent command.

# No CLI verb to tail bolt logs

There is no `lightning bolt logs <name>` verb (verified against the installed CLI; bolt subcommands are publish/activate/rollback/replace/deploy/delete/revisions/deployments/status/info/list/emit-config). A bolt's ctx.log.* output is invisible to the developer/agent, so the only debugging surfaces are (a) the error body of a failing request and (b) deploy status.

Consequence for the template: AGENTS.md tells agents to make error responses informative because logs are unreachable. The starter's dispatcher returns the thrown message in the JSON error body for this reason.

Proposed: `raindb-cli lightning bolt logs <name> [--follow] [--since 10m]` streaming the bolt's log lines (the substrate already captures them -- lightning-bolt-stats / the platform log stream). This is the single biggest debugging gap for an agent iterating on a bolt.

# Bolt URL discovery requires json parsing of bolt info

Both setup.sh and deploy.sh recover the live URL via `lightning bolt info <name> -o json` piped through python3 (payload.domain or payload.autogenDomain). Works, but a first-class `raindb-cli lightning bolt url <name>` (prints the canonical https URL, exit 1 if none) would remove the python3 dependency from the scripts and make the smoke-test one-liners in docs cleaner.

Related nicety: have `lightning bolt deploy` print the live URL on success -- the deploy already knows it, and the agent's very next step is always "curl the health endpoint".

# deploy.sh hardening notes (what the template absorbs today)

The template's scripts/deploy.sh self-heals or diagnoses, in order: missing CLI/node/git, missing or invalid profile (with the actual profile list from the INI and per-error-class fixes for 401 / unknown-profile / network), missing config files, unpublished formations (auto-publishes any local pair missing from the tenant), missing node_modules, missing client/dist on server-only deploys (bootstrap build), missing dist/main.js after build, deploy rejections classified by error text (401/403/timeout/entry/routes), missing or stale .bolt-url (rewrites), and a post-deploy /api/health probe with a wait-retry-status checklist when not 200.

Everything in that list is the template compensating for the platform: each diagnosis branch is a candidate for a better CLI error message or a server-side preflight. The error-text classification (case patterns on CLI output) is brittle by nature -- typed exit codes or a structured error JSON from raindb-cli (-o json on failure) would let the script branch reliably instead of grepping prose.

# Default chat model resolution fails on a fresh tenant (and the config seed contradicts the registry)

Symptom: on a brand-new tenant (created via tenant create, nothing else), the starter's agent chat returned: "resolveDefaultChatModel: raindb registry has no model with chat capability (check platform-llm-model + platform-config-llm seeds)". Yet GET /v1/models with the same tenant key lists 10+ chat-capable models, and a direct POST /v1/chat/completions with model pinned works fine.

Two distinct problems:
1. Default-model RESOLUTION inside the agent loop fails on a fresh tenant even though the /v1 surface can serve chat. Whatever path resolveDefaultChatModel reads (platform-llm-model via by-id-latest per platform-config-llm) is not visible/seeded for a new tenant at creation time.
2. The config seed contradicts the operator's intent and the registry: `config get llm` shows chat.defaultModel = fdn-internal/sonnet-4.6, but the cheap Amazon Nova model is supposed to be the default (and the registry flags fdn-internal/nova-lite as is_default for chat). Fresh tenants would silently default to the expensive model if resolution worked.

Template mitigation (the reference-app pattern): pin the model explicitly -- CHAT_MODEL = "fdn-internal/nova-lite" in server/ai/chat.ts, passed as runAgent's model. joshua-vs-wopr (nova-micro) and crexp (sonnet-4.6) both do this.

Platform fixes wanted: (a) make default-chat-model resolution work out of the box on a fresh tenant; (b) align platform-config-llm chat.defaultModel with the intended cheap Nova default; (c) make the resolver's error message say WHICH lookup failed (formation? index? empty registry?) so the fix is actionable without platform knowledge.

# Payload field "author" is shadowed by the platform's write-author template variable

Symptom: the starter's by-author index template used {{.author}} expecting the payload's author field. Index keys came out as .../by-author/bolt:<boltId>/... -- the WRITE AUTHOR (the writing principal) silently shadowed the payload field, so per-author filtering returned empty. No error at publish or write time.

Fix applied in the template: payload field renamed authorName; gotcha #10 added to AGENTS.md (with the debugging signature: `raindb-cli droplet keys "indexes/<f>/<i>/"` showing bolt:... where your value should be).

Platform fixes wanted, in order of value:
1. formation publish should WARN (or reject) when an index template references a variable that collides with a platform-injected name (author, tenantId, dropletId, yyyy/mm/dd, ...).
2. The patterns guide (raindb/guide-patterns pack) should list the reserved/injected template variables in the formation-config section -- it documents the date + id variables but never says `author` is injected.
3. Document the full injected-variable list in `formation publish --help`.

# End-to-end walkthrough verified (account -> tenant -> deploy -> browser)

Full agent-path verification on production (raindb.io / api.raindb.io), 2026-06-13:

1. user register --portal https://raindb.io --email/--name/--password: headless, worked.
2. group create + tenant create: wrote profile core.prod.starter-demo with working key.
3. scripts/setup.sh: formations published, LLM secrets staged, first deploy OK, hook installed. (Initial health probe failed only due to LOCAL resolver SERVFAIL on the fresh stormfront subdomain; resolved at 8.8.8.8 immediately -- DNS propagation, not platform.)
4. Notes CRUD over the live bolt: create/list/filter all green after the authorName fix.
5. Post-commit hook: server-only deploys fire automatically on commit, ~2 min, health-checked.
6. Vite dev loop: npm run dev + /api proxy to live bolt + HMR verified in-browser (edit -> instant update, no reload, live data).
7. AI chat: SSE frames (thinking / tool-call / final) render live; nova-lite + list_notes tool grounded answers; GFM tables render after remark-gfm + a system-prompt nudge to not fence markdown.

The walkthrough cost ~25 minutes including all debugging -- with the friction items in this doc fixed it would be under 10.


<!-- markdown-helper:v1
{
  "schema": [
    {
      "initial": true,
      "name": "open"
    },
    {
      "name": "proposed"
    },
    {
      "name": "fixed"
    },
    {
      "name": "wontfix",
      "terminal": true
    }
  ],
  "sections": {
    "A": {
      "state": "fixed",
      "title": "About this document"
    },
    "B": {
      "state": "fixed",
      "title": "SDK repos: default branch pointed at the v0.1 scaffold branch"
    },
    "C": {
      "state": "fixed",
      "title": "SDK git installs shipped no dist (no prepare script)"
    },
    "E": {
      "state": "fixed",
      "title": "user register is interactive-only (agents cannot complete it)"
    },
    "H": {
      "state": "proposed",
      "title": "Bolt URL discovery requires json parsing of bolt info"
    },
    "I": {
      "state": "fixed",
      "title": "deploy.sh hardening notes (what the template absorbs today)"
    },
    "K": {
      "state": "fixed",
      "title": "Payload field \"author\" is shadowed by the platform's write-author template variable"
    },
    "L": {
      "state": "fixed",
      "title": "End-to-end walkthrough verified (account -> tenant -> deploy -> browser)"
    }
  },
  "v": 1
}
-->
