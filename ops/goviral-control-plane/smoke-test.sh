#!/usr/bin/env bash
set -Eeuo pipefail

BASE="http://127.0.0.1:8180"
QUEUE="/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsS "$BASE/api/goviral/overview" > "$TMP/overview.json"
curl -fsS "$BASE/api/goviral/approvals" > "$TMP/approvals.json"
curl -fsS "$BASE/api/goviral/runtime" > "$TMP/runtime.json"
curl -fsS "$BASE/api/goviral/incidents" > "$TMP/incidents.json"
curl -fsS "$BASE/api/goviral/goals" > "$TMP/goals.json"
curl -fsS "$BASE/api/goviral/agents" > "$TMP/agents.json"
curl -fsS "$BASE/api/goviral/actions" > "$TMP/actions.json"

before="$(sha256sum "$QUEUE" | awk '{print $1}')"

python3 - "$TMP/approvals.json" "$TMP/actions.json" "$TMP/request.json" <<'PY'
import json
import sys
from pathlib import Path

approvals = json.loads(Path(sys.argv[1]).read_text())
actions = json.loads(Path(sys.argv[2]).read_text())
pending = [item for item in approvals.get('items', []) if item.get('status') == 'pending']
if not pending:
    raise SystemExit('No pending approval available for negative test')
request = {
    'action': 'approve',
    'target': pending[0]['id'],
    'confirmation': 'INTENTIONALLY WRONG',
    'csrf': actions['csrf'],
}
Path(sys.argv[3]).write_text(json.dumps(request))
PY

status="$(curl -sS -o "$TMP/action-response.json" -w '%{http_code}' \
  -H 'Origin: http://127.0.0.1:8180' \
  -H 'Content-Type: application/json' \
  --data-binary @"$TMP/request.json" \
  "$BASE/api/goviral/actions")"

test "$status" = "400"
after="$(sha256sum "$QUEUE" | awk '{print $1}')"
test "$before" = "$after"

grep -Rqs 'Search, Governed Actions & Audit' /opt/goviral-archon-src/packages/web/dist/assets

echo "read_endpoints=true"
echo "negative_action_status=$status"
echo "queue_unchanged=true"
echo "operator_ui_bundle=true"
