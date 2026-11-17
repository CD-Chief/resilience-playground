#!/usr/bin/env bash
# Runs Ansible in Docker against the Terraform-created server.
#
#   scripts/infra-ansible.sh site --first-run   # fresh server: connects as root
#   scripts/infra-ansible.sh site               # later runs: connects as deploy
#   scripts/infra-ansible.sh deploy             # applies the prod overlay
#   scripts/infra-ansible.sh tunnel             # SSH tunnel to the Kubernetes API
#
# SSH_KEY overrides the private key (default ~/.ssh/id_ed25519).
# CLOUDFLARE_API_TOKEN must be set in the shell for `site`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="resilience-playground/ansible:local"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

usage() {
  echo "Usage: scripts/infra-ansible.sh site [--first-run] | deploy | tunnel" >&2
  exit 2
}

# Git Bash on Windows: Docker needs Windows paths and must not get them mangled.
export MSYS_NO_PATHCONV=1
winpath() {
  if (cd "$1" && pwd -W) 2>/dev/null; then return; fi
  (cd "$1" && pwd)
}

[ $# -ge 1 ] || usage
cmd="$1"
shift

[ -f "$SSH_KEY" ] || { echo "SSH key not found: $SSH_KEY (set SSH_KEY to override)" >&2; exit 1; }

step() { printf '\n==> %s\n' "$*"; }

step "Reading the server IP from Terraform"
IP="$("$ROOT/scripts/tf.sh" output -raw ipv4 | tr -d '[:space:]')"
if ! [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not read a server IP from Terraform (got '$IP'). Has 'scripts/tf.sh apply' run?" >&2
  exit 1
fi

if [ "$cmd" = "tunnel" ]; then
  [ $# -eq 0 ] || usage
  cat <<MSG
Kubernetes API tunnel to $IP. Leave this running and use kubectl in another terminal.
Fetch the kubeconfig once (its server stays https://127.0.0.1:6443):

  ssh -i "$SSH_KEY" deploy@$IP sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/resilience-playground.yaml

MSG
  exec ssh -i "$SSH_KEY" -N -L 6443:127.0.0.1:6443 "deploy@$IP"
fi

user="deploy"
case "$cmd" in
  site)
    playbook="site.yml"
    if [ $# -gt 0 ]; then
      [ "$1" = "--first-run" ] && [ $# -eq 1 ] || usage
      user="root"
    fi
    if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
      echo "CLOUDFLARE_API_TOKEN is not set. Set it in your shell and run again." >&2
      exit 1
    fi
    ;;
  deploy)
    [ $# -eq 0 ] || usage
    playbook="deploy.yml"
    ;;
  *) usage ;;
esac

command -v docker >/dev/null || { echo "Missing required tool: docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 1; }

step "Building the Ansible image"
docker build -q -t "$IMAGE" "$ROOT/infra/ansible" >/dev/null

KEY_DIR="$(winpath "$(dirname "$SSH_KEY")")"

step "Running $playbook as $user on $IP"
# The container entrypoint writes the inventory from SERVER_IP, so no IP is
# ever written to the repo.
docker run --rm \
  -v "$(winpath "$ROOT"):/work" \
  -v "$KEY_DIR/$(basename "$SSH_KEY"):/keys/src:ro" \
  -e CLOUDFLARE_API_TOKEN \
  -e "SERVER_IP=$IP" \
  "$IMAGE" \
  ansible-playbook -i /tmp/inventory -e "ansible_user=$user" "$playbook"
