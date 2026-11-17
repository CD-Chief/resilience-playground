#!/usr/bin/env bash
# Builds the prod overlay and checks it is safe to deploy.
# Usage: scripts/check-prod-overlay.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="ghcr.io/cd-chief/resilience-playground/"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

kubectl kustomize "$ROOT/k8s/overlays/prod" > "$OUT"
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

# Every image and *_IMAGE value must come from GHCR. Prometheus is the one
# third-party image and is pinned upstream.
refs="$(sed -nE 's/^[[:space:]]*(- )?image:[[:space:]]*"?([^" ]+)"?[[:space:]]*$/\2/p' "$OUT")"
refs="$refs
$(grep -A1 -E 'name: [A-Z]+_IMAGE$' "$OUT" | sed -nE 's/^[[:space:]]*value:[[:space:]]*"?([^" ]+)"?$/\1/p')"
tags=""
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  case "$ref" in
    prom/prometheus:*) continue ;;
    "$PREFIX"*) tags="$tags ${ref##*:}" ;;
    *) bad "image outside GHCR: $ref" ;;
  esac
done <<< "$refs"

if grep -qE "(^|[ \"])resilience-playground/(target|loadgen|controller|web)" "$OUT"; then
  bad "local resilience-playground/ image name remains"
fi

# Every tag must end in the same 7 hex characters.
shas="$(for t in $tags; do echo "${t: -7}"; done | sort -u)"
count="$(echo "$shas" | grep -c . || true)"
[ "$count" -eq 1 ] || bad "tags do not share one SHA7: $(echo $shas)"
for t in $tags; do
  [[ "$t" =~ ^(v1-|v2-broken-|v2-flaky-)?[0-9a-f]{7}$ ]] || bad "unexpected tag format: $t"
done

grep -q 'host: lab.chiefosei.dev' "$OUT" || bad "Ingress has no host lab.chiefosei.dev"
grep -q 'secretName: playground-tls' "$OUT" || bad "Ingress has no TLS secret playground-tls"

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "prod overlay ok (SHA7 $shas, $(echo $tags | wc -w) GHCR refs)"
