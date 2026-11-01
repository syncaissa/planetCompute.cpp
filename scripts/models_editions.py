#!/usr/bin/env python3
"""PlanetCompute editions of the library's open models: the original file with planetcompute.* metadata ADDED to its
header (licence, source, attribution, and what the grid needs at inference time) and the weights unchanged, copied
into B2 so the planetCompute program downloads them through planetcompute.ai. See edition_header.py for the format.

Runs on Cloud9 (B2 + AWS keys); the bytes never pass through Cloud9. Each file's header (a few MB) is read here and
rewritten; a RunPod pod then streams the rest from the publisher into B2 in parts with upload links good only for
those parts (no keys on the pod) and hashes everything on the way: the ORIGINAL file (must equal the publisher's
SHA-256: proof of the source), the WEIGHTS alone, and the EDITION.

  models_editions.py prepare job.json [<id> ...]   every library file (models/catalog.json) not yet built, or those
                                                   ids: build its new header, start a B2 large file
                                                   Models/<id>/<name>.planetcompute.<ext>, write the pod's job
  (pod)  python3 pod_editions.py job.json results.json
  models_editions.py finish job.json results.json  check every result, finish the uploads, write each change record
                                                   (Models/<id>/<edition file>.CHANGES.json), the editions catalog
                                                   (Models/catalog-editions.json: what the program reads with ?all=1)
                                                   and the DynamoDB rows (status built, edition_json)
  models_editions.py check                         list the editions in B2

The released program keeps Models/catalog.json (the originals) unchanged. job.json holds upload tokens: copy it only
to the pod and delete it after `finish`.
"""
import base64
import json
import math
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import edition_header as E  # noqa: E402
from publish_client import B2  # noqa: E402

CATALOG = os.path.join(HERE, "..", "models", "catalog.json")
PART = 128 * 1024 * 1024
WORKERS = 8
EDITION = "1"
DATE = time.strftime("%Y-%m-%d", time.gmtime())
UA = {"User-Agent": "planetcompute-editions/1"}
ENV = os.path.join(HERE, "..", "..", ".env")
for line in open(ENV) if os.path.exists(ENV) else []:
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def catalog():
    return json.load(open(CATALOG))["models"]


def source_url(m):
    s = m["source"]
    if s["type"] == "ollama":
        name, _ = s["model"].split(":")
        return f"https://registry.ollama.ai/v2/library/{name}/blobs/sha256:{m['sha256']}"
    return f"https://huggingface.co/{s['repo']}/resolve/{s['revision']}/{s['file']}"


def edition_name(m):
    stem, ext = m["file"].rsplit(".", 1)
    return f"{stem}.planetcompute.{ext}"


def key(m):
    return f"Models/{m['id']}/{edition_name(m)}"


def fmt(m):
    return "safetensors" if m.get("format") == "safetensors" or m["file"].endswith(".safetensors") else "gguf"


def table():
    import boto3
    return boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1")).Table(
        os.environ.get("DYNAMODB_TABLE_PREFIX", "planetcompute-ai-") + "models")


def rows():
    out = {}
    for it in table().scan()["Items"]:
        out[it["model_id"]] = it
    return out


def row_for(m, rs):
    """The DynamoDB row that holds this file's licence: the same id, or the row that lists this file (a part)."""
    if m["id"] in rs:
        return rs[m["id"]]
    for r in rs.values():
        for f in json.loads(r.get("files_json") or "[]"):
            if f.get("sha256") == m["sha256"]:
                return r
    if m.get("partOf") in rs:
        return rs[m["partOf"]]
    raise RuntimeError(f"{m['id']}: no row in the models table (run models_table.py seed)")


# Provisional SSIM thresholds for matching frames from different GPUs (paper Table xplat: honest FLUX pairs 0.94-0.96,
# SD 1.5 0.99, different pictures 0.24-0.35); to be confirmed on more GPU pairs. Other families: to be measured.
SSIM_MIN = {"flux": 0.90, "sd1": 0.97}

