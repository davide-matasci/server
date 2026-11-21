#!/bin/sh
# Builds the Standard Notes "home server" (one Node.js process, SQLite, no
# MySQL/localstack) from this repository into a self-contained tarball for an
# Alpine (musl) root, such as myos's Linux layer.
#
# Run inside Alpine, from a checkout (the fork's workflow uses the alpine container):
#   sh selfhost/home-server/build-bundle.sh OUT_DIR
set -eu

OUT="${1:?usage: build-bundle.sh OUT_DIR}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"

apk add --no-cache nodejs npm git python3 make g++ sqlite-dev tar gzip >/dev/null

COMMIT="$(git -c safe.directory='*' -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

# Build in a copy, so the checkout stays as it is.
mkdir -p "$WORK/src"
tar cf - -C "$ROOT" --exclude=./.git --exclude=./out --exclude=node_modules . | tar xf - -C "$WORK/src"

cd "$WORK/src"
yarn() { node .yarn/releases/yarn-*.cjs "$@"; }
yarn install
yarn workspaces foreach -Rpt --from @standardnotes/home-server run build

# Production-only copy: compiled JavaScript and runtime dependencies.
mkdir -p "$WORK/sn"
tar cf - --exclude='*.ts' --exclude='*.map' --exclude=./selfhost . | tar xf - -C "$WORK/sn"
cd "$WORK/sn"
yarn workspaces focus @standardnotes/home-server --production
rm -rf packages/home-server/dist/data packages/home-server/.env
cp "$HERE/start.sh" "$HERE/env.example" "$HERE/activate-premium.js" "$HERE/sync-diag.js" "$HERE/update.sh" .
echo "$COMMIT" > SERVER_REF

arch="$(uname -m)"
mkdir -p "$OUT"
tar czf "$OUT/sn-home-server-musl-$arch.tar.gz" -C "$WORK" sn
echo "Built $OUT/sn-home-server-musl-$arch.tar.gz from $COMMIT"
