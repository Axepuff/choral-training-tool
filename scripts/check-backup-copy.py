#!/usr/bin/env python3
"""Exercise copy safety with fictional data on a second temporary filesystem."""
import pathlib, tempfile, subprocess, hashlib
script=str(pathlib.Path(__file__).resolve().parent / 'copy-backup.sh')
with tempfile.TemporaryDirectory(prefix='choral-copy-test-') as a, tempfile.TemporaryDirectory(prefix='choral-copy-test-',dir='/dev/shm') as b:
 source=pathlib.Path(a)/'fixture'; source.mkdir(); mirror=pathlib.Path(b)
 (source/'data.tar').write_bytes(b'fictional backup fixture')
 (source/'SHA256SUMS').write_text(hashlib.sha256((source/'data.tar').read_bytes()).hexdigest()+'  data.tar\n')
 (source/'COMMIT').write_text('fictional commit\n'); (source/'IMAGE_ID').write_text('fictional image\n')
 def run(dest,mount): return subprocess.run(['sh',script,str(source),str(dest),mount],capture_output=True).returncode
 assert run(mirror,'/dev/shm')==0
 assert (mirror/'fixture/data.tar').read_bytes()==(source/'data.tar').read_bytes()
 assert (mirror/'fixture/data.tar').stat().st_mode & 0o777==0o600
 assert run(mirror,'/dev/shm')!=0
 assert run(mirror,'/missing-test-mount')!=0
 (source/'data.tar').write_bytes(b'corrupt')
 other=mirror/'other';other.mkdir(mode=0o700)
 assert run(other,'/dev/shm')!=0
 assert not list(other.iterdir())
 print('PASS: second filesystem copy, checksum, private modes, overwrite refusal, absent mount refusal, corrupted source refusal')
