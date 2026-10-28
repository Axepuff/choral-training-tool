#!/usr/bin/env python3
"""Exercise the documented nginx proxy with synthetic secrets. Requires nginx."""
import http.client
import http.server
from pathlib import Path
import shutil
import socket
import subprocess
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
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                        conn.request("GET", path, headers={"Host": "choir.example.test", **headers})
                        response = conn.getresponse()
                        assert response.status == expected, (response.status, expected)
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
