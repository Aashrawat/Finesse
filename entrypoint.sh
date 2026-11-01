#!/bin/sh
# Hosts like Render mount the persistent disk owned by root. Fix that once, then run the app as the
# unprivileged "user". Where the container already starts as that user (Hugging Face Spaces), just run it.
set -e

mkdir -p data/knowledge_base data/logs  # a freshly mounted disk is empty

if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u data)" != "1000" ]; then
    chown -R 1000:1000 data
  fi
  exec setpriv --reuid=1000 --regid=1000 --init-groups "$@"
fi

exec "$@"
