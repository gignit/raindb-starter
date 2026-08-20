#!/usr/bin/env bash
# redeploy.sh -- rebuild + redeploy the FitLedger reference bolt to vector-sandbox1.
# Secrets are already staged; drop --from-secrets. The platform re-bundles from
# --source (entry relative to it), and --client-dist is relative to --source.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build >/dev/null
( cd client && npm run build >/dev/null )
~/raindb/bin/raindb-cli --profile vector-sandbox1 --timeout 180 lightning bolt deploy \
  --name fitledger-ref --engine goja \
  --source reference/ledger/server --entry index.ts \
  --capabilities "$PWD/config/capabilities.json" --routes "$PWD/config/routes.json" \
  --deployment "$PWD/config/deployment.json" --client-dist "../../../client/dist" 2>&1 | tail -4
