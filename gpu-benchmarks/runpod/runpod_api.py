#!/usr/bin/env python3
"""Minimal RunPod helper for the benchmarks. Reads your key from the RUNPOD_API_KEY environment variable.

  python runpod_api.py gpus                                   list GPU types, prices and stock
  python runpod_api.py create "NVIDIA GeForce RTX 4090" bench-4090 ~/.ssh/id_ed25519.pub
  python runpod_api.py ssh <pod_id>                           print the pod's public SSH host and port
  python runpod_api.py terminate <pod_id>                     stop billing and delete the pod
  python runpod_api.py status                                 balance, spend per hour and your pods
"""
import json
import os
import sys
import urllib.request

IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"


def gql(query, variables=None):
    key = os.environ.get("RUNPOD_API_KEY") or sys.exit("set RUNPOD_API_KEY first")
    req = urllib.request.Request("https://api.runpod.io/graphql",
                                 data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + key,
                                          "User-Agent": "planetcompute-bench"})
    out = json.loads(urllib.request.urlopen(req).read())
    if out.get("errors"):
        sys.exit(json.dumps(out["errors"], indent=1))
    return out["data"]


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "gpus":
        for g in gql("query { gpuTypes { id memoryInGb lowestPrice(input:{gpuCount:1}) { uninterruptablePrice stockStatus } } }")["gpuTypes"]:
            lp = g["lowestPrice"] or {}
            if lp.get("uninterruptablePrice"):
                print(f"{g['id']:36s} {g['memoryInGb']:>3} GB  ${lp['uninterruptablePrice']}/h  {lp.get('stockStatus')}")
    elif cmd == "create":
        gpu, name, pubfile = sys.argv[2], sys.argv[3], os.path.expanduser(sys.argv[4])
        inp = {"cloudType": "ALL", "gpuCount": 1, "volumeInGb": 0, "containerDiskInGb": 150, "minVcpuCount": 8,
               "minMemoryInGb": 30, "gpuTypeId": gpu, "name": name, "supportPublicIp": True, "imageName": IMAGE,
               "ports": "22/tcp", "volumeMountPath": "/workspace",
               "env": [{"key": "PUBLIC_KEY", "value": open(pubfile).read().strip()}]}
        q = "mutation($input: PodFindAndDeployOnDemandInput) { podFindAndDeployOnDemand(input: $input) { id costPerHr machine { gpuDisplayName } } }"
        print(json.dumps(gql(q, {"input": inp})["podFindAndDeployOnDemand"]))
    elif cmd == "ssh":
        pod = gql('query { pod(input:{podId:"%s"}) { runtime { ports { ip isIpPublic privatePort publicPort } } } }' % sys.argv[2])["pod"]
        ports = [p for p in ((pod.get("runtime") or {}).get("ports") or []) if p["privatePort"] == 22 and p["isIpPublic"]]
        print(f"ssh -p {ports[0]['publicPort']} root@{ports[0]['ip']}" if ports else "not ready yet, retry in 10 s")
    elif cmd == "terminate":
        gql('mutation { podTerminate(input: {podId: "%s"}) }' % sys.argv[2]); print("terminated", sys.argv[2])
    else:
        m = gql("query { myself { clientBalance currentSpendPerHr pods { id name desiredStatus } } }")["myself"]
        print(json.dumps(m, indent=1))


if __name__ == "__main__":
    main()
