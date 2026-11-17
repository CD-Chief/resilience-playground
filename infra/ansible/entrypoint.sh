#!/bin/sh
# Windows mounts show every file as 0777 and ssh rejects such a key, so the
# mounted key is copied to a private location with the right mode first.
set -eu

if [ -f /keys/src ]; then
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  cp /keys/src "$HOME/.ssh/id"
  chmod 600 "$HOME/.ssh/id"
fi

# The inventory exists only inside the container, so no IP is written to the repo.
if [ -n "${SERVER_IP:-}" ]; then
  printf '[server]\n%s\n' "$SERVER_IP" > /tmp/inventory
fi

exec "$@"
