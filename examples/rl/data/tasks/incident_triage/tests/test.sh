#!/bin/sh
set -eu
mkdir -p /logs/verifier

if [ ! -f /workspace/report.json ]; then
  echo 0.0 > /logs/verifier/reward.txt
  exit 0
fi

ERR_CNT=$(jq -r '.error_count // empty' /workspace/report.json 2>/dev/null || true)
SVC=$(jq -r '.slowest_service // empty' /workspace/report.json 2>/dev/null || true)
MAX_LAT=$(jq -r '.max_latency_ms // empty' /workspace/report.json 2>/dev/null || true)
OWNER=$(jq -r '.owner // empty' /workspace/report.json 2>/dev/null || true)

POSTED=$(slack read-messages --channel C2 --limit 1 | jq -r '.[0].text // empty' 2>/dev/null || true)
POST_SVC=$(printf '%s\n' "$POSTED" | jq -r '.slowest_service // empty' 2>/dev/null || true)
POST_OWNER=$(printf '%s\n' "$POSTED" | jq -r '.owner // empty' 2>/dev/null || true)

if [ "$ERR_CNT" = "3" ] \
  && [ "$SVC" = "billing-svc" ] \
  && [ "$MAX_LAT" = "528" ] \
  && [ "$OWNER" = "payments-team" ] \
  && [ "$POST_SVC" = "billing-svc" ] \
  && [ "$POST_OWNER" = "payments-team" ]; then
  echo 1.0 > /logs/verifier/reward.txt
else
  echo 0.0 > /logs/verifier/reward.txt
fi
