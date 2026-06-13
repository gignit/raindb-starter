#!/usr/bin/env bash
#
# setup.sh -- one-command setup for a raindb-starter app.
#
# ============================================================================
# WHAT THIS SCRIPT IS (the comments ARE the documentation)
# ============================================================================
#
# raindb-starter is a complete, working full-stack app whose ENTIRE backend
# is RainDB: data lives in FORMATIONS (declarative schema + indexes), the
# server is a LIGHTNING BOLT (a sandboxed TypeScript handler the substrate
# runs for you), and the AI assistant rides RainDB's built-in agent loop +
# OpenAI-compatible model surface. There is NO database to run, NO ORM, NO
# migrations, NO local API server to simulate.
#
# The development model is a CONSTANT LIVE RAINDB BACKEND:
#
#   * The FRONTEND runs locally with Vite hot-reload (cd client && npm run
#     dev) and proxies /api/* to your deployed bolt. Manual deploy when the
#     UI is ready: npm run deploy:client
#   * The SERVER redeploys automatically on every git commit that touches
#     server/, formations/, or config/ (via the post-commit hook this
#     script installs). A failed build does NOT deploy.
#
# ============================================================================
# PREREQUISITES (do these BEFORE running this script)
# ============================================================================
#
# 1. Install raindb-cli and put it on your PATH.
#    Download + docs: https://raindb.io
#
# 2. Create your RainDB identity + a tenant for this app. raindb-cli runs
#    the whole chain and writes a local PROFILE you then pass to this
#    script:
#
#       raindb-cli user register          # or: raindb-cli user login
#       raindb-cli group create <org>     # your organisation
#       raindb-cli tenant create <name> --group <org>
#
#    `tenant create` AUTO-WRITES a profile section into
#    ~/.config/raindb-cli/{config,credentials} named core.<env>.<name> and
#    prints it. That profile name is what you pass below as --profile.
#    (Verify any time with: raindb-cli --profile <name> formation list)
#
# 3. Node >= 20.
#
# ============================================================================
# USAGE
# ============================================================================
#
#   scripts/setup.sh --profile <profile-name> [--name <bolt-name>]
#
# The profile is REQUIRED the first time; it is stored in this repo's local
# git config (.git/config, raindb.profile) so the deploy hook and later runs
# reuse it. --name defaults to the repo directory's name.
#
# ----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

LOG="${REPO_DIR}/.setup-$(date -u +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
echo "setup.sh log: $LOG"
echo

log() { echo "[setup] $*"; }
die() { echo "[setup][FATAL] $*" >&2; exit 1; }

# ----------------------------------------------------------------------------
# 0. PRE-FLIGHT
# ----------------------------------------------------------------------------
command -v raindb-cli >/dev/null 2>&1 \
  || die "raindb-cli not found on PATH. Install it first -- see https://raindb.io"
command -v node >/dev/null 2>&1 \
  || die "node not found. Install Node >= 20."
command -v git >/dev/null 2>&1 \
  || die "git not found."

# This repo may be a fresh clone of the template; make sure it IS a git
# repo (the deploy hook + profile storage need .git).
if ! git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  log "initializing git repo (the deploy hook + profile storage live in .git)"
  git -C "$REPO_DIR" init -q
fi

# ----------------------------------------------------------------------------
# 1. PROFILE + BOLT NAME RESOLUTION
# ----------------------------------------------------------------------------
PROFILE=""
BOLT_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)   PROFILE="${2:-}"; shift 2 ;;
    --profile=*) PROFILE="${1#--profile=}"; shift ;;
    --name)      BOLT_NAME="${2:-}"; shift 2 ;;
    --name=*)    BOLT_NAME="${1#--name=}"; shift ;;
    *) die "unknown argument: $1 (usage: setup.sh --profile <name> [--name <bolt-name>])" ;;
  esac
done

STORED_PROFILE="$(git -C "$REPO_DIR" config --local --get raindb.profile 2>/dev/null || true)"
[ -n "$PROFILE" ] || PROFILE="$STORED_PROFILE"

