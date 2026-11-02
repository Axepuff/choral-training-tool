#!/bin/sh
# Run from repository root. Never starts/stops the application implicitly.
set -eu
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "${1:-}" in backup|restore) ;; *) echo 'usage: sh scripts/backup-restore.sh backup|restore DIRECTORY' >&2; exit 2;; esac
test "$#" -eq 2
if test -n "$(docker compose ps --status running -q app)"; then
 echo 'Stop app and all other volume writers before backup/restore.' >&2
 exit 1
fi
case "$1" in
 backup)
  mkdir "$2"
  # Stream to the host: no UID mismatch or archive-sized container temp file.
  if ! docker compose run --rm --no-deps -T --entrypoint choral-data app backup > "$2/data.tar.partial"; then
   echo 'Backup failed; partial archive is unusable.' >&2; exit 1
  fi
  mv "$2/data.tar.partial" "$2/data.tar"
  # Optional external frontend: record the release actually mounted in the
  # stopped container, not an operator's possibly newer Compose environment.
  container=$(docker compose ps -aq app)
  frontend_root=''
  if test -n "$container"; then
   frontend_root=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/frontend"}}{{.Source}}{{end}}{{end}}' "$container")
  fi
  if test -n "$frontend_root"; then
   python3 "$script_dir/frontend-release.py" snapshot --root "$frontend_root" --output "$2/frontend.tar"
   (cd "$2" && sha256sum data.tar frontend.tar FRONTEND.json > SHA256SUMS)
  else
   (cd "$2" && sha256sum data.tar > SHA256SUMS)
  fi
  ;;
 restore)
  (cd "$2" && sha256sum -c SHA256SUMS >/dev/null)
  docker compose run --rm --no-deps -T --entrypoint choral-data app restore < "$2/data.tar"
  ;;
esac
