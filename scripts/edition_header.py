"""Read and rewrite the HEADER of a GGUF or safetensors model file, for PlanetCompute editions.

A model file is a header followed by the weights. An edition = the original header with planetcompute.* metadata
ADDED (nothing changed or removed) + the original weights, byte for byte. So:
  edition = new_header(original) + original[data_offset:]
and the SHA-256 of the weights (the bytes from data_offset on) is the same for the original and the edition.

GGUF (https://github.com/ggml-org/ggml/blob/master/docs/gguf.md): magic "GGUF", version u32, tensor count u64,
metadata count u64, metadata (key, type, value), tensor infos (name, dims, type, offset relative to the data), then
padding to the alignment (general.alignment, default 32) and the tensor data. Tensor offsets are relative to the
data, so a longer header changes nothing in them.
safetensors: header length u64 (little endian), a JSON header (tensor name -> dtype, shape, data_offsets relative to
the data; "__metadata__": string -> string), then the data. The header is padded with spaces to a multiple of 8.
Standard library only (also runs on the pod and on users' computers)."""
import json
import struct

GGUF_TYPES = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
STRING, ARRAY = 8, 9


class Need(Exception):
    """The header is longer than the bytes given: read more."""


def _rd(b, o, fmt):
    n = struct.calcsize(fmt)
    if o + n > len(b):
        raise Need()
    return struct.unpack_from(fmt, b, o)[0], o + n


def _str(b, o):
    n, o = _rd(b, o, "<Q")
    if o + n > len(b):
        raise Need()
    return b[o:o + n].decode("utf-8", "replace"), o + n


def _skip_value(b, o, t):
    if t == STRING:
        return _str(b, o)[1]
    if t == ARRAY:
        et, o = _rd(b, o, "<I")
        n, o = _rd(b, o, "<Q")
        if et in GGUF_TYPES:
            o += n * struct.calcsize(GGUF_TYPES[et])
            if o > len(b):
                raise Need()
            return o
        for _ in range(n):
            o = _skip_value(b, o, et)
        return o
    return _rd(b, o, GGUF_TYPES[t])[1]


def _value(b, o, t):
    if t == STRING:
        return _str(b, o)
    if t == ARRAY:
        return None, _skip_value(b, o, t)
    return _rd(b, o, GGUF_TYPES[t])


def gguf_parse(b):
    """-> dict(version, n_tensors, keys {key: value or None}, kv_end, ti_end, alignment, data_offset)."""
    if b[:4] != b"GGUF":
        raise ValueError("not a GGUF file")
    version, o = _rd(b, 4, "<I")
    nt, o = _rd(b, o, "<Q")
    nkv, o = _rd(b, o, "<Q")
    keys = {}
    for _ in range(nkv):
        k, o = _str(b, o)
        t, o = _rd(b, o, "<I")
        v, o = _value(b, o, t)
        keys[k] = v
    kv_end = o
    for _ in range(nt):
        _, o = _str(b, o)
        nd, o = _rd(b, o, "<I")
        o += 8 * nd + 4 + 8
        if o > len(b):
            raise Need()
    align = int(keys.get("general.alignment") or 32)
    data = (o + align - 1) // align * align
    return {"version": version, "n_tensors": nt, "n_kv": nkv, "keys": keys, "kv_end": kv_end, "ti_end": o, "alignment": align, "data_offset": data}


def _gguf_kv(k, v):
    kb, vb = k.encode(), str(v).encode()
    return struct.pack("<Q", len(kb)) + kb + struct.pack("<I", STRING) + struct.pack("<Q", len(vb)) + vb


def gguf_edition_header(b, add):
    """New header bytes (up to the data, padded) with the string keys in `add` appended; refuses to change a key."""
    h = gguf_parse(b)
    clash = [k for k in add if k in h["keys"]]
    if clash:
        raise ValueError(f"keys already present: {clash}")
    kvs = b"".join(_gguf_kv(k, v) for k, v in add.items())
    head = b[:4] + struct.pack("<I", h["version"]) + struct.pack("<Q", h["n_tensors"]) + struct.pack("<Q", h["n_kv"] + len(add))
    new = head + b[24:h["kv_end"]] + kvs + b[h["kv_end"]:h["ti_end"]]
    pad = (-len(new)) % h["alignment"]
    return new + b"\0" * pad, h


def st_parse(b):
    n, _ = _rd(b, 0, "<Q")
    if n > 100_000_000:
        raise ValueError("not a safetensors file")
    if 8 + n > len(b):
        raise Need()
    head = json.loads(b[8:8 + n].decode("utf-8"))
    return {"header": head, "data_offset": 8 + n, "keys": dict(head.get("__metadata__") or {})}


def st_edition_header(b, add):
    h = st_parse(b)
    meta = dict(h["header"].get("__metadata__") or {})
    clash = [k for k in add if k in meta]
    if clash:
        raise ValueError(f"keys already present: {clash}")
    meta.update({k: str(v) for k, v in add.items()})
    head = dict(h["header"])
    head["__metadata__"] = meta
    j = json.dumps(head, separators=(",", ":"), ensure_ascii=False).encode()
    j += b" " * ((-len(j)) % 8)
    return struct.pack("<Q", len(j)) + j, h


def parse(b, fmt):
    return gguf_parse(b) if fmt == "gguf" else st_parse(b)


def edition_header(b, fmt, add):
    return gguf_edition_header(b, add) if fmt == "gguf" else st_edition_header(b, add)
