#!/bin/sh
# Installs Cache Bell from this clone: adds the clone as a plugin catalogue, then installs the plugin from it.
cd "$(dirname "$0")" || exit 1

if ! command -v claude >/dev/null 2>&1; then
  echo "The command 'claude' was not found. Install Claude Code first." >&2
  exit 1
fi

# The path has to be ./ here: a bare dot is refused. A catalogue added before is refreshed instead.
claude plugin marketplace add ./ || claude plugin marketplace update cache-bell || exit 1
claude plugin install cache-bell@cache-bell || exit 1

echo
echo "Cache Bell is installed. No option has to be set: the defaults work."
echo "Start a new Claude Code session; /bell status says what the plugin sees."
echo "In every session already open, run /reload-plugins."