# What the grid needs at inference time, by kind and family (defaults stay with the bytes; speeds and prices do not).
def defaults(m):
    fam = m.get("family", "")
    d = {k: m[k] for k in ("steps", "cfg", "size", "width", "height") if k in m}
    if fam == "flux":
        d.update({"cfg": 1.0, "sampler": "euler", "vae_tiling": True})
    elif fam == "zimage":
        d.update({"cfg": 1.0, "diffusion_flash_attention": True})
    elif fam == "wan":
        d.update({"cfg": 6.0, "sampler": "euler", "flow_shift": 3.0, "fps": 16, "frames": "4n+1 (default 33)", "diffusion_flash_attention": True,
                  "negative": "Wan's standard negative prompt (see the planetCompute program, image.rs WAN_NEGATIVE)"})
    elif fam == "sd1":
        d.update({"cfg": 7.0})
    return d


def metadata(m, row, lib):
    kind = m.get("kind") or "text"
    lic = row["license"]
    src = m["source"]
    md = {
        "planetcompute.model_id": m["id"],
        "planetcompute.edition": EDITION,
        "planetcompute.name": m["name"],
        "planetcompute.kind": kind,
        "planetcompute.engine": "llama.cpp" if kind == "text" else "stable-diffusion.cpp",
        "planetcompute.family": m.get("family", ""),
        "planetcompute.min_memory_gb": str(m.get("minRamGB", "")),
        "planetcompute.license": lic,
        "planetcompute.license_url": row.get("license_url", ""),
        "planetcompute.license_conditions": row.get("conditions", ""),
        "planetcompute.source.repo": src.get("repo") or ("ollama:" + src.get("model", "")),
        "planetcompute.source.revision": src.get("revision", ""),
        "planetcompute.source.file": src.get("file") or m["file"],
        "planetcompute.source.sha256": m["sha256"],
        "planetcompute.source.bytes": str(m["bytes"]),
        "planetcompute.modified_by": f"PlanetCompute (https://planetcompute.ai), {DATE}: metadata added (the planetcompute.* keys); "
                                     "nothing else changed; weights unchanged (planetcompute.source.sha256 is the original file)",
        "planetcompute.work_unit": json.dumps({"status": "to be measured", "unit": "token" if kind == "text" else "denoising step at the default size"}),
        "planetcompute.match": json.dumps(
            {"rule": "exact tokens", "temperature": 0, "seed": "from the WorkPack"} if kind == "text" else
            {"rule": "perceptual: SSIM of the finished frame (grey, 7x7 window) at least ssim_min; relative error of one recomputed denoising step",
             "ssim_min": SSIM_MIN.get(m.get("family", ""), "to be measured"), "max_relative_error": "to be measured", "seed": "from the WorkPack",
             "measured": "paper Table xplat: RTX 4090 Linux vs Tesla T4 Windows, 2026-10-22"}),
        "planetcompute.defaults": json.dumps(defaults(m)),
    }
    if lic == "llama3.3":
        md["planetcompute.attribution"] = "Built with Llama"
    elif lic == "stable-audio-community":
        md["planetcompute.attribution"] = "Powered by Stability AI"
    if m.get("needs"):
        parts = []
        for pid in m["needs"]:
            p = next((x for x in lib if x["id"] == pid), None)
            role = (m.get("roles") or {}).get(pid) or (p or {}).get("role", "")
            parts.append({"role": role, "model_id": pid, "source_sha256": (p or {}).get("sha256", "")})
        md["planetcompute.parts"] = json.dumps(parts)
    if m.get("partOf") or m.get("role"):
        md["planetcompute.part_of"] = m.get("partOf", "")
        md["planetcompute.role"] = m.get("role", "")
    return md


