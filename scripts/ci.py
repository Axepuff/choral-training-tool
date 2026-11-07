#!/usr/bin/env python3
"""Conservative CI routing and fail-closed aggregate check (stdlib only)."""
import argparse
import json
import os
from pathlib import Path
import subprocess

JOBS = ('frontend', 'backend', 'e2e', 'infrastructure', 'queue')
FLAGS = ('auth', 'audio', 'backup', 'proxy', 'container', 'release')
COMPONENTS = ('SignIn', 'CreateSong', 'SongLibrary', 'RehearsalPlayer', 'TrackControls')


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def changed_paths(base, head):
    # NUL framing preserves spaces, tabs and newlines; both sides of renames count.
    fields = subprocess.check_output(['git', 'diff', '--name-status', '-z', '--find-renames', base, head, '--']).decode().split('\0')
    paths = []
    i = 0
    while i < len(fields) - 1:
        status = fields[i]
        count = 2 if status.startswith(('R', 'C')) else 1
        paths.extend(fields[i + 1:i + 1 + count])
        i += 1 + count
    return sorted(set(paths))


def plan(paths, fallback=False):
    result = {key: False for key in (*JOBS, *FLAGS)}
    stories = set()
    reasons = []
    scopes = set()

    def select(*keys):
        for key in keys:
            result[key] = True

    def broad(reason):
        select(*JOBS, *FLAGS)
        stories.add('../src/**/*.stories.tsx')
        scopes.update(('auth', 'songs'))
        reasons.append(reason)

    if fallback:
        broad('Diff unavailable: all checks required')
    for path in paths:
        if path.startswith('docs/api/') or path in ('backend/go.mod', 'backend/go.sum'):
            broad(path + ': shared API/dependencies')
        elif path in ('docs/operations.md', 'docs/deployment.md'):
            select('proxy')  # These documents contain executable nginx examples.
        elif path.endswith('.md') and (path.startswith('docs/') or path in ('README.md', 'AGENTS.md')):
            continue
        elif path.startswith('src/') and path.endswith(('.css', '.woff', '.woff2')):
            select('frontend')
            reasons.append(path + ': visual; manual responsive/story/focus evidence required')
        elif path.startswith('src/components/') and path.split('/')[2] in COMPONENTS:
            component = path.split('/')[2]
            select('frontend')
            stories.update((f'../src/components/{component}/*.stories.tsx', '../src/stories/workflows/*.stories.tsx'))
            if not path.endswith('.stories.tsx') and '/mock' not in path:
                select('e2e')
                if component == 'SignIn':
                    select('auth')
                    scopes.add('auth')
                else:
                    scopes.add('songs')
                if component in ('RehearsalPlayer', 'TrackControls'):
                    select('audio')
        elif path.startswith(('src/auth/', 'src/api/', 'src/navigation/')) or path in ('src/main.tsx', 'src/App.tsx', 'src/PublicRoute.tsx'):
            select('frontend', 'auth', 'e2e')
            scopes.update(('auth', 'songs'))
        elif path.startswith('src/audio/'):
            select('frontend', 'audio', 'e2e')
            scopes.add('songs')
        elif path.startswith(('src/components/ui/', 'src/stories/', 'src/demo/', '.storybook/')):
            select('frontend')
            stories.add('../src/**/*.stories.tsx')
            if path.startswith('src/components/ui/') and not path.endswith('.stories.tsx'):
                select('auth', 'audio', 'e2e')
                scopes.update(('auth', 'songs'))
            if path.startswith('src/demo/'):
                select('e2e')
                scopes.add('auth')
        elif path.startswith('backend/'):
            select('backend', 'e2e')
            scopes.update(('auth', 'songs'))
            if path == 'backend/internal/platform/frontend.go':
                select('release')
        elif path.startswith('scripts/agent-queue/'):
            select('queue')
        elif path in ('tests/auth.test.mjs', 'tests/auth-browser.mjs'):
            select('frontend', 'auth', 'e2e')
            scopes.add('auth')
        elif path.startswith(('tests/audio', 'tests/mp4', 'tests/helpers/audio')):
            select('frontend', 'audio')
        elif path == 'tests/songs-browser.mjs':
            select('e2e')
            scopes.add('songs')
        elif path.startswith('tests/e2e/'):
            select('frontend', 'e2e')
            scopes.update(('auth', 'songs'))
            stories.add('../src/**/*.stories.tsx')
        elif path in ('scripts/frontend-release.py', 'scripts/check-frontend-release.py', 'scripts/check-frontend-container.py', 'tests/frontend-deploy-browser.mjs'):
            select('frontend', 'release', 'container', 'backup')
        elif path.startswith('deploy/') or path.startswith(('scripts/check-proxy', 'scripts/check-caddy', 'scripts/prepare-caddy')):
            if 'backup' in path or 'restore' in path:
                select('backup', 'container')
            else:
                select('proxy')
        elif path.startswith('scripts/') and any(word in path for word in ('backup', 'restore', 'container')):
            select('backup', 'container', 'release')
        elif path in ('Dockerfile', '.dockerignore', '.env.example') or path.startswith('compose.'):
            select('container', 'backup', 'proxy', 'release')
        else:
            # Includes lockfiles, workflows, CI/delivery tooling, index.html,
            # config files, unknown code and future directories. No silent green.
            broad(path + ': common or unmapped change')
    result['infrastructure'] = any(result[key] for key in ('backup', 'proxy', 'container', 'release'))
    result['stories'] = sorted(stories)
    result['e2e_packages'] = [f'./internal/{scope}' for scope in sorted(scopes)]
    result['paths'] = paths
    result['reasons'] = reasons
    return result


