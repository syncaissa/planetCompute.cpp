#!/usr/bin/env python3
"""Run one gridSim simulation on a short-lived AWS EC2 machine (when RunPod has no working pods).

  python3 scripts/aws_gridsim.py run <name> --devices 1000000 [--sim "<more sim/run.js options>"] [--type r7a.xlarge]
  python3 scripts/aws_gridsim.py cleanup     delete EVERYTHING this script made (state file + anything tagged)
  python3 scripts/aws_gridsim.py status      what exists now
(from planetCompute-CPP/, on Cloud9). Results: gridSim/results/<name>.json + .log, mirrored to B2 gridSim/<name>/.

Nothing may be left running:
  - every resource is written to ../.ops/aws_gridsim.json the moment it exists, and tagged Project=planetcompute-gridsim
  - the machine powers itself off after AUTO_OFF_MIN minutes whatever happens (user data "shutdown -h"), and powering
    off TERMINATES it (instance-initiated shutdown behaviour = terminate; its disk is deleted with it)
  - the run ends (results copied, or any error, or Ctrl-C) with cleanup(): terminate the instance, delete the security
    group and the imported key pair, then check that nothing tagged is left
  - after a Cloud9 crash: RESUME_HERE.md section 0 says to run "aws_gridsim.py cleanup" first
Access: SSH (user ubuntu) with the pod key ~/.ssh/planetcompute_pod (its public half imported for this run only),
port 22 open only to this machine's own public address. AWS keys from ../.env (never printed). AWS CLI + standard library.
"""
import argparse, json, os, secrets, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
GRID = os.path.join(ROOT, "gridSim")
RES = os.path.join(GRID, "results")
STATE = os.path.join(ROOT, "planetCompute-CPP", ".ops", "aws_gridsim.json")
KEY = os.path.expanduser("~/.ssh/planetcompute_pod")
TAG = {"Key": "Project", "Value": "planetcompute-gridsim"}
NODE = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz"
AUTO_OFF_MIN = 120
REGION = "us-east-1"
sys.path.insert(0, HERE)

env = {}
for l in open(os.path.join(ROOT, ".env")):
    l = l.strip()
    if "=" in l and not l.startswith("#"):
        k, v = l.split("=", 1); env[k.strip()] = v.strip().strip('"').strip("'")
AWSENV = {**os.environ, "AWS_ACCESS_KEY_ID": env["AWS_ACCESS_KEY_ID"], "AWS_SECRET_ACCESS_KEY": env["AWS_SECRET_ACCESS_KEY"],
          "AWS_DEFAULT_REGION": REGION, "AWS_PAGER": ""}
state = {}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def save():
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    json.dump(state, open(tmp, "w"), indent=1)
    os.replace(tmp, STATE)


def aws(*args, check=True):
    r = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True, env=AWSENV)
    if check and r.returncode:
        raise RuntimeError("aws " + " ".join(args[:3]) + ": " + r.stderr.strip()[:400])
    return json.loads(r.stdout) if r.stdout.strip() else {}


def tags(kind):
    return f"ResourceType={kind},Tags=[{{Key=Project,Value=planetcompute-gridsim}},{{Key=Name,Value=pc-gridsim-{state.get('name', '')}}}]"


def b2put(key, path):
    try:
        from publish_client import B2
        B2().put(key, open(path, "rb").read())
    except Exception as e:
        log("B2 mirror failed:", str(e)[:120])


