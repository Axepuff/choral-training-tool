#!/usr/bin/env python3
"""Opt-in disposable Compose test using an existing runtime image; never reads production data."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('deploy', ROOT / 'scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def command(*args, cwd=None, capture=False):
    result = subprocess.run([str(x) for x in args], cwd=cwd, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


class FixtureDeployment(deploy.Deployment):
    def check_song(self):
        # This fixture has no user/song: real HTTP static/API checks still run.
        if self.config['fixture_failure'] == 'smoke':
            raise RuntimeError('Injected smoke failure')

    def admission(self, revision):
        # CI/gh are covered by check-deploy.py. These commits exist only in the fixture.
        return revision, 1, 'https://example.test/fictional-checks'

    def prepare_full(self, commit):
        self.tag = self.config['fixture_new_tag']
        self.new_image = command('docker', 'image', 'inspect', 'choral:' + self.tag,
                                 '--format', '{{.Id}}', capture=True)
        self.artifact_from_image('choral:' + self.tag, commit)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True, help='Existing runtime sha256 image ID, no pull/build')
parser.add_argument('--failure', choices=('none', 'smoke'), default='none')
parser.add_argument('--external', action='store_true', help='Exercise the external frontend mount and snapshot')
args = parser.parse_args()
if not __import__('re').fullmatch('sha256:[0-9a-f]{64}', args.image):
    parser.error('Use an exact existing sha256 image ID')
os.umask(0o077)
name = 'choral-deploy-test-' + uuid.uuid4().hex[:12]
old_tag, new_tag = name + '-old', name + '-new'
# The wrapper may run as root; tests never interpolate config or untrusted shell code.
with tempfile.TemporaryDirectory(prefix=name + '-') as temp:
    base = Path(temp)
    checkout = base / 'checkout'
    checkout.mkdir()
    for filename in ('compose.yaml', 'compose.frontend.yaml'):
        shutil.copyfile(ROOT / filename, checkout / filename)
    shutil.copytree(ROOT / 'scripts', checkout / 'scripts')
    (checkout / '.gitignore').write_text('.env\n')
    command('git', 'init', '-b', 'main', checkout)
    command('git', 'config', 'user.email', 'fixture@example.test', cwd=checkout)
    command('git', 'config', 'user.name', 'Deployment fixture', cwd=checkout)
    command('git', 'add', '.', cwd=checkout)
    command('git', 'commit', '-qm', 'old fixture', cwd=checkout)
    old = command('git', 'rev-parse', 'HEAD', cwd=checkout, capture=True)
    (checkout / 'fixture.txt').write_text('next revision\n')
    command('git', 'add', 'fixture.txt', cwd=checkout)
    command('git', 'commit', '-qm', 'new fixture', cwd=checkout)
    new = command('git', 'rev-parse', 'HEAD', cwd=checkout, capture=True)
    # Local disposable branch only; no reset/checkout touches the project repository.
    command('git', 'branch', '-m', 'candidate', cwd=checkout)
    command('git', 'switch', '-c', 'main', old, cwd=checkout)
    for directory in ('state', 'backups'):
        (base / directory).mkdir(mode=0o700)
    # Allocate separate loopback ports before creating any container.
    import socket
    ports = []
    for _ in range(2):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            ports.append(probe.getsockname()[1])
    if ports[0] == ports[1]:
        raise ValueError('Retry: kernel selected duplicate test ports')
    config = dict(checkout=str(checkout), project=name, state=str(base / 'state'),
                  backup_root=str(base / 'backups'), lock=str(base / 'lock'),
                  origin='http://127.0.0.1:' + str(ports[0]), candidate_port=ports[1],
                  initial_backend_commit=old, fixture_new_tag=new_tag,
                  fixture_failure=args.failure)
    runner = FixtureDeployment(config)
    (checkout / '.env').write_text(f'COMPOSE_PROJECT_NAME={name}\nCHORAL_IMAGE_TAG={old_tag}\n'
                                  f'CHORAL_ORIGIN=https://example.test\nCHORAL_HTTP_PORT={ports[0]}\n')
    try:
        command('docker', 'tag', args.image, 'choral:' + old_tag)
        command('docker', 'tag', args.image, 'choral:' + new_tag)
        if args.external:
            runner.work = base / 'seed'
            runner.work.mkdir()
            runner.artifact_from_image('choral:' + old_tag, old)
            frontend_root = base / 'frontend'
            runner.frontend.publish(frontend_root, runner.archive, runner.checksum, old, runner.frontend.API)
            with (checkout / '.env').open('a') as env:
                env.write(f'COMPOSE_FILE=compose.yaml:compose.frontend.yaml\nCHORAL_FRONTEND_ROOT={frontend_root}\n')
        runner.compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app')
        before = runner.compose('ps', '-q', 'app', capture=True)
        try:
            runner.execute('full', new)
        except RuntimeError:
            if args.failure != 'smoke': raise
        else:
            if args.failure != 'none': raise AssertionError('Failure was swallowed')
        result = json.loads((runner.work / 'result.json').read_text())
        assert result['phase'] == ('complete' if args.failure == 'none' else 'needs_recovery')
        backup = Path(result['backup'])
        command('sha256sum', '-c', 'SHA256SUMS', cwd=backup)
        assert (backup / 'COMMIT').read_text().strip() == old
        if args.external:
            assert json.loads((backup / 'FRONTEND.json').read_text())['commit'] == old
            assert runner.frontend.current(frontend_root) == new
        if args.failure == 'none':
            after = runner.compose('ps', '-q', 'app', capture=True)
            assert after != before
            assert runner.inspect(after)['State']['Health']['Status'] == 'healthy'
        else:
            assert not runner.compose('ps', '--status', 'running', '-q', 'app', capture=True)
        print('PASS: isolated full deploy ' + args.failure)
    finally:
        # Only the unique fixture project/volume/tags created above are removed.
        runner.compose('down', '-v', '--remove-orphans')
        for tag in (old_tag, new_tag):
            command('docker', 'image', 'rm', 'choral:' + tag)
