#!/bin/bash
# docs/TESTING.md test 71: jobs given as on the admin tab, led by the REAL SherpaHub (planetCompute --headless
# --sherpahub, no job of its own), through the site's REAL broker (wrangler dev), to JavaScript devices: 3 that take
# whole prompts for fake models (scripts/sherpa_js_devices.mjs --prompts), 2 browser-like pack devices; later a lying
# prompt device. Checks in scripts/sherpa_jobs_e2e.mjs.
#   bash scripts/test_sherpa_jobs_e2e.sh <planetCompute binary>    (from planetCompute-CPP; needs node + npx)
set -u
BIN=$(readlink -f "$1"); ROOT=$(cd "$(dirname "$0")/.." && pwd); T=$(mktemp -d); RC=0
export PLANETCOMPUTE_SITE=http://127.0.0.1:8799
for p in $(ps -eo pid,args | awk '/workerd serve|wrangler.* dev --port 8799/ && !/awk/ {print $1}'); do kill $p 2>/dev/null; done; sleep 1
cd "$ROOT/scripts/sherpa_dev" && cp "$ROOT/website/worker.js" worker.js && rm -rf .wrangler
setsid npx -y wrangler@3.99.0 dev --port 8799 --ip 127.0.0.1 > "$T/broker.log" 2>&1 < /dev/null & BROKER=$!
for i in $(seq 1 90); do curl -s $PLANETCOMPUTE_SITE/api/sherpa/status | grep -q hubs && break; sleep 2; done
cd "$ROOT"; mkdir -p $T/hub
hub() { HOME=$T/hub setsid "$BIN" --headless --port 7601 --sherpahub >> "$T/hub.log" 2>&1 < /dev/null & echo $!; }
HUB=$(hub)
for i in $(seq 1 30); do grep -q "connected to" $T/hub.log && break; sleep 1; done
grep -q "started as a SherpaHub (it leads the jobs given on the admin tab" $T/hub.log && echo "PASS 0. start-up line: started as a SherpaHub (jobs from the tab)" || { echo "FAIL 0. start-up line"; RC=1; }
node scripts/sherpa_js_devices.mjs ws://127.0.0.1:8799 3 --prompts --prefix 0c > "$T/prompt.log" 2>&1 & P=$!
node scripts/sherpa_js_devices.mjs ws://127.0.0.1:8799 2 --prefix 0a > "$T/packs.log" 2>&1 & K=$!
sleep 3
node scripts/sherpa_jobs_e2e.mjs $PLANETCOMPUTE_SITE main || RC=1
node scripts/sherpa_js_devices.mjs ws://127.0.0.1:8799 1 --prompts --lie --prefix 0d > "$T/liar.log" 2>&1 & L=$!
sleep 3
node scripts/sherpa_jobs_e2e.mjs $PLANETCOMPUTE_SITE liar || RC=1
kill $L
# the site drops every WebSocket (as a Worker deploy does): the broker is restarted with its state kept
J=$(node scripts/sherpa_jobs_e2e.mjs $PLANETCOMPUTE_SITE drop-begin | awk '/^JOB/ {print $2}')
kill -- -$BROKER 2>/dev/null; for p in $(ps -eo pid,args | awk '/workerd serve|wrangler.* dev --port 8799/ && !/awk/ {print $1}'); do kill $p 2>/dev/null; done; sleep 2
cd "$ROOT/scripts/sherpa_dev" && (setsid npx -y wrangler@3.99.0 dev --port 8799 --ip 127.0.0.1 >> "$T/broker.log" 2>&1 < /dev/null &) ; cd "$ROOT"
for i in $(seq 1 90); do curl -s $PLANETCOMPUTE_SITE/api/sherpa/status | grep -q hubs && break; sleep 2; done
BROKER=$(ps -eo pid,args | awk '/wrangler.* dev --port 8799/ && !/awk/ {print $1; exit}')
node scripts/sherpa_jobs_e2e.mjs $PLANETCOMPUTE_SITE drop-end "$J" || RC=1
J=$(node scripts/sherpa_jobs_e2e.mjs $PLANETCOMPUTE_SITE restart-begin | awk '/^JOB/ {print $2}')
kill -9 $HUB; sleep 2; HUB=$(hub)
node scripts/sherpa_jobs_e2e.mjs $PLANETCOMPUTE_SITE restart-end "$J" || RC=1
echo "--- hub log (last 12 lines)"; tail -12 $T/hub.log
kill $HUB $P $K 2>/dev/null
# the broker and everything it started (a runtime left behind stops the next test from starting its own)
kill -- -$BROKER 2>/dev/null
for p in $(ps -eo pid,args | awk '/workerd serve|wrangler.* dev --port 8799/ && !/awk/ {print $1}'); do kill $p 2>/dev/null; done
echo "logs: $T"; exit $RC
