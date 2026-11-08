#!/usr/bin/env bash
set -u
cd /d/Workplace/novarec || exit 9
GCM="/d/Program Files/Git/mingw64/bin/git-credential-manager.exe"
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | "$GCM" get | tr -d '\r' | sed -n 's/^password=//p')
if [ -z "${TOKEN:-}" ]; then echo "NO TOKEN"; exit 3; fi
echo "token_len=${#TOKEN}"
mkdir -p artifacts
GH_TOKEN="$TOKEN" node scripts/create-release.mjs
echo "EXIT=$?"
