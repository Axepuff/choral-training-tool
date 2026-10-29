#!/bin/sh
# Copy one completed private backup to a separately mounted disk. No pruning.
set -eu
umask 077
test "$#" -eq 3 || { echo 'usage: copy-backup.sh SOURCE MIRROR_ROOT MOUNTPOINT' >&2; exit 2; }
source=$1
mirror=$2
mount=$3
case "$source:$mirror:$mount" in /*:/*:/*) ;; *) exit 2;; esac
# Refuse a missing HDD instead of filling the system disk under its mount path.
mountpoint -q "$mount"
case "$mirror" in "$mount"/*) ;; *) echo 'Mirror must be below the mounted disk.' >&2; exit 1;; esac
test -d "$mirror" && test ! -L "$mirror"
test "$(stat -c %a "$mirror")" = 700
test "$(stat -c %u "$mirror")" = "$(id -u)"
test "$(stat -c %d "$source")" != "$(stat -c %d "$mirror")"
for file in data.tar SHA256SUMS IMAGE_ID COMMIT; do
 test -f "$source/$file" && test ! -L "$source/$file"
done
test ! -e "$source/data.tar.partial"
(cd "$source" && sha256sum -c SHA256SUMS >/dev/null)
name=$(basename "$source")
test ! -e "$mirror/$name"
stage=$(mktemp -d "$mirror/.partial-$name.XXXXXX")
# On error leave an explicitly incomplete directory for private investigation.
cp -p "$source/data.tar" "$source/SHA256SUMS" "$source/IMAGE_ID" "$source/COMMIT" "$stage/"
# Operator backups may additionally carry the original release configuration.
for file in IMAGE_TAG env.before; do
 if test -f "$source/$file"; then
  test ! -L "$source/$file"
  cp -p "$source/$file" "$stage/"
 fi
done
chmod 600 "$stage/"*
(cd "$stage" && sha256sum -c SHA256SUMS >/dev/null)
sync -f "$stage"
mv -T "$stage" "$mirror/$name"
sync -f "$mirror"
echo 'PASS: second-disk backup checksum verified; no retention deletion performed'