# ---------------------------------------------------------------------------------------------------------------------
def cleanup():
    """Delete what the state file names, then anything still tagged Project=planetcompute-gridsim. Safe to run again."""
    global state
    try:
        state = json.load(open(STATE))
    except Exception:
        state = state or {}
    ids = set([state["instance"]] if state.get("instance") else [])
    for r in aws("ec2", "describe-instances", "--filters", "Name=tag:Project,Values=planetcompute-gridsim",
                 "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down")["Reservations"]:
        ids |= {i["InstanceId"] for i in r["Instances"]}
    if ids:
        aws("ec2", "terminate-instances", "--instance-ids", *ids, check=False)
        log("terminating", *ids)
        subprocess.run(["aws", "ec2", "wait", "instance-terminated", "--instance-ids", *ids], env=AWSENV)
        log("instances terminated")
    state["instance_terminated"] = True; save()
    sgs = set([state["sg"]] if state.get("sg") else [])
    sgs |= {g["GroupId"] for g in aws("ec2", "describe-security-groups", "--filters", "Name=tag:Project,Values=planetcompute-gridsim")["SecurityGroups"]}
    for g in sgs:
        for _ in range(12):                                  # a group can be deleted only once its instance is gone
            r = subprocess.run(["aws", "ec2", "delete-security-group", "--group-id", g], capture_output=True, text=True, env=AWSENV)
            if r.returncode == 0 or "InvalidGroup.NotFound" in r.stderr:
                log("security group deleted", g); break
            time.sleep(10)
        else:
            log("WARNING: could not delete security group", g)
    keys = set([state["key"]] if state.get("key") else [])
    keys |= {k["KeyName"] for k in aws("ec2", "describe-key-pairs", "--filters", "Name=tag:Project,Values=planetcompute-gridsim")["KeyPairs"]}
    for k in keys:
        aws("ec2", "delete-key-pair", "--key-name", k, check=False); log("key pair deleted", k)
    left = status(quiet=True)
    state.update({"deleted": not left, "deleted_at": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()), "left": left}); save()
    log("CLEAN: nothing of planetcompute-gridsim left on AWS" if not left else f"WARNING, still there: {left}")
    return not left


def status(quiet=False):
    left = []
    for r in aws("ec2", "describe-instances", "--filters", "Name=tag:Project,Values=planetcompute-gridsim",
                 "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down")["Reservations"]:
        left += [f"instance {i['InstanceId']} {i['State']['Name']} {i.get('PublicIpAddress', '')}" for i in r["Instances"]]
    left += [f"security group {g['GroupId']}" for g in aws("ec2", "describe-security-groups", "--filters", "Name=tag:Project,Values=planetcompute-gridsim")["SecurityGroups"]]
    left += [f"key pair {k['KeyName']}" for k in aws("ec2", "describe-key-pairs", "--filters", "Name=tag:Project,Values=planetcompute-gridsim")["KeyPairs"]]
    if not quiet:
        print("\n".join(left) if left else "nothing of planetcompute-gridsim on AWS")
    return left


