#!/bin/sh
# Runs Redis and the Standard Notes home server inside the Alpine root,
# restarting the server whenever it exits. On myos:
#   linux --root /data/alpine sh /opt/sn/start.sh            # run (stays in the foreground)
#   linux --root /data/alpine sh /opt/sn/start.sh restart    # after editing .env
# Settings: /var/lib/sn/.env (from env.example). Logs: /var/lib/sn/*.log
#
# The server does not exit on SIGTERM (it closes its port but its Redis
# client keeps it alive), so restart uses SIGKILL. SQLite keeps the
# database consistent across that.
set -u
DATA=/var/lib/sn
APP=/opt/sn
PIDFILE="$DATA/server.pid"

if [ "${1:-}" = restart ]; then
  [ -s "$PIDFILE" ] && kill -9 "$(cat "$PIDFILE")" 2>/dev/null \
    && echo "server stopped; start.sh brings it back in 5s" \
    || echo "no running server found ($PIDFILE)"
  exit 0
fi

cd "$DATA" || { echo "start.sh: create $DATA and its .env first" >&2; exit 1; }
[ -f .env ] || { echo "start.sh: $DATA/.env is missing (copy $APP/env.example)" >&2; exit 1; }
mkdir -p uploads

redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no \
  >> "$DATA/redis.log" 2>&1 &

# The server reads .env from its working directory, so it runs from $DATA;
# Yarn's resolver (.pnp.cjs) finds its dependencies in $APP.
while :; do
  node --require "$APP/.pnp.cjs" "$APP/packages/home-server/dist/bin/server.js" \
    >> "$DATA/server.log" 2>&1 &
  echo $! > "$PIDFILE"
  wait $!
  echo "$(date) server exited ($?), restarting in 5s" >> "$DATA/server.log"
  sleep 5
done
