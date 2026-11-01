#!/usr/bin/env python3
"""Full backup of /home/ubuntu/environment/planetCompute to B2, with NO secrets (RESUME_HERE.md section 10.7).

    python3 backup_to_b2.py BACKUP_20261030_F "what is new since the last backup"   [--dry-run]

1. tar.gz of the folder (from /home/ubuntu/environment) WITHOUT: .env, .env.*, *.env, *.key (incl. the release signing
   key: the user keeps an offline copy), *.secret, .solana-devnet-keys.json, mainnet_payout.json, models_job.json,
   node_modules, .wrangler, __pycache__, planetCompute-CPP/dist, client/target, client/workpack/target.
2. Stops if a secret FILE NAME is inside.
3. Byte scan: every value of .env (8+ chars) and every 24+ char token of every key file (found with os.walk: glob skips
   hidden folders such as .ops) searched in every file of the archive. Known non-secrets may match (bucket names,
   region, table prefix, CF login email, PUBLIC wallet addresses); anything else stops the backup.
4. Uploads <NAME>/planetCompute.tar.gz (B2 native API, large-file upload in 100 MB parts) and <NAME>/README.txt to the
   bucket B2_BUCKET_NAME, lists them, removes the local tar.
Standard library only (no b2sdk or boto3).
"""
import base64, datetime, fnmatch, hashlib, json, os, re, subprocess, sys, tarfile, tempfile, urllib.parse, urllib.request

ROOT = "/home/ubuntu/environment/planetCompute"
EXCLUDE = [".env", ".env.*", "*.env", "*.key", "*.secret", ".solana-devnet-keys.json", "mainnet_payout.json",
           "models_job.json", "node_modules", ".wrangler", "__pycache__", "planetCompute/planetCompute-CPP/dist",
           "planetCompute/planetCompute-CPP/client/target", "planetCompute/planetCompute-CPP/client/workpack/target"]
KEY_FILES = ["*.key", "*.secret", "mainnet_payout*.json", ".solana-devnet-keys.json", ".env", ".env.*", "*.env"]
# values that may appear in the code: names, not secrets (checked by hand 2026-10-27..30)
OK_ENV = {"AWS_REGION", "B2_BUCKET_NAME", "B2_MEDIA_BUCKET_NAME", "DYNAMODB_TABLE_PREFIX", "CLOUDFLARE_EMAIL", "B2_KEY_NAME", "B2_MEDIA_KEY_NAME"}
OK_JSON_FIELDS = {"public_address", "treasury", "test_user", "mint", "treasury_token_account", "test_user_token_account", "cluster", "rpc"}

ENV = {}
for line in open(ROOT + "/.env"):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        ENV[k.strip()] = v.strip().strip('"').strip("'")


def secrets():
    vals = {k: v for k, v in ENV.items() if len(v) >= 8 and k not in OK_ENV}
    files = []
    for d, ds, fs in os.walk(ROOT):
        ds[:] = [x for x in ds if x not in ("node_modules", "target", ".git")]
        files += [os.path.join(d, f) for f in fs if any(fnmatch.fnmatch(f, p) for p in KEY_FILES)]
    for p in files:
        text = open(p, errors="ignore").read()
        public = set()
        try:
            j = json.loads(text)
            if isinstance(j, dict):
                public = {v for k, v in j.items() if k in OK_JSON_FIELDS and isinstance(v, str)}
        except ValueError:
            pass
        for i, tok in enumerate(re.findall(r"[A-Za-z0-9+/=_\-]{24,}", text)):
            if tok not in public:
                vals[os.path.relpath(p, ROOT) + "#%d" % i] = tok
    return vals, files


def b2():
    h = base64.b64encode((ENV["B2_KEY_ID"] + ":" + ENV["B2_APPLICATION_KEY"]).encode()).decode()
    a = json.load(urllib.request.urlopen(urllib.request.Request(
        "https://api.backblazeb2.com/b2api/v3/b2_authorize_account", headers={"Authorization": "Basic " + h})))

    def call(name, body):
        req = urllib.request.Request(a["apiInfo"]["storageApi"]["apiUrl"] + "/b2api/v3/" + name, data=json.dumps(body).encode(),
                                     headers={"Authorization": a["authorizationToken"]})
        return json.load(urllib.request.urlopen(req))
    bid = call("b2_list_buckets", {"accountId": a["accountId"], "bucketName": ENV["B2_BUCKET_NAME"]})["buckets"][0]["bucketId"]
    return call, bid


