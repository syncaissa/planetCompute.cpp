"""Harness pictures and video on WINDOWS with a GPU: the planetCompute .exe programs on an AWS g4dn.xlarge (NVIDIA T4
16 GB, Windows Server 2022, NVIDIA GRID driver from AWS's driver bucket). RunPod has no Windows machines.
   python3 -I scripts/aws_windows_gpu_test.py <client CI run id>        (from planetCompute-CPP/, on Cloud9)
Creates, and ALWAYS deletes at the end (also on errors): an S3 bucket pc-wintest-<random> (programs in, results out),
an IAM role + instance profile pc-wintest (SSM + read the NVIDIA driver bucket + that bucket), a security group with NO
inbound rules, and the instance (no key pair, no open port; commands go through AWS Systems Manager). The instance
also shuts itself down (and so is terminated) after 3 hours whatever happens. State: ../.ops/wintest/state.json.
On the instance: install the driver, reboot, then the Vulkan .exe makes pictures and a clip on the GPU and the CPU
.exe one small picture; results go to the bucket, then to B2 TEMP/ (https://planetcompute.ai/temp/)."""
import io, json, os, secrets, subprocess, sys, time, urllib.error, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OPS = os.path.join(ROOT, "planetCompute-CPP", ".ops", "wintest")
env = {}
for l in open(os.path.join(ROOT, ".env")):
    l = l.strip()
    if "=" in l and not l.startswith("#"):
        k, v = l.split("=", 1); env[k.strip()] = v.strip().strip('"').strip("'")
AWSENV = {**os.environ, "AWS_ACCESS_KEY_ID": env["AWS_ACCESS_KEY_ID"], "AWS_SECRET_ACCESS_KEY": env["AWS_SECRET_ACCESS_KEY"],
          "AWS_DEFAULT_REGION": "us-east-1", "AWS_PAGER": ""}
UA = {"User-Agent": "planetcompute-ops/1"}
DRIVER = "latest/596.86__grid_win10_win11_server2022_server2025_dch_64bit_international_aws_swl.exe"
state = {}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def save():
    json.dump(state, open(os.path.join(OPS, "state.json"), "w"), indent=1)


def aws(*args, check=True):
    r = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True, env=AWSENV)
    if check and r.returncode:
        raise RuntimeError("aws " + " ".join(args[:3]) + ": " + r.stderr.strip()[:400])
    return json.loads(r.stdout) if r.stdout.strip() else {}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def artifact(run, name):
    p = os.path.join(OPS, name + ".exe")
    if os.path.exists(p):
        return p
    h = {"Authorization": "Bearer " + env["GITHUB_TOKEN"], "Accept": "application/vnd.github+json", **UA}
    arts = json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.github.com/repos/syncaissa/planetCompute.cpp/actions/runs/{run}/artifacts", headers=h)))
    a = [x for x in arts["artifacts"] if x["name"] == name][0]
    try:
        urllib.request.build_opener(_NoRedirect).open(urllib.request.Request(f"https://api.github.com/repos/syncaissa/planetCompute.cpp/actions/artifacts/{a['id']}/zip", headers=h))
        raise RuntimeError("expected a redirect")
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307):
            raise
        z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(urllib.request.Request(e.headers["Location"], headers=UA), timeout=600).read()))
    n = [x for x in z.namelist() if x.endswith(".exe")][0]
    open(p, "wb").write(z.read(n))
    log("program", n, os.path.getsize(p))
    return p


# PowerShell on the instance. Stage 1: driver. Stage 2: the tests.
STAGE1 = r'''
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force C:\pc | Out-Null
Read-S3Object -BucketName ec2-windows-nvidia-drivers -Key "__DRIVER__" -File C:\pc\driver.exe -Region us-east-1 | Out-Null
"driver downloaded: " + (Get-Item C:\pc\driver.exe).Length
$p = Start-Process -FilePath C:\pc\driver.exe -ArgumentList "-s","-noreboot","-clean" -Wait -PassThru
"driver setup exit code: " + $p.ExitCode
shutdown /r /t 15
'''

