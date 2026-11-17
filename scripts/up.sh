#!/usr/bin/env bash
# Creates the local k3d cluster (or reuses it), builds the images and deploys
# everything. Safe to run again after changing code.
#
#   PORT=9000 scripts/up.sh     # serve on another local port (first run only)
set -euo pipefail

CLUSTER="${CLUSTER:-resilience-playground}"
PORT="${PORT:-8080}"
ARGO_ROLLOUTS_VERSION="v1.10.2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT="k3d-${CLUSTER}"

step() { printf '\n==> %s\n' "$*"; }
# Every kubectl call names the context, so this can never touch another cluster.
k() { kubectl --context "$CONTEXT" "$@"; }

for tool in docker k3d kubectl; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 1; }

existed=false
if k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$CLUSTER"; then
  existed=true
  step "Using existing cluster '$CLUSTER'"
else
  step "Creating cluster '$CLUSTER' (http://localhost:${PORT})"
  k3d cluster create "$CLUSTER" \
    --port "${PORT}:80@loadbalancer" \
    --kubeconfig-switch-context=false \
    --wait --timeout 180s
fi

step "Building images"
docker build -q -t resilience-playground/target:v1 --build-arg VERSION=v1 "$ROOT/apps/target"
docker build -q -t resilience-playground/target:v2-broken --build-arg VERSION=v2-broken --build-arg BROKEN=true "$ROOT/apps/target"
docker build -q -t resilience-playground/target:v2-flaky --build-arg VERSION=v2-flaky --build-arg ERROR_RATE=0.5 "$ROOT/apps/target"
docker build -q -t resilience-playground/loadgen:v1 "$ROOT/apps/loadgen"
docker build -q -t resilience-playground/controller:v1 "$ROOT/apps/controller"
docker build -q -t resilience-playground/web:v1 "$ROOT/apps/web"

step "Importing images into the cluster"
k3d image import --cluster "$CLUSTER" \
  resilience-playground/target:v1 \
  resilience-playground/target:v2-broken \
  resilience-playground/target:v2-flaky \
  resilience-playground/loadgen:v1 \
  resilience-playground/controller:v1 \
  resilience-playground/web:v1

step "Installing Argo Rollouts ${ARGO_ROLLOUTS_VERSION}"
k create namespace argo-rollouts --dry-run=client -o yaml | k apply -f - >/dev/null
# Server-side apply: the CRDs are too large for a client-side apply.
k apply --server-side --force-conflicts -n argo-rollouts \
  -f "https://github.com/argoproj/argo-rollouts/releases/download/${ARGO_ROLLOUTS_VERSION}/install.yaml" >/dev/null
k wait --for=condition=Established crd/rollouts.argoproj.io --timeout=60s >/dev/null
k -n argo-rollouts rollout status deployment/argo-rollouts --timeout=180s

step "Applying manifests"
k apply -k "$ROOT/k8s"

if [ "$existed" = true ]; then
  step "Restarting workloads to pick up the rebuilt images"
  k -n platform rollout restart deployment/controller deployment/web
  k -n sandbox rollout restart deployment/loadgen
  k -n sandbox patch rollout target --type merge \
    -p "{\"spec\":{\"restartAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}"
fi

step "Waiting for everything to be ready"
k -n platform rollout status deployment/controller --timeout=180s
k -n platform rollout status deployment/web --timeout=180s
k -n monitoring rollout status deployment/prometheus --timeout=180s
k -n sandbox rollout status deployment/loadgen --timeout=180s
k -n sandbox wait rollout/target "--for=jsonpath={.status.phase}=Healthy" --timeout=180s

cat <<EOF

Resilience Playground is running.

  Open:      http://localhost:${PORT}
  Pods:      kubectl --context ${CONTEXT} -n sandbox get pods
  Traffic:   kubectl --context ${CONTEXT} -n sandbox logs deployment/loadgen -f
  Stop:      scripts/down.sh
EOF
