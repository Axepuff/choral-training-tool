#!/bin/sh
# Run from the release checkout, under the operator's maintenance lock.
set -eu
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
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
sh "$script_dir/backup-restore.sh" backup "$backup"
docker inspect -f '{{.Image}}' "$container" > "$backup/IMAGE_ID"
git rev-parse HEAD > "$backup/COMMIT"
# End the interruption before copying to the second disk. Keep the EXIT recovery
# trap until the explicit restart attempt has finished.
restart_status=0
docker compose up -d --no-build --no-recreate --wait --wait-timeout 90 app || restart_status=1
trap - EXIT HUP INT TERM
test "$restart_status" -eq 0
if test -n "${CHORAL_BACKUP_MIRROR_ROOT:-}"; then
 sh "$script_dir/copy-backup.sh" "$backup" "$CHORAL_BACKUP_MIRROR_ROOT" "${CHORAL_BACKUP_MIRROR_MOUNT:?Mirror mount is required}"
fi
