#!/usr/bin/env python3
"""Deploy a checked main commit on the Docker host. No implicit database rollback."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent
REPO = 'Axepuff/choral-training-tool'
SHA = re.compile(r'[0-9a-f]{40}')
REVISION = 'org.opencontainers.image.revision'


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def atomic_json(path, value):
    atomic_write(path, json.dumps(value, indent=2) + '\n')


def atomic_write(path, value):
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def image_env(text, tag):
    # Refuse shell syntax/duplicate definitions rather than silently selecting one.
    lines = text.splitlines()
    matches = [i for i, line in enumerate(lines)
               if re.match(r'\s*(?:export\s+)?CHORAL_IMAGE_TAG\s*=', line)]
    if len(matches) > 1:
        raise ValueError('Duplicate CHORAL_IMAGE_TAG in .env')
    if matches:
        lines[matches[0]] = 'CHORAL_IMAGE_TAG=' + tag
    else:
        lines.append('CHORAL_IMAGE_TAG=' + tag)
    return '\n'.join(lines) + '\n'


def checked_run(run, jobs, commit):
    if (run.get('repository', {}).get('full_name') != REPO or
            run.get('head_sha') != commit or run.get('head_branch') != 'main' or
            run.get('event') != 'push' or run.get('path') != '.github/workflows/checks.yml' or
            run.get('status') != 'completed' or run.get('conclusion') != 'success'):
        raise ValueError('A successful main push CI run for this exact commit is required')
    required = [j for j in jobs if j.get('name') == 'Required checks']
    if len(required) != 1 or required[0].get('conclusion') != 'success':
        raise ValueError('Required checks did not pass')


@contextmanager
def maintenance_lock(path):
    with path.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


class Deployment:
    def __init__(self, config):
        self.config = config
        self.checkout = Path(config['checkout'])
        self.state = Path(config['state'])
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('COMPOSE_', 'CHORAL_'))}
        self.env['COMPOSE_PROJECT_NAME'] = config['project']
        self.frontend = module('frontend-release')
        self.delivery = module('frontend-delivery')
        self.journal = None

    def run(self, *args, cwd=None, capture=False):
        result = subprocess.run([str(x) for x in args], cwd=cwd or self.checkout,
                                env=self.env, check=True, text=True,
                                stdout=subprocess.PIPE if capture else None)
        return result.stdout.strip() if capture else None

    def compose(self, *args, capture=False):
        return self.run('docker', 'compose', *args, capture=capture)

    def git(self, *args):
        return self.run('git', *args, capture=True)

    def stage(self, phase, **values):
        self.journal.update(phase=phase, **values)
        atomic_json(self.state / 'active.json', self.journal)
        atomic_json(self.work / 'result.json', self.journal)
        print('deploy: ' + phase, flush=True)

    def check_song(self):
        module('check-deploy-song').check('http://127.0.0.1:' + str(self.config['candidate_port']), self.song_fixture)

    def inspect(self, container):
        return json.loads(self.run('docker', 'inspect', container, capture=True))[0]

    def preflight(self):
        for name in ('checkout', 'state', 'backup_root', 'lock'):
            path = Path(self.config[name])
            if not path.is_absolute() or path.is_symlink():
                raise ValueError(name + ' must be an absolute non-symlink path')
        if self.state.is_relative_to(self.checkout) or Path(self.config['backup_root']).is_relative_to(self.checkout):
            raise ValueError('State and backup directories must be outside the checkout')
        for path in (self.state, Path(self.config['backup_root'])):
            if not path.is_dir() or path.stat().st_mode & 0o077:
                raise ValueError('State/backup directories must exist with mode 0700')
        if (self.state / 'active.json').exists():
            raise ValueError('Unfinished deployment: inspect state/active.json and recover before retrying')
        if self.git('status', '--porcelain') or self.git('branch', '--show-current') != 'main':
            raise ValueError('Deployment checkout must be clean and on main')
        if (self.checkout / '.env').is_symlink() or not (self.checkout / '.env').is_file():
            raise ValueError('Expected a regular private .env in the deployment checkout')
        self.old_commit = self.git('rev-parse', 'HEAD')
        self.container = self.compose('ps', '--status', 'running', '-q', 'app', capture=True)
        if not self.container or '\n' in self.container:
            raise ValueError('Exactly one running app is required')
        self.old = self.inspect(self.container)
        if self.old['State'].get('Health', {}).get('Status') != 'healthy':
            raise ValueError('Installed app is not healthy')
        config = json.loads(self.compose('config', '--format', 'json', capture=True))
        self.compose_before = config
        if self.old['Config']['Labels'].get('com.docker.compose.project') != self.config['project']:
            raise ValueError('Running container belongs to another project')
        desired_volumes = config['services']['app']['volumes']
        for target in ('/data', '/frontend'):
            desired = [v for v in desired_volumes if v['target'] == target]
            actual = [v for v in self.old['Mounts'] if v['Destination'] == target]
            if len(desired) != len(actual) or len(actual) > 1:
                raise ValueError('Compose mounts differ from installed container')
            if desired:
                volume = desired[0]
                source = volume['source']
                if volume['type'] == 'volume':
                    source = config['volumes'][source]['name']
                    installed = actual[0].get('Name')
                else:
                    installed = actual[0]['Source']
                if source != installed or volume['type'] != actual[0]['Type']:
                    raise ValueError('Compose volume differs from installed container')
        self.old_image = self.old['Image']
        resolved = self.run('docker', 'image', 'inspect', config['services']['app']['image'],
                            '--format', '{{.Id}}', capture=True)
        if resolved != self.old_image:
            raise ValueError('Compose image does not match the running app')
        self.root = None
        for mount in self.old['Mounts']:
            if mount['Destination'] == '/frontend':
                if mount['Type'] != 'bind' or mount['RW']:
                    raise ValueError('Frontend must be a read-only bind mount')
                self.root = Path(mount['Source'])
        if self.root and config['services']['app']['environment'].get('CHORAL_STATIC_DIR') != '/frontend/current':
            raise ValueError('Unexpected external frontend configuration')
        labels = self.old['Config'].get('Labels') or {}
        self.backend_commit = labels.get(REVISION, self.config.get('initial_backend_commit'))
        if not SHA.fullmatch(self.backend_commit or '') or self.backend_commit != self.old_commit:
            raise ValueError('Verify initial_backend_commit against installed image and checkout')
        return config

    def admission(self, commit):
        self.git('fetch', 'origin', 'main')
        commit = self.git('rev-parse', '--verify', commit + '^{commit}')
        if not SHA.fullmatch(commit):
            raise ValueError('Invalid commit')
        self.git('merge-base', '--is-ancestor', commit, 'origin/main')
        self.git('merge-base', '--is-ancestor', self.old_commit, commit)
        runs = json.loads(self.run('gh', 'run', 'list', '--repo', REPO,
                                  '--workflow', 'checks.yml', '--branch', 'main',
                                  '--event', 'push', '--commit', commit, '--limit', '1',
                                  '--json', 'databaseId', capture=True))
        if not runs:
            raise ValueError('No CI run for this commit; no automatic rebuild/rerun')
        run_id = runs[0]['databaseId']
        run = json.loads(self.run('gh', 'api', f'repos/{REPO}/actions/runs/{run_id}', capture=True))
        pages = json.loads(self.run('gh', 'api', '--paginate', '--slurp',
                                   f'repos/{REPO}/actions/runs/{run_id}/attempts/{run["run_attempt"]}/jobs?per_page=100', capture=True))
        checked_run(run, [job for page in pages for job in page['jobs']], commit)
        return commit, run_id, run['html_url']

    def smoke(self, origin, previous=None):
        self.delivery.smoke(SimpleNamespace(origin=origin, artifact=self.archive,
                                            sha256=self.checksum, previous_artifact=previous))

    def artifact_from_image(self, image, commit):
        # The frontend in a full release is built by the pinned Dockerfile together
        # with Go. Frontend-only delivery, separately, requires the admitted CI tar.
        container = self.run('docker', 'create', '--network', 'none', image, capture=True)
        try:
            directory = self.work / 'dist'
            self.run('docker', 'cp', container + ':/app/.', directory)
        finally:
            self.run('docker', 'rm', container)
        files = {}
        for path in directory.rglob('*'):
            if path.is_symlink():
                raise ValueError('Symlink in image frontend')
            if path.is_file():
                files[path.relative_to(directory).as_posix()] = path.read_bytes()
        manifest = dict(format=1, commit=commit, api=self.frontend.API, demo=False, base='/',
                        files={name: self.frontend.digest(data) for name, data in files.items()})
        self.frontend.validate(manifest, files)
        self.archive = self.work / 'frontend.tar'
        self.checksum = self.frontend.write_artifact(self.archive, manifest, files)

    def prepare_full(self, commit):
        # Infrastructure changes need a separate reviewed installation plan.
        changed = self.git('diff', '--name-only', self.old_commit, commit, '--').splitlines()
        protected = [p for p in changed if p.startswith(('compose.', 'deploy/')) or
                     p in ('.env.example', 'scripts/backup-restore.sh', 'scripts/scheduled-backup.sh',
                           'scripts/frontend-release.py', 'scripts/container-data.sh')]
        if protected:
            raise ValueError('Install infrastructure changes separately: ' + ', '.join(protected))
        self.song_fixture = module('check-deploy-song').load(self.config['song_fixture'])
        port = self.config['candidate_port']
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError('candidate_port must be an unprivileged TCP port')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
        for directory in (self.config['backup_root'], self.state, self.config['docker_root']):
            stat = os.statvfs(directory)
            if stat.f_bavail * stat.f_frsize < self.config['minimum_free_bytes'] or stat.f_favail < 10000:
                raise ValueError('Insufficient free space/inodes')
        source = self.work / 'source'
        source.mkdir()
        archive = self.work / 'source.tar'
        self.run('git', 'archive', '--format=tar', '-o', archive, commit)
        self.run('tar', '-xf', archive, '-C', source)
        self.tag = 'release-' + commit + '-' + self.work.name.split('-')[0]
        image = 'choral:' + self.tag
        self.run('docker', 'build', '--label', REVISION + '=' + commit, '-t', image, source)
        self.new_image = self.run('docker', 'image', 'inspect', image, '--format', '{{.Id}}', capture=True)
        self.artifact_from_image(image, commit)
        # Check collision/inventory before entering maintenance; actual publish is later.
        if self.root and (self.root / 'releases' / commit).exists():
            existing = self.frontend.release_files(self.root, commit)
            incoming, _ = self.frontend.load_artifact(self.archive, self.checksum)
            if existing != incoming:
                raise ValueError('Full build differs from immutable frontend release for this commit')

    def execute(self, mode, revision):
        self.preflight()
        commit, run_id, checks = self.admission(revision)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        self.work = self.state / (stamp + '-' + commit[:12])
        self.work.mkdir(mode=0o700)
        self.journal = dict(mode=mode, commit=commit, previous_commit=self.old_commit,
                            previous_image=self.old_image, checks_url=checks, directory=str(self.work))
        if mode == 'full':
            self.prepare_full(commit)
        else:
            if not self.root:
                raise ValueError('Enable the external frontend mount before frontend-only deployment')
            output = self.work / 'delivery'
            # prepare uses gh and local git history, so run in the deployment checkout.
            self.run(sys.executable, SCRIPTS / 'frontend-delivery.py', 'prepare',
                     '--run-id', run_id, '--commit', commit, '--backend-commit', self.backend_commit,
                     '--backend-image', self.old_image, '--confirm-compatible', '--output', output)
            self.archive = output / 'frontend.tar'
            self.checksum = json.loads((output / 'admission.json').read_text())['sha256']
        previous = None
        if self.root:
            previous = self.work / 'previous.tar'
            self.frontend.snapshot(self.root, previous)
            self.previous_frontend = self.frontend.current(self.root)
        self.stage('prepared', sha256=self.checksum,
                   previous_frontend=getattr(self, 'previous_frontend', None))
        if mode == 'frontend':
            self.deploy_frontend(commit, previous)
        else:
            self.deploy_full(commit, previous)
        self.stage('complete')
        (self.state / 'active.json').unlink()
        print('Release completed: ' + commit + '\nJournal: ' + str(self.work / 'result.json'))

    def deploy_frontend(self, commit, previous):
        try:
            self.stage('publishing_frontend')
            self.frontend.publish(self.root, self.archive, self.checksum, commit, self.frontend.API)
            self.smoke(self.config['origin'], previous)
            if self.compose('ps', '--status', 'running', '-q', 'app', capture=True) != self.container:
                raise ValueError('Backend changed during frontend deployment')
        except BaseException:
            self.frontend.rollback(self.root, self.previous_frontend, self.frontend.API)
            self.archive = previous
            self.checksum = hashlib.sha256(previous.read_bytes()).hexdigest()
            self.smoke(self.config['origin'])
            self.stage('frontend_rolled_back')
            (self.state / 'active.json').unlink()
            raise

    def deploy_full(self, commit, previous):
        backup = Path(self.config['backup_root']) / (self.work.name + '-before-update')
        env_before = (self.checkout / '.env').read_text()
        # Persist all recovery inputs before any disruption; the journal remains on failure.
        atomic_write(self.work / 'env.before', env_before)
        self.stage('closing_traffic', backup=str(backup), image=self.new_image)
        attempted_new_start = False
        candidate = self.config['project'] + '-deploy-' + self.work.name
        try:
            self.stage('backing_up')
            self.compose('stop', 'app')
            if self.inspect(self.container)['State']['ExitCode'] != 0:
                raise ValueError('App did not stop gracefully; backup refused')
            self.run('sh', self.checkout / 'scripts/backup-restore.sh', 'backup', backup)
            atomic_write(backup / 'IMAGE_ID', self.old_image + '\n')
            atomic_write(backup / 'COMMIT', self.old_commit + '\n')
            atomic_write(backup / 'env.before', env_before)
            self.run('sha256sum', '-c', 'SHA256SUMS', cwd=backup)
            if self.config.get('mirror_root'):
                self.run('sh', self.checkout / 'scripts/copy-backup.sh', backup,
                         self.config['mirror_root'], self.config['mirror_mount'])
            self.stage('installing')
            self.git('merge', '--ff-only', commit)
            atomic_write(self.checkout / '.env', image_env(env_before, self.tag))
            configured = json.loads(self.compose('config', '--format', 'json', capture=True))
            expected = json.loads(json.dumps(self.compose_before))
            expected['services']['app']['image'] = 'choral:' + self.tag
            if configured != expected:
                raise ValueError('Compose changed beyond the image; refusing to recreate app')
            if self.root:
                self.frontend.publish(self.root, self.archive, self.checksum, commit, self.frontend.API)
            # From this point even a failed startup may have migrated SQLite.
            self.stage('starting_backend', candidate=candidate)
            attempted_new_start = True
            self.start_candidate(candidate)
            self.smoke('http://127.0.0.1:' + str(self.config['candidate_port']), previous)
            self.check_song()
            self.run('docker', 'stop', '--timeout', '30', candidate)
            if self.inspect(candidate)['State']['ExitCode'] != 0:
                raise ValueError('Candidate did not stop gracefully')
            self.run('docker', 'rm', candidate)
            self.stage('opening_traffic')
            self.compose('up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '90', 'app')
            actual = self.compose('ps', '--status', 'running', '-q', 'app', capture=True)
            if self.inspect(actual)['Image'] != self.new_image:
                raise ValueError('Unexpected backend image after restart')
            self.smoke(self.config['origin'], previous)
        except BaseException:
            if attempted_new_start:
                # Keep writes closed; never start the old binary on a possibly migrated DB.
                self.stage('needs_recovery')
                try:
                    self.stop_candidate(candidate)
                finally:
                    self.compose('stop', 'app')
            else:
                # The old container is intact. Restore config/frontend without rewriting Git.
                atomic_write(self.checkout / '.env', env_before)
                if self.root:
                    self.frontend.rollback(self.root, self.previous_frontend, self.frontend.API)
                self.compose('up', '-d', '--no-build', '--no-recreate', '--wait', '--wait-timeout', '90', 'app')
                self.stage('old_backend_resumed')
            raise

    def start_candidate(self, candidate):
        self.compose('run', '-d', '--no-deps', '--name', candidate, '--publish',
                     f'127.0.0.1:{self.config["candidate_port"]}:8080', 'app')
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            info = self.inspect(candidate)
            if info['Image'] != self.new_image:
                raise ValueError('Unexpected candidate image')
            if info['State'].get('Health', {}).get('Status') == 'healthy':
                return
            if not info['State']['Running']:
                raise ValueError('Candidate exited before readiness')
            time.sleep(1)
        raise ValueError('Candidate readiness timeout')

    def stop_candidate(self, candidate):
        # A failed/interruptible create may or may not have created this exact name.
        ids = self.run('docker', 'ps', '-aq', '--filter', 'name=^/' + candidate + '$', capture=True)
        if ids:
            self.run('docker', 'stop', '--timeout', '30', candidate)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('full', 'frontend'), nargs='?', default='full')
    parser.add_argument('--config', type=Path, default=Path('/etc/choral-deploy.json'))
    parser.add_argument('--commit', default='origin/main', help='Exact SHA, or latest fetched origin/main')
    parser.add_argument('--confirm-compatible', action='store_true',
                        help='Frontend API use reviewed against the installed backend')
    args = parser.parse_args()
    if args.mode == 'frontend' and not args.confirm_compatible:
        parser.error('frontend requires --confirm-compatible after API compatibility review')
    os.umask(0o077)
    config = json.loads(args.config.read_text())
    def interrupted(signum, frame):
        raise KeyboardInterrupt('Deployment interrupted')
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    with maintenance_lock(Path(config['lock'])):
        Deployment(config).execute(args.mode, args.commit)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print('Deployment failed: ' + str(error) + '\nInspect the deployment journal before retrying.', file=sys.stderr)
        sys.exit(1)
