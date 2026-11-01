#!/usr/bin/env python3
"""Copy the models in models/catalog.json from their original sources into B2 (planetcompute-ai, Models/<id>/<file>).

Runs on Cloud9, which holds the B2 keys. The bytes never pass through Cloud9: a RunPod pod streams each file from
its source and uploads it in parts, using upload links that are good only for those parts (24 hours).

  models_to_b2.py prepare job.json [<id> ...]   start a B2 large file per model still missing; write the pod's job
  (on the pod) python3 pod_copy_models.py job.json results.json
  models_to_b2.py finish job.json results.json  finish each upload whose sha256 matches the catalog (cancel others);
                                                then write Models/catalog.json and Models/CHECKSUMS.json to B2
  models_to_b2.py check                         list each model in B2 with its size and recorded sha256
  models_to_b2.py prepare-table job.json        the same for EVERY file in the DynamoDB model table (models_table.py),
                                                Models/<model_id>/<file>; files under 256 MB are copied from Cloud9
  models_to_b2.py check-table [--write]         each table file in B2? (--write: store Models/TABLE_INDEX.json)
  models_to_b2.py prepare-repo job.json <org/repo>  EVERY file of a Hugging Face repo (all weights, for fine-tuning) to
                                                Weights/<org/repo>/<path>; same pod + finish steps
  models_to_b2.py check-repo <org/repo> [--write]   each repo file in B2? (--write: Weights/WEIGHTS_INDEX.json)

job.json holds the part-upload tokens: copy it only to the pod, and delete it after `finish`.
"""
import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_client import B2  # noqa: E402
import pod_copy_models  # noqa: E402  (signed(): HF_TOKEN for gated repos)

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.join(HERE, '..', 'models', 'catalog.json')
PART = 128 * 1024 * 1024
WORKERS = 8
SMALL = 256 * 1024 * 1024  # table files below this are copied from Cloud9 (B2 large files need 2+ parts)


def catalog():
    return json.load(open(CATALOG))


def key(m):
    return f"Models/{m['id']}/{m['file']}"


def source_url(m):
    s = m['source']
    if s['type'] == 'ollama':
        name, tag = s['model'].split(':')
        return f"https://registry.ollama.ai/v2/library/{name}/blobs/sha256:{m['sha256']}"
    return f"https://huggingface.co/{s['repo']}/resolve/{s['revision']}/{s['file']}"


def in_b2(b2, prefix='Models/'):
    """{key: fileInfo} for every finished file under prefix."""
    out, start = {}, None
    while True:
        body = {'bucketId': b2.bucket_id, 'prefix': prefix, 'maxFileCount': 1000}
        if start:
            body['startFileName'] = start
        r = b2._call('b2_list_file_names', body)
        for f in r['files']:
            out[f['fileName']] = f
        start = r.get('nextFileName')
        if not start:
            return out


