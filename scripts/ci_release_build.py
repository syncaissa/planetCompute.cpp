#!/usr/bin/env python3
"""Start the FULL client build (all five platforms) for a release: .github/workflows/client.yml workflow_dispatch with
only=all. A push builds only the three Linux builds (CI budget, user 2026-10-28: "build Windows and mac only on
publish"). Prints the new run's id; when it is green: python3 -I scripts/publish_client.py <run id> <version>.
    python3 -I scripts/ci_release_build.py [version]       (default 0.1.0; builds the head of main)
"""
import json, os, sys, time, urllib.request
sys.path.insert(0, __import__('os').path.dirname(__file__))
from publish_client import E, gh

REPO = 'syncaissa/planetCompute.cpp'
version = sys.argv[1] if len(sys.argv) > 1 else '0.1.0'
# the new run = a manual run of the head of main created after this moment (not just "a run not seen before":
# older manual runs are not among the newest ones)
import subprocess
head = subprocess.run(['git', 'rev-parse', 'origin/main'], capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(__file__))).stdout.strip()
since = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 5))
req = urllib.request.Request(f'https://api.github.com/repos/{REPO}/actions/workflows/client.yml/dispatches', method='POST',
                             data=json.dumps({'ref': 'main', 'inputs': {'version': version, 'only': 'all'}}).encode(),
                             headers={'Authorization': f"token {E['GITHUB_TOKEN']}", 'User-Agent': 'planetCompute', 'Accept': 'application/vnd.github+json'})
urllib.request.urlopen(req, timeout=60)
for _ in range(30):
    time.sleep(3)
    new = [r for r in gh(f'https://api.github.com/repos/{REPO}/actions/runs?per_page=10&event=workflow_dispatch')['workflow_runs']
           if r['created_at'] >= since and (not head or r['head_sha'] == head)]
    if new:
        r = new[0]
        print(f"full build started: run {r['id']} ({r['head_sha'][:7]}, version {version}) {r['html_url']}")
        sys.exit(0)
print('dispatched, but the new run did not show up within 90 s: check the Actions page')
