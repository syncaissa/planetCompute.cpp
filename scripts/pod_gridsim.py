"""Run one gridSim simulation on a rented RunPod CPU pod (this Cloud9 machine has 7.6 GB: the 1 M run was killed by
the kernel at t~1800 s, 2026-10-22 02:28).
   python3 scripts/pod_gridsim.py pull-1M-dir25 --devices 1000000       (from planetCompute-CPP/, on Cloud9)
   python3 scripts/pod_gridsim.py cost-v2-1M --devices 1000000 --sim "--leaseSec 1800 --jobGroups 100"   (more options)
Steps: create ONE CPU pod (8 vCPU general = 32 GB first, else 4 vCPU memory-optimised) -> install Node 22 -> copy
gridSim/ (without results/) -> start sim/run.js with nohup -> every 2 min copy the log back to gridSim/results/ and
mirror it to B2 gridSim/<name>/ -> when the result JSON exists (or the process is gone) copy it back + to B2 ->
DELETE the pod (also on any error or Ctrl-C). Keys stay on Cloud9. The pod ID is in ../.ops/gridsim_pod.txt while it
exists."""
import argparse, os, subprocess, sys, time, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from pod_media_samples import rp, gql, log, SSH, KEY, ROOT  # noqa: E402
from publish_client import B2  # noqa: E402

GRID = os.path.join(ROOT, "gridSim")
RES = os.path.join(GRID, "results")
PODFILE = os.path.join(ROOT, "planetCompute-CPP", ".ops", "gridsim_pod.txt")
NODE = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz"


def create(pub):
    for vcpu, flavors in ((8, ["cpu3g", "cpu5g"]), (4, ["cpu3m", "cpu5m"]), (16, ["cpu3c", "cpu5c"])):
        try:
            return rp("POST", "/pods", {"name": "pc-gridsim", "computeType": "CPU", "vcpuCount": vcpu, "cpuFlavorIds": flavors,
                                        "imageName": "runpod/base:1.4.0-ubuntu2204",   # 0.7 GB: the 10 GB pytorch image gave no SSH within 8 min on CPU hosts
                                        "containerDiskInGb": 20, "ports": ["22/tcp"], "supportPublicIp": True,
                                        "env": {"PUBLIC_KEY": pub}})
        except urllib.error.HTTPError as e:
            log("no pod", vcpu, flavors, e.code, e.read()[:200])
    sys.exit("no CPU pod available")


def address(pid):
    for _ in range(90):
        d = gql('query { pod(input: {podId: "%s"}) { runtime { ports { ip isIpPublic privatePort publicPort } } } }' % pid)
        for p in ((((d.get("data") or {}).get("pod") or {}).get("runtime") or {}).get("ports") or []):
            if p["privatePort"] == 22 and p["isIpPublic"]:
                return p["ip"], p["publicPort"]
        time.sleep(10)
    raise RuntimeError("no SSH address")


class NoSSH(RuntimeError):
    pass


def main():
    for attempt in range(3):              # a pod may show an SSH port that never answers: delete it, take another
        try:
            return run()
        except NoSSH as e:
            log("attempt", attempt + 1, e, "- new pod")
    sys.exit("3 pods without SSH")


def run():
    a = argparse.ArgumentParser()
    a.add_argument("name")
    a.add_argument("--devices", default="1000000")
    a.add_argument("--sim", default="", help='more sim/run.js options in one string, e.g. "--leaseSec 1800 --jobGroups 100"')
    a = a.parse_args()
    if not all(c.isalnum() or c in " -._" for c in a.sim):
        sys.exit("--sim: letters, digits, spaces, dots, dashes only")
    b2 = B2()
    pod = create(open(KEY + ".pub").read().strip())
    pid = pod["id"]
    open(PODFILE, "w").write(pid + "\n")
    log("POD", pid, "cost/h", pod.get("costPerHr"))
    try:
        ip, port = address(pid)
        log("ssh", ip, port)
        ssh = ["ssh", "-p", str(port), *SSH, "root@" + ip]
        scp = ["scp", "-P", str(port), *SSH]
        for _ in range(30):
            if subprocess.run(ssh + ["true"], capture_output=True).returncode == 0:
                break
            time.sleep(10)
        else:
            raise NoSSH("SSH never answered")
        mem = subprocess.run(ssh + ["awk '/MemTotal/{print int($2/1024)}' /proc/meminfo; nproc"], capture_output=True, text=True, check=True).stdout.split()
        # container limit can be below MemTotal: use the cgroup limit when there is one
        lim = subprocess.run(ssh + ["cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes"], capture_output=True, text=True).stdout.strip()
        mb = int(mem[0])
        if lim.isdigit() and int(lim) < mb * 1048576:
            mb = int(lim) // 1048576
        heap = max(6000, mb - 3000)
        log("pod memory MB", mb, "cpus", mem[1], "heap MB", heap)
        tar = subprocess.run(["tar", "czf", "-", "--exclude=results", "-C", ROOT, "gridSim"], capture_output=True, check=True).stdout
        subprocess.run(ssh + ["mkdir -p /root/pc && tar xzf - -C /root/pc && mkdir -p /root/pc/gridSim/results"], input=tar, check=True)
        subprocess.run(ssh + [f"cd /root && curl -fsSL {NODE} | tar xzf - && ln -sf /root/node-v22.11.0-linux-x64/bin/node /usr/local/bin/node && node --version"], check=True)
        # the whole start line runs detached with its output closed, else ssh waits for the sim to end (happened 2026-10-22)
        subprocess.run(ssh + [f"cd /root/pc/gridSim && (nohup node --max-old-space-size={heap} sim/run.js --devices {a.devices} {a.sim} --name {a.name} "
                              f"> results/{a.name}.log 2>&1 < /dev/null & echo $! > /root/pc/sim.pid) > /dev/null 2>&1"], check=True)
        log("started", a.name)
        remote = f"root@{ip}:/root/pc/gridSim/results/"
        while True:
            time.sleep(120)
            subprocess.run(scp + [remote + a.name + ".log", RES], capture_output=True)
            try:
                b2.put(f"gridSim/{a.name}/{a.name}.log", open(os.path.join(RES, a.name + ".log"), "rb").read())
            except Exception as e:
                log("B2 log mirror failed", e)
            tail = open(os.path.join(RES, a.name + ".log")).read().strip().splitlines()[-1:] if os.path.exists(os.path.join(RES, a.name + ".log")) else []
            log("progress", tail)
            alive = subprocess.run(ssh + ["kill -0 $(cat /root/pc/sim.pid)"], capture_output=True).returncode == 0
            if not alive:
                break
        subprocess.run(scp + [remote + a.name + ".log", remote + a.name + ".json", RES], check=False)
        subprocess.run(ssh + ["dmesg 2>/dev/null | tail -20"], check=False)
        for f in (a.name + ".log", a.name + ".json"):
            p = os.path.join(RES, f)
            if os.path.exists(p):
                b2.put(f"gridSim/{a.name}/{f}", open(p, "rb").read())
                log("saved", p, "+ B2")
    finally:
        for _ in range(5):
            try:
                rp("DELETE", "/pods/" + pid); log("POD DELETED", pid); break
            except Exception as e:
                log("delete failed, again", e); time.sleep(10)
        if os.path.exists(PODFILE):
            os.remove(PODFILE)
    if not os.path.exists(os.path.join(RES, a.name + ".json")):
        sys.exit("no result JSON: see the log")
    log("done")


if __name__ == "__main__":
    main()