def prepare(job_path, only):
    b2, have, job = B2(), None, []
    have = in_b2(b2)
    for m in catalog()['models']:
        if only and m['id'] not in only:
            continue
        f = have.get(key(m))
        if f and f['contentLength'] == m['bytes'] and (f.get('fileInfo') or {}).get('large_file_sha256') == m['sha256']:
            print(f"{m['id']}: already in B2")
            continue
        lf = b2._call('b2_start_large_file', {'bucketId': b2.bucket_id, 'fileName': key(m), 'contentType': 'application/octet-stream',
                                              'fileInfo': {'large_file_sha256': m['sha256']}})
        urls = [b2._call('b2_get_upload_part_url', {'fileId': lf['fileId']}) for _ in range(WORKERS)]
        job.append({'id': m['id'], 'url': source_url(m), 'bytes': m['bytes'], 'sha256': m['sha256'], 'fileId': lf['fileId'],
                    'part': PART, 'parts': math.ceil(m['bytes'] / PART),
                    'upload': [{'url': u['uploadUrl'], 'token': u['authorizationToken']} for u in urls]})
        print(f"{m['id']}: {m['bytes'] / 1e9:.1f} GB in {job[-1]['parts']} parts")
    fd = os.open(job_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump({'made_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'models': job}, fh)
    print(f"{len(job)} models to copy, {sum(j['bytes'] for j in job) / 1e9:.1f} GB; job written to {job_path}")


def write_index(b2):
    have = in_b2(b2)
    sums = {}
    for m in catalog()['models']:
        f = have.get(key(m))
        if f and f['contentLength'] == m['bytes'] and (f.get('fileInfo') or {}).get('large_file_sha256') == m['sha256']:
            sums[key(m)] = {'sha256': m['sha256'], 'bytes': m['bytes']}
    b2.put('Models/CHECKSUMS.json', json.dumps({'updated_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'files': sums}, indent=1).encode())
    b2.put('Models/catalog.json', open(CATALOG, 'rb').read())
    print(f"Models/CHECKSUMS.json lists {len(sums)} of {len(catalog()['models'])} models")


def finish(job_path, results_path):
    b2 = B2()
    res = json.load(open(results_path))
    for j in json.load(open(job_path))['models']:
        r = res.get(j['fileId'])
        if not r or r.get('error'):
            print(f"{j['id']}: not copied ({(r or {}).get('error', 'no result')}); left unfinished, run prepare again later")
            continue
        if r['sha256'] != j['sha256'] or r['bytes'] != j['bytes'] or len(r['sha1']) != j['parts']:
            b2._call('b2_cancel_large_file', {'fileId': j['fileId']})
            print(f"{j['id']}: WRONG CONTENT (sha256 {r['sha256'][:12]}..., {r['bytes']} bytes); upload cancelled")
            continue
        b2._call('b2_finish_large_file', {'fileId': j['fileId'], 'partSha1Array': r['sha1']})
        print(f"{j['id']}: finished, sha256 checked")
    write_index(b2)


def table_files():
    """Every file of every row in the DynamoDB model table (models_table.py), at its pinned revision."""
    import models_table
    out = []
    for r in sorted(models_table.table().scan()['Items'], key=lambda r: r['model_id']):
        for f in json.loads(r['files_json']):
            # full path in the id: one repo can hold same-named files in subfolders
            out.append({'id': f"{r['model_id']}/{f['path']}", 'model_id': r['model_id'], 'path': f['path'],
                        'repo': f['repo'], 'revision': f['revision'], 'bytes': int(f['bytes']), 'sha256': f['sha256'],
                        'url': f"https://huggingface.co/{f['repo']}/resolve/{f['revision']}/{f['path']}"})
    return out


def by_sha256(have):
    return {(f.get('fileInfo') or {}).get('large_file_sha256') or (f.get('fileInfo') or {}).get('sha256'): k for k, f in have.items()}


def prepare_table(job_path):
    """Like prepare, for the whole model table. A file already in B2 (same sha256, any key) is not copied again.
    Files under SMALL are fetched and uploaded here; bigger ones go into the pod's job."""
    b2 = B2()
    have = by_sha256(in_b2(b2))
    job, seen = [], set()
    for f in table_files():
        k = f"Models/{f['id']}"
        if f['sha256'] in have or f['sha256'] in seen:
            continue
        seen.add(f['sha256'])
        if f['bytes'] < SMALL:
            try:
                data = urllib.request.urlopen(urllib.request.Request(pod_copy_models.signed(f['url']), headers={'User-Agent': 'planetCompute-model-copy'}), timeout=600).read()
            except Exception as e:
                print(f"{f['id']}: NOT COPIED ({e})")
                continue
            if hashlib.sha256(data).hexdigest() != f['sha256'] or len(data) != f['bytes']:
                print(f"{f['id']}: WRONG CONTENT, not uploaded")
                continue
            up = b2._call('b2_get_upload_url', {'bucketId': b2.bucket_id})
            urllib.request.urlopen(urllib.request.Request(up['uploadUrl'], data=data, headers={
                'Authorization': up['authorizationToken'], 'X-Bz-File-Name': urllib.parse.quote(k), 'Content-Type': 'application/octet-stream',
                'X-Bz-Content-Sha1': hashlib.sha1(data).hexdigest(), 'X-Bz-Info-sha256': f['sha256']}), timeout=600).read()
            print(f"{f['id']}: {len(data) / 1e6:.1f} MB uploaded from here, sha256 checked")
            continue
        try:  # gated repos answer 401 without a token: skip them rather than leave an unfinished large file
            urllib.request.urlopen(urllib.request.Request(pod_copy_models.signed(f['url']), headers={'User-Agent': 'planetCompute-model-copy', 'Range': 'bytes=0-15'}), timeout=60).read()
        except Exception as e:
            print(f"{f['id']}: NOT COPIED ({e})")
            continue
        lf = b2._call('b2_start_large_file', {'bucketId': b2.bucket_id, 'fileName': k, 'contentType': 'application/octet-stream',
                                              'fileInfo': {'large_file_sha256': f['sha256']}})
        urls = [b2._call('b2_get_upload_part_url', {'fileId': lf['fileId']}) for _ in range(WORKERS)]
        job.append({'id': f['id'], 'url': f['url'], 'bytes': f['bytes'], 'sha256': f['sha256'], 'fileId': lf['fileId'],
                    'part': PART, 'parts': math.ceil(f['bytes'] / PART),
                    'upload': [{'url': u['uploadUrl'], 'token': u['authorizationToken']} for u in urls]})
    fd = os.open(job_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump({'made_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'models': job}, fh)
    print(f"{len(job)} files for the pod, {sum(j['bytes'] for j in job) / 1e9:.1f} GB; job written to {job_path}")


def repo_files(repo):
    """Every file of a Hugging Face repo at its current revision (pinned in the result); LFS files carry their sha256."""
    tok = os.environ.get('HF_TOKEN')
    get = lambda u: json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'planetCompute-model-copy', **({'Authorization': 'Bearer ' + tok} if tok else {})}), timeout=60))
    rev = get(f"https://huggingface.co/api/models/{repo}")['sha']
    out = []
    for f in get(f"https://huggingface.co/api/models/{repo}/tree/{rev}?recursive=1"):
        if f['type'] != 'file':
            continue
        lfs = f.get('lfs') or {}
        out.append({'id': f"{repo}/{f['path']}", 'path': f['path'], 'repo': repo, 'revision': rev,
                    'bytes': int(lfs.get('size', f.get('size', 0))), 'sha256': lfs.get('oid'),
                    'url': f"https://huggingface.co/{repo}/resolve/{rev}/{urllib.parse.quote(f['path'])}"})
    return out


def prepare_repo(job_path, repo):
    """The WHOLE repo (all weights, for fine-tuning) to Weights/<repo>/<path>. A file already anywhere under Models/ or
    Weights/ with the same sha256 is not copied again (WEIGHTS_INDEX.json points to it). Small files from here."""
    b2 = B2()
    have = by_sha256({**in_b2(b2), **in_b2(b2, 'Weights/')})
    job = []
    for f in repo_files(repo):
        k = f"Weights/{f['id']}"
        if f['sha256'] and f['sha256'] in have:
            print(f"{f['path']}: already in B2 as {have[f['sha256']]}")
            continue
        if f['bytes'] < SMALL:
            if f['sha256']:  # LFS: huggingface.co redirects to a signed link
                req = urllib.request.Request(pod_copy_models.signed(f['url']), headers={'User-Agent': 'planetCompute-model-copy'})
            else:  # plain git file: served by huggingface.co itself
                req = urllib.request.Request(f['url'], headers={'User-Agent': 'planetCompute-model-copy', **({'Authorization': 'Bearer ' + os.environ['HF_TOKEN']} if os.environ.get('HF_TOKEN') else {})})
            data = urllib.request.urlopen(req, timeout=600).read()
            sha = hashlib.sha256(data).hexdigest()
            if len(data) != f['bytes'] or (f['sha256'] and sha != f['sha256']):
                print(f"{f['path']}: WRONG CONTENT, not uploaded")
                continue
            for attempt in range(5):  # B2 answers 500/503 now and then: take a new upload link and try again
                up = b2._call('b2_get_upload_url', {'bucketId': b2.bucket_id})
                try:
                    urllib.request.urlopen(urllib.request.Request(up['uploadUrl'], data=data, headers={
                        'Authorization': up['authorizationToken'], 'X-Bz-File-Name': urllib.parse.quote(k), 'Content-Type': 'application/octet-stream',
                        'X-Bz-Content-Sha1': hashlib.sha1(data).hexdigest(), 'X-Bz-Info-sha256': sha, 'X-Bz-Info-revision': f['revision']}), timeout=600).read()
                    break
                except urllib.error.HTTPError as e:
                    print(f"{f['path']}: B2 {e.code} {e.read()[:200]!r}; retrying")
                    if attempt == 4:
                        raise
                    time.sleep(5)
            print(f"{f['path']}: {len(data) / 1e6:.2f} MB uploaded from here")
            continue
        lf = b2._call('b2_start_large_file', {'bucketId': b2.bucket_id, 'fileName': k, 'contentType': 'application/octet-stream',
                                              'fileInfo': {'large_file_sha256': f['sha256'], 'revision': f['revision']}})
        urls = [b2._call('b2_get_upload_part_url', {'fileId': lf['fileId']}) for _ in range(WORKERS)]
        job.append({'id': f['id'], 'url': f['url'], 'bytes': f['bytes'], 'sha256': f['sha256'], 'fileId': lf['fileId'],
                    'part': PART, 'parts': math.ceil(f['bytes'] / PART),
                    'upload': [{'url': u['uploadUrl'], 'token': u['authorizationToken']} for u in urls]})
    fd = os.open(job_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump({'made_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'repo': repo, 'models': job}, fh)
    print(f"{len(job)} files for the pod, {sum(j['bytes'] for j in job) / 1e9:.1f} GB; job written to {job_path}")


def check_repo(repo, write=False):
    """Each file of the repo in B2 (by sha256 + size)? With write, add it to Weights/WEIGHTS_INDEX.json."""
    b2 = B2()
    files = {**in_b2(b2), **in_b2(b2, 'Weights/')}
    have = by_sha256(files)
    rows, missing = [], 0
    for f in repo_files(repo):
        k = have.get(f['sha256']) if f['sha256'] else (f"Weights/{f['id']}" if f"Weights/{f['id']}" in files else None)
        ok = bool(k) and files[k]['contentLength'] == f['bytes']
        missing += not ok
        rows.append({'path': f['path'], 'revision': f['revision'], 'bytes': f['bytes'], 'sha256': f['sha256'] or (files[k].get('fileInfo') or {}).get('sha256') if ok else f['sha256'], 'b2_key': k if ok else None})
        print(f"{'OK     ' if ok else 'MISSING'} {f['path']:80s} {f['bytes'] / 1e9:7.2f} GB {k or ''}")
    print(f"{missing} of {len(rows)} files missing in B2")
    if write:
        try:
            idx = json.loads(b2.get('Weights/WEIGHTS_INDEX.json'))
        except Exception:
            idx = {'repos': {}}
        idx['repos'][repo] = rows
        idx['updated_utc'] = time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime())
        b2.put('Weights/WEIGHTS_INDEX.json', json.dumps(idx, indent=1).encode())
        print('Weights/WEIGHTS_INDEX.json updated')


def check_table(write=False):
    """Each table file: OK when a B2 file has its sha256 (and size). With write, also store Models/TABLE_INDEX.json."""
    b2 = B2()
    files = in_b2(b2)
    have = by_sha256(files)
    index, missing = {}, 0
    for f in table_files():
        k = have.get(f['sha256'])
        ok = bool(k) and files[k]['contentLength'] == f['bytes']
        missing += not ok
        if ok:
            index.setdefault(f['model_id'], []).append({'path': f['path'], 'repo': f['repo'], 'revision': f['revision'],
                                                        'b2_key': k, 'bytes': f['bytes'], 'sha256': f['sha256']})
        print(f"{'OK     ' if ok else 'MISSING'} {f['id']:70s} {f['bytes'] / 1e9:6.2f} GB {k or ''}")
    print(f"{missing} table files missing in B2")
    if write:
        b2.put('Models/TABLE_INDEX.json', json.dumps({'updated_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'models': index}, indent=1).encode())
        print(f"Models/TABLE_INDEX.json lists {len(index)} models")


def check():
    have = in_b2(B2())
    for m in catalog()['models']:
        f = have.get(key(m))
        ok = f and f['contentLength'] == m['bytes'] and (f.get('fileInfo') or {}).get('large_file_sha256') == m['sha256']
        print(f"{'OK     ' if ok else 'MISSING'} {m['id']:38s} {m['bytes'] / 1e9:6.1f} GB")


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == 'prepare' and len(a) >= 2:
        prepare(a[1], set(a[2:]))
    elif a[0] == 'finish' and len(a) == 3:
        finish(a[1], a[2])
    elif a[0] == 'prepare-table' and len(a) == 2:
        prepare_table(a[1])
    elif a[0] == 'prepare-repo' and len(a) == 3:
        prepare_repo(a[1], a[2])
    elif a[0] == 'check-repo' and len(a) >= 2:
        check_repo(a[1], '--write' in a)
    elif a[0] == 'check':
        check()
    elif a[0] == 'check-table':
        check_table('--write' in a)
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
