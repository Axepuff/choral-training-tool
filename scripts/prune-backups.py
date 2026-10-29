#!/usr/bin/env python3
"""Prune paired daily backups only after verifying a newer pair; default dry-run.

Caller must hold /run/lock/choral-maintenance.lock. Manual/pre-update backups,
partials, symlinks and directories with unexpected files are never pruned.
"""
import argparse
import datetime as dt
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess

REQUIRED = {'data.tar', 'SHA256SUMS', 'IMAGE_ID', 'COMMIT'}
ALLOWED = REQUIRED | {'IMAGE_TAG', 'env.before'}
DAILY = re.compile(r'\d{8}T\d{6}Z')


def private_directory(path):
    s = path.lstat()
    return stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode) == 0o700 and s.st_uid == os.geteuid()


def eligible(path):
    if not private_directory(path):
        return False
    entries = list(path.iterdir())
    if not REQUIRED <= {p.name for p in entries} <= ALLOWED:
        return False
    return all(stat.S_ISREG(p.lstat().st_mode) and p.lstat().st_nlink == 1 for p in entries)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_pair(source, target):
    if not eligible(source) or not eligible(target):
        raise ValueError('pair_incomplete_or_unsafe')
    manifest = source.joinpath('SHA256SUMS').read_text()
    if not re.fullmatch(r'[0-9a-f]{64}  data\.tar\n', manifest):
        raise ValueError('invalid_checksum_manifest')
    for name in ('SHA256SUMS', 'IMAGE_ID', 'COMMIT'):
        if (source / name).read_bytes() != (target / name).read_bytes():
            raise ValueError('pair_metadata_mismatch')
    expected = manifest[:64]
    if digest(source / 'data.tar') != expected or digest(target / 'data.tar') != expected:
        raise ValueError('pair_checksum_mismatch')


def prune(root, mirror, mount, days=31, apply=False, now=None):
    if days < 31:
        raise ValueError('retention_must_be_at_least_31_days')
    if not private_directory(root) or not private_directory(mirror):
        raise ValueError('private_roots_required')
    if subprocess.run(['mountpoint', '-q', str(mount)], timeout=5).returncode or root.stat().st_dev == mirror.stat().st_dev:
        raise ValueError('separate_mounted_disk_required')
    if not mirror.resolve().is_relative_to(mount.resolve()):
        raise ValueError('mirror_outside_mount')
    now = dt.datetime.now(dt.timezone.utc) if now is None else now
    pairs = []
    for p in root.iterdir():
        if not DAILY.fullmatch(p.name):
            continue
        try:
            timestamp = dt.datetime.strptime(p.name, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
            if eligible(p) and eligible(mirror / p.name):
                pairs.append((timestamp, p))
        except (ValueError, FileNotFoundError):
            continue
    if not pairs:
        raise ValueError('no_completed_daily_pair')
    pairs.sort()
    newest_time, newest = pairs[-1]
    if not dt.timedelta() <= now - newest_time <= dt.timedelta(hours=26):
        raise ValueError('latest_pair_not_fresh')
    verify_pair(newest, mirror / newest.name)
    candidates = [p for stamp, p in pairs[:-1] if now - stamp > dt.timedelta(days=days)]
    # Validate every selected pair before removing anything; never prune damaged copies.
    for p in candidates:
        verify_pair(p, mirror / p.name)
    if apply:
        for p in candidates:
            for directory in (p, mirror / p.name):
                for file in directory.iterdir():
                    file.unlink()
                directory.rmdir()
    return len(candidates)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('mirror', type=Path)
    parser.add_argument('mount', type=Path)
    parser.add_argument('--days', type=int, default=31)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        count = prune(args.root, args.mirror, args.mount, args.days, args.apply)
        print(('Removed' if args.apply else 'Would remove') + f' {count} expired daily backup pairs; manual copies preserved')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Do not leak private backup paths or contents in logs.
        raise SystemExit('Backup retention refused: '+ (str(error) if isinstance(error, ValueError) else type(error).__name__)) from None
