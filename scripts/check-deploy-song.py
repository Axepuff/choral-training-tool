#!/usr/bin/env python3
"""Read-only check of one technical song; never log private URLs or tokens."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def load(path):
    path = Path(path)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError('Song fixture must be a private regular file (0600)')
    fixture = json.loads(path.read_text())
    patterns = dict(token=r'[A-Za-z0-9_-]{43}', song_id=r'[a-f0-9-]{36}',
                    track_id=r'[a-f0-9-]{36}', media_sha256=r'[a-f0-9]{64}', peaks_sha256=r'[a-f0-9]{64}')
    if any(not re.fullmatch(pattern, fixture.get(key, '')) for key, pattern in patterns.items()):
        raise ValueError('Song fixture fields are missing or invalid')
    return fixture


def check(origin, fixture):
    parsed = urlparse(origin)
    if (parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/') or
            not (parsed.scheme == 'https' or parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1'))):
        raise ValueError('Expected HTTPS or loopback HTTP origin')
    base = '/api/v1/public/shares/' + fixture['token']
    opener = build_opener(NoRedirect)

    def get(path, status=200, headers=None):
        try:
            with opener.open(Request(origin.rstrip('/') + path, headers=headers or {}), timeout=15) as response:
                data = response.read(128 * 1024 * 1024 + 1)
                if response.status != status or len(data) > 128 * 1024 * 1024:
                    raise ValueError()
                return data, response.headers
        except Exception:
            raise ValueError('Technical song HTTP check failed (private URL omitted)') from None

    metadata, _ = get(base)
    try:
        songs = json.loads(metadata)['songs']
        song = next(song for song in songs if song['id'] == fixture['song_id'])
        next(track for track in song['tracks'] if track['id'] == fixture['track_id'])
    except (KeyError, ValueError, StopIteration, TypeError):
        raise ValueError('Technical song or track is missing') from None
    track = base + '/songs/' + fixture['song_id'] + '/tracks/' + fixture['track_id']
    media, _ = get(track + '/media')
    peaks, _ = get(track + '/peaks')
    if (len(media) < 16 or hashlib.sha256(media).hexdigest() != fixture['media_sha256'] or
            hashlib.sha256(peaks).hexdigest() != fixture['peaks_sha256']):
        raise ValueError('Technical song media/peaks checksum mismatch')
    part, headers = get(track + '/media', 206, {'Range': 'bytes=0-15'})
    if part != media[:16] or headers.get('Content-Range') != f'bytes 0-15/{len(media)}':
        raise ValueError('Technical song Range mismatch')
    print('Technical song metadata, media, peaks and Range passed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--origin', required=True)
    args = parser.parse_args()
    try:
        check(args.origin, load(args.fixture))
    except Exception:
        print('Technical song check failed; verify the private fixture and server.', file=sys.stderr)
        sys.exit(1)