STAGE2 = r'''
$ErrorActionPreference = "Continue"
$B = "__BUCKET__"
cd C:\pc
New-Item -ItemType Directory -Force C:\pc\out | Out-Null
$smi = "C:\Windows\System32\nvidia-smi.exe"
if (-not (Test-Path $smi)) { $smi = (Get-ChildItem -Recurse "C:\Program Files\NVIDIA Corporation" -Filter nvidia-smi.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
"nvidia-smi: " + $smi
& $smi --query-gpu=name,memory.total,driver_version,driver_model.current --format=csv,noheader
Read-S3Object -BucketName $B -Key in/planetCompute-vulkan.exe -File C:\pc\planetCompute-vulkan.exe -Region us-east-1 | Out-Null
Read-S3Object -BucketName $B -Key in/planetCompute.exe -File C:\pc\planetCompute.exe -Region us-east-1 | Out-Null
$U = "http://localhost:7526"
function Start-App($exe) {
  Start-Process -FilePath $exe -ArgumentList "--headless" -RedirectStandardOutput ("C:\pc\out\" + [IO.Path]::GetFileNameWithoutExtension($exe) + ".log") -RedirectStandardError ("C:\pc\out\" + [IO.Path]::GetFileNameWithoutExtension($exe) + ".err.log") -WindowStyle Hidden
  for ($i = 0; $i -lt 60; $i++) { try { Invoke-RestMethod "$U/local/info" | Out-Null; return } catch { Start-Sleep 1 } }
}
function Post($path, $body) { try { Invoke-RestMethod -Method Post -Uri "$U$path" -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress) } catch { @{ error = $_.ErrorDetails.Message } } }
$results = @()
function Run-Job($name, $model, $req) {
  $q = $req.Clone(); $q.model = $model
  $st = Post "/local/image" $q
  if (-not $st.id) { $script:results += @{ name = $name; error = ("" + $st.error) }; return }
  $peak = 0; $mem = 0
  while ($true) {
    Start-Sleep 1
    $j = Invoke-RestMethod "$U/local/image/job/$($st.id)"
    try { $g = (& $smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits).Split(","); $peak = [Math]::Max($peak, [int]$g[0]); $mem = [Math]::Max($mem, [int]$g[1]) } catch {}
    if ($j.state -in @("done", "error", "cancelled")) { break }
    if ($j.seconds -gt 1800) { Post "/local/image/cancel" @{ id = $st.id } | Out-Null; Start-Sleep 5; $j = Invoke-RestMethod "$U/local/image/job/$($st.id)"; break }
  }
  if ($j.state -eq "done") { Invoke-WebRequest "$U/local/image/file/$($st.id)" -OutFile ("C:\pc\out\" + $name) -UseBasicParsing }
  $script:results += @{ name = $name; model = $model; state = $j.state; seconds = $j.seconds; ran_on = $j.ran_on; retried = $j.retried; error = $j.error; gpu_peak_util = $peak; gpu_peak_mem_mb = $mem; req = $req }
  $script:results | ConvertTo-Json -Depth 5 | Set-Content C:\pc\out\results.json
  "job " + $name + ": " + $j.state + " " + $j.seconds + " s on " + $j.ran_on + " " + $j.error
}
# 1. the Vulkan program on the GPU
Start-App "C:\pc\planetCompute-vulkan.exe"
Invoke-RestMethod "$U/local/image/info" | ConvertTo-Json -Compress
foreach ($m in @("sd15-q8", "flux1-schnell-q4", "wan21-t2v-1.3b-q8")) { Post "/local/models/download" @{ id = $m } | Out-Null }
$t0 = Get-Date
$need = @("sd15-q8", "flux1-ae", "flux1-clip-l-q8", "flux1-t5xxl-q4k", "flux1-schnell-q4", "wan21-t2v-1.3b-q8", "wan21-vae", "umt5-xxl-q4km")
while (((Get-Date) - $t0).TotalSeconds -lt 3600) {
  $d = (Invoke-RestMethod "$U/local/models").downloaded
  $ok = @($d | Where-Object { $need -contains $_.id -and $_.state -eq "ready" -and $_.verified }).Count
  $bad = @($d | Where-Object { $need -contains $_.id -and $_.state -eq "error" })
  if ($ok -eq $need.Count -or $bad.Count) { break }
  Start-Sleep 15
}
"downloads: $ok of $($need.Count) ready, verified, in " + [int]((Get-Date) - $t0).TotalSeconds + " s " + ($bad | ConvertTo-Json -Compress)
Run-Job "win-gpu-sd15-lighthouse.png" "sd15-q8" @{ prompt = "a lighthouse on a rocky coast at sunset, dramatic sky, oil painting"; negative = "blurry, low quality, deformed, text, watermark"; width = 512; height = 512; steps = 20; seed = 1001 }
Run-Job "win-gpu-sd15-apple.png" "sd15-q8" @{ prompt = "a red apple on a wooden table, soft window light, photograph"; negative = "blurry, low quality, deformed, text, watermark"; width = 512; height = 512; steps = 20; seed = 1002 }
Run-Job "win-gpu-flux-cat.png" "flux1-schnell-q4" @{ prompt = "a fluffy orange cat sleeping on a sunny windowsill, cozy, photograph"; width = 1024; height = 1024; steps = 4; seed = 13 }
Run-Job "win-gpu-flux-sign.png" "flux1-schnell-q4" @{ prompt = "a wooden sign in a green forest that says PlanetCompute, morning light, photograph"; width = 1024; height = 768; steps = 4; seed = 14 }
Run-Job "win-gpu-wan-boat.webm" "wan21-t2v-1.3b-q8" @{ prompt = "a small sailing boat on a calm lake at sunrise, mountains in the background, gentle waves"; width = 832; height = 480; frames = 33; steps = 20; seed = 7 }
# 2. the CPU program (the newest start replaces the running copy; the models stay)
Start-App "C:\pc\planetCompute.exe"
Invoke-RestMethod "$U/local/info" | ConvertTo-Json -Compress
Run-Job "win-cpu-sd15-apple-256.png" "sd15-q8" @{ prompt = "a red apple on a wooden table, soft window light, photograph"; width = 256; height = 256; steps = 4; seed = 42 }
try { Invoke-RestMethod -Method Post -Uri "$U/local/quit" -Headers @{ "x-planetcompute" = "quit" } | Out-Null } catch {}
Get-ChildItem C:\pc\out | ForEach-Object { Write-S3Object -BucketName $B -Key ("out/" + $_.Name) -File $_.FullName -Region us-east-1 }
"uploaded: " + ((Get-ChildItem C:\pc\out).Name -join ", ")
'''


