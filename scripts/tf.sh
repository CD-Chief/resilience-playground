#!/usr/bin/env bash
# Runs Terraform in Docker against infra/terraform. Arguments pass through:
#
#   export HCLOUD_TOKEN=... CLOUDFLARE_API_TOKEN=...
#   scripts/tf.sh plan
#   scripts/tf.sh output -raw ipv4
set -euo pipefail

TERRAFORM_IMAGE="hashicorp/terraform:1.17.1"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Docker on Windows needs a Windows path; pwd -W only exists in Git Bash.
if MOUNT_ROOT="$(cd "$ROOT" && pwd -W 2>/dev/null)"; then :; else MOUNT_ROOT="$ROOT"; fi

command -v docker >/dev/null || { echo "Missing required tool: docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 1; }

case "${1:-}" in
  plan|apply|destroy|import|refresh)
    [ -n "${HCLOUD_TOKEN:-}" ] || { echo "HCLOUD_TOKEN is not set. Export your Hetzner Cloud API token first." >&2; exit 1; }
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "CLOUDFLARE_API_TOKEN is not set. Export your Cloudflare API token first." >&2; exit 1; }
    ;;
esac

# Tokens go in by name only, so they never show up in the process list.
docker_args=(run --rm)
if [ -t 0 ] && [ -t 1 ]; then docker_args+=(-it); fi
if [ -n "${HCLOUD_TOKEN:-}" ]; then
  export TF_VAR_hcloud_token="$HCLOUD_TOKEN"
  docker_args+=(-e TF_VAR_hcloud_token)
fi
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  export TF_VAR_cloudflare_api_token="$CLOUDFLARE_API_TOKEN"
  docker_args+=(-e TF_VAR_cloudflare_api_token)
fi

# MSYS_NO_PATHCONV stops Git Bash rewriting /workspace into a Windows path.
MSYS_NO_PATHCONV=1 docker "${docker_args[@]}" \
  -v "$MOUNT_ROOT/infra/terraform:/workspace" -w /workspace \
  "$TERRAFORM_IMAGE" "$@"
