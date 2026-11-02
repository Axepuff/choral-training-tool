#!/usr/bin/env python3
"""Linux frontend artifacts and atomic releases. No Docker, database or private data access."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import time

FORMAT = 1
API = 'choral-api-v1'
COMMIT = re.compile(r'[0-9a-f]{40}')
ASSET = re.compile(r'assets/[A-Za-z0-9_][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+')
RETENTION = 7 * 86400
MAX_BYTES = 128 * 1024 * 1024
PUBLIC_FILES = {'index.html', 'fonts/jost/SOURCE.txt', 'fonts/jost/OFL.txt'}


def public_file(name):
    return name in PUBLIC_FILES or ASSET.fullmatch(name)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(data):
    return (json.dumps(data, sort_keys=True, indent=2) + '\n').encode()


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ('src', 'href') and value:
                self.paths.append(value)


def validate(manifest, files):
    if manifest.get('format') != FORMAT or not COMMIT.fullmatch(manifest.get('commit', '')):
        raise ValueError('Invalid artifact format/commit')
    if manifest.get('demo') is not False or manifest.get('base') != '/':
        raise ValueError('Only production artifacts with base=/ are accepted')
    if not re.fullmatch(r'[a-z0-9-]{1,80}', manifest.get('api', '')):
        raise ValueError('Missing API compatibility contract')
    if set(files) != set(manifest['files']) or 'index.html' not in files:
        raise ValueError('Incomplete artifact inventory')
    if not any(n.endswith('.js') for n in files):
        raise ValueError('Missing application JavaScript')
    for name, data in files.items():
        if not public_file(name):
            raise ValueError('Unexpected artifact path')
        if not data or manifest['files'][name] != digest(data):
            raise ValueError('Empty or corrupt artifact file')
    parser = References()
    parser.feed(files['index.html'].decode('utf-8'))
    if not parser.paths or any(not p.startswith('/assets/') or p[1:] not in files for p in parser.paths):
        raise ValueError('Index references missing assets or uses a non-root base')


def load_artifact(archive, checksum):
    # Read once to avoid checking one upload and extracting a different one.
    with archive.open('rb') as source:
        data = source.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or digest(data) != checksum:
        raise ValueError('Artifact checksum/size mismatch')
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as tar:
        for member in tar:
            if (not member.isfile() or member.name in files or
                    (member.name != 'release.json' and not public_file(member.name))):
                raise ValueError('Unsafe or duplicate archive member')
            total += member.size
            if total > MAX_BYTES or len(files) >= 10000:
                raise ValueError('Artifact exceeds limits')
            files[member.name] = tar.extractfile(member).read()
    manifest = json.loads(files.pop('release.json'))
    validate(manifest, files)
    return manifest, files


def write_artifact(output, manifest, files):
    with tarfile.open(output, 'w', format=tarfile.USTAR_FORMAT) as tar:
        for name, data in sorted({**files, 'release.json': encode(manifest)}.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o644
            tar.addfile(info, io.BytesIO(data))
    return digest(output.read_bytes())


def build(output):
    repo = Path(__file__).resolve().parent.parent
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()
    if git('status', '--porcelain'):
        raise ValueError('Build requires a clean checkout of the approved commit')
    commit = git('rev-parse', 'HEAD')
    env = dict(os.environ, VITE_APP_DEMO='false', CHORAL_BUILD_BASE='/')
    subprocess.run(['npm', 'run', 'build', '--', '--manifest'], cwd=repo, env=env, check=True)
    dist = repo / 'dist'
    files = {}
    for p in sorted(dist.rglob('*')):
        if p.is_symlink():
            raise ValueError('Symlink in dist')
        if p.is_file() and '.vite' not in p.relative_to(dist).parts:
            files[p.relative_to(dist).as_posix()] = p.read_bytes()
    # Vite inventories transitive JS/CSS/assets, including dynamic imports.
    vite = json.loads((dist / '.vite/manifest.json').read_text())
    for entry in vite.values():
        for name in [entry['file'], *entry.get('css', []), *entry.get('assets', [])]:
            if name not in files:
                raise ValueError('Incomplete Vite build')
        for key in [*entry.get('imports', []), *entry.get('dynamicImports', [])]:
            if key not in vite:
                raise ValueError('Missing Vite chunk')
    manifest = {'format': FORMAT, 'commit': commit, 'api': API, 'demo': False,
                'base': '/', 'files': {n: digest(d) for n, d in files.items()}}
    validate(manifest, files)
    if git('rev-parse', 'HEAD') != commit or git('status', '--porcelain'):
        raise ValueError('Checkout changed during build')
    output.parent.mkdir(parents=True, exist_ok=True)
    # An interrupted build never replaces a previously completed artifact.
    with tempfile.TemporaryDirectory(dir=output.parent) as temp:
        target = Path(temp) / 'frontend.tar'
        checksum = write_artifact(target, manifest, files)
        os.replace(target, output)
    output.with_name(output.name + '.sha256').write_text(checksum + '  ' + output.name + '\n')
    print(json.dumps({'commit': commit, 'sha256': checksum, 'api': API}))


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_file(path, data):
    fd, name = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fchmod(out.fileno(), 0o644)
            os.fsync(out.fileno())
        os.replace(name, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def locked(root):
    if not root.is_absolute() or root.is_symlink():
        raise ValueError('Release root must be an absolute, real directory')
    try:
        root.mkdir(mode=0o755, parents=True)
        root.chmod(0o755)  # Public tree must remain readable under umask 077.
    except FileExistsError:
        pass
    allowed = {'assets', 'releases', 'current', '.lock', '.next'}
    if any(p.name not in allowed and not p.name.startswith(('.stage-', '.write-')) for p in root.iterdir()):
        raise ValueError('Release root must be dedicated to frontend releases')
    # This is a dedicated operator-owned tree, never /data or a shared writable directory.
    with (root / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another frontend operation holds the lock') from None
        for name in ('assets', 'releases'):
            p = root / name
            if p.is_symlink():
                raise ValueError('Unsafe release directory')
            try:
                p.mkdir(mode=0o755)
                p.chmod(0o755)
            except FileExistsError:
                pass
        yield


def current(root):
    p = root / 'current'
    if not p.is_symlink():
        if p.exists():
            raise ValueError('current must be a release symlink')
        return None
    target = os.readlink(p)
    name = PurePosixPath(target).name
    if target != 'releases/' + name or not COMMIT.fullmatch(name):
        raise ValueError('Invalid current release')
    return name


def release_files(root, commit):
    if not COMMIT.fullmatch(commit):
        raise ValueError('Invalid release ID')
    release = root / 'releases' / commit
    if release.is_symlink():
        raise ValueError('Unsafe release')
    manifest = json.loads((release / '.release.json').read_text())
    files = {n: (release / n).read_bytes() for n in manifest['files']}
    validate(manifest, files)
    if manifest['commit'] != commit:
        raise ValueError('Release ID mismatch')
    return manifest


def activate(root, commit):
    old = current(root)
    if old == commit:
        return
    # Timestamp before switching: a crash can extend retention, never shorten it.
    if old:
        atomic_file(root / 'releases' / old / '.retained-at', str(time.time()).encode())
    atomic_file(root / 'releases' / commit / '.retained-at', str(time.time()).encode())
    link = root / '.next'
    link.unlink(missing_ok=True)
    os.symlink('releases/' + commit, link)
    os.replace(link, root / 'current')
    sync_dir(root)


def publish(root, archive, checksum, approved_commit, backend_api):
    with locked(root):
        manifest, files = load_artifact(archive, checksum)
        if manifest['commit'] != approved_commit or manifest['api'] != backend_api:
            raise ValueError('Artifact is not approved for this commit/backend API')
        commit = manifest['commit']
        # Validate *all* collisions before writing; immutable URLs never change bytes.
        for name, data in files.items():
            if name.startswith('assets/'):
                p = root / name
                if p.exists() and (p.is_symlink() or p.read_bytes() != data):
                    raise ValueError('Immutable asset collision')
        release = root / 'releases' / commit
        if release.exists():
            if release_files(root, commit) != manifest:
                raise ValueError('Commit already published with different contents')
        else:
            with tempfile.TemporaryDirectory(prefix='.stage-', dir=root) as temp:
                stage = Path(temp)
                for name, data in files.items():
                    if name.startswith('assets/'):
                        p = root / name
                        if not p.exists():
                            atomic_file(p, data)
                for name, data in files.items():
                    if not name.startswith('assets/'):
                        parent = stage
                        for part in Path(name).parts[:-1]:
                            parent = parent / part
                            parent.mkdir(mode=0o755, exist_ok=True)
                            parent.chmod(0o755)
                        atomic_file(stage / name, data)
                atomic_file(stage / '.release.json', encode(manifest))
                atomic_file(stage / '.artifact-sha256', checksum.encode())
                os.symlink('../../assets', stage / 'assets')
                os.chmod(stage, 0o755)
                sync_dir(stage)
                os.rename(stage, release)
                sync_dir(root / 'releases')
        release_files(root, commit)
        activate(root, commit)
        print(commit)


def rollback(root, commit, backend_api):
    with locked(root):
        if release_files(root, commit)['api'] != backend_api:
            raise ValueError('Release is incompatible with installed backend API')
        activate(root, commit)
        print(commit)


def prune(root, apply):
    with locked(root):
        active = current(root)
        cutoff = time.time() - RETENTION
        remove, keep = [], []
        for p in (root / 'releases').iterdir():
            if not COMMIT.fullmatch(p.name) or p.is_symlink():
                raise ValueError('Unexpected release directory; inspect manually')
            release_files(root, p.name)
            stamp = float((p / '.retained-at').read_text()) if (p / '.retained-at').exists() else time.time()
            (remove if p.name != active and stamp < cutoff else keep).append(p)
        used = set()
        for p in keep:
            used.update(json.loads((p / '.release.json').read_text())['files'])
        unused = [p for p in (root / 'assets').iterdir()
                  if 'assets/' + p.name not in used and p.stat().st_mtime < cutoff]
        print(json.dumps({'releases': [p.name for p in remove], 'assets': len(unused), 'apply': apply}))
        if apply:
            for p in remove:
                shutil.rmtree(p)
            for p in unused:
                p.unlink()
            sync_dir(root / 'releases')
            sync_dir(root / 'assets')


def snapshot(root, output):
    # Called by backup, never by publish/rollback. Its lock pins the exact release.
    with locked(root):
        commit = current(root)
        if commit is None or output.exists():
            raise ValueError('Missing current release or snapshot already exists')
        manifest = release_files(root, commit)
        release = root / 'releases' / commit
        files = {n: (release / n).read_bytes() for n in manifest['files']}
        checksum = write_artifact(output, manifest, files)
        atomic_file(output.with_name('FRONTEND.json'), encode({
            'commit': commit, 'api': manifest['api'], 'sha256': checksum}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    b = commands.add_parser('build')
    b.add_argument('--output', type=Path, required=True)
    p = commands.add_parser('publish')
    p.add_argument('archive', type=Path)
    p.add_argument('--sha256', required=True)
    p.add_argument('--approved-commit', required=True)
    for name in ('rollback', 'prune', 'snapshot'):
        commands.add_parser(name)
    for name in ('publish', 'rollback', 'prune', 'snapshot'):
        commands.choices[name].add_argument('--root', type=Path, required=True)
    for name in ('publish', 'rollback'):
        commands.choices[name].add_argument('--backend-api', required=True)
    commands.choices['rollback'].add_argument('--to', required=True)
    commands.choices['prune'].add_argument('--apply', action='store_true')
    commands.choices['snapshot'].add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'build':
        build(args.output.resolve())
    elif args.command == 'publish':
        publish(args.root, args.archive, args.sha256, args.approved_commit, args.backend_api)
    elif args.command == 'rollback':
        rollback(args.root, args.to, args.backend_api)
    elif args.command == 'prune':
        prune(args.root, args.apply)
    else:
        snapshot(args.root, args.output)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        raise SystemExit('Frontend release failed: ' + str(error)) from None
