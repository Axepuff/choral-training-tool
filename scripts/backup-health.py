#!/usr/bin/env python3
"""Loopback-only, read-only backup health for Beszel HTTP monitoring."""
import datetime as dt
from http.server import BaseHTTPRequestHandler, HTTPServer
import os
from pathlib import Path
import re
import subprocess

ROOT = Path('/var/backups/choral')
MIRROR = Path('/mnt/storage/choral-backups')
MOUNT = Path('/mnt/storage')
MAX_AGE = 26 * 3600


def latest_complete(root):
    candidates = []
    for p in root.iterdir():
        if p.is_symlink() or not p.is_dir() or not re.fullmatch(r'\d{8}T\d{6}Z(?:-[a-zA-Z0-9-]+)?', p.name):
            continue
        if (p / 'data.tar.partial').exists():
            continue
        if all((p / f).is_file() and not (p / f).is_symlink()
               for f in ('data.tar', 'SHA256SUMS', 'IMAGE_ID', 'COMMIT')):
            stamp = dt.datetime.strptime(p.name[:16], '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
            candidates.append((stamp.timestamp(), p))
    if not candidates:
        raise ValueError('no_completed_backup')
    return max(candidates)


def backup_status(root=ROOT, mirror=MIRROR, mount=MOUNT, now=None, service=True):
    now = dt.datetime.now(dt.timezone.utc).timestamp() if now is None else now
    if subprocess.run(['mountpoint', '-q', str(mount)], timeout=5).returncode != 0 or root.stat().st_dev == mirror.stat().st_dev:
        raise ValueError('second_disk_unavailable')
    for p in (root, mirror):
        st = os.statvfs(p)
        if st.f_bavail / st.f_blocks < 0.15 or (st.f_files and st.f_favail / st.f_files < 0.15):
            raise ValueError('disk_space_or_inodes_low')
    stamp, source = latest_complete(root)
    if not 0 <= now - stamp <= MAX_AGE:
        raise ValueError('backup_stale')
    target = mirror / source.name
    if not target.is_dir() or target.is_symlink():
        raise ValueError('second_copy_missing')
    for name in ('SHA256SUMS', 'IMAGE_ID', 'COMMIT'):
        p = target / name
        if p.is_symlink() or p.read_bytes() != (source / name).read_bytes():
            raise ValueError('second_copy_metadata_mismatch')
    p = target / 'data.tar'
    if p.is_symlink() or p.stat().st_size != (source / 'data.tar').stat().st_size:
        raise ValueError('second_copy_size_mismatch')
    # Checksums are verified at copy time, not rehashing large archives every probe.
    if service:
        services = ['choral-backup.service']
        if Path('/etc/systemd/system/choral-acceptance-restore.service').is_file():
            services.append('choral-acceptance-restore.service')
        for unit in services:
            result = subprocess.run(['systemctl', 'show', unit,
                                     '-p', 'LoadState', '-p', 'Result'],
                                    capture_output=True, text=True, timeout=5, check=True)
            values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
            if values.get('LoadState') != 'loaded' or values.get('Result') != 'success':
                raise ValueError('backup_service_failed' if unit == services[0] else 'restore_acceptance_failed')
    return 'backup_ready'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/readyz':
            self.send_error(404)
            return
        try:
            message = backup_status()
            status = 200
        except ValueError as error:
            message = str(error)
            status = 503
        except (OSError, subprocess.SubprocessError):
            message = 'backup_check_failed'
            status = 503
        body = (message + '\n').encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass  # Do not log request paths or headers.


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 18082), Handler).serve_forever()
