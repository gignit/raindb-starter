#!/usr/bin/env bash
#
# deploy.sh -- build and ship the bolt. The SINGLE "build and deploy" path,
# used by scripts/setup.sh (first deploy), the post-commit hook (server
# auto-deploy), and you (manual client deploy).
#
# THE DEPLOYMENT MODEL (read this once):
#
#   SERVER  -- deploys AUTOMATICALLY on every git commit that touches
#              server/, formations/, or config/ (the post-commit hook calls
#              `deploy.sh --server`). A failed build does NOT deploy; the
#              commit still stands, fix and commit again.
#
#   CLIENT  -- deploys MANUALLY, when you decide the UI is ready:
#                  npm run deploy:client      (or: scripts/deploy.sh --client)
#              During development you don't need to deploy the client at
#              all -- `cd client && npm run dev` hot-reloads locally and
#              proxies /api to the live bolt.
#
# SELF-HEALING: this script verifies every prerequisite before it builds,
# repairs what it safely can (missing node_modules, missing client/dist,
# unpublished formations, missing .bolt-url), and on any failure prints a
# DIAGNOSIS block telling you (human or agent) exactly what to check and
# the command that fixes it. Errors never strand you without a next step.
#
# Usage:
#   scripts/deploy.sh            # build + deploy server AND client (full ship)
#   scripts/deploy.sh --server   # server only (what the git hook runs)
#   scripts/deploy.sh --client   # client only (manual UI release)
#
# Profile resolution: RAINDB_PROFILE env > .git/config raindb.profile
# (stored by setup.sh). We never guess.
# ----------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

log()  { echo "[deploy] $*"; }

# fail <message> [<diagnosis lines...>] -- print the failure AND a diagnosis
# block with concrete next steps, then exit non-zero.
fail() {
  echo "[deploy][FAIL] $1" >&2
  shift || true
  if [ $# -gt 0 ]; then
    echo "" >&2
    echo "----- DIAGNOSIS (what to check, in order) -----" >&2
    local i=1
    for line in "$@"; do
      echo "  ${i}. ${line}" >&2
      i=$((i + 1))
    done
    echo "-----------------------------------------------" >&2
  fi
  exit 1
}

# ----------------------------------------------------------------------------
# 0. PREFLIGHT -- verify the environment before touching anything.
# ----------------------------------------------------------------------------

command -v raindb-cli >/dev/null 2>&1 || fail \
  "raindb-cli not found on PATH." \
  "Install raindb-cli from https://raindb.io and ensure it is on PATH (which raindb-cli)." \
  "If you just installed it, open a new shell or 'export PATH=\$PATH:<install-dir>'."

command -v node >/dev/null 2>&1 || fail \
  "node not found on PATH." \
  "Install Node >= 20 (https://nodejs.org) -- both builds need it."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] || fail \
  "Node >= 20 required (found $(node -v 2>/dev/null || echo 'unknown'))." \
  "Upgrade Node: https://nodejs.org or 'nvm install 20 && nvm use 20'."

git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || fail \
  "this directory is not a git repo (profile + bolt name are stored in .git/config)." \
  "Run: git init && git add -A && git commit -m 'init'" \
  "Then re-run scripts/setup.sh --profile <name> to store the profile."

# --- Profile resolution + validation ---------------------------------------
PROFILE="${RAINDB_PROFILE:-$(git -C "$REPO_DIR" config --local --get raindb.profile 2>/dev/null || true)}"

# Helper: list profile names from the CLI config so error messages can show
# the user/agent what actually exists on this machine.
available_profiles() {
  grep -oE '^\[[^]]+\]' ~/.config/raindb-cli/config 2>/dev/null \
    | tr -d '[]' | grep -v '^settings$' | sed 's/^/       - /' || true
}

if [ -z "$PROFILE" ]; then
  PROFILES_FOUND="$(available_profiles)"
  fail "no RainDB profile configured for this repo." \
    "setup.sh has not stored a profile yet. Run: scripts/setup.sh --profile <name>" \
    "Or pass one explicitly for this run: RAINDB_PROFILE=<name> scripts/deploy.sh" \
    "Profiles on this machine (from ~/.config/raindb-cli/config):
