#!/bin/sh
# Hosts like Render mount the persistent disk owned by root. Fix that, then run the app as the
# unprivileged "user". Where the container already starts as that user, just run it.
set -e

# the folders the app writes to; made as the app's own user so it can always write to them
PREPARE='mkdir -p data/knowledge_base data/logs data/uploads data/exports; exec "$@"'

if [ "$(id -u)" = "0" ]; then
  mkdir -p data
  # give everything under data/ to the app user if anything there belongs to someone else
  if [ -n "$(find data ! -user 1000 -print -quit)" ]; then
    chown -R 1000:1000 data
  fi
  exec setpriv --reuid=1000 --regid=1000 --init-groups sh -c "$PREPARE" sh "$@"
fi

exec sh -c "$PREPARE" sh "$@"
