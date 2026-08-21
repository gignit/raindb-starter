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
#       raindb-cli user register --email <you> --name "<Name>"   # or: user login
#       raindb-cli group create --name <org>       # an org to own the tenant
#       raindb-cli plan list                       # the tiers; NAME is the slug,
#                                                  # pick one AVAILABLE=True
#       raindb-cli tenant create --group <org> --name <name> --tier <slug>
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
        raindb-cli user register --email <you> --name \"<Name>\"   # or: user login
        raindb-cli group create --name <org>
        raindb-cli plan list                       # pick a --tier slug (AVAILABLE=True)
        raindb-cli tenant create --group <org> --name <name> --tier <slug>
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
# Deploys the SERVER when the commit touched server-side files (server/,
# formations/, config/, package.json, esbuild/tsconfig). The client is
# deliberately NOT auto-deployed -- ship it with `npm run deploy:client`.
#
# It runs the deploy in the FOREGROUND and reports the real outcome: on
# failure it prints the deploy error and exits non-zero, so you (or your
# agent) cannot miss a broken deploy. A failed deploy does NOT undo the
# commit -- fix and commit again.
set -uo pipefail
REPO_DIR="$(git rev-parse --show-toplevel)"
PROFILE="$(git config --local --get raindb.profile || true)"

# A commit with no configured profile means the app was never set up. Do
# NOT skip silently -- tell the human/agent exactly how to get a working
# RainDB account + tenant + profile, then re-run setup.
if [ -z "$PROFILE" ]; then
  cat >&2 <<'MSG'
[post-commit] STOP: this repo has no RainDB profile, so the bolt cannot deploy.

You need a RainDB account + a tenant, then a local profile pointing at it.

  From zero (CLI only -- an agent can run these):
    raindb-cli user register --email <you> --name "<Name>"   # or: user login
    raindb-cli group create --name <org>       # an org to own the tenant
    raindb-cli plan list                       # the tiers; NAME is the slug,
                                               # pick one whose AVAILABLE is True
    raindb-cli tenant create --group <org> --name <name> --tier <slug>
                                               # provisions the tenant AND writes +
                                               # prints a profile core.<env>.<name>
  Then finish setup (publishes formations, stages secrets, deploys, installs this hook):
    scripts/setup.sh --profile core.<env>.<name>

  Already have a tenant (e.g. from the raindb.io onboarding page)?
    raindb-cli profile setup --name <p> --token <bootstrap-key> \
      --api-url <api-url> --tenant-id <id> --realm-id <realm> --region <region>
    scripts/setup.sh --profile <p>

Docs: ~/.local/share/raindb/RAINDB_GUIDE.md  (section "Getting set up")
MSG
  exit 1
fi

# Did this commit touch the server side? (Client-only/doc-only commits do
# not deploy -- that is intended, not a silent failure.)
if ! git diff-tree --no-commit-id --name-only -r HEAD \
    | grep -qE '^(server/|formations/|config/|package\.json|esbuild\.config\.mjs|tsconfig\.json)'; then
  echo "[post-commit] no server-side changes in this commit; nothing to deploy (ship the client with: npm run deploy:client)."
  exit 0
fi

echo "[post-commit] server changed -> building + deploying (profile ${PROFILE})"
echo "[post-commit] full log: ${REPO_DIR}/.deploy.log"
# Foreground: tee to the log AND the terminal, and capture the deploy's
# real exit code (PIPESTATUS[0], not tee's).
set -o pipefail
RAINDB_PROFILE="$PROFILE" bash "${REPO_DIR}/scripts/deploy.sh" --server 2>&1 | tee "${REPO_DIR}/.deploy.log"
RC=${PIPESTATUS[0]}
if [ "$RC" -eq 0 ]; then
  echo "[post-commit] deploy OK ($(date -u +%H:%M:%S))"
  exit 0
fi
echo "[post-commit] DEPLOY FAILED (exit ${RC}) -- the error is above and in ${REPO_DIR}/.deploy.log." >&2
echo "[post-commit] Your commit still stands; fix the error and commit again (or run: npm run deploy)." >&2
exit "$RC"
HOOK_EOF
chmod +x "$HOOK"
log "post-commit hook installed (foreground deploy, hard-fails on missing profile / deploy error)."

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
