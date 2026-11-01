#!/usr/bin/env python3
"""Request free TEST SOL on Solana devnet for an address (default: PlanetCompute's devnet test treasury).

Devnet SOL has no value; it only pays devnet transaction fees while testing. Nothing here touches the real
network (mainnet). Python 3 standard library only: runs on macOS, Windows and Linux with nothing to install.

Usage:
    python sendTestMoney2DevnetSolana.py                      # 1 SOL to the test treasury
    python sendTestMoney2DevnetSolana.py --amount 2
    python sendTestMoney2DevnetSolana.py --address <base58 address>
    python sendTestMoney2DevnetSolana.py --rpc https://devnet.helius-rpc.com/?api-key=YOUR_KEY
    python sendTestMoney2DevnetSolana.py --balance            # only show the balance

Notes:
  - The public devnet faucet limits airdrops per IP address per day and usually refuses cloud servers.
    Run this from your own computer, or pass --rpc with a devnet RPC URL from a provider account
    (for example a free Helius or QuickNode key) if the public one refuses.
  - If every route is refused, use https://faucet.solana.com (network: Devnet) in a browser.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

TEST_TREASURY = "AqvcRLPKaBkjD8sJ6fwTsgAErTRK9NQtGBrFjSy1xzH3"   # PlanetCompute devnet test treasury
PUBLIC_DEVNET = "https://api.devnet.solana.com"
LAMPORTS = 1_000_000_000


def rpc(url, method, params):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "planetcompute-devnet-test"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"error": {"code": e.code, "message": str(e)}}


def balance(url, address):
    r = rpc(url, "getBalance", [address, {"commitment": "confirmed"}])
    return None if "error" in r else r["result"]["value"] / LAMPORTS


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--address", default=TEST_TREASURY, help="devnet address to fund (default: the test treasury)")
    ap.add_argument("--amount", type=float, default=1.0, help="SOL to request (devnet faucets give 1-2 per request)")
    ap.add_argument("--rpc", default=PUBLIC_DEVNET, help="devnet RPC URL (default: public devnet)")
    ap.add_argument("--balance", action="store_true", help="only print the balance")
    a = ap.parse_args()

    if "devnet" not in a.rpc:
        sys.exit("Refusing: this script is for devnet only, and the RPC URL does not look like a devnet endpoint.")
    before = balance(a.rpc, a.address)
    print(f"Address : {a.address}\nNetwork : devnet ({a.rpc.split('?')[0]})\nBalance : {before} SOL")
    if a.balance:
        return

    for attempt in range(1, 4):
        r = rpc(a.rpc, "requestAirdrop", [a.address, int(a.amount * LAMPORTS)])
        if "result" in r:
            sig = r["result"]
            print(f"Airdrop requested: {sig}\nWaiting for confirmation…")
            for _ in range(30):
                st = rpc(a.rpc, "getSignatureStatuses", [[sig]]).get("result", {}).get("value", [None])[0]
                if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
                    print(f"Done. Balance now {balance(a.rpc, a.address)} SOL")
                    print(f"Explorer: https://explorer.solana.com/tx/{sig}?cluster=devnet")
                    return
                time.sleep(1)
            print("Requested, but not confirmed yet; check the balance again in a minute with --balance.")
            return
        msg = r.get("error", {}).get("message", str(r))
        print(f"Attempt {attempt}: refused: {msg[:200]}")
        if "limit" in msg.lower() or "429" in msg or "dry" in msg.lower():
            break                                  # a rate limit: retrying immediately will not help
        time.sleep(3 * attempt)
    print("\nThe faucet refused this request. Options:\n"
          "  1. Run this script from your own computer (home connections are usually allowed).\n"
          "  2. Pass --rpc with a devnet URL from a provider account (e.g. Helius, QuickNode).\n"
          "  3. Use https://faucet.solana.com in a browser (network: Devnet).")
    sys.exit(1)


if __name__ == "__main__":
    main()
