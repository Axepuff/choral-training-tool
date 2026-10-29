#!/usr/bin/env python3
"""Integration test on a disposable Docker volume with fictional content only.

Usage: python3 scripts/check-restore-acceptance.py sha256:<existing-runtime-image>
No production volumes, passwords, shares or audio are read.
"""
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import uuid
sys.dont_write_bytecode = True
spec=importlib.util.spec_from_file_location('acceptance',Path(__file__).with_name('verify-backup-restore.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
image=sys.argv[1]
if not m.re.fullmatch(r'sha256:[0-9a-f]{64}',image):raise SystemExit('Exact image ID required')
with tempfile.TemporaryDirectory(prefix='choral-restore-test-') as work:
 root=Path(work);project='choral-seed-'+uuid.uuid4().hex[:12]
 compose=root/'compose.json'
 compose.write_text(json.dumps({'services':{'app':{'image':image,'network_mode':'none','environment':{'CHORAL_ORIGIN':'https://choral-train.ru'},'volumes':['data:/data'],'mem_limit':'768m','cpus':0.5,'pids_limit':64,'restart':'no','stop_grace_period':'30s'}},'volumes':{'data':{}}}))
 cmd=['docker','compose','-p',project,'-f',str(compose)]
 def run(args,**kw):return m.run(cmd+args,**kw)
 try:
  run(['up','-d','--no-build','--wait','--wait-timeout','90','app']);run(['stop','app'])
  owner,song,track,asset,share1,share2=[str(uuid.uuid4()) for _ in range(6)]
  songtoken,listtoken=secrets.token_urlsafe(32),secrets.token_urlsafe(32)
  now=dt.datetime.now(dt.timezone.utc).replace(microsecond=0);stamp=now.isoformat().replace('+00:00','Z')
  playback='playback-'+asset;peaks='peaks-'+asset
  sql=f"""PRAGMA foreign_keys=ON;
INSERT INTO users VALUES('{owner}','fictional@example.test','unusable-hash','teacher',NULL,0,'{stamp}','{stamp}');
INSERT INTO songs VALUES('{song}','{owner}','Fictional restore fixture',120,4,4,'','published',1,'{stamp}','{stamp}',NULL);
INSERT INTO tracks VALUES('{track}','{song}',0,'Test',1,NULL,NULL,NULL);
INSERT INTO assets(id,track_id,source_path,playback_path,peaks_path,source_bytes,source_sha256,duration_ms,mime,sample_rate,channels,state,created_at,updated_at) VALUES('{asset}','{track}','original-{asset}','{playback}','{peaks}',256,X'00',1000,'audio/mp4',48000,1,'ready','{stamp}','{stamp}');
UPDATE tracks SET active_asset_id='{asset}' WHERE id='{track}';
INSERT INTO shares VALUES('{share1}','song','{owner}','{song}',X'{hashlib.sha256(songtoken.encode()).hexdigest()}',NULL,'{stamp}','{stamp}');
INSERT INTO shares VALUES('{share2}','list','{owner}',NULL,X'{hashlib.sha256(listtoken.encode()).hexdigest()}',NULL,'{stamp}','{stamp}');
"""
  run(['run','--rm','--no-deps','-T','--entrypoint','sqlite3','app','/data/choral.sqlite'],input=sql.encode())
  media=b'fictional-media-bytes'*32
  for name,data in [(playback,media),(peaks,b'{"peaks":[0.1,0.2]}')]:
   run(['run','--rm','--no-deps','-T','--entrypoint','sh','app','-c','cat > /data/files/'+name],input=data)
  backups=root/'backups';backups.mkdir();backup=backups/now.strftime('%Y%m%dT%H%M%SZ');backup.mkdir()
  with (backup/'data.tar').open('wb') as output:
   subprocess.run(cmd+['run','--rm','--no-deps','-T','--entrypoint','choral-data','app','backup'],stdout=output,stderr=subprocess.PIPE,check=True,timeout=60)
  (backup/'SHA256SUMS').write_text(hashlib.sha256((backup/'data.tar').read_bytes()).hexdigest()+'  data.tar\n')
  (backup/'IMAGE_ID').write_text(image);(backup/'COMMIT').write_text('fictional')
  fixture=root/'fixture.json';fixture.write_text(json.dumps({'checkedAt':(now-dt.timedelta(minutes=1)).isoformat(),'songId':song,'songShare':{'token':songtoken},'listShare':{'token':listtoken},'mediaSha256':hashlib.sha256(media).hexdigest()}))
  report=m.verify(backups,fixture)
  assert report['status']=='passed'
  print('PASS: isolated real Docker backup/restore, original synthetic song/list tokens, media hash, peaks and Range; production untouched')
 finally:
  run(['down','-v'])
