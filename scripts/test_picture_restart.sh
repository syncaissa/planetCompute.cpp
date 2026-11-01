#!/bin/bash
# A picture being made when a newer copy of the program replaces the old one must come back in the queue (docs/TESTING.md
# test 99). Uses a stand-in picture engine, so it needs no models and no GPU and takes about 30 s a round.
#   1. the stand-in engine (a static program: the engine runs in the sandbox, which allows no shell):
#        printf '#include <stdio.h>\n#include <unistd.h>\nint main(void){puts("stand-in engine: working");fflush(stdout);sleep(900);return 0;}\n' > standin.c
#        gcc -static -O2 -o standin standin.c
#   2. build the program with it:  cd client && SD_CLI=$PWD/../standin cargo build --release --no-default-features --features llama
#   3. bash scripts/test_picture_restart.sh client/target/release/planetCompute 8
# The program's file must be called planetCompute (a new copy replaces only a process that really is planetCompute).
# Uses port 7526 and the folder /tmp/pc-restart-test as HOME. Placeholder model files (empty, right size) stand in for
# Z-Image Turbo; the model's remembered way is set to the CPU, the last way, as on a computer whose GPU fails: there a
# stopped engine counts as a failure, which is where the old code lost the picture (2026-11-01, macOS CI).
BIN=$1; N=${2:-5}; B=http://localhost:7526; ok=0
for r in $(seq $N); do
  export HOME=/tmp/pc-restart-test; pkill -f '/planetCompute --headless' >/dev/null 2>&1; pkill -x standin; pkill -f sd-cli- >/dev/null 2>&1; pkill -f 'sd-cli-' >/dev/null 2>&1; sleep 1
  rm -rf /tmp/pc-restart-test; M=$HOME/.local/share/planetCompute/models
  mkdir -p $M/zimage-turbo-q4k $M/flux1-ae $M/qwen3-4b-instruct-2507
  truncate -s 3864250304 $M/zimage-turbo-q4k/z_image_turbo-Q4_K.gguf; truncate -s 167656704 $M/flux1-ae/ae-f16.gguf; truncate -s 2497281120 $M/qwen3-4b-instruct-2507/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
  echo '{"zimage-turbo-q4k":{"mode":2,"way":"CPU","errors":[],"at":0,"version":"0.1.0"}}' > $HOME/.local/share/planetCompute/gpu_results.json   # as on the macOS runner: this model runs on the CPU (the last way)
  $BIN --headless > /tmp/pc-restart-a.log 2>&1 &
  for i in $(seq 30); do [ -f $HOME/.config/planetCompute/local_token ] && curl -sf -H "Authorization: Bearer $(cat $HOME/.config/planetCompute/local_token)" $B/local/info >/dev/null && break; sleep 0.5; done
  T="Authorization: Bearer $(cat $HOME/.config/planetCompute/local_token)"
  ID=$(curl -s -H "$T" -H content-type:application/json -X POST -d '{"model":"zimage-turbo-q4k","prompt":"a castle","width":512,"height":512,"steps":60}' $B/local/image | sed -E 's/.*"id":"([0-9a-f]+)".*/\1/')
  ID2=$(curl -s -H "$T" -H content-type:application/json -X POST -d '{"model":"zimage-turbo-q4k","prompt":"a boat","width":256,"height":256,"steps":4}' $B/local/image | sed -E 's/.*"id":"([0-9a-f]+)".*/\1/')
  for i in $(seq 40); do curl -sf -H "$T" $B/local/image/job/$ID | grep -qE '"state":"(loading|sampling|decoding)"' && break; sleep 0.25; done
  st1=$(curl -sf -H "$T" $B/local/image/job/$ID | sed -E 's/.*"state":"([a-z]+)".*/\1/')
  pid1=$(curl -sf -H "$T" $B/local/info | sed -E 's/.*"pid":([0-9]+).*/\1/')
  $BIN --headless > /tmp/pc-restart-b.log 2>&1 &
  for i in $(seq 40); do p=$(curl -sf -H "$T" $B/local/info | sed -E 's/.*"pid":([0-9]+).*/\1/'); [ -n "$p" ] && [ "$p" != "$pid1" ] && break; sleep 0.5; done
  q=$(curl -sf -H "$T" $B/local/image/queue)
  file=$(cat $HOME/.local/share/planetCompute/queue.json 2>/dev/null | head -c 300)
  a=no; b=no; echo "$q" | grep -q $ID && a=yes; echo "$q" | grep -q $ID2 && b=yes
  [ $a = yes ] && [ $b = yes ] && ok=$((ok+1))
  echo "round $r: castle was '$st1' -> after restart: castle back=$a, boat back=$b"
done
pkill -f '/planetCompute --headless' >/dev/null 2>&1; pkill -x standin; pkill -f sd-cli- >/dev/null 2>&1
echo "RESULT $BIN: $ok of $N rounds kept both pictures"
[ $ok = $N ] || exit 1
