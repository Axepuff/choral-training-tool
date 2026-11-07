#!/usr/bin/env python3
"""Fetch an admitted CI frontend without rebuilding; smoke an explicit deployment."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import urlopen

REPO = 'Axepuff/choral-training-tool'
SHA = re.compile('[0-9a-f]{40}')
sys.dont_write_bytecode = True


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)


def validate_admission(run, jobs, receipt, commit, run_id):
    if (run.get('id') != int(run_id) or run.get('head_sha') != commit or
            run.get('repository', {}).get('full_name') != REPO or
            run.get('path') != '.github/workflows/checks.yml' or
            run.get('event') != 'push' or run.get('head_branch') != 'main' or
            run.get('status') != 'completed' or run.get('conclusion') != 'success'):
        raise ValueError('Expected a successful PR checks push run on main for this exact commit')
    required = [j for j in jobs if j.get('name') == 'Required checks']
    if len(required) != 1 or required[0].get('conclusion') != 'success':
        raise ValueError('Required checks did not pass')
    if (receipt.get('commit') != commit or receipt.get('api') != 'choral-api-v1' or
            receipt.get('run_id') != str(run_id) or
            receipt.get('run_attempt') != str(run['run_attempt']) or
            not re.fullmatch('[0-9a-f]{64}', receipt.get('sha256', ''))):
        raise ValueError('Admission is missing, stale or belongs to other bytes/commit/run')


def release_module():
    spec = importlib.util.spec_from_file_location('frontend', Path(__file__).with_name('frontend-release.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare(args):
    if not SHA.fullmatch(args.commit) or not SHA.fullmatch(args.backend_commit):
        raise ValueError('Use full lowercase commit SHAs')
    if not re.fullmatch('sha256:[0-9a-f]{64}', args.backend_image):
        raise ValueError('Record the installed backend image digest')
    if not args.confirm_compatible:
        raise ValueError('Review API usage against the installed backend, then confirm compatibility')
    if args.output.exists():
        raise ValueError('Output must be a new directory')
    # Use complete local Git history: GitHub compare file lists can be truncated.
    subprocess.run(['git', 'merge-base', '--is-ancestor', args.backend_commit, args.commit], check=True)
    import ci
    changes = ci.changed_paths(args.backend_commit, args.commit)
    incompatible = [p for p in changes if p.startswith(('backend/', 'docs/api/')) and
                    not p.endswith(('_test.go', '.md')) and p != 'backend/internal/platform/frontend.go']
    if incompatible:
        raise ValueError('Backend/API changes since installed version require a coordinated release: ' + ', '.join(incompatible))
    run = json.loads(gh('api', f'repos/{REPO}/actions/runs/{args.run_id}'))
    jobs = json.loads(gh('api', f'repos/{REPO}/actions/runs/{args.run_id}/attempts/{run["run_attempt"]}/jobs?per_page=100'))['jobs']
    with tempfile.TemporaryDirectory(prefix='choral-ci-delivery-') as temp:
        work = Path(temp)
        for name, directory in ((f'frontend-{args.commit}', 'candidate'), (f'frontend-admission-{args.commit}', 'admission')):
            gh('run', 'download', str(args.run_id), '--repo', REPO, '--name', name, '--dir', str(work / directory))
        receipt = json.loads((work / 'admission/admission.json').read_text())
        validate_admission(run, jobs, receipt, args.commit, args.run_id)
        archive = work / 'candidate/frontend.tar'
        frontend = release_module()
        manifest, _ = frontend.load_artifact(archive, receipt['sha256'])
        if manifest['commit'] != args.commit or manifest['api'] != receipt['api']:
            raise ValueError('Artifact does not match admission')
        receipt.update(backend_commit=args.backend_commit, backend_image=args.backend_image,
                       compatibility_confirmed=True, checks_url=run['html_url'])
        # Only validated bytes leave the temporary directory. Nothing is published.
        args.output.mkdir(parents=True)
        shutil.copyfile(archive, args.output / 'frontend.tar')
        (args.output / 'frontend.tar.sha256').write_text(receipt['sha256'] + '  frontend.tar\n')
        (args.output / 'admission.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt, indent=2))


def smoke(args):
    parsed = urlparse(args.origin)
    if (parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/') or
            not (parsed.scheme == 'https' or parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost'))):
        raise ValueError('Use an HTTPS origin or an isolated loopback HTTP origin')
    frontend = release_module()
    manifest, files = frontend.load_artifact(args.artifact, args.sha256)
    base = args.origin.rstrip('/')

    def request(path, status=200, expected=None):
        try:
            with urlopen(base + path, timeout=15) as response:
                actual, data = response.status, response.read()
        except HTTPError as error:
            actual, data = error.code, b''
        if actual != status or expected is not None and data != expected:
            raise ValueError('Deployment smoke failed: ' + path)

    for path in ('/', '/listen/ci-smoke'):
        request(path, expected=files['index.html'])
    for name, data in files.items():
        if name.startswith('assets/'):
            request('/' + name, expected=data)
    if args.previous_artifact:
        previous = args.previous_artifact.read_bytes()
        _, old_files = frontend.load_artifact(args.previous_artifact, hashlib.sha256(previous).hexdigest())
        for name, data in old_files.items():
            if name.startswith('assets/'):
                request('/' + name, expected=data)
    request('/readyz')
    request('/api/v1/auth/me', 401)
    request('/api/missing', 404)
    request('/assets/missing.js', 404)
    print('HTTP smoke passed for frontend ' + manifest['commit'] + '; login/playback still need browser acceptance.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare_parser = commands.add_parser('prepare')
    prepare_parser.add_argument('--run-id', type=int, required=True)
    prepare_parser.add_argument('--commit', required=True)
    prepare_parser.add_argument('--backend-commit', required=True)
    prepare_parser.add_argument('--backend-image', required=True)
    prepare_parser.add_argument('--confirm-compatible', action='store_true')
    prepare_parser.add_argument('--output', type=Path, required=True)
    smoke_parser = commands.add_parser('smoke')
    smoke_parser.add_argument('--origin', required=True)
    smoke_parser.add_argument('--artifact', type=Path, required=True)
    smoke_parser.add_argument('--sha256', required=True)
    smoke_parser.add_argument('--previous-artifact', type=Path)
    args = parser.parse_args()
    (prepare if args.command == 'prepare' else smoke)(args)


if __name__ == '__main__':
    main()
