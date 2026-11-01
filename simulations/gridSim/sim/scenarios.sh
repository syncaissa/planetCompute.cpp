#!/usr/bin/env bash
# The standard scenarios. One at a time: a 1M run needs about 6 GB of memory.
# Usage: bash sim/scenarios.sh [devices]   (default 100000; 1000000 for the full size)
set -e
cd "$(dirname "$0")/.."
N=${1:-100000}
run() { node --max-old-space-size=6200 sim/run.js --devices "$N" --consumers 10000 "$@" | sed -n '/^==/,$p'; echo; }

run --policy pull                                   --name "pull-$N"
run --policy push                                   --name "push-$N"
run --policy steal                                  --name "steal-$N"
run --deployAt 1800 --jitter 30                     --name "deploy-jitter-$N"
run --deployAt 1800 --jitter 0                      --name "deploy-storm-$N"
run --outageAt 1800 --outageFrac 0.3                --name "outage-$N"
run --outageAt 1800 --outageFrac 0.3 --outageSilent true --name "outage-silent-$N"
run --burstAt 1200 --burstN 2000 --burstLane 2      --name "burst-$N"
run --burstAt 1200 --burstN 2000 --burstLane 2 --admission false --name "burst-noadmit-$N"
run --networks 40                                   --name "runpod-40nets-$N"
run --sleepers true                                 --name "sleepers-$N"
run --split 0                                       --name "nosplit-$N"
run --rebalance false                               --name "norebalance-$N"
run --load 0.9                                      --name "load90-$N"
