"""docs/TESTING.md test 86 (security issue 2, 2026-10-30): signed releases. The servers' agent (workhorse/whagent.py) checks an
Ed25519 signature of "planetCompute release|<sha256>" with its built-in public key, in plain Python. Checked here against
the `cryptography` library: real signatures pass; another message, a changed signature, another key, empty or malformed
signatures fail; and, if the release key is on this machine (.ops/release_ed25519.key), its public half is the one the agent has.
    python3 -I scripts/test_release_signing.py
"""
import base64, hashlib, importlib.util, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whagent", os.path.join(here, "..", "workhorse", "whagent.py"))
src = open(spec.origin).read()
ns = {}
exec(src[src.index("RELEASE_PUBKEY ="):src.index("\nclass ")], {"base64": base64, "hashlib": hashlib}, ns)   # only the verifier
verify, PUB = ns["ed25519_verify"], ns["RELEASE_PUBKEY"]
ok_n = bad = 0
def ok(name, cond):
    global ok_n, bad
    print(("PASS " if cond else "FAIL ") + name); ok_n += cond; bad += (not cond)
k = Ed25519PrivateKey.generate(); pk = k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
msgs = [f"planetCompute release|{hashlib.sha256(os.urandom(64)).hexdigest()}".encode() for _ in range(20)]
ok("1 twenty real signatures of release messages verify", all(verify(pk, m, k.sign(m)) for m in msgs))
m = msgs[0]; s = k.sign(m)
ok("2 another message (another SHA-256) with that signature: refused", not verify(pk, msgs[1], s))
ok("3 the signature changed by one bit: refused", not verify(pk, m, bytes([s[0] ^ 1]) + s[1:]) and not verify(pk, m, s[:40] + bytes([s[40] ^ 1]) + s[41:]))
ok("4 another key: refused", not verify(Ed25519PrivateKey.generate().public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw), m, s))
ok("5 empty, short, or nonsense signatures: refused (no crash)", not verify(pk, m, b"") and not verify(pk, m, b"x" * 63) and not verify(pk, m, b"\xff" * 64))
ok("6 the RFC 8032 test vector 1 (empty message) verifies", verify(bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), b"",
   bytes.fromhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")))
keyfile = os.path.join(here, "..", ".ops", "release_ed25519.key")
if os.path.exists(keyfile):
    rk = serialization.load_pem_private_key(open(keyfile, "rb").read(), None)
    ok("7 the release key on this machine matches the agent's public key, and signs what the agent accepts",
       rk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw) == PUB and verify(PUB, b"planetCompute release|abc", rk.sign(b"planetCompute release|abc")))
print(f"\n{ok_n} passed, {bad} failed"); sys.exit(1 if bad else 0)
