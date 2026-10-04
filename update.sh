#!/bin/sh
# Updates Cache Bell installed from this clone: pulls the clone, then refreshes the catalogue and the plugin.
cd "$(dirname "$0")" || exit 1

if ! command -v claude >/dev/null 2>&1; then
  echo "The command 'claude' was not found. Install Claude Code first." >&2
  exit 1
fi

# Only what can be fast-forwarded: local changes in the clone are never overwritten.
git pull --ff-only || exit 1
claude plugin marketplace update cache-bell || exit 1
claude plugin update cache-bell@cache-bell || exit 1

echo
echo "Cache Bell is up to date. Sessions that are open pick it up with /reload-plugins; new ones have it."
