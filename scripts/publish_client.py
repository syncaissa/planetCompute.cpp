#!/usr/bin/env python3
"""Publish planetCompute client builds from a GitHub Actions run (.github/workflows/client.yml) to B2, one at a time.

  publish_client.py <run id> <version> [build key ...]
  publish_client.py --file <path> <version> <build key>      (a RunPod build, e.g. linux-x86_64-cuda)

Adapted from sushila.cpp's publish_engine.py. Runs on Cloud9 only: the B2 keys and the GitHub token are read from the
project's .env (B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, GITHUB_TOKEN; path in $PC_ENV, default ../../.env) and
are never printed. Each build goes to b2://<bucket>/client/<version>/ and is merged into client/LATEST.json, keeping
the builds already listed for the same version. One build at a time, so Cloud9's small disk is enough.
"""
import calendar
import base64
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = 'syncaissa/planetCompute.cpp'
HERE = os.path.dirname(os.path.abspath(__file__))


def env():
    p = os.environ.get('PC_ENV', os.path.join(HERE, '..', '..', '.env'))
    out = {}
    for line in open(p):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


E = env()


class B2:
    def __init__(self):
        auth = base64.b64encode(f"{E['B2_KEY_ID']}:{E['B2_APPLICATION_KEY']}".encode()).decode()
        r = json.loads(urllib.request.urlopen(urllib.request.Request(
            'https://api.backblazeb2.com/b2api/v3/b2_authorize_account', headers={'Authorization': f'Basic {auth}'}), timeout=60).read())
        self.tok, self.bucket = r['authorizationToken'], E['B2_BUCKET_NAME']
        api = r['apiInfo']['storageApi']
        self.api, self.dl = api['apiUrl'], api['downloadUrl']
        self.bucket_id = api.get('bucketId') or self._call('b2_list_buckets', {'accountId': r['accountId'], 'bucketName': self.bucket})['buckets'][0]['bucketId']

    def _call(self, name, body):
        req = urllib.request.Request(f'{self.api}/b2api/v3/{name}', data=json.dumps(body).encode(), headers={'Authorization': self.tok})
        return json.loads(urllib.request.urlopen(req, timeout=60).read())

    def put(self, key, data):
        up = self._call('b2_get_upload_url', {'bucketId': self.bucket_id})
        req = urllib.request.Request(up['uploadUrl'], data=data, headers={
            'Authorization': up['authorizationToken'], 'X-Bz-File-Name': urllib.parse.quote(key),
            'Content-Type': 'b2/x-auto', 'X-Bz-Content-Sha1': hashlib.sha1(data).hexdigest()})
        return json.loads(urllib.request.urlopen(req, timeout=1800).read())

    def get(self, key):
        req = urllib.request.Request(f'{self.dl}/file/{self.bucket}/{urllib.parse.quote(key)}', headers={'Authorization': self.tok})
        return urllib.request.urlopen(req, timeout=60).read()


def gh(url):
    r = urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': f"token {E['GITHUB_TOKEN']}", 'User-Agent': 'planetCompute'}), timeout=600)
    return json.loads(r.read())


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def artifact_zip(url):
    """GitHub answers with a redirect to short-lived storage that must be fetched WITHOUT the GitHub token."""
    try:
        urllib.request.build_opener(_NoRedirect).open(urllib.request.Request(url, headers={'Authorization': f"token {E['GITHUB_TOKEN']}", 'User-Agent': 'planetCompute'}), timeout=60)
        raise RuntimeError('expected a redirect')
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            raise
        loc = e.headers['Location']
    return urllib.request.urlopen(urllib.request.Request(loc, headers={'User-Agent': 'planetCompute'}), timeout=600).read()


def sign(sha256):
    """Ed25519 signature of 'planetCompute release|<sha256>' with the release key kept only on this machine
    (.ops/release_ed25519.key, never in git, Cloudflare, CI or the backups): the servers' agents (whagent.py) refuse a
    build without it, so someone who could write the downloads (B2) or the site still cannot push their own program."""
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    key = load_pem_private_key(open(os.path.join(os.path.dirname(__file__), '..', '.ops', 'release_ed25519.key'), 'rb').read(), None)
    return base64.b64encode(key.sign(f'planetCompute release|{sha256}'.encode())).decode()


def sign2(sha256, build_time, key_name):
    """Second signature (security review P3): also covers the build time and the platform, so the agents can refuse an
    older signed build or one for another platform (a rollback by someone who controls the downloads)."""
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    key = load_pem_private_key(open(os.path.join(os.path.dirname(__file__), '..', '.ops', 'release_ed25519.key'), 'rb').read(), None)
    return base64.b64encode(key.sign(f'planetCompute release v2|{sha256}|{int(build_time)}|{key_name}'.encode())).decode()


def commit_build(sha):
    """(short commit, unix commit time): what the program built from that commit reports (client/build.rs uses
    git log %ct = the committer date), so the window can tell a newer build (plan_old_programs #1/#3)."""
    if not sha:
        return '', 0
    c = gh(f'https://api.github.com/repos/{REPO}/commits/{sha}')['commit']['committer']['date']
    return sha[:7], calendar.timegm(time.strptime(c, '%Y-%m-%dT%H:%M:%SZ'))


def add(b2, latest, v, key, path, build=('', 0)):
    name = os.path.basename(path)
    data = open(path, 'rb').read()
    b2.put(f'client/{v}/{name}', data)
    sha = hashlib.sha256(data).hexdigest()
    latest['builds'][key] = {'file': name, 'sha256': sha, 'bytes': len(data), 'sig': sign(sha),
                             **({'commit': build[0], 'build_time': build[1], 'sig2': sign2(sha, build[1], key)} if build[1] else {})}
    print(f'{key}: {name} ({len(data) / 1e6:.0f} MB)', flush=True)


def main():
    a = sys.argv[1:]
    if len(a) < 2:
        sys.exit(__doc__)
    b2 = B2()
    v = a[2] if a[0] == '--file' else a[1]
    try:
        latest = json.loads(b2.get('client/LATEST.json'))
    except Exception:
        latest = {}
    if latest.get('version') != v:
        latest = {'version': v, 'builds': {}}
    if a[0] == '--file':
        add(b2, latest, v, a[3], a[1])
    else:
        run, only = a[0], set(a[2:])
        meta = gh(f'https://api.github.com/repos/{REPO}/actions/runs/{run}')
        build = commit_build(meta.get('head_sha', ''))
        for art in gh(f'https://api.github.com/repos/{REPO}/actions/runs/{run}/artifacts?per_page=100')['artifacts']:
            key = art['name']
            if only and key not in only:
                continue
            outer = zipfile.ZipFile(io.BytesIO(artifact_zip(art['archive_download_url'])))  # GitHub wraps each artifact in a zip
            name = next(n for n in outer.namelist() if n.startswith(f'planetCompute-{v}-{key}'))
            with tempfile.TemporaryDirectory() as d:
                add(b2, latest, v, key, outer.extract(name, d), build)
        latest.update({'commit': meta.get('head_sha', ''), 'run': int(run)})
    latest['built_utc'] = time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime())
    b2.put('client/LATEST.json', json.dumps(latest, indent=1).encode())
    print('builds now listed:', ', '.join(sorted(latest['builds'])))


if __name__ == '__main__':
    main()
