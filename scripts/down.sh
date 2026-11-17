#!/usr/bin/env bash
# Deletes the local k3d cluster and everything in it.
set -euo pipefail

CLUSTER="${CLUSTER:-resilience-playground}"

command -v k3d >/dev/null || { echo "Missing required tool: k3d" >&2; exit 1; }

if k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$CLUSTER"; then
  k3d cluster delete "$CLUSTER"
else
  echo "Cluster '$CLUSTER' does not exist. Nothing to do."
fi
