#!/usr/bin/env python3
"""On a RunPod pod: stream each model in job.json from its source into B2 in parts, without saving it to disk.

  python3 pod_copy_models.py job.json results.json

job.json comes from models_to_b2.py prepare (Cloud9). Each part is fetched with an HTTP Range request and uploaded
with the part-upload links in the job (no B2 keys on the pod). The whole file's sha256 is computed in order, so
Cloud9 can check it before finishing the upload. results.json is rewritten after every model.
Gated Hugging Face repos: set HF_TOKEN in the environment. The token goes only to huggingface.co, which answers with a
redirect to a signed download link; the parts are then fetched from that link without the token.
Standard library only.
"""
import concurrent.futures as cf
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = {'User-Agent': 'planetCompute-model-copy'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def signed(url):
    """With HF_TOKEN: ask huggingface.co (with the token) where the file is, so the token never leaves huggingface.co."""
    if not os.environ.get('HF_TOKEN') or not url.startswith('https://huggingface.co/'):
        return url
    req = urllib.request.Request(url, headers={**UA, 'Authorization': 'Bearer ' + os.environ['HF_TOKEN'], 'Range': 'bytes=0-0'})
    try:
        urllib.request.build_opener(NoRedirect).open(req, timeout=60).read()
        raise IOError(f'no redirect for {url}')
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308) and e.headers.get('Location'):
            return urllib.parse.urljoin(url, e.headers['Location'])
        raise


def fetch(url, start, end):
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={**UA, 'Range': f'bytes={start}-{end}'})
            data = urllib.request.urlopen(req, timeout=300).read()
            if len(data) == end - start + 1:
                return data
            raise IOError(f'short read {len(data)}')
        except Exception as e:
            if attempt == 5:
                raise
            time.sleep(5 * (attempt + 1))


def upload(link, n, data):
    sha1 = hashlib.sha1(data).hexdigest()
    for attempt in range(6):
        try:
            req = urllib.request.Request(link['url'], data=data, headers={
                'Authorization': link['token'], 'X-Bz-Part-Number': str(n), 'Content-Length': str(len(data)), 'X-Bz-Content-Sha1': sha1})
            urllib.request.urlopen(req, timeout=600).read()
            return sha1
        except Exception:
            if attempt == 5:
                raise
            time.sleep(5 * (attempt + 1))


def copy(j):
    links, size, part = j['upload'], j['bytes'], j['part']
    whole, sha1s, t0 = hashlib.sha256(), [], time.time()
    batch = len(links)
    with cf.ThreadPoolExecutor(batch) as ex:
        for first in range(0, j['parts'], batch):
            nums = range(first, min(first + batch, j['parts']))

            def one(i, k):
                start = i * part
                data = fetch(j['url'], start, min(start + part, size) - 1)
                return data, upload(links[k], i + 1, data)  # each link serves one upload at a time

            done = list(ex.map(lambda ik: one(*ik), [(i, k) for k, i in enumerate(nums)]))
            for data, sha1 in done:  # in part order
                whole.update(data)
                sha1s.append(sha1)
            gb = min((first + batch) * part, size) / 1e9
            print(f"  {j['id']}: {gb:.1f}/{size / 1e9:.1f} GB, {gb * 1e3 / (time.time() - t0):.0f} MB/s", flush=True)
    return {'sha256': whole.hexdigest(), 'bytes': size, 'sha1': sha1s, 'seconds': round(time.time() - t0)}


def main():
    job, out = json.load(open(sys.argv[1])), sys.argv[2]
    try:
        res = json.load(open(out))
    except Exception:
        res = {}
    for j in job['models']:
        if j['fileId'] in res and not res[j['fileId']].get('error'):
            continue
        print(f"{j['id']}: {j['bytes'] / 1e9:.1f} GB from {j['url'].split('/')[2]}", flush=True)
        try:
            res[j['fileId']] = copy({**j, 'url': signed(j['url'])})
            ok = res[j['fileId']]['sha256'] == j['sha256']
            print(f"{j['id']}: done in {res[j['fileId']]['seconds']} s, sha256 {'matches' if ok else 'DOES NOT MATCH'}", flush=True)
        except Exception as e:
            res[j['fileId']] = {'error': str(e)[:300]}
            print(f"{j['id']}: FAILED {e}", flush=True)
        json.dump(res, open(out, 'w'))
    print('ALL_DONE', flush=True)


if __name__ == '__main__':
    main()
