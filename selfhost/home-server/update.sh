#!/bin/sh
# Updates the home server in this Alpine root to the latest release of the
# fork, keeping the previous version for a rollback. On myos:
#   linux --root /data/alpine sh /opt/sn/update.sh            # update if a newer release exists
#   linux --root /data/alpine sh /opt/sn/update.sh --force    # reinstall the latest release
#   linux --root /data/alpine sh /opt/sn/update.sh rollback   # go back to the previous version
#
# Steps: download the latest release, back up the database, swap /opt/sn
# (the old one becomes /opt/sn.old), restart, and wait for /healthcheck.
# If the new version doesn't come up within 90s it rolls back by itself.
# Your settings and data in /var/lib/sn are not touched (except backups/).
# start.sh must be running: it starts the new version after the restart.
set -eu
REPO="${SN_REPO:-davide-matasci/server}"
APP=/opt/sn
DATA=/var/lib/sn
BACKUPS="$DATA/backups"
PIDFILE="$DATA/server.pid"
WORK=/opt/sn-update
# If this script is /opt/sn/update.sh, run a copy: the update replaces /opt/sn.
if [ "${SN_UPDATE_COPY:-}" != 1 ]; then
  cp "$0" /tmp/sn-update.sh
  SN_UPDATE_COPY=1 exec sh /tmp/sn-update.sh "$@"
fi

say() { echo "update: $*"; }
die() { echo "update: $*" >&2; exit 1; }

restart() {
  [ -s "$PIDFILE" ] && kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
}

healthy() {
  # start.sh brings the server back 5s after it exits; startup takes ~10-30s.
  i=0
  sleep 6
  while [ $i -lt 90 ]; do
    if node -e "fetch('http://127.0.0.1:3000/healthcheck').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
      return 0
    fi
    i=$((i + 2)); sleep 2
  done
  return 1
}

swap_back() {
  [ -d "$APP.old" ] || die "no previous version in $APP.old"
  rm -rf "$APP.failed"
  mv "$APP" "$APP.failed"
  mv "$APP.old" "$APP"
  mv "$APP.failed" "$APP.old"
  restart
  if healthy; then
    say "back on $(cat "$APP/SERVER_REF" 2>/dev/null || echo '?'); the other version is in $APP.old"
  else
    die "the server doesn't answer after the rollback either: see $DATA/server.log"
  fi
}

[ -d "$DATA" ] && [ -f "$DATA/.env" ] || die "$DATA/.env not found: run this inside the server's Alpine root"
[ -s "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null || die "the server isn't running: start it with start.sh first"

if [ "${1:-}" = rollback ]; then
  say "rolling back to the previous version"
  swap_back
  exit 0
fi

current="$(cat "$APP/SERVER_REF" 2>/dev/null || echo unknown)"
short="$(echo "$current" | cut -c1-7)"
arch="$(uname -m)"

# The latest release: its tag (home-server-<commit>) and this machine's tarball.
release="$(node -e "
  fetch('https://api.github.com/repos/$REPO/releases/latest', { headers: { 'User-Agent': 'sn-home-server-update' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('GitHub answered ' + r.status))))
    .then((rel) => {
      const asset = rel.assets.find((a) => a.name === 'sn-home-server-musl-$arch.tar.gz')
      if (!asset) throw new Error('release ' + rel.tag_name + ' has no tarball for $arch')
      console.log(rel.tag_name + ' ' + asset.browser_download_url)
    })
    .catch((e) => { console.error(e.message); process.exit(1) })
")" || die "can't read the latest release of $REPO"
tag="${release%% *}"
url="${release#* }"
latest="${tag#home-server-}"

case "$current" in
  "$latest"*)
    if [ "${1:-}" != --force ]; then
      say "already up to date ($tag)"
      exit 0
    fi ;;
esac
say "installed: $short, latest: $tag"

# Space: the tarball (~80 MB) and the unpacked version (~300 MB) next to the current one.
free_kb="$(df -Pk /opt 2>/dev/null | awk 'NR == 2 { print $4 }')"
if [ -z "$free_kb" ]; then
  say "can't tell the free space here (df); continuing: about 450 MB are needed"
elif [ "$free_kb" -lt 450000 ]; then
  die "only $((free_kb / 1024)) MB free for /opt; about 450 MB needed (rm -rf $APP.old frees ~300 MB)"
fi

rm -rf "$WORK"
mkdir -p "$WORK"
say "downloading $url"
node -e "
  const fs = require('fs')
  const { Readable } = require('stream')
  const { pipeline } = require('stream/promises')
  fetch('$url', { headers: { 'User-Agent': 'sn-home-server-update' } })
    .then((r) => (r.ok ? pipeline(Readable.fromWeb(r.body), fs.createWriteStream('$WORK/sn.tar.gz')) : Promise.reject(new Error('download answered ' + r.status))))
    .catch((e) => { console.error(e.message); process.exit(1) })
" || die "download failed"
tar xzf "$WORK/sn.tar.gz" -C "$WORK" || die "the download is damaged"
rm "$WORK/sn.tar.gz"
[ -f "$WORK/sn/packages/home-server/dist/bin/server.js" ] && [ -f "$WORK/sn/start.sh" ] || die "the tarball doesn't contain a server"

# Consistent copy of the database while the server runs; keeps the newest three.
mkdir -p "$BACKUPS"
backup="$BACKUPS/home_server-$(date +%Y%m%d-%H%M%S)-$short.sqlite"
db_path="$(sed -n 's/^DB_SQLITE_DATABASE_PATH=//p' "$DATA/.env" | tail -1)"
[ -f "$db_path" ] || die "database $db_path (DB_SQLITE_DATABASE_PATH in .env) not found"
say "backing up the database to $backup"
SN_APP="$APP" SN_DB="$db_path" SN_BACKUP="$backup" node --require "$APP/.pnp.cjs" -e "
  const requireFromServer = require('module').createRequire(process.env.SN_APP + '/packages/syncing-server/package.json')
  const sqlite3 = requireFromServer('sqlite3')
  const db = new sqlite3.Database(process.env.SN_DB)
  db.serialize(() => {
    db.run('PRAGMA busy_timeout = 10000')
    db.run('PRAGMA temp_store = MEMORY')
    db.run('VACUUM INTO ?', [process.env.SN_BACKUP], (e) => {
      if (e) { console.error(e.message); process.exit(1) }
      db.close()
    })
  })
" || die "database backup failed; nothing was changed"
ls -1t "$BACKUPS"/home_server-*.sqlite 2>/dev/null | tail -n +4 | xargs -r rm -f

rm -rf "$APP.old"
mv "$APP" "$APP.old"
mv "$WORK/sn" "$APP"
rmdir "$WORK"
say "restarting"
restart
if healthy; then
  say "done: now on $tag; the previous version is in $APP.old (update.sh rollback)"
else
  echo "update: the new version doesn't answer /healthcheck; rolling back (its log: $DATA/server.log)" >&2
  swap_back
  exit 1
fi
