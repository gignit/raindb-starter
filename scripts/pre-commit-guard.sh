#!/usr/bin/env bash
# pre-commit-guard.sh -- installed as .git/hooks/pre-commit by scripts/setup.sh.
#
# The reference/ tree is the LIVING DOCUMENTATION: a complete, deployed example
# app. It is meant to be READ, not edited -- you build in app/. This guard blocks
# a commit that modifies reference/ so the worked example stays pristine (and your
# diffs stay about YOUR app). When you are ready to build your own, run
# scripts/remove-reference.sh -- it deletes reference/ AND this guard.
#
# Override for a one-off (e.g. you are intentionally improving the reference):
#   ALLOW_REFERENCE_EDIT=1 git commit ...
set -uo pipefail
[ "${ALLOW_REFERENCE_EDIT:-0}" = "1" ] && exit 0

CHANGED="$(git diff --cached --name-only)"
if echo "$CHANGED" | grep -qE '^reference/'; then
  echo "[pre-commit] BLOCKED: this commit edits the reference app (reference/)." >&2
  echo "  reference/ is the read-only worked example. Build YOUR app in app/ instead." >&2
  echo "  - To graduate to your own app:      bash scripts/remove-reference.sh" >&2
  echo "  - To intentionally edit the ref:    ALLOW_REFERENCE_EDIT=1 git commit ..." >&2
  exit 1
fi
exit 0
