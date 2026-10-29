#!/usr/bin/env python3
"""Prepare a private candidate; never install/reload or print existing config.

Usage: python3 scripts/prepare-caddy.py /etc/caddy/Caddyfile /private/new-Caddyfile
Relative imports are resolved from the original directory. Install beside the
original only after approval. Re-run against the latest original before rollout.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys

HOST = 'choral-train.ru'
ROOT = Path(__file__).resolve().parent.parent


def adapt(text, directory):
    result = subprocess.run(['caddy', 'adapt', '--config', '-', '--adapter', 'caddyfile'],
                            cwd=directory, input=text, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit('Caddy adaptation failed; inspect privately, configuration was not printed.')
    return json.loads(result.stdout)


def is_choral(route):
    return route.get('match') == [{'host': [HOST]}]


def normalize_groups(config):
    # The adapter renumbers mutually exclusive route groups when adding a site.
    # Preserve identity/sharing of groups, ignoring only their generated labels.
    labels = {}

    def visit(value):
        if isinstance(value, dict):
            return {key: (labels.setdefault(item, len(labels)) if key == 'group'
                          else visit(item)) for key, item in sorted(value.items())}
        if isinstance(value, list):
            return [visit(item) for item in value]
        return value

    return visit(config)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source, destination = map(Path, sys.argv[1:])
    source = source.resolve()
    original = source.read_text()
    fragment = (ROOT / 'deploy/choral.caddy').read_text()
    candidate = original + '\n\n' + fragment
    before, after = adapt(original, source.parent), adapt(candidate, source.parent)
    # This host was inspected with no custom loggers or access logging. Refuse
    # changes to that premise instead of quietly disabling someone else's logs.
    if before.get('logging'):
        raise SystemExit('Existing custom/debug logging requires a separate privacy review.')
    servers = before.get('apps', {}).get('http', {}).get('servers', {})
    for server in servers.values():
        if server.get('logs') or server.get('trace'):
            raise SystemExit('Existing access/trace logging requires a separate privacy review.')
        if any(is_choral(route) for route in server.get('routes', [])):
            raise SystemExit('Choral host already configured; refusing duplicate installation.')
    # Remove exactly the two additions and require every existing setting/route
    # to remain identical, including TLS, other apps and ordering of old routes.
    projected = copy.deepcopy(after)
    added_routes = added_errors = 0
    for server in projected.get('apps', {}).get('http', {}).get('servers', {}).values():
        routes = server.get('routes', [])
        added_routes += sum(is_choral(r) for r in routes)
        server['routes'] = [r for r in routes if not is_choral(r)]
        errors = server.get('errors', {})
        routes = errors.get('routes', [])
        added_errors += sum(is_choral(r) for r in routes)
        if routes:
            errors['routes'] = [r for r in routes if not is_choral(r)]
            if not errors['routes']:
                del errors['routes']
            if not errors:
                server.pop('errors', None)
    if ((added_routes, added_errors) != (1, 1)
            or normalize_groups(projected) != normalize_groups(before)):
        raise SystemExit('Candidate changes more than the new host; manual review required.')
    # O_EXCL protects existing candidates and symlinks; configuration may be private.
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(candidate)
    print('PASS: private candidate created; existing routes/settings preserved; nothing installed.')


if __name__ == '__main__':
    main()