def head_bytes(url, f):
    """Enough of the start of the file to hold the whole header (GGUF headers with big vocabularies are tens of MB)."""
    n = 4 << 20
    while True:
        h = {**UA, "Range": f"bytes=0-{n - 1}"}
        if "huggingface.co" in url and os.environ.get("HF_TOKEN"):
            h["Authorization"] = "Bearer " + os.environ["HF_TOKEN"]
        b = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120).read()
        try:
            E.parse(b, f)
            return b
        except E.Need:
            if n >= 512 << 20:
                raise RuntimeError("header larger than 512 MB?")
            n *= 4


def prepare(job_path, only):
    b2, lib, rs = B2(), catalog(), rows()
    have = {}
    start = None
    while True:
        r = b2._call("b2_list_file_names", {"bucketId": b2.bucket_id, "prefix": "Models/", "maxFileCount": 1000, **({"startFileName": start} if start else {})})
        have.update({f["fileName"]: f for f in r["files"]})
        start = r.get("nextFileName")
        if not start:
            break
    job = []
    for m in lib:
        if only and m["id"] not in only:
            continue
        if key(m) in have and not only:
            print(f"{m['id']}: edition already in B2")
            continue
        row = row_for(m, rs)
        if not row.get("allowed"):
            print(f"{m['id']}: SKIPPED, licence {row['license']} not allowed")
            continue
        f, url = fmt(m), source_url(m)
        b = head_bytes(url, f)
        new_head, h = E.edition_header(b, f, metadata(m, row, lib))
        d0, total = h["data_offset"], m["bytes"]
        size = len(new_head) + (total - d0)
        part = PART if size > PART else max(5 << 20, math.ceil(size / 2))    # B2: at least two parts of 5 MB or more
        parts = max(2, math.ceil(size / part))
        lf = b2._call("b2_start_large_file", {"bucketId": b2.bucket_id, "fileName": key(m), "contentType": "application/octet-stream",
                                              "fileInfo": {"planetcompute_edition": EDITION, "original_sha256": m["sha256"]}})
        urls = [b2._call("b2_get_upload_part_url", {"fileId": lf["fileId"]}) for _ in range(min(WORKERS, parts))]
        job.append({"id": m["id"], "row": row["model_id"], "url": url, "format": f, "bytes": total, "sha256": m["sha256"],
                    "data_offset": d0, "header_b64": base64.b64encode(new_head).decode(), "edition_bytes": size,
                    "part": part, "parts": parts, "fileId": lf["fileId"], "key": key(m),
                    "added": sorted(metadata(m, row, lib).keys()),
                    "upload": [{"url": u["uploadUrl"], "token": u["authorizationToken"]} for u in urls]})
        print(f"{m['id']}: {total / 1e9:.2f} GB, header {d0} -> {len(new_head)} bytes, {parts} parts -> {key(m)}")
        table().update_item(Key={"model_id": row["model_id"], "sk": "MODEL"}, UpdateExpression="SET #s = :s, status_note = :n",
                            ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":s": "building", ":n": f"edition {EDITION} being built {DATE}"})
    fd = os.open(job_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump({"made_utc": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()), "files": job}, fh)
    print(f"{len(job)} files, {sum(j['bytes'] for j in job) / 1e9:.1f} GB; job written to {job_path}")


