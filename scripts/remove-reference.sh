#!/usr/bin/env bash
#
# remove-reference.sh -- graduate from the reference app to YOUR app.
#
# This starter ships with a COMPLETE, deployed reference application under
# reference/ (the "fit" workout + journal app) so you can read a real,
# working example of every RainDB pattern: two-plane reads, versioned
# entries, tokens/counters, zero-knowledge client encryption, an SSE AI
# agent. It is the living documentation.
#
# When you are ready to build your OWN app, run this once. It:
#   1. removes reference/ (the worked example) and its docs,
#   2. removes the pre-commit guard that protected reference/,
#   3. points the build + deploy at app/ (your skeleton),
#   4. leaves your formations/server/client in app/ untouched.
#
# It does NOT touch your tenant, your deployed bolt, or your git history.
# Commit the result and keep building.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ ! -d app ]; then
  echo "[remove-reference] app/ not found -- nothing to graduate to. Aborting." >&2
  exit 1
fi

echo "[remove-reference] removing the reference app (reference/) ..."
git rm -r --quiet reference 2>/dev/null || rm -rf reference

echo "[remove-reference] removing the reference-protection pre-commit guard ..."
rm -f .git/hooks/pre-commit

echo "[remove-reference] pointing the build at app/server ..."
# esbuild entry + the deploy --source both move from reference/ledger to app.
sed -i 's#reference/ledger/server/index.ts#app/server/index.ts#' esbuild.config.mjs
sed -i 's#reference/ledger/server#app/server#g; s#reference/ledger/formations#app/formations#g' scripts/deploy.sh
sed -i 's#../../../client/dist#../../client/dist#g' scripts/deploy.sh

cat <<'DONE'

[remove-reference] Done. The reference app is gone; the build now targets app/.
  Next:
    1. Edit app/formations/*, app/server/*, client/src/* to build your app.
    2. git add -A && git commit -m "start my app"
    3. bash scripts/deploy.sh
DONE