def upload(call, bid, path, name):
    size, sha = os.path.getsize(path), hashlib.sha1()
    with open(path, "rb") as fh:
        for ch in iter(lambda: fh.read(1 << 20), b""):
            sha.update(ch)
    if size < 100 << 20:
        u = call("b2_get_upload_url", {"bucketId": bid})
        req = urllib.request.Request(u["uploadUrl"], data=open(path, "rb").read(), headers={
            "Authorization": u["authorizationToken"], "X-Bz-File-Name": urllib.parse.quote(name),
            "Content-Type": "b2/x-auto", "X-Bz-Content-Sha1": sha.hexdigest()})
        json.load(urllib.request.urlopen(req))
    else:
        fid = call("b2_start_large_file", {"bucketId": bid, "fileName": name, "contentType": "b2/x-auto",
                                           "fileInfo": {"large_file_sha1": sha.hexdigest()}})["fileId"]
        parts = []
        with open(path, "rb") as fh:
            for n, ch in enumerate(iter(lambda: fh.read(100 << 20), b""), 1):
                u = call("b2_get_upload_part_url", {"fileId": fid})
                h = hashlib.sha1(ch).hexdigest()
                parts.append(h)
                json.load(urllib.request.urlopen(urllib.request.Request(u["uploadUrl"], data=ch, headers={
                    "Authorization": u["authorizationToken"], "X-Bz-Part-Number": str(n), "X-Bz-Content-Sha1": h})))
        call("b2_finish_large_file", {"fileId": fid, "partSha1Array": parts})
    print(f"uploaded {name}: {size:,} bytes, sha1 {sha.hexdigest()}")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    name, news, dry = sys.argv[1], sys.argv[2], "--dry-run" in sys.argv
    tmp = tempfile.mkdtemp(prefix="pcbackup-")
    tar = os.path.join(tmp, "planetCompute.tar.gz")
    subprocess.run(["tar"] + [f"--exclude={e}" for e in EXCLUDE] + ["-czf", tar, "planetCompute"],
                   cwd=os.path.dirname(ROOT), check=True)
    with tarfile.open(tar, "r:gz") as tf:
        names = tf.getnames()
    bad = [n for n in names if any(fnmatch.fnmatch(os.path.basename(n), p) for p in KEY_FILES)]
    if bad:
        sys.exit(f"STOP: secret file names in the archive: {bad[:5]}")
    vals, files = secrets()
    needles = {k: v.encode() for k, v in vals.items()}
    hits, scanned = {}, 0
    with tarfile.open(tar, "r:gz") as tf:
        for m in tf:
            if m.isfile():
                scanned += 1
                b = tf.extractfile(m).read()
                for k, v in needles.items():
                    if v in b:
                        hits.setdefault(k, []).append(m.name)
    print(f"{len(names):,} entries; scanned {scanned:,} files for {len(vals)} secret values from .env + {len(files)} key files")
    if hits:
        for k, f in hits.items():
            print("SECRET FOUND:", k, f[:3])
        sys.exit("STOP: not uploaded; local tar at " + tar)
    now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    readme = os.path.join(tmp, "README.txt")
    open(readme, "w").write(
        f"{name}  ({now}, Cloud9 clock)\nplanetCompute.tar.gz = {ROOT} (from {os.path.dirname(ROOT)})\n"
        f"Excluded: {', '.join(EXCLUDE)}.\n"
        f"Checked: no secret file names ({len(names):,} entries); byte scan of {len(vals)} secret values (.env + {len(files)} key "
        f"files incl. .ops) over {scanned:,} files: none found. Known non-secrets (bucket names, region, table prefix, CF login "
        f"email, public wallet addresses) are not counted as secrets.\n\nNew since the last backup: {news}\n")
    if dry:
        print("dry run: not uploaded; tar at", tar); return
    call, bid = b2()
    upload(call, bid, tar, f"{name}/planetCompute.tar.gz")
    upload(call, bid, readme, f"{name}/README.txt")
    os.remove(tar); os.remove(readme); os.rmdir(tmp)


if __name__ == "__main__":
    main()
