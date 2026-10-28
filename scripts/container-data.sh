#!/bin/sh
# Private archive stream; caller must stop every writer and verify its checksum.
set -eu
umask 077
data=${CHORAL_DATA_DIR:-/data}
check_db() {
 test -f "$data/choral.sqlite"
 integrity=$(sqlite3 "$data/choral.sqlite" 'PRAGMA integrity_check;')
 test "$integrity" = ok
 foreign_keys=$(sqlite3 "$data/choral.sqlite" 'PRAGMA foreign_key_check;')
 test -z "$foreign_keys"
}
case "${1:-}" in
 backup)
  check_db
  # Entire stopped volume includes WAL, keys, pending jobs and private files.
  tar -C "$data" -cf - .
  ;;
 restore)
  test -z "$(find "$data" -mindepth 1 -maxdepth 1 -print -quit)"
  tar -C "$data" --no-same-owner -xf -
  check_db
  ;;
 *) echo 'usage: choral-data backup|restore' >&2; exit 2 ;;
esac
