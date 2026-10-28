#!/bin/sh
# Isolated, disposable Docker integration. Never touches the default project volume.
set -eu
umask 077
export COMPOSE_FILE=compose.yaml
export COMPOSE_PROJECT_NAME="choral-check-$$"
export CHORAL_IMAGE_TAG="check-$$"
export CHORAL_HTTP_PORT=0
export CHORAL_ORIGIN=https://localhost
backup=$(mktemp -d)
rmdir "$backup"
cleanup() {
 docker compose down -v >/dev/null 2>&1 || true
 rm -rf "$backup"
}
trap cleanup EXIT HUP INT TERM
wait_ready() {
 n=0
 until docker compose exec -T app choral-server healthcheck; do
  n=$((n+1)); test "$n" -lt 60; sleep 1
 done
}
verify() {
 docker compose exec -T app sh -ec '
  test "$(sqlite3 /data/choral.sqlite "SELECT email_normalized FROM users WHERE id='"'"'container-control'"'"';")" = control@example.test
  test "$(cat /data/control-file)" = synthetic-control
 '
}
docker compose build
docker compose up -d
wait_ready
endpoint="http://$(docker compose port app 8080)"
curl -fsS "$endpoint/livez" >/dev/null
curl -fsS "$endpoint/readyz" >/dev/null
html=$(curl -fsS "$endpoint/listen/deep?list=synthetic")
asset=$(printf '%s' "$html" | sed -n 's/.*src="\(\/assets\/[^" ]*\.js\)".*/\1/p' | head -1)
test -n "$asset"
curl -fsS "$endpoint$asset?version=1" >/dev/null
test "$(curl -s -o /dev/null -w '%{http_code}' "$endpoint/assets/missing.js")" = 404
test "$(curl -s -o /dev/null -w '%{http_code}' "$endpoint/api/missing")" = 404
docker compose exec -T app sh -ec '
 test "$(id -u)" = 10001
 ! touch /app/forbidden 2>/dev/null
 sqlite3 /data/choral.sqlite "INSERT INTO users VALUES ('"'"'container-control'"'"','"'"'control@example.test'"'"','"'"'fictional-hash'"'"','"'"'teacher'"'"',NULL,1,'"'"'now'"'"','"'"'now'"'"');"
 printf synthetic-control > /data/control-file
'
docker compose restart
wait_ready
verify
docker compose up -d --build --force-recreate
wait_ready
verify
# stop sends SIGTERM; exit code distinguishes graceful stop from SIGKILL.
docker compose stop app
container=$(docker compose ps -aq app)
test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" = 0
sh scripts/backup-restore.sh backup "$backup"
# Removing only this disposable project creates a genuinely clean named volume.
docker compose down -v
sh scripts/backup-restore.sh restore "$backup"
docker compose up -d
wait_ready
verify
echo 'PASS: build, health, routes/assets, nonroot/read-only, restart/rebuild persistence, SIGTERM, clean restore'
