#!/bin/sh
# Unpacks a built bundle into a fresh Alpine container, starts it with
# start.sh and a throwaway .env, and waits for /healthcheck.
#   sh selfhost/home-server/boot-test.sh OUT_DIR    (needs Docker)
set -eu
OUT="$(cd "${1:?usage: boot-test.sh OUT_DIR}" && pwd)"
tarball="$(ls "$OUT"/sn-home-server-musl-*.tar.gz | head -1)"

docker run --rm -v "$tarball:/bundle.tar.gz:ro" alpine:3 sh -euc '
  apk add --no-cache nodejs redis curl >/dev/null
  tar xzf /bundle.tar.gz -C /opt
  mkdir -p /var/lib/sn
  secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n"; }
  sed -e "s/^\(JWT_SECRET\|AUTH_JWT_SECRET\|ENCRYPTION_SERVER_KEY\|PSEUDO_KEY_PARAMS_KEY\|VALET_TOKEN_SECRET\)=$/\1=$(secret)/" \
    /opt/sn/env.example > /var/lib/sn/.env
  sh /opt/sn/start.sh &
  for i in $(seq 90); do
    if curl -sf http://127.0.0.1:3000/healthcheck >/dev/null; then
      echo "healthcheck OK after ${i}s ($(cat /opt/sn/SERVER_REF))"
      exit 0
    fi
    sleep 1
  done
  echo "server did not answer /healthcheck in 90s:" >&2
  tail -50 /var/lib/sn/server.log >&2
  exit 1
'
