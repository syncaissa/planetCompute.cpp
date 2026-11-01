#!/usr/bin/env python3
"""Check a PlanetCompute edition against the original model file: prints every difference.

  python3 compare_edition.py <original file> <edition file>

Expected result for an edition: the only difference is the metadata keys starting with "planetcompute." that were
ADDED; no key changed or removed; the weights (everything after the header) are byte for byte the same, shown by one
SHA-256 for both. Works for GGUF and safetensors files. Standard library only (with edition_header.py next to it).
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import edition_header as E  # noqa: E402


def info(path):
    with open(path, "rb") as f:
        head = f.read(4)
        fmt = "gguf" if head == b"GGUF" else "safetensors"
        n = 4 << 20
        while True:
            f.seek(0)
            b = f.read(n)
            try:
                h = E.parse(b, fmt)
                break
            except E.Need:
                n *= 4
        f.seek(h["data_offset"])
        w = hashlib.sha256()
        for chunk in iter(lambda: f.read(8 << 20), b""):
            w.update(chunk)
    whole = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            whole.update(chunk)
    return fmt, h, w.hexdigest(), whole.hexdigest()


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    (fa, ha, wa, sa), (fb, hb, wb, sb) = info(sys.argv[1]), info(sys.argv[2])
    print(f"original: {sys.argv[1]}  ({fa}, sha256 {sa})")
    print(f"edition:  {sys.argv[2]}  ({fb}, sha256 {sb})")
    ka, kb = ha["keys"], hb["keys"]
    added = sorted(set(kb) - set(ka))
    removed = sorted(set(ka) - set(kb))
    changed = sorted(k for k in set(ka) & set(kb) if ka[k] != kb[k])
    print(f"\nmetadata keys added ({len(added)}):")
    for k in added:
        v = str(kb[k])
        print(f"  {k} = {v if len(v) < 160 else v[:157] + '...'}")
    print(f"metadata keys removed: {removed or 'none'}")
    print(f"metadata keys changed: {changed or 'none'}")
    if fa == "gguf":
        print(f"tensors: {ha['n_tensors']} in the original, {hb['n_tensors']} in the edition")
    print(f"\nweights sha256 (everything after the header):\n  original {wa}\n  edition  {wb}")
    ok = wa == wb and not removed and not changed and all(k.startswith("planetcompute.") for k in added)
    print("\nRESULT: " + ("only planetcompute.* metadata was added; the weights are identical." if ok else "DIFFERENT: see above."))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
