#!/usr/bin/env python3
"""The model library's master list in DynamoDB (<prefix>models; see CreateTables.py), shown on the admin page's
Models tab. Only open models whose licence allows commercial use and redistribution are "allowed"; others are kept
as "excluded" with the reason, so the list also shows what PlanetCompute chose not to offer.

  python3 models_table.py seed [<id> ...]     check each model below against Hugging Face (licence tag, every file's
                                              size and SHA-256 at a pinned revision) and write it to the table
                                              (status listed / excluded; an existing row keeps its status and edition)
  python3 models_table.py list                print the table, by category
  python3 models_table.py add <file.json>     add your own entries (same fields as MODELS below), checked the same way

Add a model: append it to MODELS (or a JSON file for `add`): id, category (Image | Video | Music | Audio | Chat | Coding),
name, engine, files (role + repo + path; revision optional = the repo's current one, pinned when written), notes.
Set status "pending" on rows to be built into PlanetCompute editions by models_editions.py.
Credentials: AWS_* and DYNAMODB_TABLE_PREFIX from ../../.env (never printed).
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, "..", "..", ".env")
for line in open(ENV) if os.path.exists(ENV) else []:
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
TABLE = os.environ.get("DYNAMODB_TABLE_PREFIX", "planetcompute-ai-") + "models"
UA = {"User-Agent": "planetcompute-models/1"}

# Licences that allow commercial use, change and redistribution (some with revenue limits, accepted by PlanetCompute) (with their conditions, Table "licences" in the paper).
OPEN = {
    "apache-2.0": "Ship the licence (and any NOTICE file); state prominently that files were changed; keep attribution; no use of the authors' trademarks as endorsement.",
    "mit": "Keep the copyright notice and the licence.",
    "stable-audio-community": "Stability AI Community Licence: free for commercial use while the organisation's annual revenue is under US$1 million (above it an enterprise licence from Stability AI is needed; PlanetCompute's choice, 2026-10-22: stays below); ship the licence; show \"Powered by Stability AI\"; Stability's acceptable-use policy passes to users. The repository is gated: downloading needs a Hugging Face token whose account accepted the terms (HF_TOKEN).",
    "openrail++": "CreativeML Open RAIL++-M: commercial use and redistribution allowed; the use-based restrictions (no illegal, harmful or deceptive uses, as listed in the licence) pass to every user and must be repeated in any redistribution.",
    "stabilityai-ai-community": "Stability AI Community Licence: free for commercial use while the organisation's annual revenue is under US$1 million (PlanetCompute stays below it); ship the licence; show \"Powered by Stability AI\"; Stability's acceptable-use policy passes to users. Gated: needs HF_TOKEN.",
    "ltx-2.x-community": "LTX-2.x Community Licence: free commercial use only under US$10 million annual revenue (section 2.1); ship the licence; its use restrictions pass to users. Gated: needs HF_TOKEN.",
    "openmdw-1.1": "OpenMDW 1.1: described by the model card as fully permissive for commercial products; ship the licence and keep notices. The licence text itself is still to be read before launch.",
    "cc-by-4.0": "Creative Commons Attribution 4.0: commercial use and redistribution allowed; give credit to the authors and say what was changed.",
    "llama3.3": "Ship the licence; show \"Built with Llama\"; a changed model's name begins with \"Llama\"; Meta's acceptable-use policy passes to users; separate terms above 700 million monthly users.",
}
LIC_URL = {"apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0", "mit": "https://opensource.org/license/mit",
           "stable-audio-community": "https://huggingface.co/stabilityai/stable-audio-open-1.0/blob/main/LICENSE.md",
           "openrail++": "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md",
           "cc-by-4.0": "https://creativecommons.org/licenses/by/4.0/",
           "llama3.3": "https://www.llama.com/llama3_3/license/"}

F = lambda role, repo, path, revision=None: {"role": role, "repo": repo, "path": path, **({"revision": revision} if revision else {})}
SD = "stable-diffusion.cpp"
MODELS = [
    # ---- Images ----
    {"id": "flux1-schnell-q4", "category": "Image", "name": "FLUX.1 schnell (4-bit)", "engine": SD, "in_app": True, "min_ram_gb": 16,
     "files": [F("diffusion", "second-state/FLUX.1-schnell-GGUF", "flux1-schnell-Q4_0.gguf"), F("vae", "second-state/FLUX.1-schnell-GGUF", "ae-f16.gguf"),
               F("clip_l", "second-state/FLUX.1-schnell-GGUF", "clip_l-Q8_0.gguf"), F("t5xxl", "second-state/FLUX.1-schnell-GGUF", "t5xxl-Q4_K.gguf")],
     "license_repo": "black-forest-labs/FLUX.1-schnell", "notes": "Recommended for pictures; 4 steps."},
    {"id": "zimage-turbo-q4k", "category": "Image", "name": "Z-Image Turbo (4-bit)", "engine": SD, "in_app": True, "min_ram_gb": 8,
     "files": [F("diffusion", "leejet/Z-Image-Turbo-GGUF", "z_image_turbo-Q4_K.gguf"), F("vae", "second-state/FLUX.1-schnell-GGUF", "ae-f16.gguf"),
               F("llm", "unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")],
     "license_repo": "Tongyi-MAI/Z-Image-Turbo", "notes": "Modern pictures on smaller machines; text encoder shared with the chat model Qwen3 4B."},
    {"id": "flux2-klein-4b-q4", "category": "Image", "name": "FLUX.2 klein 4B (4-bit)", "engine": SD, "in_app": False, "min_ram_gb": 8,
     "files": [F("diffusion", "leejet/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q4_0.gguf")],
     "license_repo": "black-forest-labs/FLUX.2-klein-4B", "notes": "Newer FLUX generation, small. Parts (VAE, text encoder) to be added per docs/flux2.md of the engine."},
    {"id": "qwen-image-q4km", "category": "Image", "name": "Qwen-Image (4-bit)", "engine": SD, "in_app": False, "min_ram_gb": 24,
     "files": [F("diffusion", "city96/Qwen-Image-gguf", "qwen-image-Q4_K_M.gguf")],
     "license_repo": "Qwen/Qwen-Image", "notes": "Large (20B); strong at text in pictures. Parts (VAE, Qwen2.5-VL encoder) to be added per docs/qwen_image.md."},
    {"id": "chroma1-hd-q4", "category": "Image", "name": "Chroma1-HD (4-bit)", "engine": SD, "in_app": False, "min_ram_gb": 16,
     "files": [F("diffusion", "silveroxides/Chroma-GGUF", "Chroma1-HD/Chroma1-HD-Q4_0.gguf")],
     "license_repo": "lodestones/Chroma", "notes": "FLUX-based, Apache-2.0. Uses the FLUX VAE and T5-XXL (already in the library)."},
    # ---- Video ----
    {"id": "wan21-t2v-1.3b-q8", "category": "Video", "name": "Wan 2.1 text to video 1.3B (8-bit)", "engine": SD, "in_app": True, "min_ram_gb": 16,
     "files": [F("diffusion", "samuelchristlie/Wan2.1-T2V-1.3B-GGUF", "Wan2.1-T2V-1.3B-Q8_0.gguf"),
               F("vae", "Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/vae/wan_2.1_vae.safetensors"),
               F("t5xxl", "city96/umt5-xxl-encoder-gguf", "umt5-xxl-encoder-Q4_K_M.gguf")],
     "license_repo": "Wan-AI/Wan2.1-T2V-1.3B", "notes": "Clips of 1-3 s; 832x480."},
    {"id": "wan22-ti2v-5b-q4km", "category": "Video", "name": "Wan 2.2 text/image to video 5B (4-bit)", "engine": SD, "in_app": False, "min_ram_gb": 16,
     "files": [F("diffusion", "QuantStack/Wan2.2-TI2V-5B-GGUF", "Wan2.2-TI2V-5B-Q4_K_M.gguf"), F("vae", "QuantStack/Wan2.2-TI2V-5B-GGUF", "VAE/Wan2.2_VAE.safetensors"),
               F("t5xxl", "city96/umt5-xxl-encoder-gguf", "umt5-xxl-encoder-Q4_K_M.gguf")],
     "license_repo": "Wan-AI/Wan2.2-TI2V-5B", "notes": "Better clips, 720p capable; text or a starting picture."},
    # ---- Music ----
    {"id": "ace-step-v1-3.5b", "category": "Music", "name": "ACE-Step v1 3.5B", "engine": "not yet", "in_app": False, "min_ram_gb": 16,
     "files": [F("diffusion", "ACE-Step/ACE-Step-v1-3.5B", "ace_step_transformer/diffusion_pytorch_model.safetensors"),
               F("dcae", "ACE-Step/ACE-Step-v1-3.5B", "music_dcae_f8c8/diffusion_pytorch_model.safetensors"),
               F("vocoder", "ACE-Step/ACE-Step-v1-3.5B", "music_vocoder/diffusion_pytorch_model.safetensors"),
               F("text", "ACE-Step/ACE-Step-v1-3.5B", "umt5-base/model.safetensors")],
     "license_repo": "ACE-Step/ACE-Step-v1-3.5B", "notes": "Songs with lyrics. No engine in the app yet (needs a music runner)."},
    {"id": "yue-s1-7b", "category": "Music", "name": "YuE s1 7B (English, chain of thought)", "engine": "not yet", "in_app": False, "min_ram_gb": 24,
     "files": [F("lm", "m-a-p/YuE-s1-7B-anneal-en-cot", f"model-0000{i}-of-00003.safetensors") for i in (1, 2, 3)],
     "license_repo": "m-a-p/YuE-s1-7B-anneal-en-cot",
     "notes": "Songs from lyrics. Its audio codec (m-a-p/xcodec_mini_infer) ships as .pth/.bin pickle files: convert to safetensors before an edition (pickle can run code)."},
    # ---- Chat ----
    {"id": "qwen2.5-0.5b-q4km", "category": "Chat", "name": "Qwen2.5 0.5B Instruct (4-bit)", "engine": "llama.cpp", "in_app": True, "min_ram_gb": 2,
     "files": [F("model", "Qwen/Qwen2.5-0.5B-Instruct-GGUF", "qwen2.5-0.5b-instruct-q4_k_m.gguf")], "license_repo": "Qwen/Qwen2.5-0.5B-Instruct", "notes": "Smallest; in the app from Ollama."},
    {"id": "qwen3-4b-instruct-2507", "category": "Chat", "name": "Qwen3 4B Instruct 2507 (4-bit)", "engine": "llama.cpp", "in_app": True, "min_ram_gb": 6,
     "files": [F("model", "unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")], "license_repo": "Qwen/Qwen3-4B-Instruct-2507", "notes": "Also Z-Image Turbo's text encoder."},
    {"id": "qwen3-30b-a3b-q4km", "category": "Chat", "name": "Qwen3 30B A3B (4-bit)", "engine": "llama.cpp", "in_app": True, "min_ram_gb": 24,
     "files": [F("model", "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF", "Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf")], "license_repo": "Qwen/Qwen3-30B-A3B-Instruct-2507", "notes": ""},
    {"id": "qwen3-32b-q4km", "category": "Chat", "name": "Qwen3 32B (4-bit)", "engine": "llama.cpp", "in_app": True, "min_ram_gb": 24,
     "files": [F("model", "unsloth/Qwen3-32B-GGUF", "Qwen3-32B-Q4_K_M.gguf")], "license_repo": "Qwen/Qwen3-32B", "notes": ""},
    {"id": "gpt-oss-20b", "category": "Chat", "name": "gpt-oss 20B (MXFP4)", "engine": "llama.cpp", "in_app": False, "min_ram_gb": 16,
     "files": [F("model", "ggml-org/gpt-oss-20b-GGUF", "gpt-oss-20b-MXFP4.gguf")], "license_repo": "openai/gpt-oss-20b", "notes": "OpenAI's open-weight model, Apache-2.0."},
    {"id": "mistral-small-3.2-24b-q4km", "category": "Chat", "name": "Mistral Small 3.2 24B (4-bit)", "engine": "llama.cpp", "in_app": False, "min_ram_gb": 24,
     "files": [F("model", "unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF", "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf")], "license_repo": "mistralai/Mistral-Small-3.2-24B-Instruct-2506", "notes": ""},
    {"id": "deepseek-r1-distill-llama-70b-q4km", "category": "Chat", "name": "DeepSeek-R1 Distill Llama 70B (4-bit)", "engine": "llama.cpp", "in_app": True, "min_ram_gb": 48,
     "files": [F("model", "unsloth/DeepSeek-R1-Distill-Llama-70B-GGUF", "DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf")], "license_repo": "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
     "license_override": "llama3.3", "notes": "MIT (DeepSeek) on Llama 3.3 (Llama licence conditions apply)."},
    # ---- Coding ----
    {"id": "qwen2.5-coder-7b", "category": "Coding", "name": "Qwen2.5-Coder 7B Instruct (4-bit)", "engine": "llama.cpp", "in_app": True, "min_ram_gb": 8,
     "files": [F("model", "unsloth/Qwen2.5-Coder-7B-Instruct-GGUF", "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf")], "license_repo": "Qwen/Qwen2.5-Coder-7B-Instruct", "notes": ""},
    {"id": "qwen2.5-coder-14b", "category": "Coding", "name": "Qwen2.5-Coder 14B Instruct (4-bit)", "engine": "llama.cpp", "in_app": False, "min_ram_gb": 16,
     "files": [F("model", "unsloth/Qwen2.5-Coder-14B-Instruct-GGUF", "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf")], "license_repo": "Qwen/Qwen2.5-Coder-14B-Instruct", "notes": ""},
    {"id": "qwen3-coder-30b-a3b", "category": "Coding", "name": "Qwen3-Coder 30B A3B (4-bit)", "engine": "llama.cpp", "in_app": True, "min_ram_gb": 24,
     "files": [F("model", "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf")], "license_repo": "Qwen/Qwen3-Coder-30B-A3B-Instruct", "notes": ""},
    {"id": "devstral-small-2507-q4km", "category": "Coding", "name": "Devstral Small 2507 24B (4-bit)", "engine": "llama.cpp", "in_app": False, "min_ram_gb": 24,
     "files": [F("model", "unsloth/Devstral-Small-2507-GGUF", "Devstral-Small-2507-Q4_K_M.gguf")], "license_repo": "mistralai/Devstral-Small-2507", "notes": "Mistral's coding agent model."},
    # ---- Not allowed (kept to show why) ----
    {"id": "musicgen-small", "category": "Music", "name": "MusicGen small", "engine": "not yet", "in_app": False, "files": [],
     "license_repo": "facebook/musicgen-small", "notes": "CC-BY-NC-4.0: non-commercial only."},
    {"id": "stable-audio-open-1.0", "category": "Music", "name": "Stable Audio Open 1.0", "engine": "not yet", "in_app": False, "min_ram_gb": 12,
     "files": [F("model", "stabilityai/stable-audio-open-1.0", "model.safetensors")],
     "license_repo": "stabilityai/stable-audio-open-1.0", "license_override": "stable-audio-community", "gated": True,
     "notes": "Sound effects and music up to 47 s. Revenue-limited licence, accepted by PlanetCompute (user, 2026-10-22: \"we will not exceed the revenue\"). Gated: needs HF_TOKEN."},
    {"id": "gemma-3-12b", "category": "Chat", "name": "Gemma 3 12B", "engine": "llama.cpp", "in_app": False, "files": [],
     "license_repo": "google/gemma-3-12b-it", "notes": "Gemma Terms of Use: custom terms with use restrictions, not an open-source licence."},
]


def hf(repo, revision="main"):
    for a in range(4):
        try:
            h = {**UA, **({"Authorization": "Bearer " + os.environ["HF_TOKEN"]} if os.environ.get("HF_TOKEN") else {})}
            return json.load(urllib.request.urlopen(urllib.request.Request(f"https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true", headers=h), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 404):
                return {"error": f"HTTP {e.code}", "gated": True}
            time.sleep(3 * (a + 1))
    raise RuntimeError("Hugging Face does not answer for " + repo)


def check(m):
    """Fill in licence, every file's size, SHA-256 and pinned revision; decide allowed / excluded."""
    lic_info = hf(m["license_repo"])
    card = lic_info.get("cardData") or {}
    lic = m.get("license_override") or (card.get("license") or ("gated" if lic_info.get("error") else "unknown"))
    row = {k: v for k, v in m.items() if k not in ("files", "license_override")}
    row["license"] = lic
    row["license_url"] = LIC_URL.get(lic, f"https://huggingface.co/{m['license_repo']}")
    row["allowed"] = lic in OPEN and bool(m["files"])
    row["conditions"] = OPEN.get(lic, "Not an open licence that allows commercial use and redistribution: not offered.")
    files, total = [], 0
    for f in m["files"]:
        info = hf(f["repo"], f.get("revision", "main"))
        if (info.get("cardData") or {}).get("license") not in (None, lic) and not m.get("license_override"):
            row["allowed"] = False
            row["status_note"] = f"{f['repo']} says licence {(info.get('cardData') or {}).get('license')}, not {lic}"
        s = [x for x in info.get("siblings", []) if x["rfilename"] == f["path"]]
        if not s:
            raise RuntimeError(f"{m['id']}: {f['repo']}/{f['path']} not found")
        s = s[0]
        files.append({**f, "revision": info["sha"], "bytes": s.get("size", 0), "sha256": (s.get("lfs") or {}).get("sha256", ""),
                      "format": "safetensors" if f["path"].endswith(".safetensors") else "gguf" if f["path"].endswith(".gguf") else "other"})
        total += s.get("size", 0)
    row["files_json"] = json.dumps(files)
    row["total_bytes"] = total
    row["status"] = "listed" if row["allowed"] else "excluded"
    row.setdefault("status_note", "" if row["allowed"] else row["notes"])
    return row


