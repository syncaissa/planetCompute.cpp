#!/bin/bash
# docs/TESTING.md test 68: the REAL SherpaHub (planetCompute --headless --sherpahub) and REAL devices (planetCompute
# --headless --contribute, and the browser's JavaScript device code) through the site's REAL broker (wrangler dev).
# Checks: the job ends DONE (every unit Freivalds-checked + the final whole-product check); a lying device is struck
# and banned (closed 4008); the hub killed mid-job (kill -9) continues from its checkpoint in a new epoch and ends DONE.
#   bash scripts/test_sherpa_e2e.sh <planetCompute binary>     (from planetCompute-CPP; needs node + npx)
set -u
BIN=$(readlink -f "$1"); ROOT=$(cd "$(dirname "$0")/.." && pwd); T=$(mktemp -d); PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS $2"; else FAIL=$((FAIL+1)); echo "FAIL $2"; fi; }
export PLANETCOMPUTE_SITE=http://127.0.0.1:8799
for p in $(ps -eo pid,args | awk '/workerd serve|wrangler.* dev --port 8799/ && !/awk/ {print $1}'); do kill $p 2>/dev/null; done; sleep 1
cd "$ROOT/scripts/sherpa_dev" && cp "$ROOT/website/worker.js" worker.js && rm -rf .wrangler
setsid npx -y wrangler@3.99.0 dev --port 8799 --ip 127.0.0.1 > "$T/broker.log" 2>&1 < /dev/null & BROKER=$!
for i in $(seq 1 90); do curl -s $PLANETCOMPUTE_SITE/api/sherpa/status | grep -q hubs && break; sleep 2; done
cd "$ROOT"
hub() { HOME=$T/hub setsid "$BIN" --headless --port 7601 --sherpahub --sherpa-job "$1" --sherpa-tile 64 >> "$T/hub.log" 2>&1 < /dev/null & echo $!; }
mkdir -p $T/hub $T/d1 $T/d2 $T/d3
# 1. a job of 4096x4096x4096 (4096 units, 137 GOP) with 3 JS devices, 2 liars and 3 program devices (2 cores each)
HUB=$(hub 4096x4096x4096)
for i in $(seq 1 30); do grep -q "connected to" $T/hub.log && break; sleep 1; done
sleep 12   # the hub's first status report puts it on the directory
node scripts/sherpa_js_devices.mjs ws://127.0.0.1:8799 3 > "$T/js.log" 2>&1 & JS=$!
node scripts/sherpa_js_devices.mjs ws://127.0.0.1:8799 2 --lie > "$T/liar.log" 2>&1 & LIAR=$!
sleep 5
for d in 1 2 3; do HOME=$T/d$d setsid "$BIN" --headless --port 761$d --contribute --cores 2 --cap 100 > "$T/d$d.log" 2>&1 < /dev/null & eval D$d=\$!; done
T1=$(date +%s); for i in $(seq 1 600); do grep -q "DONE: every unit" $T/hub.log && break; sleep 1; done; T1=$(( $(date +%s) - T1 ))
grep -q "DONE: every unit checked, and the whole product passed the final check" $T/hub.log; ok $? "1. job 1 DONE through the broker (about $T1 s after the devices started): $(grep 'DONE: every unit' $T/hub.log | head -1 | cut -c1-150)"
grep -q "SherpaHub packs: connected" $T/d1.log; ok $? "1. program devices connected and computed"
sleep 2; tail -1 $T/js.log | grep -q '"units":[1-9]'; ok $? "1. JS (browser-code) devices computed units: $(tail -1 $T/js.log | cut -c1-80)"
tail -1 $T/liar.log | grep -q '"banned":2'; ok $? "1. both liars banned (closed 4008): $(tail -1 $T/liar.log | cut -c1-90)"
grep -q "banned for this job" $T/hub.log; ok $? "1. hub logged the bans"
kill $LIAR 2>/dev/null
# 2. a new job; the hub is killed (kill -9) once some units are done, and restarted: it continues from the
# checkpoint in a new epoch (units done before the kill are not done again) and ends DONE
kill -9 $HUB; sleep 1
HUB=$(hub 8192x4096x8192)
for i in $(seq 1 40); do grep -q "new job .*8192x4096x8192" $T/hub.log && break; sleep 0.5; done
J2=$(grep "new job .*8192x4096x8192" $T/hub.log | tail -1 | awk '{print $4}' | tr -d :)
for i in $(seq 1 600); do N=$(grep -o "job $J2: [0-9]* of 16384 units" $T/hub.log | tail -1 | awk '{print $3}'); [ -n "$N" ] && [ "$N" -ge 500 ] && break; sleep 0.5; done
echo "   job $J2 killed at about $N of 16384 units"
kill -9 $HUB; sleep 3
HUB=$(hub 8192x4096x8192)
for i in $(seq 1 30); do grep -q "continuing job $J2" $T/hub.log && break; sleep 1; done
grep -q "continuing job $J2 .* epoch 2" $T/hub.log; ok $? "2. restarted hub continues the same job: $(grep "continuing job $J2" $T/hub.log | tail -1)"
D0=$(grep "continuing job $J2" $T/hub.log | tail -1 | grep -o "([0-9]* of" | tr -dc 0-9)
[ -n "$D0" ] && [ "$D0" -gt 0 ] && [ "$D0" -lt 16384 ]; ok $? "2. it kept the units done before the kill ($D0 of 16384)"
for i in $(seq 1 900); do grep -q "job $J2 DONE: every unit" $T/hub.log && break; sleep 1; done
grep -q "job $J2 DONE: every unit checked, and the whole product passed the final check" $T/hub.log; ok $? "2. job $J2 DONE after the restart: $(grep "job $J2 DONE" $T/hub.log | tail -1 | cut -c1-150)"
echo "--- hub log (last 8 lines)"; tail -8 $T/hub.log
kill $HUB $D1 $D2 $D3 $JS 2>/dev/null
# the broker and everything it started (a runtime left behind stops the next test from starting its own)
kill -- -$BROKER 2>/dev/null
for p in $(ps -eo pid,args | awk '/workerd serve|wrangler.* dev --port 8799/ && !/awk/ {print $1}'); do kill $p 2>/dev/null; done
echo "logs: $T"; echo; echo "$PASS passed, $FAIL failed"; [ $FAIL = 0 ]
