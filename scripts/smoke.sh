#!/usr/bin/env sh
set -eu

npm test
tmpdir="$(mktemp -d)"
mkdir -p "$tmpdir/source"
printf 'hello\n' > "$tmpdir/source/hello.txt"
KAKURIZAI_HOME="$tmpdir/home" node ./bin/agctl.js create --source "$tmpdir/source" --name smoke --backend cube-sandbox-overlay >"$tmpdir/create.json"
KAKURIZAI_HOME="$tmpdir/home" node ./bin/agctl.js list