def gate(needs):
    if needs.get('changes', {}).get('result') != 'success':
        raise ValueError('Change selection did not succeed')
    selection = json.loads(needs['changes']['outputs']['plan'])
    for name in JOBS:
        selected = selection.get(name)
        if type(selected) is not bool:
            raise ValueError('Missing/invalid selection: ' + name)
        expected = 'success' if selected else 'skipped'
        actual = needs.get(name, {}).get('result')
        if actual != expected:
            raise ValueError(f'{name}: expected {expected}, got {actual}')
    return selection


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'gate'))
    parser.add_argument('--base')
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--paths', nargs='*')
    args = parser.parse_args()
    if args.command == 'gate':
        selection = gate(json.loads(os.environ['CI_NEEDS']))
        print('All selected checks passed; unselected jobs were skipped.')
        if os.environ.get('GITHUB_EVENT_NAME') == 'push' and selection['frontend']:
            needs = json.loads(os.environ['CI_NEEDS'])
            checksum = needs['frontend']['outputs']['sha256']
            import re
            if not re.fullmatch('[0-9a-f]{64}', checksum):
                raise ValueError('Missing artifact checksum')
            receipt = {'commit': selection['commit'], 'sha256': checksum,
                       'api': 'choral-api-v1', 'run_id': os.environ['GITHUB_RUN_ID'],
                       'run_attempt': os.environ['GITHUB_RUN_ATTEMPT']}
            Path(os.environ['RUNNER_TEMP'], 'admission.json').write_text(json.dumps(receipt, indent=2) + '\n')
        return
    fallback = False
    if args.paths is not None:
        paths = args.paths
    elif args.base:
        paths = changed_paths(args.base, args.head)
    else:
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        try:
            if os.environ['GITHUB_EVENT_NAME'] == 'pull_request':
                head = event['pull_request']['head']['sha']
                base = git('merge-base', event['pull_request']['base']['sha'], head)
            else:
                base, head = event['before'], event['after']
                if base == '0' * 40:
                    raise ValueError('Initial push')
            paths = changed_paths(base, head)
        except (subprocess.CalledProcessError, KeyError, ValueError):
            paths, fallback = [], True
    selection = plan(paths, fallback)
    selection['commit'] = git('rev-parse', 'HEAD')
    encoded = json.dumps(selection, separators=(',', ':'))
    print(json.dumps(selection, indent=2))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
            out.write('plan=' + encoded + '\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as out:
            out.write('## Selected checks\n\n```json\n' + json.dumps(selection, indent=2) + '\n```\n')


if __name__ == '__main__':
    main()
