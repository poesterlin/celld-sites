#!/bin/sh
# Stages the store build of this site in <out-dir>: the built output, hamstr.json
# and a celld.json WITHOUT "auth". Inside a Hamstr grain, Hamstr signs people in;
# "auth" would make the router send the frame to the auth service, which refuses
# framing. The standalone deploy (tools/deploy.sh sites/authdemo <host>) keeps
# "auth": "required" from this directory's celld.json.
#
#   sites/authdemo/stage-store.sh /tmp/authdemo-store
#   node store/cli/hamstr.ts publish /tmp/authdemo-store --no-build
set -eu
out="${1:?usage: stage-store.sh <out-dir>}"
here=$(cd "$(dirname "$0")" && pwd)
(cd "$here" && npm run build >/dev/null)
rm -rf "$out"
mkdir -p "$out"
cp -R "$here/.svelte-kit" "$out/.svelte-kit" # the worker imports from output/ too
cp "$here/hamstr.json" "$out/"
node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
delete c.auth;
require("fs").writeFileSync(process.argv[2], JSON.stringify(c, null, "\t") + "\n");
' "$here/celld.json" "$out/celld.json"
ln -s "$here/node_modules" "$out/node_modules" # pack.ts finds esbuild there