if [ -z "$PROFILE" ]; then
  die "no RainDB profile provided and none stored.

      Provide the profile you created for this app:

        scripts/setup.sh --profile <profile-name>

      If you have not created a tenant yet, do this first:
        raindb-cli user register
        raindb-cli group create <org>
        raindb-cli tenant create <name> --group <org>
      then pass the printed profile name (core.<env>.<name>) as --profile."
fi

log "using profile: ${PROFILE}"
raindb-cli --profile "$PROFILE" formation list >/dev/null 2>&1 \
  || die "profile '${PROFILE}' does not work (raindb-cli --profile ${PROFILE} formation list failed).
         Check the name against ~/.config/raindb-cli/config, or re-run tenant create."

[ -n "$BOLT_NAME" ] || BOLT_NAME="$(git -C "$REPO_DIR" config --local --get raindb.bolt-name 2>/dev/null || basename "$REPO_DIR")"

git -C "$REPO_DIR" config --local raindb.profile "$PROFILE"
git -C "$REPO_DIR" config --local raindb.bolt-name "$BOLT_NAME"
log "stored profile + bolt name in .git/config (raindb.profile, raindb.bolt-name)"
log "bolt name: ${BOLT_NAME}"

# ----------------------------------------------------------------------------
# 2. PUBLISH FORMATIONS
#
# Formations ARE the data model -- declarative config + schema, no
# migrations. Publishing is idempotent. Each formation is a
# <name>-config.json + <name>-schema.json pair in formations/.
# ----------------------------------------------------------------------------
log "publishing formations..."
for cfg in "$REPO_DIR"/formations/*-config.json; do
  [ -e "$cfg" ] || continue
  name="$(basename "$cfg" -config.json)"
  schema="$REPO_DIR/formations/${name}-schema.json"
  [ -e "$schema" ] || { log "  skip ${name}: no schema file"; continue; }
  log "  publishing formation: ${name}"
  raindb-cli --profile "$PROFILE" formation publish "$name" \
    --config "$cfg" --schema "$schema" --version 1 >/dev/null \
    || die "formation publish failed for ${name}"
done
log "formations published."

# ----------------------------------------------------------------------------
# 3. SECRETS
#
# The bolt declares two secrets in config/capabilities.json:
#   * LLM_API_BASE -- the tenant API base + /v1. The assistant's agent loop
#   * LLM_API_KEY  -- POSTs {LLM_API_BASE}/chat/completions; RainDB's
#                     OpenAI-compatible surface answers, so there is NO
#                     third-party AI account. Data IO does NOT use a key --
#                     it rides the capability-gated db.* bindings.
#
# We resolve both from the active profile and stage them on the tenant
# (idempotent).
# ----------------------------------------------------------------------------
log "staging bolt secrets (LLM endpoint + key for the assistant)..."

RAINDB_URL="$(awk -v p="[$PROFILE]" '$0==p{f=1;next} f&&/^endpoint/{print $3;exit} /^\[/{f=0}' \
  ~/.config/raindb-cli/config 2>/dev/null | sed 's#/graphql$##')"
[ -n "$RAINDB_URL" ] || die "could not resolve the tenant API URL for profile ${PROFILE} from ~/.config/raindb-cli/config."

API_KEY="$(awk -v p="[$PROFILE]" '$0==p{f=1;next} f&&/^api_key/{print $3;exit} /^\[/{f=0}' \
  ~/.config/raindb-cli/credentials 2>/dev/null)"
[ -n "$API_KEY" ] || die "could not read the API key for profile ${PROFILE} from ~/.config/raindb-cli/credentials."

raindb-cli --profile "$PROFILE" lightning secrets set \
  --literal "LLM_API_BASE=${RAINDB_URL}/v1" \
  --literal "LLM_API_KEY=${API_KEY}" \
  || die "could not stage bolt secrets."
log "secrets staged (LLM_API_BASE -> ${RAINDB_URL}/v1, LLM_API_KEY)."

# ----------------------------------------------------------------------------
# 4. FIRST DEPLOY (server + client together)
# ----------------------------------------------------------------------------
log "running first build + deploy..."
RAINDB_PROFILE="$PROFILE" BOLT_NAME="$BOLT_NAME" bash "${SCRIPT_DIR}/deploy.sh" \
  || die "first deploy failed -- see the output above"

BOLT_URL="$(raindb-cli --profile "$PROFILE" lightning bolt info "$BOLT_NAME" -o json 2>/dev/null \
  | python3 -c "import sys,json; p=json.load(sys.stdin).get('payload',{}); d=p.get('domain') or p.get('autogenDomain') or ''; print('https://'+d if d else '')" 2>/dev/null || true)"
if [ -n "$BOLT_URL" ]; then
  echo "$BOLT_URL" > "${REPO_DIR}/.bolt-url"
  log "bolt URL: ${BOLT_URL} (written to .bolt-url for the Vite proxy)"
else
  log "WARNING: could not read bolt URL; set .bolt-url manually (raindb-cli lightning bolt info ${BOLT_NAME})."
fi

# ----------------------------------------------------------------------------
# 5. INSTALL THE POST-COMMIT HOOK (server auto-deploy)
#
# Every git commit that touches server/, formations/, or config/ triggers a
# SERVER build + deploy in the background. The CLIENT is never auto-deployed
# -- ship it deliberately with `npm run deploy:client`. A failed build does
# NOT deploy; the commit still stands.
# ----------------------------------------------------------------------------
HOOK="${REPO_DIR}/.git/hooks/post-commit"
log "installing post-commit deploy hook at ${HOOK}"
cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# raindb-starter post-commit hook (installed by scripts/setup.sh).
# Auto-deploys the SERVER when the commit touched server-side files
# (server/, formations/, config/, package.json, esbuild config). The
# client is deliberately NOT auto-deployed -- use `npm run deploy:client`.
set -uo pipefail
REPO_DIR="$(git rev-parse --show-toplevel)"
PROFILE="$(git config --local --get raindb.profile || true)"
if [ -z "$PROFILE" ]; then
  echo "[post-commit] no raindb.profile in .git/config; skipping deploy."
  exit 0
fi
# Did this commit touch the server side?
if ! git diff-tree --no-commit-id --name-only -r HEAD \
    | grep -qE '^(server/|formations/|config/|package\.json|esbuild\.config\.mjs|tsconfig\.json)'; then
  echo "[post-commit] no server-side changes; skipping deploy (client ships via npm run deploy:client)."
  exit 0
fi
echo "[post-commit] server changed -> building + deploying (profile ${PROFILE}); log: ${REPO_DIR}/.deploy.log"
( RAINDB_PROFILE="$PROFILE" bash "${REPO_DIR}/scripts/deploy.sh" --server \
    > "${REPO_DIR}/.deploy.log" 2>&1 \
  && echo "[post-commit] deploy OK ($(date -u +%H:%M:%S))" >> "${REPO_DIR}/.deploy.log" \
  || echo "[post-commit] BUILD/DEPLOY FAILED -- see ${REPO_DIR}/.deploy.log (commit still stands)" >> "${REPO_DIR}/.deploy.log" ) &
exit 0
HOOK_EOF
chmod +x "$HOOK"
log "post-commit hook installed."

# ----------------------------------------------------------------------------
# DONE
# ----------------------------------------------------------------------------
cat <<EOF

[setup] COMPLETE.

  Profile:   ${PROFILE}    (stored in .git/config -> raindb.profile)
  Bolt:      ${BOLT_NAME}
  Live URL:  ${BOLT_URL:-"(unknown -- raindb-cli --profile ${PROFILE} lightning bolt info ${BOLT_NAME})"}

Smoke test:

    curl -s ${BOLT_URL:-https://<bolt-url>}/api/health

Develop (frontend hot-reload against your LIVE bolt):

    cd client && npm install && npm run dev
    # Vite at http://localhost:5173, /api -> your deployed bolt

Ship changes:

    git commit ...            # server-side changes auto-deploy (hook)
    tail -f .deploy.log       # watch the background deploy
    npm run deploy:client     # ship the client when the UI is ready

Now read AGENTS.md for the build-your-app guide.
EOF
