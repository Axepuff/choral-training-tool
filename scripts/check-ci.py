#!/usr/bin/env python3
"""CI contract checks: representative diffs, Git events, gate and release admission."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
import ci
spec = importlib.util.spec_from_file_location('delivery', Path(__file__).with_name('frontend-delivery.py'))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)
SCRIPT = str(Path(__file__).with_name('ci.py').resolve())


class Routing(unittest.TestCase):
    def test_representative_changes(self):
        # Independent risk expectations: CSS must not acquire audio/Go/browser work;
        # executable changes must retain their owning behavior checks.
        cases = [
            ('CSS', ['src/components/RehearsalPlayer/RehearsalPlayer.module.css'], {'frontend'}, set()),
            ('password form', ['src/auth/ChangePassword.tsx'], {'frontend', 'e2e'}, {'auth'}),
            ('song validation', ['src/components/CreateSong/CreateSong.tsx'], {'frontend', 'e2e'}, set()),
            ('audio', ['src/audio/engine.ts'], {'frontend', 'e2e'}, {'audio'}),
            ('API client', ['src/api/client.ts'], {'frontend', 'e2e'}, {'auth'}),
            ('Go migration', ['backend/migrations/0006_example.sql'], {'backend', 'e2e'}, set()),
            ('container', ['compose.frontend.yaml'], {'infrastructure'}, {'container', 'release', 'backup', 'proxy'}),
            ('backup', ['scripts/scheduled-backup.sh'], {'infrastructure'}, {'container', 'release', 'backup'}),
            ('proxy', ['deploy/choral.caddy'], {'infrastructure'}, {'proxy'}),
            ('docs', ['docs/frontend-deployment.md'], set(), set()),
            ('executable docs', ['docs/operations.md'], {'infrastructure'}, {'proxy'}),
            ('mixed', ['src/styles/tokens.css', 'backend/internal/auth/auth.go'], {'frontend', 'backend', 'e2e'}, set()),
        ]
        for label, paths, expected_jobs, expected_flags in cases:
            with self.subTest(label=label):
                result = ci.plan(paths)
                selected = {key for key in ci.JOBS if result[key]}
                self.assertEqual(selected, expected_jobs)
                self.assertEqual({key for key in ci.FLAGS if result[key]}, expected_flags)
                if label == 'CSS':
                    self.assertEqual(result['stories'], [])
                if label == 'song validation':
                    self.assertEqual(result['e2e_packages'], ['./internal/songs'])
                    self.assertIn('../src/components/CreateSong/*.stories.tsx', result['stories'])
                print(f'{label}: selected={sorted(selected)} skipped={sorted(set(ci.JOBS) - selected)}')
        for path in ('package-lock.json', 'vite.config.ts', '.github/workflows/checks.yml',
                     'docs/api/openapi.yaml', 'new-area/unknown.txt', 'scripts/ci.py'):
            with self.subTest(path=path):
                result = ci.plan([path])
                self.assertTrue(all(result[key] for key in (*ci.JOBS, *ci.FLAGS)))

    def test_real_git_push_pr_rename_and_delete(self):
        with tempfile.TemporaryDirectory(prefix='choral-ci-git-') as temp:
            work = Path(temp)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=work, text=True, stderr=subprocess.DEVNULL).strip()
            def commit(label):
                git('add', '.')
                git('-c', 'user.name=CI Test', '-c', 'user.email=ci@example.test', 'commit', '-qm', label)
                return git('rev-parse', 'HEAD')
            git('init', '-q')
            (work / 'src/audio').mkdir(parents=True)
            (work / 'docs').mkdir()
            (work / 'src/audio/engine.ts').write_text('audio logic\n')
            (work / 'docs/old file.md').write_text('old documentation\n')
            base = commit('base')
            git('checkout', '-qb', 'feature')
            (work / 'src/audio/engine.ts').rename(work / 'docs/renamed file.md')
            (work / 'docs/old file.md').unlink()
            head = commit('rename code to docs and delete')
            git('checkout', '-qb', 'base-advanced', base)
            (work / 'unrelated-backend.go').write_text('base only\n')
            advanced = commit('base branch advanced')
            git('checkout', '-q', 'feature')
            event_path = work / 'event.json'
            def run(event, name):
                event_path.write_text(json.dumps(event))
                env = {**os.environ, 'GITHUB_EVENT_NAME': name, 'GITHUB_EVENT_PATH': str(event_path)}
                for key in ('GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'):
                    env.pop(key, None)
                return json.loads(subprocess.check_output([sys.executable, SCRIPT, 'plan'], cwd=work, env=env, text=True))
            pr = run({'pull_request': {'base': {'sha': advanced}, 'head': {'sha': head}}}, 'pull_request')
            self.assertEqual(pr['paths'], ['docs/old file.md', 'docs/renamed file.md', 'src/audio/engine.ts'])
            self.assertTrue(pr['audio'])
            self.assertFalse(pr['backend'], 'PR must use merge-base, not unrelated base changes')
            pushed = run({'before': base, 'after': head}, 'push')
            self.assertEqual(pushed['paths'], pr['paths'])
            # Explicit two-ended push diff includes all commits, not only HEAD^.
            (work / 'src/auth').mkdir(parents=True)
            (work / 'src/auth/session.ts').write_text('auth logic\n')
            second = commit('second push commit')
            pushed = run({'before': base, 'after': second}, 'push')
            self.assertTrue(pushed['auth'] and pushed['audio'])
            for missing in ('0' * 40, 'f' * 40):
                fallback = run({'before': missing, 'after': second}, 'push')
                self.assertTrue(all(fallback[key] for key in ci.JOBS))


class Admission(unittest.TestCase):
    def needs(self):
        selection = ci.plan(['src/styles/tokens.css'])
        selection['commit'] = 'a' * 40
        return {'changes': {'result': 'success', 'outputs': {'plan': json.dumps(selection)}},
                **{job: {'result': 'success' if selection[job] else 'skipped'} for job in ci.JOBS},
                'frontend': {'result': 'success', 'outputs': {'sha256': 'b' * 64}}}

    def test_gate_cli_only_emits_admission_on_success(self):
        with tempfile.TemporaryDirectory(prefix='choral-ci-gate-') as temp:
            receipt = Path(temp, 'admission.json')
            cases = [('success', self.needs(), True)]
            for job in ('changes', 'frontend'):
                for status in ('failure', 'cancelled', 'skipped', None):
                    needs = self.needs()
                    needs[job]['result'] = status
                    cases.append((f'{job} {status}', needs, False))
            needs = self.needs()
            needs['backend']['result'] = 'failure'
            cases.append(('unselected job unexpectedly failed', needs, False))
            needs = self.needs()
            del needs['e2e']
            cases.append(('missing result', needs, False))
            for label, needs, success in cases:
                with self.subTest(label=label):
                    receipt.unlink(missing_ok=True)
                    env = {**os.environ, 'CI_NEEDS': json.dumps(needs), 'GITHUB_EVENT_NAME': 'push',
                           'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'RUNNER_TEMP': temp}
                    result = subprocess.run([sys.executable, SCRIPT, 'gate'], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, success, result.stderr)
                    self.assertEqual(receipt.exists(), success)
            env['CI_NEEDS'] = json.dumps(self.needs())
            env['GITHUB_EVENT_NAME'] = 'pull_request'
            subprocess.run([sys.executable, SCRIPT, 'gate'], env=env, check=True, capture_output=True)
            self.assertFalse(receipt.exists(), 'PR merge-ref artifacts must never be admitted')

    def test_delivery_rejects_failed_stale_or_wrong_origin_run(self):
        run = {'id': 123, 'head_sha': 'a' * 40, 'repository': {'full_name': delivery.REPO},
               'path': '.github/workflows/checks.yml', 'event': 'push', 'head_branch': 'main',
               'status': 'completed', 'conclusion': 'success', 'run_attempt': 2}
        receipt = {'commit': 'a' * 40, 'api': 'choral-api-v1', 'run_id': '123',
                   'run_attempt': '2', 'sha256': 'b' * 64}
        jobs = [{'name': 'Required checks', 'conclusion': 'success'}]
        delivery.validate_admission(run, jobs, receipt, 'a' * 40, 123)
        for key, value in [('conclusion', 'failure'), ('conclusion', 'cancelled'), ('event', 'pull_request'),
                           ('head_branch', 'feature'), ('head_sha', 'c' * 40), ('path', 'other.yml'),
                           ('status', 'in_progress'), ('repository', {'full_name': 'other/repo'})]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                delivery.validate_admission({**run, key: value}, jobs, receipt, 'a' * 40, 123)
        for key, value in [('run_attempt', '1'), ('run_id', '456'), ('commit', 'c' * 40), ('sha256', ''), ('api', 'other')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                delivery.validate_admission(run, jobs, {**receipt, key: value}, 'a' * 40, 123)
        for status in ('failure', 'cancelled', 'skipped'):
            failed = copy.deepcopy(jobs)
            failed[0]['conclusion'] = status
            with self.assertRaises(ValueError):
                delivery.validate_admission(run, failed, receipt, 'a' * 40, 123)


if __name__ == '__main__':
    unittest.main(verbosity=2)