# ---------------------------------------------------------------------------------------------------------------------
def run(a):
    global state
    if os.path.exists(STATE):
        old = json.load(open(STATE))
        if not old.get("deleted"):
            sys.exit(f"{STATE} names resources not yet deleted: run 'aws_gridsim.py cleanup' first")
    state = {"name": a.name, "region": REGION, "type": a.type, "made": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
             "note": "DELETE ALL OF THIS when the run is over (python3 scripts/aws_gridsim.py cleanup)"}
    save()
    myip = urllib.request.urlopen("https://checkip.amazonaws.com", timeout=20).read().decode().strip()
    rnd = secrets.token_hex(3)
    # key pair (the public half of the pod key, for this run only)
    state["key"] = f"pc-gridsim-{rnd}"; save()
    aws("ec2", "import-key-pair", "--key-name", state["key"], "--public-key-material", "fileb://" + KEY + ".pub",
        "--tag-specifications", tags("key-pair"))
    # security group: SSH from this machine only
    vpc = aws("ec2", "describe-vpcs", "--filters", "Name=isDefault,Values=true")["Vpcs"][0]["VpcId"]
    state["sg"] = aws("ec2", "create-security-group", "--group-name", f"pc-gridsim-{rnd}", "--description", "planetCompute gridSim run (SSH from Cloud9 only)",
                      "--vpc-id", vpc, "--tag-specifications", tags("security-group"))["GroupId"]; save()
    aws("ec2", "authorize-security-group-ingress", "--group-id", state["sg"], "--protocol", "tcp", "--port", "22", "--cidr", f"{myip}/32")
    log(f"key pair {state['key']}, security group {state['sg']} (SSH from {myip} only)")
    # the machine: powers itself off (= terminated) after AUTO_OFF_MIN minutes whatever happens
    ami = aws("ssm", "get-parameter", "--name", "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id")["Parameter"]["Value"]
    userdata = f"#!/bin/bash\nshutdown -h +{AUTO_OFF_MIN} 'planetCompute gridSim: auto power-off'\n"
    r = aws("ec2", "run-instances", "--image-id", ami, "--instance-type", a.type, "--key-name", state["key"],
            "--security-group-ids", state["sg"], "--instance-initiated-shutdown-behavior", "terminate", "--user-data", userdata,
            "--block-device-mappings", '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]',
            "--tag-specifications", tags("instance"), tags("volume"), "--count", "1")
    state["instance"] = r["Instances"][0]["InstanceId"]; save()
    log(f"instance {state['instance']} ({a.type}, Ubuntu 24.04), powers itself off and is terminated after {AUTO_OFF_MIN} min")
    subprocess.run(["aws", "ec2", "wait", "instance-running", "--instance-ids", state["instance"]], env=AWSENV, check=True)
    ip = aws("ec2", "describe-instances", "--instance-ids", state["instance"])["Reservations"][0]["Instances"][0]["PublicIpAddress"]
    state["ip"] = ip; save()
    ssh = ["ssh", "-i", KEY, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=15",
           "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", f"ubuntu@{ip}"]
    scp = ["scp", "-q", "-i", KEY, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]
    for _ in range(40):
        if subprocess.run(ssh + ["true"], capture_output=True).returncode == 0:
            break
        time.sleep(10)
    else:
        raise RuntimeError("SSH never answered")
    mem = int(subprocess.run(ssh + ["awk '/MemTotal/{print int($2/1024)}' /proc/meminfo"], capture_output=True, text=True, check=True).stdout.strip())
    heap = max(6000, mem - 3000)
    log(f"ssh ubuntu@{ip}: {mem} MB, heap {heap} MB")
    tar = subprocess.run(["tar", "czf", "-", "--exclude=results", "--exclude=backup-before-costv2", "-C", ROOT, "gridSim"], capture_output=True, check=True).stdout
    subprocess.run(ssh + ["mkdir -p ~/pc && tar xzf - -C ~/pc && mkdir -p ~/pc/gridSim/results"], input=tar, check=True)
    subprocess.run(ssh + [f"cd ~ && curl -fsSL {NODE} | tar xzf - && ~/node-v22.11.0-linux-x64/bin/node --version"], check=True)
    subprocess.run(ssh + [f"cd ~/pc/gridSim && (nohup ~/node-v22.11.0-linux-x64/bin/node --max-old-space-size={heap} sim/run.js --devices {a.devices} {a.sim} "
                          f"--name {a.name} > results/{a.name}.log 2>&1 < /dev/null & echo $! > ~/pc/sim.pid) > /dev/null 2>&1"], check=True)
    log("started", a.name)
    remote = f"ubuntu@{ip}:pc/gridSim/results/"
    while True:
        time.sleep(120)
        subprocess.run(scp + [remote + a.name + ".log", RES], capture_output=True)
        b2put(f"gridSim/{a.name}/{a.name}.log", os.path.join(RES, a.name + ".log"))
        if subprocess.run(scp + [remote + a.name + ".json", RES], capture_output=True).returncode == 0:
            b2put(f"gridSim/{a.name}/{a.name}.json", os.path.join(RES, a.name + ".json"))
            log(f"saved {RES}/{a.name}.json + B2")
            state["result"] = os.path.join(RES, a.name + ".json"); save()
            return
        alive = subprocess.run(ssh + ["kill -0 $(cat ~/pc/sim.pid) && echo yes"], capture_output=True, text=True).stdout.strip()
        tail = subprocess.run(["tail", "-1", os.path.join(RES, a.name + ".log")], capture_output=True, text=True).stdout.strip()
        log("progress", tail[:160])
        if alive != "yes":
            raise RuntimeError("the simulation stopped without a result (see the log)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("name"); r.add_argument("--devices", default="1000000")
    r.add_argument("--sim", default=""); r.add_argument("--type", default="r7a.xlarge")
    sub.add_parser("cleanup"); sub.add_parser("status")
    a = ap.parse_args()
    if a.cmd == "cleanup":
        sys.exit(0 if cleanup() else 1)
    if a.cmd == "status":
        status(); return
    if not all(c.isalnum() or c in " -._" for c in a.sim + a.name):
        sys.exit("name / --sim: letters, digits, spaces, dots, dashes only")
    try:
        run(a)
    finally:
        log("cleaning up (always)")
        cleanup()


if __name__ == "__main__":
    main()
