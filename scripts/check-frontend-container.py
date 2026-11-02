#!/usr/bin/env python3
"""Focused #65 Compose/browser smoke using an existing runtime image + new Go binary.

No build, production mounts or default Compose project. Removes only its own
random project and volume. Run with Docker access, Node and optional CHROME_BIN.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
from urllib.request import urlopen
from urllib.error import HTTPError

sys.dont_write_bytecode = True
repo = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('checks', repo / 'scripts/check-frontend-release.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True, help='Existing local runtime image; never built or pulled')
parser.add_argument('--server', required=True, type=Path, help='Newly built Go server')
args = parser.parse_args()
project = 'choral-fe-test-' + uuid.uuid4().hex[:12]
with tempfile.TemporaryDirectory(prefix=project + '-') as directory:
    work = Path(directory)
    root = work / 'frontend'
    one, two = work / 'one.tar', work / 'two.tar'
    previous, commit = 'a' * 40, 'b' * 40
    sha1, _, _ = checks.artifact(one, previous, 'one')
    sha2, _, files2 = checks.artifact(two, commit, 'two')
    checks.f.publish(root, one, sha1, previous, checks.f.API)
    envfile = work / 'test.env'
    envfile.write_text('CHORAL_FRONTEND_ROOT=' + str(root) + '\nCHORAL_HTTP_PORT=0\nCHORAL_ORIGIN=https://localhost\n')
    override = work / 'override.json'
    override.write_text(json.dumps({'services': {'app': {
        'image': args.image, 'pull_policy': 'never', 'restart': 'no',
        'volumes': [str(args.server.resolve()) + ':/usr/local/bin/choral-server:ro']}}}))
    cmd = ['docker', 'compose', '--project-name', project, '--env-file', str(envfile),
           '-f', str(repo / 'compose.yaml'), '-f', str(repo / 'compose.frontend.yaml'), '-f', str(override)]
    basecmd = ['docker', 'compose', '--project-name', project, '--env-file', str(envfile),
               '-f', str(repo / 'compose.yaml'), '-f', str(override)]
    def run(tail, **kwargs):
        return subprocess.run(cmd + tail, check=True, capture_output=True, text=True, timeout=120, **kwargs).stdout.strip()
    try:
        # Begin with image dist, then apply the one-time mount migration.
        subprocess.run(basecmd + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app'],
                       check=True, capture_output=True, timeout=120)
        original = run(['ps', '-q', 'app'])
        run(['exec', '-T', 'app', 'sh', '-c', 'printf synthetic-persistence > /data/control-file'])
        original_schema = run(['exec', '-T', 'app', 'sqlite3', '/data/choral.sqlite', '.schema'])
        original_migrations = run(['exec', '-T', 'app', 'sqlite3', '/data/choral.sqlite', 'SELECT * FROM schema_migrations ORDER BY name'])
        run(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app'])
        container = run(['ps', '-q', 'app'])
        assert container != original, 'Mount migration must recreate the container'
        assert run(['exec', '-T', 'app', 'cat', '/data/control-file']) == 'synthetic-persistence'
        assert run(['exec', '-T', 'app', 'sqlite3', '/data/choral.sqlite', '.schema']) == original_schema
        assert run(['exec', '-T', 'app', 'sqlite3', '/data/choral.sqlite', 'SELECT * FROM schema_migrations ORDER BY name']) == original_migrations
        def identity():
            return subprocess.check_output(['docker', 'inspect', '-f', '{{.Id}} {{.State.Pid}} {{.RestartCount}}', container], text=True).strip()
        before_id = identity()
        before_data = run(['exec', '-T', 'app', 'sh', '-c', 'find /data -type f -exec sha256sum {} +'])
        origin = 'http://' + run(['port', 'app', '8080'])
        fixture = work / 'browser.json'
        fixture.write_text(json.dumps({'origin': origin, 'root': str(root), 'archive': str(two),
            'sha256': sha2, 'commit': commit, 'previous': previous,
            'newAsset': next(n for n in files2 if n.startswith('assets/')),
            'helper': str(repo / 'scripts/frontend-release.py')}))
        subprocess.run(['node', str(repo / 'tests/frontend-deploy-browser.mjs'), str(fixture)], check=True, timeout=90)
        assert identity() == before_id, 'Go process/container restarted'
        assert run(['exec', '-T', 'app', 'sh', '-c', 'find /data -type f -exec sha256sum {} +']) == before_data, 'Private test data changed'
        for route in ('/', '/listen/deep', '/readyz'):
            assert urlopen(origin + route).status == 200
        try:
            urlopen(origin + '/api/v1/auth/me')
            raise AssertionError('Anonymous auth request unexpectedly succeeded')
        except HTTPError as error:
            assert error.code == 401
        # Container cannot write the mounted public tree; /data is a separate named volume.
        assert run(['exec', '-T', 'app', 'sh', '-c', 'test ! -w /frontend && test -w /data; echo isolated']) == 'isolated'
        # Exercise the actual backup entrypoint only in this disposable project.
        # This is separate from deploy and verifies the external frontend snapshot.
        run(['stop', 'app'])
        backup = work / 'backup'
        env = dict(os.environ, COMPOSE_PROJECT_NAME=project,
                   COMPOSE_FILE=':'.join([str(repo/'compose.yaml'), str(repo/'compose.frontend.yaml'), str(override)]),
                   CHORAL_FRONTEND_ROOT=str(root), CHORAL_HTTP_PORT='0', CHORAL_ORIGIN='https://localhost')
        subprocess.run(['sh', str(repo/'scripts/backup-restore.sh'), 'backup', str(backup)], cwd=repo, env=env, check=True, timeout=120)
        assert (backup/'frontend.tar').read_bytes() == one.read_bytes()
        subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=backup, check=True, capture_output=True)
        # Roll back the Compose transition to the image's bundled frontend.
        subprocess.run(basecmd + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app'],
                       check=True, capture_output=True, timeout=120)
        base_origin = 'http://' + run(['port', 'app', '8080'])
        assert b'/assets/index-' in urlopen(base_origin + '/').read()
        run(['stop', 'app'])
        run(['down', '-v'])
        # Restore the snapshot into a new external root and a clean private volume.
        restored = work / 'restored-frontend'
        metadata = json.loads((backup/'FRONTEND.json').read_text())
        checks.f.publish(restored, backup/'frontend.tar', metadata['sha256'], metadata['commit'], metadata['api'])
        envfile.write_text('CHORAL_FRONTEND_ROOT=' + str(restored) + '\nCHORAL_HTTP_PORT=0\nCHORAL_ORIGIN=https://localhost\n')
        env['CHORAL_FRONTEND_ROOT'] = str(restored)
        subprocess.run(['sh', str(repo/'scripts/backup-restore.sh'), 'restore', str(backup)], cwd=repo, env=env, check=True, timeout=120)
        run(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app'])
        restored_origin = 'http://' + run(['port', 'app', '8080'])
        assert urlopen(restored_origin + '/').read() == (restored/'current/index.html').read_bytes()
        for name in checks.f.release_files(restored, previous)['files']:
            assert urlopen(restored_origin + '/' + name).read() == (restored/'current'/name).read_bytes()
        assert urlopen(restored_origin + '/readyz').status == 200
        assert run(['exec', '-T', 'app', 'cat', '/data/control-file']) == 'synthetic-persistence'
        print('PASS: real Compose parent bind read-only, unchanged container ID/Go PID/private hashes; separate external-frontend backup checksum')
        print('PASS: one-time Compose migration and rollback; external frontend + clean private volume restored from snapshot')
    finally:
        run(['down', '-v'])
