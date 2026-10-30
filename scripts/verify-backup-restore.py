#!/usr/bin/env python3
"""One-shot private acceptance of a fresh backup using a retained test share.

Requires root, Docker and a fixture JSON created by the operator's production
smoke. Never mounts production data or publishes ports. Hold the maintenance lock.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=120, **kwargs).stdout


def verify(root, fixture_path):
    state = json.loads(fixture_path.read_text())
    checked = dt.datetime.fromisoformat(state['checkedAt'])
    choices = []
    for p in root.iterdir():
        if re.fullmatch(r'\d{8}T\d{6}Z', p.name) and p.is_dir() and not p.is_symlink():
            stamp = dt.datetime.strptime(p.name, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
            if stamp > checked and all((p / n).is_file() for n in ['data.tar', 'SHA256SUMS', 'IMAGE_ID', 'COMMIT']):
                choices.append(p)
    if not choices:
        raise ValueError('No completed daily backup newer than the test fixture')
    backup = max(choices)
    image = (backup / 'IMAGE_ID').read_text().strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise ValueError('Invalid backup image ID')
    run(['docker', 'image', 'inspect', image])
    run(['sha256sum', '-c', 'SHA256SUMS'], cwd=backup)
    project = 'choral-acceptance-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='restore-', dir=fixture_path.parent) as work:
        compose = Path(work) / 'compose.json'
        compose.write_text(json.dumps({'services': {'app': {
            'image': image, 'network_mode': 'none', 'environment': {'CHORAL_ORIGIN': 'https://choral-train.ru'},
            'volumes': ['data:/data'], 'read_only': True, 'tmpfs': ['/tmp:size=128m,mode=1777'],
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'mem_limit': '768m', 'cpus': 0.5, 'pids_limit': 64, 'restart': 'no', 'stop_grace_period': '30s'}}, 'volumes': {'data': {}}}))
        cmd = ['docker', 'compose', '-p', project, '-f', str(compose)]
        try:
            with (backup / 'data.tar').open('rb') as archive:
                run(cmd + ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'choral-data', 'app', 'restore'], stdin=archive)
            run(cmd + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app'])
            cid = run(cmd + ['ps', '-q', 'app']).decode().strip()
            pid = run(['docker', 'inspect', '-f', '{{.State.Pid}}', cid]).decode().strip()
            def get(path, ranged=False):
                # URL is carried over stdin, never argv, logs or exception messages.
                if not path.startswith('/api/v1/') or any(c in path for c in '\r\n"'):
                    raise ValueError('Invalid fixture URL')
                config = 'url = "http://127.0.0.1:8080'+path+'"\nsilent\nfail\nmax-time = 15\n'
                if ranged:
                    config += 'header = "Range: bytes=0-31"\n'
                return run(['nsenter', '-t', pid, '-n', 'curl', '--config', '-'], input=config.encode())
            for key in ('songShare', 'listShare'):
                token = state[key]['token']
                if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
                    raise ValueError('Invalid fixture token')
                data = json.loads(get('/api/v1/public/shares/'+token))
                song = next(s for s in data['songs'] if s['id'] == state['songId'])
                track = song['tracks'][0]
                media = get(track['mediaUrl'])
                if hashlib.sha256(media).hexdigest() != state['mediaSha256']:
                    raise ValueError('Restored test media differs from production smoke')
                if get(track['mediaUrl'], True) != media[:32] or not json.loads(get(track['peaksUrl'])):
                    raise ValueError('Restored Range or peaks failed')
            return {'status': 'passed', 'backup': backup.name, 'image': image,
                    'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                    'checks': ['checksum', 'sqlite_integrity_foreign_keys', 'original_song_list_links', 'media_hash', 'peaks', 'range']}
        finally:
            # Only our freshly generated project/volume is removed, never choral.
            run(cmd + ['down', '-v'])


if __name__ == '__main__':
    os.umask(0o077)
    fixture = Path('/var/lib/choral-acceptance/fixture.json')
    result = fixture.with_name('restore-result.json')
    try:
        run(['mountpoint', '-q', '/mnt/storage'])
        report = verify(Path('/mnt/storage/choral-backups'), fixture)
        report['source'] = 'secondary_disk'
    except Exception:
        result.write_text(json.dumps({'status': 'failed', 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat()}))
        raise SystemExit('Isolated backup acceptance failed; inspect privately, no secrets printed') from None
    result.write_text(json.dumps(report))
    print('PASS: isolated fresh-backup restore and original guest links; private report saved')
