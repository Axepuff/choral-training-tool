#!/bin/sh
# Run from the release checkout, under the operator's maintenance lock.
set -eu
umask 077
test "$#" -eq 1
case "$1" in /*) ;; *) echo 'Backup root must be absolute.' >&2; exit 2;; esac
test -d "$1" && test -w "$1"
container=$(docker compose ps --status running -q app)
test -n "$container" || { echo 'App is stopped; no scheduled backup.' >&2; exit 1; }
backup="$1/$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$backup"
# Restore availability even when archive creation fails; preserve the failure status.
resume() {
 status=$?
 trap - EXIT HUP INT TERM
 docker compose up -d --no-build --no-recreate --wait --wait-timeout 90 app || status=1
 exit "$status"
}
trap resume EXIT
trap 'exit 1' HUP INT TERM
docker compose stop app
test "$(docker inspect -f '{{.State.ExitCode}}' "$container")" = 0
sh scripts/backup-restore.sh backup "$backup"
docker inspect -f '{{.Image}}' "$container" > "$backup/IMAGE_ID"
git rev-parse HEAD > "$backup/COMMIT"
