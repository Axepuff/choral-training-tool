#!/usr/bin/env python3
"""Publication safety tests; optional real Go process HTTP/static integration."""
import argparse
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen, Request
import socket

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('frontend', Path(__file__).with_name('frontend-release.py'))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
SERVER = None


def artifact(path, commit, label):
    script = f'window.release = "{label}";'.encode()
    asset = 'assets/aac.worker-' + hashlib.sha256(script).hexdigest()[:16] + '.js'
    files = {'index.html': f'<html><script src="/{asset}"></script></html>'.encode(), asset: script,
             'fonts/jost/OFL.txt': b'fictional font license', 'fonts/jost/SOURCE.txt': b'fictional font attribution'}
    manifest = {'format': 1, 'commit': commit, 'api': f.API, 'demo': False,
                'base': '/', 'files': {n: f.digest(d) for n, d in files.items()}}
    checksum = f.write_artifact(path, manifest, files)
    return checksum, manifest, files


class Releases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='choral-frontend-test-')
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.root = self.work / 'frontend'
        self.a, self.b = 'a' * 40, 'b' * 40
        self.one, self.two = self.work / 'one.tar', self.work / 'two.tar'
        self.sum1, self.meta1, self.files1 = artifact(self.one, self.a, 'one')
        self.sum2, self.meta2, self.files2 = artifact(self.two, self.b, 'two')
        self.publish(self.one, self.sum1, self.a)

    def publish(self, archive, checksum, commit):
        f.publish(self.root, archive, checksum, commit, f.API)

    def test_switch_rollback_and_snapshot_restore(self):
        self.publish(self.two, self.sum2, self.b)
        self.assertEqual(f.current(self.root), self.b)
        for name in self.files1:
            if name.startswith('assets/'):
                self.assertEqual((self.root / 'current' / name).read_bytes(), self.files1[name])
        f.rollback(self.root, self.a, f.API)
        output = self.work / 'frontend.tar'
        f.snapshot(self.root, output)
        recorded = json.loads((self.work / 'FRONTEND.json').read_text())
        self.assertEqual(recorded['sha256'], self.sum1)
        self.assertEqual(output.read_bytes(), self.one.read_bytes())
        restored = self.work / 'restored'
        f.publish(restored, output, recorded['sha256'], recorded['commit'], recorded['api'])
        self.assertEqual((restored / 'current/index.html').read_bytes(), self.files1['index.html'])

    def test_partial_upload_wrong_checksum_and_approval(self):
        for data, checksum, commit in [(self.two.read_bytes()[:1024], self.sum2, self.b),
                                       (self.two.read_bytes(), '0' * 64, self.b),
                                       (self.two.read_bytes(), self.sum2, self.a)]:
            broken = self.work / 'broken.tar'
            broken.write_bytes(data)
            with self.assertRaises(ValueError):
                self.publish(broken, checksum, commit)
            self.assertEqual(f.current(self.root), self.a)
        with self.assertRaises(ValueError):
            f.publish(self.root, self.two, self.sum2, self.b, 'choral-api-v2')

    def test_missing_asset_demo_bad_base_hash_and_archive_paths(self):
        cases = []
        for field, value in [('demo', True), ('base', './')]:
            cases.append(({**self.meta2, field: value}, self.files2))
        cases.append((self.meta2, {'index.html': self.files2['index.html']}))
        cases.append((self.meta2, {**self.files2, 'index.html': b'corrupt'}))
        for manifest, files in cases:
            checksum = f.write_artifact(self.two, manifest, files)
            with self.assertRaises(ValueError):
                self.publish(self.two, checksum, self.b)
            self.assertEqual(f.current(self.root), self.a)
        for name, kind in [('../escape', tarfile.REGTYPE), ('index.html', tarfile.SYMTYPE)]:
            with tarfile.open(self.two, 'w') as tar:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = '/etc/passwd'
                tar.addfile(member, io.BytesIO())
            with self.assertRaises(ValueError):
                self.publish(self.two, f.digest(self.two.read_bytes()), self.b)
        self.assertFalse((self.work / 'escape').exists())

    def test_concurrent_deploy_and_rollback_refuse(self):
        with (self.root / '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for args in [ ['publish', str(self.two), '--sha256', self.sum2, '--approved-commit', self.b],
                          ['rollback', '--to', self.a] ]:
                result = subprocess.run([sys.executable, str(Path(f.__file__)), *args,
                                         '--root', str(self.root), '--backend-api', f.API], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'holds the lock', result.stderr)
        self.assertEqual(f.current(self.root), self.a)

    def test_refuse_mixed_private_directory_and_support_private_umask(self):
        mixed = self.work / 'mixed'
        mixed.mkdir()
        (mixed / 'choral.sqlite').write_bytes(b'fictional private database')
        with self.assertRaises(ValueError):
            f.publish(mixed, self.two, self.sum2, self.b, f.API)
        self.assertEqual(list(mixed.iterdir()), [mixed / 'choral.sqlite'])
        previous_umask = os.umask(0o077)
        try:
            fresh = self.work / 'fresh'
            f.publish(fresh, self.two, self.sum2, self.b, f.API)
            for p in (fresh, fresh / 'assets', fresh / 'releases', fresh / 'releases' / self.b):
                self.assertEqual(p.stat().st_mode & 0o777, 0o755)
        finally:
            os.umask(previous_umask)

    def test_collision_and_corrupt_rollback(self):
        asset = next(n for n in self.files1 if n.startswith('assets/'))
        files = {**self.files1, asset: b'different immutable content'}
        manifest = {**self.meta1, 'commit': self.b, 'files': {n: f.digest(d) for n, d in files.items()}}
        checksum = f.write_artifact(self.two, manifest, files)
        with self.assertRaises(ValueError):
            self.publish(self.two, checksum, self.b)
        self.assertEqual(f.current(self.root), self.a)
        self.sum2, _, _ = artifact(self.two, self.b, 'two')
        self.publish(self.two, self.sum2, self.b)
        (self.root / 'releases' / self.a / 'index.html').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            f.rollback(self.root, self.a, f.API)
        self.assertEqual(f.current(self.root), self.b)

    def test_retention_measured_from_last_use_and_dry_run(self):
        old = time.time() - f.RETENTION - 3600
        self.publish(self.two, self.sum2, self.b)
        # An old build that was just deactivated is still retained.
        for p in (self.root / 'assets').iterdir():
            os.utime(p, (old, old))
        f.prune(self.root, True)
        self.assertTrue((self.root / 'releases' / self.a).exists())
        (self.root / 'releases' / self.a / '.retained-at').write_text(str(old))
        f.prune(self.root, False)
        self.assertTrue((self.root / 'releases' / self.a).exists())
        f.prune(self.root, True)
        self.assertFalse((self.root / 'releases' / self.a).exists())
        self.assertEqual(f.current(self.root), self.b)
        self.assertTrue(all((self.root / name).exists() for name in self.files2 if name.startswith('assets/')))
        self.assertTrue(all(not (self.root / name).exists() for name in self.files1 if name.startswith('assets/')))

    def test_running_process_switch_without_database_changes(self):
        if not SERVER:
            self.skipTest('pass --server for real Go/SQLite/FFmpeg HTTP acceptance')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        private = self.work / 'private'
        env = dict(os.environ, CHORAL_STATIC_DIR=str(self.root / 'current'),
                   CHORAL_DATA_DIR=str(private), CHORAL_ADDR=f'127.0.0.1:{port}',
                   CHORAL_ORIGIN=f'http://127.0.0.1:{port}', CHORAL_LOCAL_HTTP='true')
        with (self.work / 'server.log').open('wb') as log:
            proc = subprocess.Popen([SERVER], env=env, stdout=log, stderr=log)
            try:
                base = f'http://127.0.0.1:{port}'
                for _ in range(100):
                    try:
                        with urlopen(base + '/readyz', timeout=1):
                            break
                    except OSError:
                        if proc.poll() is not None:
                            self.fail('Isolated server failed before readiness')
                        time.sleep(0.1)
                else:
                    self.fail('Readiness timed out')
                pid = proc.pid
                before = {p.relative_to(private): (f.digest(p.read_bytes()), p.stat().st_mtime_ns)
                          for p in private.rglob('*') if p.is_file()}
                old_asset = '/' + next(n for n in self.files1 if n.startswith('assets/'))
                self.assertIn(old_asset.encode(), urlopen(base + '/listen/deep?list=fictional').read())
                self.publish(self.two, self.sum2, self.b)
                for files in (self.files1, self.files2):
                    asset = '/' + next(n for n in files if n.startswith('assets/'))
                    with urlopen(base + asset) as response:
                        self.assertIn('immutable', response.headers['Cache-Control'])
                        self.assertEqual(response.read(), files[asset[1:]])
                with urlopen(base + '/') as response:
                    self.assertEqual(response.headers['Cache-Control'], 'no-cache')
                    self.assertEqual(response.read(), self.files2['index.html'])
                with urlopen(Request(base + old_asset, headers={'Range': 'bytes=0-5'})) as response:
                    self.assertEqual(response.status, 206)
                for path in ('/assets/missing.js', '/api/missing', '/.release.json', '/choral.sqlite', '/assets/.secret'):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(base + path)
                    self.assertEqual(error.exception.code, 404)
                    self.assertNotIn('immutable', error.exception.headers.get('Cache-Control', ''))
                with self.assertRaises(HTTPError) as unauthorized:
                    urlopen(base + '/api/v1/auth/me')
                self.assertEqual(unauthorized.exception.code, 401)
                self.assertEqual(unauthorized.exception.headers['Cache-Control'], 'no-store')
                # Delivery smoke consumes the actual published archive; no rebuild.
                subprocess.run([sys.executable, str(repo_script := Path(__file__).with_name('frontend-delivery.py')),
                                'smoke', '--origin', base, '--artifact', str(self.two), '--sha256', self.sum2,
                                '--previous-artifact', str(self.one)], check=True)
                # A healthy server serving the wrong release must not pass admission smoke.
                wrong = subprocess.run([sys.executable, str(repo_script), 'smoke', '--origin', base,
                                        '--artifact', str(self.one), '--sha256', self.sum1], capture_output=True)
                self.assertNotEqual(wrong.returncode, 0)
                f.rollback(self.root, self.a, f.API)
                self.assertEqual(urlopen(base + '/listen/deep').read(), self.files1['index.html'])
                after = {p.relative_to(private): (f.digest(p.read_bytes()), p.stat().st_mtime_ns)
                         for p in private.rglob('*') if p.is_file()}
                self.assertEqual(before, after, 'Frontend operations changed private data')
                self.assertIsNone(proc.poll())
                self.assertEqual(proc.pid, pid)
            finally:
                proc.terminate()
                proc.wait(timeout=30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--server', help='Absolute path to a newly built Go server')
    args, remaining = parser.parse_known_args()
    SERVER = args.server
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