def finish(job_path, results_path):
    b2, lib, rs = B2(), catalog(), rows()
    res = json.load(open(results_path))
    built = {}
    for j in json.load(open(job_path))["files"]:
        r = res.get(j["fileId"])
        if not r or r.get("error"):
            print(f"{j['id']}: not built ({(r or {}).get('error', 'no result')}); run prepare again for it")
            continue
        ok = r["original_sha256"] == j["sha256"] and r["edition_bytes"] == j["edition_bytes"] and len(r["sha1"]) == j["parts"]
        if not ok:
            b2._call("b2_cancel_large_file", {"fileId": j["fileId"]})
            print(f"{j['id']}: WRONG (original sha256 {r['original_sha256'][:12]}... expected {j['sha256'][:12]}...); upload cancelled")
            continue
        b2._call("b2_finish_large_file", {"fileId": j["fileId"], "partSha1Array": r["sha1"]})
        change = {
            "model_id": j["id"], "edition": EDITION, "made": DATE, "by": "PlanetCompute (https://planetcompute.ai)",
            "what_changed": "Metadata added to the file's header: the keys listed in 'added'. Nothing removed, no existing key changed. "
                            "Model weights: unchanged (weights_sha256 is the same for the original and this edition).",
            "added": j["added"], "format": j["format"],
            "original": {"url": j["url"], "sha256": j["sha256"], "bytes": j["bytes"], "data_offset": j["data_offset"]},
            "edition": {"b2": j["key"], "sha256": r["edition_sha256"], "bytes": r["edition_bytes"]},
            "weights_sha256": r["weights_sha256"],
            "check_it": "python3 compare_edition.py <original file> <edition file>  (planetCompute-CPP/scripts)",
        }
        b2.put(j["key"] + ".CHANGES.json", json.dumps(change, indent=1).encode())
        built[j["id"]] = change
        print(f"{j['id']}: edition finished; original sha256 verified; weights {r['weights_sha256'][:12]}...")
    # the editions catalog: every library entry, the edition where one exists (with the original kept for the fallback)
    try:
        old = json.loads(b2.get("Models/catalog-editions.json"))
    except Exception:
        old = {"models": []}
    prev = {m["id"]: m for m in old.get("models", [])}
    out = []
    for m in lib:
        c = built.get(m["id"]) or (prev.get(m["id"]) or {}).get("edition_record")
        e = dict(m)
        if c:
            e.update({"sha256": c["edition"]["sha256"], "bytes": c["edition"]["bytes"], "b2_file": c["edition"]["b2"].split("/")[-1],
                      "edition": EDITION, "weights_sha256": c["weights_sha256"], "edition_record": c,
                      "original": {"sha256": m["sha256"], "bytes": m["bytes"], "source": m["source"]},
                      "label": "PlanetCompute edition: metadata added, weights unchanged"})
        out.append(e)
    b2.put("Models/catalog-editions.json", json.dumps({"updated_utc": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()), "models": out}, indent=1).encode())
    print(f"Models/catalog-editions.json: {sum(1 for e in out if e.get('edition'))} editions of {len(out)} library files")
    # DynamoDB: the row of each built file gets its edition record
    per_row = {}
    for j in json.load(open(job_path))["files"]:
        if j["id"] in built:
            per_row.setdefault(j["row"], []).append(built[j["id"]])
    for rid, recs in per_row.items():
        old_e = json.loads(rs.get(rid, {}).get("edition_json") or "[]")
        keep = [x for x in old_e if x["model_id"] not in {r["model_id"] for r in recs}]
        table().update_item(Key={"model_id": rid, "sk": "MODEL"}, UpdateExpression="SET #s = :s, status_note = :n, edition_json = :e, updated_at = :t",
                            ExpressionAttributeNames={"#s": "status"},
                            ExpressionAttributeValues={":s": "built", ":n": f"edition {EDITION} built {DATE}", ":e": json.dumps(keep + recs),
                                                       ":t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        print(f"table: {rid} built ({len(recs)} file(s))")


def check():
    b2 = B2()
    r = b2._call("b2_list_file_names", {"bucketId": b2.bucket_id, "prefix": "Models/", "maxFileCount": 1000})
    for f in r["files"]:
        if ".planetcompute." in f["fileName"] and not f["fileName"].endswith(".json"):
            print(f"{f['contentLength'] / 1e9:7.2f} GB  {f['fileName']}")


def main():
    a = sys.argv[1:]
    if a[:1] == ["prepare"] and len(a) >= 2:
        prepare(a[1], set(a[2:]))
    elif a[:1] == ["finish"] and len(a) == 3:
        finish(a[1], a[2])
    elif a[:1] == ["check"]:
        check()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
