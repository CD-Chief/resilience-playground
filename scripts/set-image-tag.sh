#!/usr/bin/env bash
# Rewrites every image tag in k8s/overlays/prod to the given commit tag.
# Usage: scripts/set-image-tag.sh <SHA7>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/k8s/overlays/prod"

if [ "$#" -ne 1 ] || ! [[ "$1" =~ ^[0-9a-f]{7}$ ]]; then
  echo "usage: scripts/set-image-tag.sh <SHA7>  (exactly 7 lowercase hex characters, got '${1:-}')" >&2
  exit 1
fi
TAG="$1"

# Tags look like 0000000, v1-0000000, v2-broken-0000000 and v2-flaky-0000000.
# Only the trailing 7 hex characters change.
for f in kustomization.yaml controller-env.yaml; do
  before="$(cat "$DIR/$f")"
  sed -i -E \
    -e "s/^(    newTag: \"?(v1-|v2-broken-|v2-flaky-)?)[0-9a-f]{7}(\"?)\$/\1$TAG\3/" \
    -e "s#^(  *value: ghcr\.io/cd-chief/resilience-playground/target:v(1|2-broken|2-flaky)-)[0-9a-f]{7}\$#\1$TAG#" \
    "$DIR/$f"
  if [ "$before" = "$(cat "$DIR/$f")" ]; then
    echo "unchanged: k8s/overlays/prod/$f"
  else
    echo "updated:   k8s/overlays/prod/$f"
  fi
done
grep -hE 'newTag:|_IMAGE' -A1 "$DIR/kustomization.yaml" "$DIR/controller-env.yaml" | grep -E 'newTag|value:' || true