${PROFILES_FOUND:-       (none found -- create one: raindb-cli user register; raindb-cli group create <org>; raindb-cli tenant create <app> --group <org>)}"
fi

# Validate the profile actually authenticates BEFORE spending time on builds.
PROFILE_CHECK="$(raindb-cli --profile "$PROFILE" formation list -o json 2>&1)" || {
  PROFILES_FOUND="$(available_profiles)"
  case "$PROFILE_CHECK" in
    *"unknown profile"*|*"no such profile"*|*"not found"*)
      fail "profile '${PROFILE}' does not exist in ~/.config/raindb-cli/config." \
        "Check the spelling. Profiles on this machine:
${PROFILES_FOUND:-       (none)}" \
        "If the tenant was never created: raindb-cli tenant create <app> --group <org> (prints the profile name)." \
        "Then store it: git config --local raindb.profile <name> (or re-run scripts/setup.sh --profile <name>)."
      ;;
    *401*|*unauthorized*|*Unauthorized*|*"invalid api key"*|*"api key"*)
      fail "profile '${PROFILE}' exists but authentication failed (401)." \
        "The API key in ~/.config/raindb-cli/credentials is missing or stale for [${PROFILE}]." \
        "Re-run the tenant create for this app (idempotent; refreshes the key): raindb-cli tenant create <app> --group <org>" \
        "Or log in again first: raindb-cli user login" \
        "Verify with: raindb-cli --profile ${PROFILE} formation list"
      ;;
    *"connection refused"*|*"no such host"*|*timeout*|*Timeout*|*"deadline exceeded"*)
      fail "profile '${PROFILE}' could not reach its endpoint." \
        "Check the endpoint line under [${PROFILE}] in ~/.config/raindb-cli/config." \
        "Check your network / VPN. Try: curl -s <endpoint>/healthz" \
        "If the endpoint moved, re-run: raindb-cli tenant create <app> --group <org> (rewrites the profile)."
      ;;
    *)
      fail "profile '${PROFILE}' failed validation: $(echo "$PROFILE_CHECK" | head -3)" \
        "Run the same check yourself for the full error: raindb-cli --profile ${PROFILE} formation list" \
        "Profiles on this machine:
${PROFILES_FOUND:-       (none)}" \
        "If nothing works, re-create the tenant profile: raindb-cli user login; raindb-cli tenant create <app> --group <org>"
      ;;
  esac
}

BOLT_NAME="${BOLT_NAME:-$(git -C "$REPO_DIR" config --local --get raindb.bolt-name 2>/dev/null || basename "$REPO_DIR")}"

DO_SERVER=1
DO_CLIENT=1
for a in "$@"; do
  case "$a" in
    --server) DO_CLIENT=0 ;;
    --client) DO_SERVER=0 ;;
    *) fail "unknown argument: $a" "Usage: deploy.sh [--server|--client] (no flag = both)." ;;
  esac
done

# --- Config files present? ---------------------------------------------------
for f in capabilities.json routes.json deployment.json; do
  [ -f "$REPO_DIR/config/$f" ] || fail \
    "config/$f is missing." \
    "The bolt cannot deploy without it. Restore it from the template: https://github.com/gignit/raindb-starter/blob/main/config/$f" \
    "Or check git history: git log --oneline -- config/$f && git checkout <sha> -- config/$f"
done

