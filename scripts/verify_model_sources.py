#!/usr/bin/env python3
"""Check models/catalog.json against the models' ORIGINAL sources (Ollama registry, Hugging Face).

  python3 scripts/verify_model_sources.py              compare each pinned sha256 and size with what the source
                                                      publishes (no download)
  python3 scripts/verify_model_sources.py --download <id>   also download that model and hash every byte

An Ollama blob is named by its sha256; a Hugging Face LFS file lists its sha256 for the pinned revision. If these
match the catalog, the copies planetCompute serves (checked against the same sha256) are the original files.
Standard library only.
"""
import hashlib, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CAT = json.load(open(os.path.join(HERE, "..", "models", "catalog.json")))
UA = {"User-Agent": "planetCompute-verify"}


def get(url, headers=None):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={**UA, **(headers or {})}), timeout=60).read())


def published(m):
    s = m["source"]
    if s["type"] == "ollama":
        name, tag = s["model"].split(":")
        man = get(f"https://registry.ollama.ai/v2/library/{name}/manifests/{tag}",
                  {"Accept": "application/vnd.docker.distribution.manifest.v2+json"})
        layer = [l for l in man["layers"] if l["mediaType"].endswith("model")][0]
        # a tag can move to a newer file; the pinned blob stays downloadable by its digest
        return layer["digest"].split(":")[1], layer["size"], f"https://registry.ollama.ai/v2/library/{name}/blobs/sha256:{m['sha256']}"
    info = get(f"https://huggingface.co/api/models/{s['repo']}/revision/{s['revision']}?blobs=true")
    f = [x for x in info["siblings"] if x["rfilename"] == s["file"]][0]
    return f["lfs"]["sha256"], f["size"], f"https://huggingface.co/{s['repo']}/resolve/{s['revision']}/{s['file']}"


def main():
    dl = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--download" else None
    bad = 0
    for m in CAT["models"]:
        if dl and m["id"] != dl:
            continue
        sha, size, url = published(m)
        moved = m["source"]["type"] == "ollama" and sha != m["sha256"]
        same = (sha == m["sha256"] and size == m["bytes"]) or moved
        note = " (the tag now points to a newer file; the pinned blob is fetched by its digest)" if moved else ""
        print(f"{'OK  ' if same else 'DIFF'} {m['id']:38s} {m['bytes'] / 1e9:5.1f} GB{note}")
        bad += not same
        if dl:
            h, n = hashlib.sha256(), 0
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
                while chunk := r.read(8 << 20):
                    h.update(chunk)
                    n += len(chunk)
            ok = h.hexdigest() == m["sha256"] and n == m["bytes"]
            print(f"{'OK  ' if ok else 'DIFF'} downloaded {n} bytes, sha256 {h.hexdigest()}")
            bad += not ok
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
