#!/usr/bin/env python3
"""Exercise deployment failure boundaries with fictional data and a Docker adapter."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
OLD, NEW = 'a' * 40, 'b' * 40
IMAGE, NEXT_IMAGE = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64


def artifact(frontend, directory, commit):
    files = {'index.html': f'<script src="/assets/app-{commit[:8]}.js"></script>'.encode(),
             f'assets/app-{commit[:8]}.js': commit.encode()}
    manifest = dict(format=1, commit=commit, api=frontend.API, demo=False, base='/',
                    files={k: frontend.digest(v) for k, v in files.items()})
    archive = directory / (commit + '.tar')
    return archive, frontend.write_artifact(archive, manifest, files)


class Host(deploy.Deployment):
    def __init__(self, directory, external=True, failure=None):
        config = dict(checkout=str(directory / 'checkout'), state=str(directory / 'state'),
                      backup_root=str(directory / 'backups'), lock=str(directory / 'lock'),
                      project='fictional', origin='https://example.test', candidate_port=18080,
                      initial_backend_commit=OLD)
        super().__init__(config)
        self.failure = failure
        self.events = []
        self.running = True
        self.closed = False
        self.started_new = False
        self.head = OLD
        for path in (self.checkout, self.state, Path(config['backup_root'])):
            path.mkdir(mode=0o700)
        (self.checkout / '.env').write_text('CHORAL_ORIGIN=https://example.test\nCHORAL_IMAGE_TAG=old\n')
        volumes = [dict(type='volume', source='data', target='/data')]
        mounts = [dict(Type='volume', Name='fictional_data', Source='/fictional/data', Destination='/data', RW=True)]
        self.static = directory / 'frontend' if external else None
        if external:
            archive, checksum = artifact(self.frontend, directory, OLD)
            self.frontend.publish(self.static, archive, checksum, OLD, self.frontend.API)
            volumes.append(dict(type='bind', source=str(self.static), target='/frontend', read_only=True))
            mounts.append(dict(Type='bind', Source=str(self.static), Destination='/frontend', RW=False))
        self.base_config = dict(services=dict(app=dict(image='choral:old', volumes=volumes,
                                environment={'CHORAL_STATIC_DIR': '/frontend/current' if external else '/app'})),
                                volumes=dict(data=dict(name='fictional_data')))
        self.installed = dict(Image=IMAGE, State=dict(Health=dict(Status='healthy'), ExitCode=0),
                              Mounts=mounts, Config=dict(Labels={'com.docker.compose.project': 'fictional'}))

    def git(self, *args):
        self.events.append(('git', *args))
        if args[0] == 'status': return ''
        if args[0] == 'branch': return 'main'
        if args[0] == 'rev-parse': return self.head
        if args[0] == 'merge':
            if self.failure == 'merge': raise RuntimeError('merge failed')
            self.head = NEW
            return ''
        raise AssertionError(args)

    def inspect(self, container):
        value = copy.deepcopy(self.installed)
        if self.started_new: value['Image'] = NEXT_IMAGE
        if self.failure == 'killed' and not self.running: value['State']['ExitCode'] = 137
        return value

    def compose(self, *args, capture=False):
        self.events.append(('compose', *args))
        if args[0] == 'ps': return 'new-container' if self.started_new else 'old-container'
        if args[0] == 'config':
            value = copy.deepcopy(self.base_config)
            if 'CHORAL_IMAGE_TAG=new' in (self.checkout / '.env').read_text():
                value['services']['app']['image'] = 'choral:new'
                if self.failure == 'compose-drift': value['services']['app']['ports'] = ['9999:8080']
            return json.dumps(value)
        if args[0] == 'stop':
            self.running = False
            self.closed = True
        elif args[0] == 'up':
            if '--force-recreate' in args:
                self.started_new = True
                if self.failure == 'startup': raise RuntimeError('migration/startup failure')
            self.running = True
            self.closed = False
        else: raise AssertionError(args)

    def run(self, *args, cwd=None, capture=False):
        self.events.append(tuple(str(x) for x in args))
        if args[:3] == ('docker', 'image', 'inspect'): return IMAGE
        if args[:2] in (('docker', 'stop'), ('docker', 'rm')): return ''
        if args[0] == 'sh' and str(args[1]).endswith('backup-restore.sh'):
            assert not self.running and self.closed
            if self.failure == 'backup': raise RuntimeError('backup failed')
            backup = Path(args[3])
            backup.mkdir(mode=0o700)
            (backup / 'data.tar').write_bytes(b'fictional data')
            (backup / 'SHA256SUMS').write_text('fixture checksum')
        elif args[0] == 'sh' and str(args[1]).endswith('copy-backup.sh'):
            if self.failure == 'mirror': raise RuntimeError('mirror failed')
        elif args[0] == 'sha256sum':
            if self.failure == 'checksum': raise RuntimeError('corrupt backup')
        elif str(args[0]) == sys.executable:
            output = Path(args[-1])
            output.mkdir()
            archive, checksum = artifact(self.frontend, output, NEW)
            archive.rename(output / 'frontend.tar')
            (output / 'admission.json').write_text(json.dumps(dict(sha256=checksum)))
        else: raise AssertionError(args)

    def admission(self, revision):
        if self.failure == 'ci': raise ValueError('CI failed')
        return NEW, 123, 'https://example.test/checks/123'

    def prepare_full(self, commit):
        if self.failure == 'build': raise RuntimeError('build failed')
        self.tag, self.new_image = 'new', NEXT_IMAGE
        self.archive, self.checksum = artifact(self.frontend, self.work, NEW)

    def start_candidate(self, candidate):
        self.events.append(('candidate', 'start'))
        self.started_new = True
        if self.failure == 'startup': raise RuntimeError('candidate failed')

    def stop_candidate(self, candidate):
        self.events.append(('candidate', 'stop'))

    def check_song(self):
        self.hook('smoke_command')

    def hook(self, name):
        self.events.append(('hook', name))
        if name == 'maintenance_on': self.closed = True
        elif name == 'maintenance_off': self.closed = False
        elif name == 'smoke_command' and self.failure == 'song-smoke': raise RuntimeError('song smoke failed')

    def smoke(self, origin, previous=None):
        self.events.append(('smoke', origin))
        commit = self.frontend.load_artifact(self.archive, self.checksum)[0]['commit']
        if self.static:
            assert self.frontend.current(self.static) == commit
        if self.failure == 'smoke' and commit == NEW: raise RuntimeError('HTTP failed')
        if self.failure == 'public-smoke' and origin == self.config['origin']: raise RuntimeError('HTTPS failed')


class DeployTests(unittest.TestCase):
    def test_full_success(self):
        for external in (False, True):
            with self.subTest(external=external), tempfile.TemporaryDirectory() as temp:
                host = Host(Path(temp), external=external)
                host.execute('full', NEW)
                self.assertTrue(host.running)
                self.assertFalse(host.closed)
                self.assertEqual(host.head, NEW)
                self.assertFalse((host.state / 'active.json').exists())
                backup = next(Path(host.config['backup_root']).iterdir())
                self.assertEqual((backup / 'COMMIT').read_text().strip(), OLD)
                self.assertEqual((backup / 'IMAGE_ID').read_text().strip(), IMAGE)
                self.assertIn('CHORAL_IMAGE_TAG=old', (backup / 'env.before').read_text())
                self.assertIn('CHORAL_IMAGE_TAG=new', (host.checkout / '.env').read_text())
                self.assertLess(host.events.index(('hook', 'smoke_command')), next(i for i, event in enumerate(host.events) if event[:2] == ('compose', 'up')))

    def test_failure_before_disruption(self):
        for failure in ('ci', 'build'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                host = Host(Path(temp), failure=failure)
                with self.assertRaises((ValueError, RuntimeError)): host.execute('full', NEW)
                self.assertTrue(host.running)
                self.assertFalse(host.closed)
                self.assertFalse(any(x[:2] == ('compose', 'stop') for x in host.events))

    def test_failure_before_new_start_resumes_old(self):
        for failure in ('backup', 'checksum', 'mirror', 'killed', 'merge', 'compose-drift'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                host = Host(Path(temp), failure=failure)
                if failure == 'mirror': host.config.update(mirror_root='/fictional', mirror_mount='/fictional')
                with self.assertRaises((ValueError, RuntimeError)): host.execute('full', NEW)
                self.assertTrue(host.running)
                self.assertFalse(host.closed)
                self.assertFalse(host.started_new)
                self.assertEqual(host.frontend.current(host.static), OLD)
                self.assertIn('CHORAL_IMAGE_TAG=old', (host.checkout / '.env').read_text())
                self.assertEqual(json.loads((host.state / 'active.json').read_text())['phase'], 'old_backend_resumed')
                with self.assertRaisesRegex(ValueError, 'Unfinished'): host.execute('full', NEW)

    def test_failure_after_start_never_rolls_back_database(self):
        for failure in ('startup', 'smoke', 'song-smoke', 'public-smoke'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                host = Host(Path(temp), failure=failure)
                with self.assertRaises(RuntimeError): host.execute('full', NEW)
                self.assertTrue(host.closed)
                self.assertFalse(host.running)
                self.assertTrue(host.started_new)
                self.assertEqual(host.frontend.current(host.static), NEW)
                self.assertFalse(any('--no-recreate' in event for event in host.events))
                self.assertEqual(json.loads((host.state / 'active.json').read_text())['phase'], 'needs_recovery')

    def test_frontend_success_and_rollback(self):
        for failure in (None, 'smoke'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                host = Host(Path(temp), failure=failure)
                if failure:
                    with self.assertRaises(RuntimeError): host.execute('frontend', NEW)
                else: host.execute('frontend', NEW)
                self.assertEqual(host.frontend.current(host.static), OLD if failure else NEW)
                self.assertTrue(host.running)
                self.assertEqual(host.head, OLD)
                self.assertFalse((host.state / 'active.json').exists())
                self.assertFalse(any(x[0] == 'compose' and x[1] in ('stop', 'up', 'run') for x in host.events))
                self.assertFalse(list(Path(host.config['backup_root']).iterdir()))

    def test_frontend_requires_mount(self):
        with tempfile.TemporaryDirectory() as temp:
            host = Host(Path(temp), external=False)
            with self.assertRaisesRegex(ValueError, 'external frontend'): host.execute('frontend', NEW)

    def test_wrong_volume_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            host = Host(Path(temp))
            host.base_config['volumes']['data']['name'] = 'different-data'
            with self.assertRaisesRegex(ValueError, 'volume differs'): host.execute('full', NEW)
            self.assertTrue(host.running)

    def test_ci_admission(self):
        run = dict(repository=dict(full_name=deploy.REPO), head_sha=NEW, head_branch='main', event='push',
                   path='.github/workflows/checks.yml', status='completed', conclusion='success')
        jobs = [dict(name='Required checks', conclusion='success')]
        deploy.checked_run(run, jobs, NEW)
        for field, value in [('head_sha', OLD), ('head_branch', 'feature'), ('event', 'pull_request'),
                             ('path', 'other.yml'), ('status', 'in_progress'), ('conclusion', 'failure')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                deploy.checked_run(dict(run, **{field: value}), jobs, NEW)
        for invalid in ([], jobs + jobs, [dict(name='Required checks', conclusion='skipped')]):
            with self.assertRaises(ValueError): deploy.checked_run(run, invalid, NEW)

    def test_environment_update(self):
        text = '# retained\nCHORAL_ORIGIN=https://example.test\nexport CHORAL_IMAGE_TAG = old\n'
        value = deploy.image_env(text, 'new')
        self.assertIn('# retained\nCHORAL_ORIGIN=https://example.test\n', value)
        self.assertIn('CHORAL_IMAGE_TAG=new\n', value)
        with self.assertRaises(ValueError): deploy.image_env(text + 'CHORAL_IMAGE_TAG=duplicate\n', 'new')

    def test_song_http_checks(self):
        checker = deploy.module('check-deploy-song')
        fixture = dict(token='x' * 43, song_id='a' * 36, track_id='b' * 36,
                       media_sha256=deploy.hashlib.sha256(b'abcdefghijklmnoprest').hexdigest(),
                       peaks_sha256=deploy.hashlib.sha256(b'{"peaks":[]}').hexdigest())
        mode = ['success']
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                status, headers = 200, {}
                if mode[0] == 'redirect':
                    status, data = 302, b''
                    headers['Location'] = '/redirected'
                elif self.path.endswith('/media'):
                    data = b'abcdefghijklmnoprest'
                    if self.headers.get('Range'):
                        status, data = 206, data[:16]
                        headers['Content-Range'] = 'bytes 0-15/20'
                        if mode[0] == 'range': data = b'wrong'
                elif self.path.endswith('/peaks'):
                    data = b'{"peaks":[]}' if mode[0] != 'corrupt' else b'corrupt'
                else:
                    data = json.dumps(dict(songs=[dict(id=fixture['song_id'], tracks=[dict(id=fixture['track_id'])])])).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(data)))
                for key, value in headers.items(): self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = 'http://127.0.0.1:' + str(server.server_port)
            checker.check(origin, fixture)
            for failure in ('range', 'corrupt', 'redirect'):
                mode[0] = failure
                with self.assertRaises(ValueError) as error: checker.check(origin, fixture)
                self.assertNotIn(fixture['token'], str(error.exception))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_lock_rejects_second_process(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'lock'
            with deploy.maintenance_lock(path):
                result = subprocess.run([sys.executable, '-c',
                    'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', str(path)],
                    capture_output=True)
                self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