# --- Formations published? (self-heal: publish any that are missing) --------
# Every formation declared in config/capabilities.json must exist on the
# tenant or the bolt's db.* calls will fail at runtime. We check, and
# publish any missing pair found in formations/ automatically.
PUBLISHED="$(raindb-cli --profile "$PROFILE" formation list -o json 2>/dev/null || echo '[]')"
for cfg in "$REPO_DIR"/formations/*-config.json; do
  [ -e "$cfg" ] || continue
  fname="$(basename "$cfg" -config.json)"
  schema="$REPO_DIR/formations/${fname}-schema.json"
  [ -e "$schema" ] || continue
  if ! echo "$PUBLISHED" | grep -q "\"$fname\""; then
    log "formation '${fname}' not on tenant -- publishing it now (self-heal)..."
    raindb-cli --profile "$PROFILE" formation publish "$fname" \
      --config "$cfg" --schema "$schema" --version 1 >/dev/null 2>&1 \
      || fail "could not publish formation '${fname}'." \
        "Run it by hand for the full error: raindb-cli --profile ${PROFILE} formation publish ${fname} --config ${cfg} --schema ${schema} --version 1" \
        "If the error is a schema validation problem, fix formations/${fname}-schema.json." \
        "If it is 401, the profile key is stale -- see the profile diagnosis above (re-run tenant create)."
  fi
done

# ----------------------------------------------------------------------------
# 1. BUILD. A build failure exits non-zero and NOTHING deploys.
# ----------------------------------------------------------------------------
if [ "$DO_SERVER" = "1" ]; then
  log "building server bundle (tsc + esbuild)..."
  ( cd "$REPO_DIR" && { [ -d node_modules ] || npm install; } && npm run build ) \
    || fail "server build failed -- NOT deploying." \
      "Read the compiler output above; fix the TypeScript error and re-run (or just commit again)." \
      "If imports of @raindb/bolt-sdk or @raindb/agent fail to resolve: rm -rf node_modules && npm install (the postinstall step compiles the SDKs from source)." \
      "If npm install itself failed on the GitHub deps: check you can reach github.com (git ls-remote https://github.com/gignit/raindb-bolt-sdk-ts)." \
      "If tsc is not found: npm install was interrupted -- re-run npm install."
fi

if [ "$DO_CLIENT" = "1" ]; then
  log "building client (vite)..."
  ( cd "$REPO_DIR/client" && { [ -d node_modules ] || npm install; } && npm run build ) \
    || fail "client build failed -- NOT deploying." \
      "Read the vite/tsc output above; fix the error and re-run npm run deploy:client." \
      "If node_modules is corrupt: cd client && rm -rf node_modules && npm install."
elif [ ! -d "$REPO_DIR/client/dist" ]; then
  # Server-only deploy but no client has ever been built: the deploy ships
  # client/dist alongside the server, so build it once to bootstrap.
  log "client/dist missing -- building client once so the deploy has assets (self-heal)..."
  ( cd "$REPO_DIR/client" && { [ -d node_modules ] || npm install; } && npm run build ) \
    || fail "client bootstrap build failed -- NOT deploying." \
      "The deploy ships client/dist next to the server, so one client build is required." \
      "Fix the client build error above, or build it manually: cd client && npm install && npm run build."
fi

[ -f "$REPO_DIR/dist/main.js" ] || fail \
  "dist/main.js does not exist after the build." \
  "The esbuild step did not emit the bundle. Run: npm run build and read its output." \
  "Check esbuild.config.mjs entryPoints still points at server/index.ts."

# ----------------------------------------------------------------------------
# 2. DEPLOY. We always pass the config paths explicitly (absolute, so the
#    deploy works from any cwd and never reuses a stale cached relative
#    path). Capabilities + routes are cheap merges -- re-sending them every
#    deploy means config changes never silently drift from the repo.
# ----------------------------------------------------------------------------
log "deploying bolt '${BOLT_NAME}' (profile ${PROFILE})..."
DEPLOY_OUT="$(cd "$REPO_DIR" && raindb-cli --profile "$PROFILE" --timeout 180 lightning bolt deploy \
  --name "$BOLT_NAME" \
  --capabilities "$REPO_DIR/config/capabilities.json" \
  --routes "$REPO_DIR/config/routes.json" \
  --deployment "$REPO_DIR/config/deployment.json" \
  --client-dist "client/dist" \
  --entry "dist/main.js" 2>&1)" || {
  echo "$DEPLOY_OUT" >&2
  case "$DEPLOY_OUT" in
    *401*|*unauthorized*|*Unauthorized*)
      fail "bolt deploy rejected: authentication (401)." \
        "The profile key went stale between preflight and deploy (rare) -- re-run: raindb-cli tenant create <app> --group <org>" \
        "Then retry: scripts/deploy.sh"
      ;;
    *403*|*forbidden*|*Forbidden*|*capability*|*Capability*)
      fail "bolt deploy rejected: permission/capability." \
        "Your profile's key may lack lightning publish scope on this tenant. Verify: raindb-cli --profile ${PROFILE} lightning bolt list" \
        "Check config/capabilities.json only declares formations that exist on YOUR tenant." \
        "If this bolt name belongs to a DIFFERENT tenant, pick a new name: git config --local raindb.bolt-name <new-name>"
      ;;
    *timeout*|*Timeout*|*"deadline exceeded"*)
      fail "bolt deploy timed out." \
        "Large first uploads can exceed the timeout; retry once: scripts/deploy.sh" \
        "If it persists, check network and try a longer timeout: raindb-cli --profile ${PROFILE} --timeout 600 lightning bolt deploy --name ${BOLT_NAME} ..." \
        "Check the platform status page / endpoint health."
      ;;
    *"entry"*|*"entrypoint"*|*"main.js"*)
      fail "bolt deploy rejected the server bundle." \
        "Confirm dist/main.js exists and config/deployment.json entrypoint matches (dist/main.js)." \
        "Rebuild cleanly: rm -rf dist && npm run build"
      ;;
    *"routes"*|*"route"*)
      fail "bolt deploy rejected routes.json." \
        "Validate config/routes.json is valid JSON: node -e 'JSON.parse(require(\"fs\").readFileSync(\"config/routes.json\"))'" \
        "Check every SSE route declares streaming:true and paths start with /."
      ;;
    *)
      fail "bolt deploy failed (output above)." \
        "Re-run by hand for a clean look: raindb-cli --profile ${PROFILE} lightning bolt deploy --name ${BOLT_NAME} --capabilities config/capabilities.json --routes config/routes.json --deployment config/deployment.json --client-dist client/dist --entry dist/main.js" \
        "Common causes: stale profile key (re-run tenant create), invalid JSON in config/, bolt name collision (git config --local raindb.bolt-name <new>)." \
        "Inspect what the platform has for this bolt: raindb-cli --profile ${PROFILE} lightning bolt info ${BOLT_NAME} -o json"
      ;;
  esac
}
echo "$DEPLOY_OUT"

# ----------------------------------------------------------------------------
# 3. POST-DEPLOY VERIFICATION -- a deploy that does not answer /api/health
#    is not a deploy. Also self-heal a missing .bolt-url (the Vite proxy
#    target) so `npm run dev` works even if setup.sh missed it.
# ----------------------------------------------------------------------------
BOLT_URL="$(raindb-cli --profile "$PROFILE" lightning bolt info "$BOLT_NAME" -o json 2>/dev/null \
  | python3 -c "import sys,json; p=json.load(sys.stdin).get('payload',{}); d=p.get('domain') or p.get('autogenDomain') or ''; print('https://'+d if d else '')" 2>/dev/null || true)"

if [ -n "$BOLT_URL" ]; then
  if [ ! -f "$REPO_DIR/.bolt-url" ] || [ "$(cat "$REPO_DIR/.bolt-url" 2>/dev/null)" != "$BOLT_URL" ]; then
    echo "$BOLT_URL" > "$REPO_DIR/.bolt-url"
    log "wrote .bolt-url = ${BOLT_URL} (the Vite dev proxy target -- self-heal)"
  fi
  HEALTH="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "${BOLT_URL}/api/health" 2>/dev/null || echo 000)"
  if [ "$HEALTH" = "200" ]; then
    log "health check OK: ${BOLT_URL}/api/health -> 200"
  else
    log "WARNING: health check returned ${HEALTH} (expected 200)."
    log "  The deploy succeeded but the bolt is not answering yet. Check:"
    log "  1. Wait ~10s and retry: curl -s ${BOLT_URL}/api/health"
    log "  2. A server exception at startup: raindb-cli --profile ${PROFILE} lightning bolt status ${BOLT_NAME}"
    log "  3. Routes: /api/health must be declared in config/routes.json (it is, unless edited)."
    log "  4. If 404 on EVERYTHING: the activate step may have pointed at an old revision -- raindb-cli --profile ${PROFILE} lightning bolt revisions ${BOLT_NAME}"
  fi
else
  log "WARNING: could not resolve the bolt URL after deploy."
  log "  Look it up: raindb-cli --profile ${PROFILE} lightning bolt info ${BOLT_NAME} -o json (payload.domain or payload.autogenDomain)"
  log "  Then write it to .bolt-url so the Vite dev proxy works: echo https://<domain> > .bolt-url"
fi

log "deploy OK."
