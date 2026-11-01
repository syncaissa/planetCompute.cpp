# The model library: open models, licences and PlanetCompute editions

The planetCompute program downloads its models from planetcompute.ai (files kept in PlanetCompute's own storage and
served through Cloudflare), so users do not need accounts or tokens at the original publishers. This page explains
which models are offered, why that is allowed, what PlanetCompute changes in the files, and how anyone can check it.

## Which models

Only **open models whose licence allows commercial use, changes and redistribution** are offered. The master list is
the DynamoDB table `planetcompute-ai-models` (filled by `scripts/models_table.py`, shown on the admin page's
**Models** tab), in five categories: Image, Video, Music, Chat, Coding. Models whose weights can be downloaded but
whose licence does not allow this (for example non-commercial licences) are kept in the list as **excluded**, with
the reason, and are not offered.

## Licences (our reading; not legal advice; to be confirmed by counsel before launch)

| Licence | Models | Change and redistribute? | Conditions |
|---|---|---|---|
| Apache-2.0 | Qwen chat and coding models, gpt-oss, Mistral Small, Devstral, FLUX.1 schnell, FLUX.2 klein 4B, Z-Image Turbo, Qwen-Image, Chroma, Wan 2.1 / 2.2, ACE-Step, YuE, the T5/umt5 encoders | yes, also commercially | ship the licence (and any NOTICE file); state prominently that the files were changed; keep attribution; do not use the authors' trademarks as an endorsement |
| MIT | CLIP-L encoder; DeepSeek's part of the R1 distillation | yes | keep the copyright notice and licence |
| Llama 3.3 Community | DeepSeek-R1-Distill-Llama-70B | yes, with conditions | ship the licence; show "Built with Llama"; a changed model's name begins with "Llama"; Meta's acceptable-use policy passes to users; separate terms above 700 million monthly users |
| Stability AI Community | Stable Audio Open 1.0 | yes, with conditions | free for commercial use while the organisation's annual revenue is under US$1 million (PlanetCompute stays below it; a user whose own organisation earns more needs Stability's enterprise licence for commercial use); ship the licence; show "Powered by Stability AI"; Stability's acceptable-use policy passes to users |
| Non-commercial open weights (e.g. CC-BY-NC MusicGen) or custom terms (e.g. Gemma) | none | no | excluded |

## Gated models (for example Stable Audio Open)

Some publishers put a model behind a "gate" on Hugging Face: whoever downloads it first accepts the licence with
their account, and the download then needs that account's access token. Our reading of the licences (again, not
legal advice, to be confirmed by counsel):

- **Technically**: PlanetCompute downloads the files once with its own Hugging Face token; users then get them from
  PlanetCompute's storage through planetcompute.ai and never need a Hugging Face account or token.
- **Legally** this is fine for the gated models in the library, because their licences allow redistribution, **on
  two conditions** that PlanetCompute keeps:
  1. **A licence-agreement step in the program**: before a model with conditions (a gated model, or one under the
     Llama or Stability licence) is downloaded, the program shows its licence and the user agrees ("I agree to the
     ... licence"), just as the Hugging Face gate asks. Each user has then accepted the terms themselves.
  2. **The Hugging Face token stays private**: it is kept only in PlanetCompute's server settings (never in the
     program, the website, a file users receive, or any public repository) and is used only to read the gated
     files when an edition is built.
- The required notices ("Powered by Stability AI", "Built with Llama") are written into each edition's metadata and
  its change record, and shown next to the model in the program.

## PlanetCompute editions: what we change, and how to check it

Each library file is offered as a **PlanetCompute edition**: the original file with metadata **added** to its header.
Nothing is removed, no existing metadata is changed, and **the model weights are byte for byte the original's**.
Every device therefore computes exactly the same answers as with the original file.

The added metadata (keys starting with `planetcompute.`) holds what the grid needs to run and check work, and the
legal notices:

| Key | Why |
|---|---|
| `model_id`, `edition`, `name` | a WorkPack names the model; a device can prove the file it loaded is that edition |
| `kind`, `engine`, `family` | which engine (llama.cpp or stable-diffusion.cpp) and mode runs it |
| `parts` / `part_of`, `role` | a model made of several files knows its exact companions |
| `work_unit` | how much work a token or a denoising step counts as (the basis of credit); "to be measured" until measured |
| `match` | how answers from different devices are compared (exact tokens for chat; the allowed difference per step for pictures) |
| `defaults` | steps, guidance, sampler, size and other settings, so the same request means the same work everywhere |
| `min_memory_gb` | the memory a device needs, so it is only sent work it can hold |
| `license`, `license_url`, `license_conditions`, `attribution` | the licence and the notices it requires |
| `source.repo`, `source.revision`, `source.file`, `source.sha256`, `source.bytes` | exactly which original file this edition comes from |
| `modified_by` | "PlanetCompute: metadata added; nothing else changed; weights unchanged" |

How an edition is built (`scripts/models_editions.py`, `scripts/pod_editions.py`): the original's header is read and
rewritten with the keys above; a rented server streams the rest of the original from its publisher into
PlanetCompute's storage, and while it streams it computes three SHA-256 checksums: of the **original file** (it must
equal the publisher's, which proves the source), of the **weights alone**, and of the **edition**.

**"What did you change?"** Every edition has a change record (`<edition file>.CHANGES.json`, shown in the program
and on the website) with: the list of added keys and their values, the original's SHA-256, the edition's SHA-256,
and the SHA-256 of the weights, which is the same for both files. Anyone can check it themselves:

```
python3 scripts/compare_edition.py <original file> <edition file>
```

It prints every metadata key added, removed or changed, and the weights' SHA-256 for both files, and ends with
`RESULT: only planetcompute.* metadata was added; the weights are identical.` (or `DIFFERENT` and what differs). It
uses only Python's standard library and `scripts/edition_header.py`.

If PlanetCompute ever changes the weights themselves (its own quantisation, a fine-tune), the change record says so
plainly and the model gets a new name.

## Tests

- `edition_header.py` was checked against the reference readers: llama.cpp's own `gguf` Python reader (every tensor
  identical, only the new keys added, no existing key changed) and the official `safetensors` loader (every tensor
  identical, original metadata kept).
- The streaming build was tested end to end on small real files split into many parts: the reassembled edition is
  byte for byte the expected one, and all three checksums are right.
- `compare_edition.py` reports exactly the added keys and identical weights for both formats.