def table():
    import boto3
    return boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1")).Table(TABLE)


def write(rows):
    from decimal import Decimal
    t, now = table(), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for r in rows:
        old = t.get_item(Key={"model_id": r["id"], "sk": "MODEL"}).get("Item")
        item = {**{k: (Decimal(str(v)) if isinstance(v, float) else v) for k, v in r.items() if k != "id"},
                "model_id": r["id"], "sk": "MODEL", "cat_sk": f"{r['name'].lower()}#{r['id']}", "updated_at": now, "updated_by": "models_table.py"}
        if old:   # keep what the editions script and the admins set
            # keep what the editions script and the admins set; the licence decision (excluded or not) is always new
            keep_status = old.get("status") not in (None, "listed", "excluded") and r["status"] != "excluded"
            for k in ("status", "status_note", "edition_json", "created_at"):
                if k in old and (k not in ("status", "status_note") or keep_status):
                    item[k] = old[k]
        item.setdefault("created_at", now)
        t.put_item(Item=item)
        print(f"{'updated' if old else 'added  '} {r['category']:6} {r['id']:36} {item['status']:9} {r['license']:12} {r['total_bytes'] / 1e9:6.2f} GB")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd in ("seed", "add"):
        todo = MODELS if cmd == "seed" else json.load(open(sys.argv[2]))
        only = set(sys.argv[2:]) if cmd == "seed" else set()
        rows, bad = [], []
        for m in todo:
            if only and m["id"] not in only:
                continue
            try:
                rows.append(check(m))
            except Exception as e:   # one wrong entry must not stop the others
                bad.append(f"{m['id']}: {e}")
        write(rows)
        for b in bad:
            print("NOT WRITTEN", b)
    elif cmd == "list":
        items = table().scan()["Items"]   # a few hundred rows at most; the admin page uses the category index
        for it in sorted(items, key=lambda x: (x["category"], x["cat_sk"])):
            print(f"{it['category']:6} {it['model_id']:36} {it['status']:9} {it['license']:12} {float(it.get('total_bytes', 0)) / 1e9:6.2f} GB  in app: {it.get('in_app')}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
