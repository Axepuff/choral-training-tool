#!/usr/bin/env python3
"""Prepare a private candidate; never install/reload or print existing config.

Usage: python3 scripts/prepare-caddy.py /etc/caddy/Caddyfile /private/new-Caddyfile
Relative imports are resolved from the original directory. Install beside the
original only after approval. Re-run against the latest original before rollout.
"""
import copy
import json
import os
import re
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


def add_logging(original, logging):
    # Preserve the original text, including comments and relative imports. Only
    # insert into a literal leading global block; ambiguous imports fail adaptation.
    offset = 0
    for line in original.splitlines(keepends=True):
        if line.strip() and not line.lstrip().startswith('#'):
            if re.fullmatch(r'\s*\{\s*(?:#[^\n]*)?\n?', line):
                return original[:offset + len(line)] + logging + '\n' + original[offset + len(line):]
            break
        offset += len(line)
    return '{\n' + logging + '\n}\n' + original


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source, destination = map(Path, sys.argv[1:])
    source = source.resolve()
    original = source.read_text()
    fragment = (ROOT / 'deploy/choral.caddy').read_text()
    logging = (ROOT / 'deploy/caddy-logging.caddy').read_text()
    candidate = add_logging(original, logging) + '\n\n' + fragment
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
    # Allow exactly the reviewed runtime filter, keeping all diagnostic events.
    expected_logging = adapt('{\n' + logging + '\n}\n', source.parent)['logging']
    if after.get('logging') != expected_logging:
        raise SystemExit('Unexpected logging configuration; manual review required.')
    # Remove exactly the logging filter and new route; every existing setting/route
    # to remain identical, including TLS, other apps and ordering of old routes.
    projected = copy.deepcopy(after)
    projected.pop('logging')
    added_routes = 0
    for server in projected.get('apps', {}).get('http', {}).get('servers', {}).values():
        routes = server.get('routes', [])
        added_routes += sum(is_choral(r) for r in routes)
        server['routes'] = [r for r in routes if not is_choral(r)]
    if (added_routes != 1
            or normalize_groups(projected) != normalize_groups(before)):
        raise SystemExit('Candidate changes more than the new host; manual review required.')
    # O_EXCL protects existing candidates and symlinks; configuration may be private.
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(candidate)
    print('PASS: private candidate created; existing routes/settings preserved except reviewed runtime redaction; nothing installed.')


if __name__ == '__main__':
    main()
