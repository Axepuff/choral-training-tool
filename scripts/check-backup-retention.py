#!/usr/bin/env python3
"""Exercise retention on disposable, fictional paired archives only."""
import datetime as dt
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
sys.dont_write_bytecode = True
spec=importlib.util.spec_from_file_location('retention',Path(__file__).with_name('prune-backups.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
now=dt.datetime(2026,10,29,12,tzinfo=dt.timezone.utc)
with tempfile.TemporaryDirectory() as a,tempfile.TemporaryDirectory(dir='/dev/shm') as b:
 root,mirror=Path(a),Path(b)
 def pair(age,suffix=''):
  name=(now-dt.timedelta(days=age)).strftime('%Y%m%dT%H%M%SZ')+suffix
  for base in (root,mirror):
   p=base/name;p.mkdir(mode=0o700)
   (p/'data.tar').write_bytes(b'fictional backup')
   (p/'SHA256SUMS').write_text(hashlib.sha256(b'fictional backup').hexdigest()+'  data.tar\n')
   (p/'IMAGE_ID').write_text('image');(p/'COMMIT').write_text('commit')
  return name
 newest=pair(0);keep=pair(31);old=pair(32);manual=pair(90,'-before-update')
 def run(apply=False):return m.prune(root,mirror,Path('/dev/shm'),apply=apply,now=now)
 assert run()==1 and (root/old).exists()
 (mirror/newest/'data.tar').write_bytes(b'corrupt')
 try:run(True);raise AssertionError('bad latest accepted')
 except ValueError:pass
 assert (root/old).exists()
 (mirror/newest/'data.tar').write_bytes(b'fictional backup')
 (root/old/'unexpected').write_text('preserve')
 assert run(True)==0 and (root/old/'unexpected').exists()
 (root/old/'unexpected').unlink()
 assert run(True)==1 and not (root/old).exists() and not (mirror/old).exists()
 for name in (newest,keep,manual):assert (root/name).exists() and (mirror/name).exists()
 assert run(True)==0
 try:m.prune(root,mirror,Path('/dev/shm'),now=now+dt.timedelta(days=2));raise AssertionError('stale accepted')
 except ValueError:pass
print('PASS: dry-run, 31-day boundary, fresh verified pair required, unexpected files and manual backups preserved, repeated apply safe')
