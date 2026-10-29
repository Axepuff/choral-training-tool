#!/usr/bin/env python3
"""Run the deployment fragment in an isolated Caddy, never the host service.

Only synthetic requests, temporary certificates/storage and loopback high ports.
No ACME, system trust installation, Docker, production config or admin API access.
"""
import http.client
import http.server
import itertools
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time


ROOT = Path(__file__).resolve().parent.parent
SECRETS = ['synthetic-path-secret-16', 'synthetic-query-secret-16',
           'synthetic-cookie-16', 'synthetic-auth-16', 'synthetic-referer-16']
PATH = f'/api/v1/public/shares/{SECRETS[0]}/media?token={SECRETS[1]}'
HOST = 'choral-train.ru'


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if 'truncated' in self.path:
            self.send_response(200)
            self.send_header('Content-Length', '100')
            self.end_headers()
            self.wfile.write(b'x')
            self.wfile.flush()
            self.close_connection = True
            return
        if 'unavailable' in self.path:
            self.connection.close()
            return
        assert self.headers['Host'] == HOST
        assert self.headers['X-Forwarded-Proto'] == 'https'
        assert self.path.startswith('/api/v1/public/shares/')
        code = 404 if 'missing' in self.path else 200
        body = b'0123456789'
        if self.headers.get('Range') == 'bytes=2-5':
            code, body = 206, body[2:6]
        self.send_response(code)
        if code == 206:
            self.send_header('Content-Range', 'bytes 2-5/10')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    do_HEAD = do_GET

    def do_POST(self):
        # Read real bytes so a streaming/chunked request cannot evade the limit.
        remaining = int(self.headers['Content-Length'])
        while remaining:
            data = self.rfile.read(min(65536, remaining))
            if not data:
                return
            remaining -= len(data)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_):
        pass


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def check_prepare(root):
    base = root / 'original'
    candidate = root / 'candidate'
    original = ('https://existing.example.test {\n'
                ' handle /one {\n respond "one"\n }\n'
                ' handle {\n respond "two"\n }\n}\n')
    base.write_text(original)

    def prepare(source, destination):
        return subprocess.run([sys.executable, str(ROOT / 'scripts/prepare-caddy.py'),
                               str(source), str(destination)], capture_output=True).returncode

    assert prepare(base, candidate) == 0
    assert candidate.read_text().endswith(original + '\n\n' + (ROOT / 'deploy/choral.caddy').read_text())
    assert candidate.stat().st_mode & 0o777 == 0o600
    assert prepare(base, candidate) != 0, 'existing candidate must not be overwritten'
    assert prepare(candidate, root / 'duplicate') != 0, 'duplicate host accepted'
    assert not (root / 'duplicate').exists()
    base.write_text('{\n debug\n}\n' + original)
    assert prepare(base, root / 'debug') != 0, 'debug logging accepted'
    assert not (root / 'debug').exists()
    base.write_text(original.replace(' respond "one"', ' log\n respond "one"'))
    assert prepare(base, root / 'access') != 0, 'access logging accepted'
    assert not (root / 'access').exists()
    # Existing globals/comments must remain intact when inserting logging.
    base.write_text('# leading comment\n{ # global options\n admin off\n}\n' + original)
    assert prepare(base, root / 'globals') == 0
    assert ' admin off\n}\n' + original in (root / 'globals').read_text()
    print('PASS: candidate preserves original, mode 0600, refuses overwrite/duplicate/debug/access logs')


