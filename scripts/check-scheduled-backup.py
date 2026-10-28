#!/usr/bin/env python3
"""Test maintenance failure recovery at the shell/Docker boundary, without a daemon."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
DOCKER = '''#!/usr/bin/env python3
import os, sys
from pathlib import Path
root = Path(os.environ['FIXTURE'])
args = sys.argv[1:]
mode = os.environ['CASE']
running = root / 'running'
if args[:2] == ['compose', 'ps']:
    if running.exists(): print('container')
elif args[:2] == ['compose', 'stop']:
    running.unlink()
elif args[:2] == ['compose', 'up']:
    if mode == 'restart-fails': sys.exit(1)
    running.touch()
elif args[0] == 'inspect':
    print(('137' if mode == 'killed' else '0') if 'ExitCode' in args[2] else 'sha256:fixture')
elif args[:2] == ['compose', 'run']:
    assert not running.exists(), 'archive requested while app writes'
    print('synthetic archive')
    if mode == 'archive-fails': sys.exit(1)
else:
    raise SystemExit('unexpected Docker operation')
'''

for case in ('success', 'archive-fails', 'killed', 'stopped', 'restart-fails'):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        binary = root / 'docker'
        binary.write_text(DOCKER)
        binary.chmod(0o700)
        backups = root / 'backups'
        backups.mkdir()
        if case != 'stopped':
            (root / 'running').touch()
        env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}', FIXTURE=directory, CASE=case)
        result = subprocess.run(['sh', 'scripts/scheduled-backup.sh', str(backups)],
                                cwd=ROOT, env=env, capture_output=True)
        assert (result.returncode == 0) == (case == 'success'), case
        assert (root / 'running').exists() == (case not in ('stopped', 'restart-fails')), case
        archives = list(backups.glob('*/data.tar'))
        assert bool(archives) == (case in ('success', 'restart-fails')), case
        if case == 'archive-fails':
            assert list(backups.glob('*/data.tar.partial'))
            assert not list(backups.glob('*/SHA256SUMS'))
        if case == 'success':
            subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=archives[0].parent,
                           check=True, capture_output=True)
            assert (archives[0].parent / 'IMAGE_ID').read_text().strip() == 'sha256:fixture'
        print(f'PASS: {case}')