def ssm(iid, script, timeout, label):
    cid = aws("ssm", "send-command", "--instance-ids", iid, "--document-name", "AWS-RunPowerShellScript", "--comment", label,
              "--parameters", json.dumps({"commands": script.strip().split("\n"), "executionTimeout": [str(timeout)]}))["Command"]["CommandId"]
    log("ssm", label, cid)
    while True:
        time.sleep(20)
        r = aws("ssm", "get-command-invocation", "--command-id", cid, "--instance-id", iid, check=False)
        if r.get("Status") in ("Success", "Failed", "Cancelled", "TimedOut"):
            print(r.get("StandardOutputContent", ""), r.get("StandardErrorContent", "")[-2000:], flush=True)
            return r["Status"]


def online(iid, minutes=25):
    for _ in range(minutes * 3):
        r = aws("ssm", "describe-instance-information", "--filters", f"Key=InstanceIds,Values={iid}", check=False)
        if r.get("InstanceInformationList") and r["InstanceInformationList"][0]["PingStatus"] == "Online":
            return True
        time.sleep(20)
    return False


def cleanup():
    log("cleaning up", json.dumps(state))
    if state.get("instance"):
        aws("ec2", "terminate-instances", "--instance-ids", state["instance"], check=False)
        subprocess.run(["aws", "ec2", "wait", "instance-terminated", "--instance-ids", state["instance"]], env=AWSENV)
        log("instance terminated", state["instance"]); state["instance_terminated"] = True; save()
    if state.get("sg"):
        for _ in range(10):
            if subprocess.run(["aws", "ec2", "delete-security-group", "--group-id", state["sg"]], env=AWSENV, capture_output=True).returncode == 0:
                log("security group deleted"); break
            time.sleep(15)
    if state.get("role"):
        aws("iam", "remove-role-from-instance-profile", "--instance-profile-name", "pc-wintest", "--role-name", "pc-wintest", check=False)
        aws("iam", "delete-instance-profile", "--instance-profile-name", "pc-wintest", check=False)
        aws("iam", "detach-role-policy", "--role-name", "pc-wintest", "--policy-arn", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore", check=False)
        aws("iam", "delete-role-policy", "--role-name", "pc-wintest", "--policy-name", "pc-wintest-s3", check=False)
        aws("iam", "delete-role", "--role-name", "pc-wintest", check=False)
        log("role and instance profile deleted")
    if state.get("bucket"):
        subprocess.run(["aws", "s3", "rb", "s3://" + state["bucket"], "--force"], env=AWSENV, capture_output=True)
        log("bucket deleted", state["bucket"])
    state["cleaned"] = True; save()


def main():
    run = sys.argv[1]
    os.makedirs(os.path.join(OPS, "out"), exist_ok=True)
    vk, cpu = artifact(run, "windows-x86_64-vulkan"), artifact(run, "windows-x86_64")
    try:
        state["bucket"] = "pc-wintest-" + secrets.token_hex(4); save()
        aws("s3api", "create-bucket", "--bucket", state["bucket"])
        aws("s3api", "put-public-access-block", "--bucket", state["bucket"], "--public-access-block-configuration",
            "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true")
        subprocess.run(["aws", "s3", "cp", vk, f"s3://{state['bucket']}/in/planetCompute-vulkan.exe", "--only-show-errors"], env=AWSENV, check=True)
        subprocess.run(["aws", "s3", "cp", cpu, f"s3://{state['bucket']}/in/planetCompute.exe", "--only-show-errors"], env=AWSENV, check=True)
        log("programs in", state["bucket"])
        state["role"] = "pc-wintest"; save()
        aws("iam", "create-role", "--role-name", "pc-wintest", "--assume-role-policy-document",
            json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]}))
        aws("iam", "attach-role-policy", "--role-name", "pc-wintest", "--policy-arn", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore")
        aws("iam", "put-role-policy", "--role-name", "pc-wintest", "--policy-name", "pc-wintest-s3", "--policy-document", json.dumps({"Version": "2012-10-17", "Statement": [
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:ListBucket"], "Resource": ["arn:aws:s3:::ec2-windows-nvidia-drivers", "arn:aws:s3:::ec2-windows-nvidia-drivers/*"]},
            {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": [f"arn:aws:s3:::{state['bucket']}/in/*"]},
            {"Effect": "Allow", "Action": ["s3:PutObject"], "Resource": [f"arn:aws:s3:::{state['bucket']}/out/*"]}]}))
        aws("iam", "create-instance-profile", "--instance-profile-name", "pc-wintest")
        aws("iam", "add-role-to-instance-profile", "--instance-profile-name", "pc-wintest", "--role-name", "pc-wintest")
        vpc = aws("ec2", "describe-vpcs", "--filters", "Name=isDefault,Values=true")["Vpcs"][0]["VpcId"]
        state["sg"] = aws("ec2", "create-security-group", "--group-name", "pc-wintest-" + secrets.token_hex(3), "--description", "planetCompute Windows GPU test: no inbound", "--vpc-id", vpc)["GroupId"]; save()
        ami = aws("ssm", "get-parameter", "--name", "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base")["Parameter"]["Value"]
        time.sleep(15)   # the new instance profile takes a moment to be usable
        userdata = "<powershell>\nshutdown /s /t 10800 /c \"planetCompute test: 3 h limit\"\n</powershell>\n<persist>false</persist>"
        for attempt in range(6):
            try:
                inst = aws("ec2", "run-instances", "--image-id", ami, "--instance-type", "g4dn.xlarge", "--count", "1",
                           "--iam-instance-profile", "Name=pc-wintest", "--security-group-ids", state["sg"],
                           "--instance-initiated-shutdown-behavior", "terminate", "--user-data", userdata,
                           "--block-device-mappings", json.dumps([{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": 120, "VolumeType": "gp3", "DeleteOnTermination": True}}]),
                           "--tag-specifications", "ResourceType=instance,Tags=[{Key=Name,Value=pc-wintest}]")
                break
            except RuntimeError as e:
                if "instance profile" in str(e).lower() and attempt < 5:
                    time.sleep(15); continue
                raise
        state["instance"] = inst["Instances"][0]["InstanceId"]; state["started"] = time.strftime("%H:%M:%S"); save()
        log("INSTANCE", state["instance"], "g4dn.xlarge", ami)
        if not online(state["instance"]):
            raise RuntimeError("the instance never reached Systems Manager")
        log("online")
        ssm(state["instance"], STAGE1.replace("__DRIVER__", DRIVER), 1800, "pc driver")
        time.sleep(90)
        if not online(state["instance"]):
            raise RuntimeError("not back after the driver reboot")
        log("back after reboot")
        ssm(state["instance"], STAGE2.replace("__BUCKET__", state["bucket"]), 7200, "pc tests")
        subprocess.run(["aws", "s3", "cp", f"s3://{state['bucket']}/out/", os.path.join(OPS, "out"), "--recursive", "--only-show-errors"], env=AWSENV)
        log("results copied to", os.path.join(OPS, "out"))
    finally:
        cleanup()


if __name__ == "__main__":
    main()