def main():
    caddy = shutil.which('caddy')
    if not caddy or not shutil.which('openssl'):
        raise SystemExit('caddy and openssl are required; check was NOT run')
    with tempfile.TemporaryDirectory(prefix='choral-caddy-') as directory:
        root = Path(directory)
        check_prepare(root)
        env = dict(os.environ, XDG_DATA_HOME=str(root / 'data'),
                   XDG_CONFIG_HOME=str(root / 'config'))
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-days', '1', '-subj', '/CN=choral-train.ru', '-addext',
                        'subjectAltName=DNS:choral-train.ru,DNS:other.example.test,IP:127.0.0.1',
                        '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem')],
                       check=True, capture_output=True)
        context = ssl.create_default_context(cafile=str(root / 'cert.pem'))
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream) as upstream:
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
            https_port, http_port = port(), port()
            fragment = (ROOT / 'deploy/choral.caddy').read_text()
            fragment = fragment.replace('choral-train.ru {', f'https://{HOST}:{https_port} {{\n'
                                        f' bind 127.0.0.1\n tls {root}/cert.pem {root}/key.pem')
            fragment = fragment.replace('127.0.0.1:8080', f'127.0.0.1:{upstream.server_port}')
            config = root / 'Caddyfile'
            logging = (ROOT / 'deploy/caddy-logging.caddy').read_text()
            config.write_text('{\n' + logging + f'\n admin off\n persist_config off\n'
                              f' http_port {http_port}\n https_port {https_port}\n'
                              ' servers {\n protocols h1 h2\n }\n}\n' + fragment +
                              f'\nhttps://other.example.test:{https_port} {{\n'
                              f' bind 127.0.0.1\n tls {root}/cert.pem {root}/key.pem\n'
                              ' @broken path /unavailable /truncated\n handle @broken {\n'
                              f' reverse_proxy 127.0.0.1:{upstream.server_port}\n }}\n'
                              ' handle {\n respond "existing site"\n }\n}\n')
            log_path = root / 'process.log'
            with log_path.open('w') as log:
                process = subprocess.Popen([caddy, 'run', '--config', str(config),
                                            '--adapter', 'caddyfile'],
                                           stdout=log, stderr=log, env=env)
                try:
                    for _ in range(100):
                        if process.poll() is not None:
                            raise RuntimeError('isolated Caddy startup failed: ' + log_path.read_text())
                        try:
                            with socket.create_connection(('127.0.0.1', https_port), timeout=.1):
                                break
                        except OSError:
                            time.sleep(.05)
                    else:
                        raise RuntimeError('isolated Caddy did not start')

                    def request(path=PATH, method='GET', headers=None, body=None, tls=True):
                        conn = (http.client.HTTPSConnection('127.0.0.1', https_port,
                                                           context=context, timeout=8) if tls else
                                http.client.HTTPConnection('127.0.0.1', http_port, timeout=8))
                        fields = {'Host': HOST, 'Cookie': 'session=' + SECRETS[2],
                                  'Authorization': 'Bearer ' + SECRETS[3],
                                  'Referer': 'https://example.test/' + SECRETS[4]}
                        fields.update(headers or {})
                        try:
                            conn.request(method, path, body=body, headers=fields)
                            response = conn.getresponse()
                            return response.status, dict(response.getheaders()), response.read()
                        finally:
                            conn.close()

                    for path, expected in [(PATH, 200), (PATH + '&missing', 404),
                                           (PATH + '&unavailable', 502),
                                           (PATH.replace('/media', '/%ZZ'), 400)]:
                        status, _, _ = request(path)
                        assert status == expected, (expected, status)
                    status, headers, body = request(headers={'Range': 'bytes=2-5'})
                    assert status == 206 and body == b'2345'
                    assert headers['Content-Range'] == 'bytes 2-5/10'
                    status, headers, body = request(method='HEAD')
                    assert status == 200 and body == b'' and headers['Content-Length'] == '10'
                    status, _, _ = request(method='POST', body=b'small upload')
                    assert status == 200
                    # Exercise the actual 101 MiB boundary without allocating it in RAM.
                    oversized = itertools.chain(itertools.repeat(b'x' * 65536, 1616), [b'x'])
                    status, _, _ = request(method='POST', body=oversized,
                                           headers={'Content-Length': str(101*1024*1024 + 1)})
                    assert status == 413, status
                    status, headers, _ = request(tls=False)
                    assert status == 308
                    assert headers['Location'] == f'https://{HOST}' + PATH
                    status, _, body = request(headers={'Host': 'other.example.test'})
                    assert status == 200 and body == b'existing site'
                    status, _, _ = request(path='/unavailable', headers={'Host': 'other.example.test',
                                            'Cookie': '', 'Authorization': '', 'Referer': ''})
                    assert status == 502, 'adjacent site error status changed'
                    for path, host in [(PATH + '&truncated', HOST),
                                       ('/truncated', 'other.example.test')]:
                        try:
                            request(path, headers={'Host': host})
                        except http.client.IncompleteRead:
                            pass
                        else:
                            raise AssertionError('truncated response must fail at the client')
                finally:
                    process.terminate()
                    process.wait(timeout=10)
                    upstream.shutdown()
            logs = log_path.read_text()
            entries = [json.loads(line) for line in logs.splitlines() if line.startswith('{')]
            aborted = [e for e in entries if e.get('msg') == 'aborting with incomplete response']
            assert len(aborted) == 2, 'truncated response diagnostics missing or duplicated'
            assert {e['request']['host'] for e in aborted} == {HOST, 'other.example.test'}
            for entry in aborted:
                assert entry['level'] == 'warn' and entry['error']
                assert entry['request']['method'] == 'GET'
                assert 'uri' not in entry['request'] and 'headers' not in entry['request']
            assert any(e.get('logger') == 'http.log.error'
                       and e.get('request', {}).get('host') == 'other.example.test'
                       for e in entries), 'adjacent site error diagnostic disappeared'
            for secret in SECRETS:
                assert secret not in logs, 'synthetic secret leaked to Caddy process logs'
    print('PASS: Caddy TLS, 200/404/502/413/400, upload, HEAD/Range, redirect, truncated bodies, adjacent diagnostics and secret-free logs')


if __name__ == '__main__':
    main()
