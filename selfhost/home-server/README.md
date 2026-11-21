# Standard Notes home server on myos

The lightweight way to self-host: Standard Notes' **home server** mode, a
single Node.js process with SQLite (plus a small Redis), instead of the
Docker stack in `../`. It runs on any Alpine (musl) Linux root, and so on
[myos](https://github.com/davide-matasci/myos) through its Linux layer
(`docs/linux-compat.md` there).

| File | What |
|---|---|
| `build-bundle.sh` | builds the server from this repository into `sn-home-server-musl-<arch>.tar.gz` (run in Alpine) |
| `update.sh` | updates an installed server to the latest release (with a database backup and automatic rollback) |
| `boot-test.sh` | unpacks a built bundle in a fresh Alpine container and checks that it starts |
| `start.sh` | runs Redis and the server, restarts it if it exits; `start.sh restart` after editing `.env` |
| `env.example` | the settings, copied to `/var/lib/sn/.env` |
| `../../.github/workflows/fork.home-server.yml` | on every merge to `main`: builds and boot-tests the tarball for x86_64 and aarch64 and publishes it as the latest release |
| `../../.github/workflows/fork.pr.yml` | on pull requests: builds and boot-tests the tarball, runs lint, unit tests and the home-server end-to-end suites |

Tested on Alpine 3.24 / Node 24 (Linux kernel): register, sync a note,
sign in from a fresh browser, registration lock, restart. On myos: Node's
JIT, threads and an HTTP server pass on the Linux layer; the full server
there is what the steps below test.

## 0. The download

Every merge to `main` builds the server and publishes it as the latest
release of this repository, with `sn-home-server-musl-x86_64.tar.gz` and
`...-aarch64.tar.gz` (~80 MB each). To build without merging anything:
GitHub → **Actions → Fork Home Server bundle → Run workflow**.

## 1. Install on myos

As root on myos, with the Linux layer loaded (`grep linux /proc/modules`)
and `/data` holding the Alpine root (`get-alpine`). Check space first: the
server needs ~250 MB in `/data` (`df /data`; a disk written straight from
the image has only 64 MiB, see myos `docs/install.md`).

```sh
A=/data/alpine
linux --root $A apk add nodejs redis openssl
cd $A/tmp && curl -fLO https://github.com/davide-matasci/server/releases/latest/download/sn-home-server-musl-x86_64.tar.gz
linux --root $A tar xzf /tmp/sn-home-server-musl-x86_64.tar.gz -C /opt
linux --root $A mkdir -p /var/lib/sn
cp $A/opt/sn/env.example $A/var/lib/sn/.env
```

Fill in `$A/var/lib/sn/.env` (vim): five secrets, generated with
`linux --root $A openssl rand -hex 32` (one per line), and your domains.

## 2. Try it

```sh
linux --root /data/alpine sh /opt/sn/start.sh &
sleep 20; curl -s http://127.0.0.1:3000/healthcheck      # OK
```

Logs: `/data/alpine/var/lib/sn/server.log` and `redis.log`.

## 3. HTTPS

The apps need `https://sync.example.com`. Caddy gets the certificate
automatically and forwards to the server:

```sh
linux --root /data/alpine apk add caddy
cat > /data/alpine/etc/caddy/Caddyfile <<'EOF'
sync.example.com {
	@private path /admin* /internal*
	respond @private 404
	reverse_proxy 127.0.0.1:3000
}
EOF
linux --root /data/alpine caddy run --config /etc/caddy/Caddyfile &
```

DNS: an A record `sync` → the VPS's address; ports 80 and 443 open.

## 4. Start at boot

Append to `/data/etc/rc.local` (after the line that loads the layer):

```sh
linux --root /data/alpine sh /opt/sn/start.sh > /dev/null 2>&1 &
linux --root /data/alpine caddy run --config /etc/caddy/Caddyfile > /tmp/caddy.log 2>&1 &
```

## 5. Use it

Follow `selfhost/README.md` in the [app repository](https://github.com/davide-matasci/app) from step 4 ("Point the web app at it"): GitHub Pages
custom domain, `SYNC_SERVER_URL` = `https://sync.example.com`, create your
account, then set `DISABLE_USER_REGISTRATION=true` in `.env` and
`linux --root /data/alpine sh /opt/sn/start.sh restart`.

## Paid features on your own server

`activate-premium.js` marks an account as subscribed (Pro, until 2099) with
the server's own activation code. The fork's web app then trusts that,
because it counts the server it was built for (`SYNC_SERVER_URL`) as
first-party; other builds ignore subscriptions from third-party servers.

```sh
# bundles built before this script existed: fetch it once
curl -fL -o /data/alpine/opt/sn/activate-premium.js \
  https://raw.githubusercontent.com/davide-matasci/server/main/selfhost/home-server/activate-premium.js
linux --root /data/alpine sh -c 'cd /var/lib/sn && node --require /opt/sn/.pnp.cjs /opt/sn/activate-premium.js you@example.com'
linux --root /data/alpine sh /opt/sn/start.sh restart
```

Then sign out and back in on the web app.

## A new device doesn't download everything

`sync-diag.js` shows, read-only, how the server would page a full download of
each account. It prints only counts, sizes and timestamps. It flags pages that
are very large, and timestamps shared by 150+ items, which paging can't get
past.

```sh
# bundles built before this script existed: fetch it once
curl -fL -o /data/alpine/opt/sn/sync-diag.js \
  https://raw.githubusercontent.com/davide-matasci/server/main/selfhost/home-server/sync-diag.js
linux --root /data/alpine sh -c 'cd /var/lib/sn && node --require /opt/sn/.pnp.cjs /opt/sn/sync-diag.js'
```

## Backups

The whole state is `/data/alpine/var/lib/sn` (the SQLite database and
uploads). Copy it off the machine regularly, e.g. with `scp` from another
computer (dropbear listens on port 2222). For a consistent copy while it
runs, use `linux --root /data/alpine sqlite3 /var/lib/sn/home_server.sqlite
".backup /var/lib/sn/backup.sqlite"` (`apk add sqlite`) and copy that file.

## Updating

Merge the change into `main` (upstream changes too: merge
`standardnotes/server`'s `main` into this fork's) and wait for the release
(Actions → Fork Home Server bundle, ~10 minutes). Then on myos, while the
server runs:

```sh
linux --root /data/alpine sh /opt/sn/update.sh
```

It downloads the latest release, backs up the database to
`/var/lib/sn/backups/` (the newest three are kept), swaps in the new
`/opt/sn` (the old one becomes `/opt/sn.old`), restarts the server and waits
for it to answer. If it doesn't within 90 seconds, it puts the old version
back by itself. Your `.env` and data in `/var/lib/sn` are not touched. It
needs about 450 MB free in `/data`; `rm -rf /data/alpine/opt/sn.old` frees
about 300 MB once you're happy with an update.

- `update.sh` without a newer release does nothing; `update.sh --force`
  reinstalls the latest one.
- `update.sh rollback` swaps back to the previous version (run it again to
  undo the rollback).

**First time, on a server installed before `update.sh` existed** (built from
the app repository): fetch the script once, then run it as above.

```sh
curl -fL -o /data/alpine/opt/sn/update.sh \
  https://raw.githubusercontent.com/davide-matasci/server/main/selfhost/home-server/update.sh
```
