#!/usr/bin/env python3
"""Exercise the documented nginx proxy with synthetic secrets. Requires nginx."""
import http.client
import http.server
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith("unavailable"):
            self.connection.close()
            return
        self.send_response(404 if "missing" in self.path else 200)
        self.end_headers()
        self.wfile.write(b"synthetic response")

    def log_message(self, *_):
        pass


def main():
    nginx = shutil.which("nginx")
    if not nginx:
        raise SystemExit("nginx is required; this check was not run")
    doc = (Path(__file__).resolve().parent.parent / "docs/operations.md").read_text()
    example = doc.split("```nginx\n", 1)[1].split("```", 1)[0]
    with tempfile.TemporaryDirectory(prefix="choral-proxy-") as directory:
        root = Path(directory)
        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream) as upstream:
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
            with socket.socket() as reserve:
                reserve.bind(("127.0.0.1", 0))
                port = reserve.getsockname()[1]
            # Only transport/endpoints change; logging directives come from the docs.
            example = example.replace("listen 443 ssl;", f"listen 127.0.0.1:{port};")
            example = example.replace("127.0.0.1:8080", f"127.0.0.1:{upstream.server_port}")
            config = root / "nginx.conf"
            config.write_text(f"daemon off;\nmaster_process off;\npid {root}/nginx.pid;\n"
                              f"error_log {root}/error.log info;\nevents {{}}\nhttp {{\n"
                              f"access_log {root}/access.log combined;\n"
                              f"client_body_temp_path {root}/body;\nproxy_temp_path {root}/proxy;\n"
                              f"fastcgi_temp_path {root}/fastcgi;\nuwsgi_temp_path {root}/uwsgi;\nscgi_temp_path {root}/scgi;\n"
                              + example + "\n}\n")
            tls = '--deployment' in sys.argv
            if tls:
                subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                                '-days', '1', '-subj', '/CN=localhost',
                                '-addext', 'subjectAltName=IP:127.0.0.1',
                                '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem')],
                               check=True, capture_output=True)
                with socket.socket() as reserve:
                    reserve.bind(('127.0.0.1', 0))
                    http_port = reserve.getsockname()[1]
                template = (Path(__file__).resolve().parent.parent / 'deploy/nginx.conf').read_text()
                template = template.replace('user www-data;', 'daemon off;\nmaster_process off;')
                template = template.replace('/run/nginx.pid', str(root / 'nginx.pid'))
                template = template.replace('listen 80 default_server;', f'listen 127.0.0.1:{http_port} default_server;')
                template = template.replace('listen [::]:80 default_server;', '')
                template = template.replace('listen 443 ssl default_server;', f'listen 127.0.0.1:{port} ssl default_server;')
                template = template.replace('listen [::]:443 ssl default_server;', '')
                template = template.replace('/etc/letsencrypt/live/choir.example.test/fullchain.pem', str(root / 'cert.pem'))
                template = template.replace('/etc/letsencrypt/live/choir.example.test/privkey.pem', str(root / 'key.pem'))
                template = template.replace('127.0.0.1:8080', f'127.0.0.1:{upstream.server_port}')
                template = template.replace('http {', f'http {{\nclient_body_temp_path {root}/body;\nproxy_temp_path {root}/proxy;')
                template = template.replace('http {', f'http {{\nfastcgi_temp_path {root}/fastcgi;\nuwsgi_temp_path {root}/uwsgi;\nscgi_temp_path {root}/scgi;')
                config.write_text(template)
                context = ssl.create_default_context(cafile=str(root / 'cert.pem'))
            with (root / "stderr.log").open("w") as stderr:
                process = subprocess.Popen([nginx, "-p", directory, "-c", str(config)],
                                           stdout=stderr, stderr=stderr)
                try:
                    for _ in range(100):
                        if process.poll() is not None:
                            raise RuntimeError("nginx startup failed: " + (root / "stderr.log").read_text())
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                                break
                        except OSError:
                            time.sleep(0.05)
                    else:
                        raise RuntimeError("nginx did not listen")
                    path_token, query_token = "synthetic-path-secret-41", "synthetic-query-secret-41"
                    prefix = f"/api/v1/public/shares/{path_token}/"
                    cases = [(prefix + f"media?token={query_token}", {}, 200),
                             (prefix + f"missing?token={query_token}", {}, 404),
                             (prefix + f"media?token={query_token}&unavailable", {}, 502),
                             (prefix + f"media?token={query_token}", {"Content-Length": str(102*1024*1024)}, 413),
                             (prefix + f"%ZZ?token={query_token}", {}, 400)]
                    for path, headers, expected in cases:
                        conn = (http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=context)
                                if tls else http.client.HTTPConnection("127.0.0.1", port, timeout=5))
                        conn.request("GET", path, headers={"Host": "choir.example.test", **headers})
                        response = conn.getresponse()
                        assert response.status == expected, (response.status, expected)
                        response.read()
                        conn.close()
                    if tls:
                        conn = http.client.HTTPConnection('127.0.0.1', http_port, timeout=5)
                        path = prefix + f'media?token={query_token}'
                        conn.request('GET', path, headers={'Host': 'untrusted.example'})
                        response = conn.getresponse()
                        assert response.status == 308
                        assert response.getheader('Location') == 'https://choir.example.test' + path
                        response.read()
                        conn.close()
                finally:
                    process.terminate()
                    process.wait(timeout=5)
                    upstream.shutdown()
            for log in root.glob("*.log"):
                text = log.read_text()
                assert path_token not in text and query_token not in text, f"secret leaked to {log.name}"
    print("Proxy logs: 200, 404, upstream 502, body 413 and malformed URI 400 passed")


if __name__ == "__main__":
    main()
