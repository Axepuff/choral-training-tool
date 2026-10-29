#!/usr/bin/env python3
"""Behavior checks with fictional backups on distinct filesystems."""
import importlib.util
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import tempfile
import datetime as dt
spec = importlib.util.spec_from_file_location('health', Path(__file__).with_name('backup-health.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory(dir='/dev/shm') as b:
    root, mirror = Path(a), Path(b)
    def result():
        try:
            return h.backup_status(root, mirror, Path('/dev/shm'), now.timestamp(), service=False)
        except ValueError as error:
            return str(error)
    assert result() == 'no_completed_backup'
    name = now.strftime('%Y%m%dT%H%M%SZ')
    src = root / name; src.mkdir()
    for f in ('data.tar', 'SHA256SUMS', 'IMAGE_ID', 'COMMIT'):
        (src / f).write_text('fictional')
    assert result() == 'second_copy_missing'
    dst = mirror / name; dst.mkdir()
    for f in src.iterdir():
        (dst / f.name).write_bytes(f.read_bytes())
    assert result() == 'backup_ready'
    (dst / 'IMAGE_ID').write_text('wrong image')
    assert result() == 'second_copy_metadata_mismatch'
    (dst / 'IMAGE_ID').write_text('fictional')
    # Different size is observable without expensive repeated hashing.
    (dst / 'data.tar').write_text('short')
    assert result() == 'second_copy_size_mismatch'
    (dst / 'data.tar').write_text('fictional')
    try:
        h.backup_status(root, mirror, Path('/dev/shm'), now.timestamp()+27*3600, service=False)
        raise AssertionError('stale accepted')
    except ValueError as e:
        assert str(e) == 'backup_stale'
    (src / 'data.tar.partial').touch()
    assert result() == 'no_completed_backup'
print('PASS: missing, incomplete, stale, mismatched second copy and healthy backup states')
