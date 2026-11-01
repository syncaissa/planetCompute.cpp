#!/usr/bin/env python3
"""On a RunPod pod: build each PlanetCompute edition in job.json (from models_editions.py prepare) by streaming.

  python3 pod_editions.py job.json results.json

For every file: the edition = the new header (in the job) + the original's bytes from its data offset on. The pod
fetches the original's own header too, so it can hash the ORIGINAL file exactly as published (proof of the source);
it hashes the WEIGHTS (the bytes after the header, the same in both) and the EDITION, and uploads the edition to B2 in
parts with the part-upload links in the job (no B2 keys here). Nothing is written to disk. results.json is rewritten
after every file. Standard library only. HF_TOKEN in the environment is used only for gated Hugging Face files.
"""
import base64
import concurrent.futures as cf
import hashlib
import json
import os
import sys
import time
import urllib.request

UA = {"User-Agent": "planetcompute-editions/1"}


def fetch(url, start, end):
    h = {**UA, "Range": f"bytes={start}-{end}"}
    if "huggingface.co" in url and os.environ.get("HF_TOKEN"):
        h["Authorization"] = "Bearer " + os.environ["HF_TOKEN"]
    for attempt in range(6):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=300).read()
            if len(data) == end - start + 1:
                return data
            raise IOError(f"short read {len(data)}")
        except Exception:
            if attempt == 5:
                raise
            time.sleep(5 * (attempt + 1))


def upload(link, n, data):
    sha1 = hashlib.sha1(data).hexdigest()
    for attempt in range(6):
        try:
            req = urllib.request.Request(link["url"], data=data, headers={
                "Authorization": link["token"], "X-Bz-Part-Number": str(n), "Content-Length": str(len(data)), "X-Bz-Content-Sha1": sha1})
            urllib.request.urlopen(req, timeout=600).read()
            return sha1
        except Exception:
            if attempt == 5:
                raise
            time.sleep(5 * (attempt + 1))


def build(j):
    head = base64.b64decode(j["header_b64"])
    d0, total, part, links = j["data_offset"], j["bytes"], j["part"], j["upload"]
    orig, weights, edition, sha1s, t0 = hashlib.sha256(), hashlib.sha256(), hashlib.sha256(), [], time.time()
    orig.update(fetch(j["url"], 0, d0 - 1))           # the original's own header
    edition.update(head)
    first_data = part - len(head)                     # part 1 = new header + the first weights
    if first_data <= 0:
        raise RuntimeError("header larger than one part")

    def span(i):                                      # the original's byte range carried in edition part i (0-based)
        a = d0 + (0 if i == 0 else first_data + (i - 1) * part)
        b = min(d0 + (first_data if i == 0 else first_data + i * part), total)
        return a, b

    with cf.ThreadPoolExecutor(len(links)) as ex:
        for first in range(0, j["parts"], len(links)):
            nums = range(first, min(first + len(links), j["parts"]))

            def one(i, k):
                a, b = span(i)
                data = fetch(j["url"], a, b - 1) if b > a else b""
                blob = (head + data) if i == 0 else data
                return data, blob, upload(links[k], i + 1, blob)

            for data, blob, sha1 in ex.map(lambda ik: one(*ik), [(i, k) for k, i in enumerate(nums)]):   # in order
                orig.update(data)
                weights.update(data)
                edition.update(data)                  # the new header was hashed before the loop
                sha1s.append(sha1)
            done = span(nums[-1])[1] - d0
            print(f"  {j['id']}: {done / 1e9:.2f}/{(total - d0) / 1e9:.2f} GB, {done / 1e6 / max(1, time.time() - t0):.0f} MB/s", flush=True)
    return {"original_sha256": orig.hexdigest(), "weights_sha256": weights.hexdigest(), "edition_sha256": edition.hexdigest(),
            "edition_bytes": len(head) + total - d0, "sha1": sha1s, "seconds": round(time.time() - t0)}


def main():
    job, out = json.load(open(sys.argv[1])), sys.argv[2]
    try:
        res = json.load(open(out))
    except Exception:
        res = {}
    for j in job["files"]:
        if j["fileId"] in res and not res[j["fileId"]].get("error"):
            continue
        print(f"{j['id']}: {j['bytes'] / 1e9:.2f} GB from {j['url'].split('/')[2]}", flush=True)
        try:
            r = build(j)
            res[j["fileId"]] = r
            print(f"{j['id']}: done in {r['seconds']} s; original sha256 {'MATCHES the publisher' if r['original_sha256'] == j['sha256'] else 'DOES NOT MATCH'}", flush=True)
        except Exception as e:
            res[j["fileId"]] = {"error": str(e)[:300]}
            print(f"{j['id']}: FAILED {e}", flush=True)
        json.dump(res, open(out, "w"))
    print("ALL_DONE", flush=True)


if __name__ == "__main__":
    main()
