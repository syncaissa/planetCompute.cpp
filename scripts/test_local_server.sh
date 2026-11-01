#!/usr/bin/env bash
# Checks of planetCompute's local web server, the takeover rule and the native contributor, on any computer with
# the program (the same checks CI runs on Windows, macOS and Linux). No sign-in needed.
#   bash scripts/test_local_server.sh ./planetCompute        (Windows, Git Bash: ./planetCompute.exe)
#   WITH_MODEL=1 bash scripts/test_local_server.sh ...       also Harness: downloads the smallest model (0.4 GB,
#                                                            SHA-256 checked) and runs chat completions on it
#   WITH_IMAGE=1 ...                                         also images: downloads Z-Image Turbo with its parts (6.5 GB) and
#                                                            makes real pictures with the built-in image engine
#   WITH_VIDEO=1 ...                                         also video: downloads Wan 2.1 1.3B with its parts (5.4 GB)
#                                                            and makes a tiny real clip (WebM)
# Uses port 7526: close any planetCompute you are running first (this script starts and replaces copies).
set -u
BIN=${1:-./planetCompute}; B=http://localhost:7526; fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
pid_of() { curl -sf $B/local/info | sed -E 's/.*"pid":([0-9]+).*/\1/'; }
# a downloaded model's state ("ready verified", "downloading", "none" ...), whatever the order of the JSON keys
PY=$(command -v python3 || command -v python)
mstate() { curl -sf $B/local/models | "$PY" -c "import json,sys; d=json.load(sys.stdin); print(next((m['state'] + (' verified' if m.get('verified') else '') for m in d['downloaded'] if m['id'] == sys.argv[1]), 'none'))" "$1"; }

"$BIN" --version || { echo "cannot run $BIN"; exit 1; }
# the engines in the operating system's sandbox: each kind is started sandboxed and tries to read, write, connect and
# start a program (sandbox.rs; TESTING.md test 61)
"$BIN" --sandbox-check > sandbox.log 2>&1; sandbox_rc=$?; cat sandbox.log
check "the engines run in the operating system's sandbox (--sandbox-check)" "[ $sandbox_rc = 0 ] && grep -q 'ALL PASS' sandbox.log"
"$BIN" --headless > headless.log 2>&1 &
# the program's secret (security review E1): printed in the sign-in link; every call below sends it as the program's key
for i in $(seq 30); do TOK=$(sed -nE 's/.*\/local\/\?t=([0-9a-f]+).*/\1/p' headless.log | head -1); [ -n "$TOK" ] && break; sleep 1; done
curl() { command curl -H "Authorization: Bearer ${TOK:-none}" "$@"; }
for i in $(seq 30); do curl -sf $B/local/info > /dev/null && break; sleep 1; done
cat headless.log
S=http://localhost:$(curl -sf $B/local/info | sed -E 's/.*"site_port":([0-9]+).*/\1/')

check "device page served"                        "curl -sf $B/local/ | grep -q 'id=\"signin\"'"
check "--headless: / goes to the device page"     "[ \"\$(code $B/)\" = 307 ]"
check "without the program's key: refused"         "[ \"\$(command curl -s -o /dev/null -w '%{http_code}' $B/local/info)\" = 401 ] && [ \"\$(command curl -s -o /dev/null -w '%{http_code}' $B/v1/models)\" = 401 ] && [ \"\$(command curl -s -o /dev/null -w '%{http_code}' $S/contribute)\" = 401 ]"
check "a wrong key is refused"                    "[ \"\$(command curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer 00' $B/local/info)\" = 401 ]"
check "the printed link sets the program's cookie" "command curl -s -D - -o /dev/null $B/local/?t=$TOK | grep -qi 'set-cookie: pc_local=$TOK'"
check "site pages are on their own port, not the program's" "[ \"\$(code $B/contribute)\" = 404 ] && [ \"$S\" != \"$B\" ]"
check "site console passed through (on its own it opens inside the program's page)" "for i in 1 2 3; do curl -sf $S/contribute | grep -q '/local/#site=' && break; sleep 3; done"
check "site API passed through (credit rule)"     "curl -sf $B/api/credit-rate | grep -q current"
check "not signed in yet"                         "curl -s $B/api/me | grep -q 'Not signed in'"
check "tunnel off until sign-in"                  "curl -sf $B/local/info | grep -q '\"tunnel\":\"off: sign in'"
check "wrong Host refused (DNS rebinding)"        "[ \"\$(code -H 'Host: evil.example:7526' http://127.0.0.1:7526/local/)\" = 403 ]"
check "cross-site POST refused"                   "[ \"\$(code -X POST -H 'Origin: https://evil.example' -H 'content-type: application/json' -d '{}' $B/api/auth/signout)\" = 403 ]"
check "cross-site WebSocket refused"              "[ \"\$(code --http1.1 -H 'Origin: https://evil.example' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' '$B/api/police/ws?device=0123456789ab')\" = 403 ]"
check "quit needs the program's header"           "[ \"\$(code -X POST $B/local/quit)\" = 403 ]"

pid1=$(pid_of)
"$BIN" --headless > headless2.log 2>&1 &
for i in $(seq 30); do pid2=$(pid_of); [ -n "$pid2" ] && [ "$pid2" != "$pid1" ] && break; sleep 1; done
check "a second start replaces the first ($pid1 -> ${pid2:-none})" "[ -n \"${pid2:-}\" ] && [ \"$pid2\" != \"$pid1\" ] && grep -q 'Replaced the planetCompute' headless2.log"

check "Disk space lists the program, models, pictures and app data, with free space" "curl -sf $B/local/storage | grep -q '\"key\":\"program\"' && curl -sf $B/local/storage | grep -q '\"key\":\"models\"' && curl -sf $B/local/storage | grep -q '\"key\":\"media\"' && curl -sf $B/local/storage | grep -q '\"key\":\"data\"' && curl -sf $B/local/storage | grep -q '\"free\":[1-9]'"
check "Queue tab: the list answers, and removing an unknown request is refused" "curl -sf '$B/local/image/queue?all=1' | grep -q '\"jobs\"' && [ \"\$(code -X POST -H 'content-type: application/json' -d '{\"id\":\"nope\"}' $B/local/image/remove)\" = 404 ]"
check "Open folder: an unknown part refused" "[ \"\$(code -X POST -H 'content-type: application/json' -d '{\"key\":\"../x\"}' $B/local/storage/open)\" = 400 ]"
check "native contributor present"                "curl -sf $B/local/contribute | grep -q '\"engine\":\"native\"'"
check "start refused without I agree"             "[ \"\$(code -X POST -H 'content-type: application/json' -d '{\"run\":true}' $B/local/contribute)\" = 400 ]"
curl -sf -X POST -H 'content-type: application/json' -d '{"agree":true,"cores":1,"cap":50,"run":true}' $B/local/contribute > /dev/null
sleep 5
check "computes after I agree"                    "curl -sf $B/local/contribute | grep -q '\"running\":true' && ! curl -sf $B/local/contribute | grep -q '\"packs\":0,'"
curl -s $B/local/contribute; echo
curl -sf -X POST -H 'content-type: application/json' -d '{"run":false,"agree":false}' $B/local/contribute > /dev/null

if [ "${WITH_MODEL:-0}" = 1 ]; then
  M=qwen2.5-0.5b-q4km
  curl -sf -X POST -H 'content-type: application/json' -d "{\"id\":\"$M\"}" $B/local/models/download > /dev/null
  for i in $(seq 300); do
    st=$(curl -sf $B/local/models | sed -E "s/.*\"id\":\"$M\"[^}]*\"state\":\"([a-z]+)\".*/\1/")
    [ "$st" = ready ] || [ "$st" = error ] && break; sleep 2
  done
  check "model downloaded and SHA-256 checked ($M)" "[ \"$st\" = ready ]"
  check "/v1/models lists it" "curl -sf $B/v1/models | grep -q '\"id\":\"$M\"'"
  ans=$(curl -s -X POST -H 'content-type: application/json' \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the capital of France? One word.\"}],\"max_tokens\":16,\"temperature\":0}" \
    $B/v1/chat/completions)
  echo "$ans"
  # macOS: what the sandbox refused the engines in the last minutes (empty when nothing)
  if [ "$(uname)" = Darwin ]; then log show --last 5m --style compact --predicate 'eventMessage CONTAINS "deny"' 2>/dev/null | grep -i planetcompute | tail -25; fi
  check "chat completion answers (Paris)" "echo \"\$ans\" | grep -qi paris"
  sse=$(curl -sN -X POST -H 'content-type: application/json' \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Count from 1 to 5.\"}],\"max_tokens\":24,\"stream\":true}" \
    $B/v1/chat/completions)
  check "streamed chat completion (chunks, then [DONE])" "echo \"\$sse\" | grep -q 'chat.completion.chunk' && echo \"\$sse\" | grep -q 'data: \[DONE\]'"
  # other sources, disk use, delete
  R="$B/local/models/resolve?q="
  check "paste: owner/repo = Hugging Face, lists its files" "curl -sf '${R}unsloth/Qwen3-4B-Instruct-2507-GGUF' | grep -q '\"kind\":\"huggingface\"' && curl -sf '${R}unsloth/Qwen3-4B-Instruct-2507-GGUF' | grep -q 'Q4_K_M.gguf'"
  check "paste: a huggingface.co file address = that one file" "[ \"\$(curl -sf '${R}https%3A%2F%2Fhuggingface.co%2Funsloth%2FQwen3-4B-Instruct-2507-GGUF%2Fblob%2Fmain%2FQwen3-4B-Instruct-2507-Q4_K_M.gguf' | grep -o '\"add\"' | wc -l | tr -d ' ')\" = 1 ]"
  check "paste: name:tag = Ollama, SHA-256 known" "curl -sf '${R}qwen2.5:0.5b' | grep -q '\"kind\":\"ollama\"' && curl -sf '${R}qwen2.5:0.5b' | grep -qE '\"sha256\":\"[0-9a-f]{64}\"'"
  check "paste: ollama.com address = Ollama" "curl -sf '${R}https%3A%2F%2Follama.com%2Flibrary%2Fqwen2.5%3A0.5b' | grep -q '\"kind\":\"ollama\"'"
  check "paste: GitHub release file = a link" "curl -sf '${R}https%3A%2F%2Fgithub.com%2Fo%2Fr%2Freleases%2Fdownload%2Fv1%2Fm.gguf' | grep -q '\"label\":\"GitHub: o/r\"'"
  check "paste: GitHub file in a repo = its raw address" "curl -sf '${R}https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fblob%2Fmain%2Fm.gguf' | grep -q 'github.com/o/r/raw/main/m.gguf'"
  check "paste: Dropbox link = Dropbox" "curl -sf '${R}https%3A%2F%2Fwww.dropbox.com%2Fs%2Fabc%2Fm.gguf%3Fdl%3D0' | grep -q '\"label\":\"Dropbox\"'"
  check "paste: Google Drive link = Google Drive" "curl -sf '${R}https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2FABC123%2Fview' | grep -q '\"label\":\"Google Drive\"'"
  check "paste: nonsense is refused" "[ \"\$(code '${R}two%20words')\" = 400 ]"
  check "open browser: other sites refused" "[ \"\$(code -X POST -H 'content-type: application/json' -d '{\"url\":\"https://evil.example/\"}' $B/local/open)\" = 400 ]"
  check "Hugging Face: lists a repo's .gguf files" "curl -sf '$B/local/models/hf?repo=unsloth/Qwen3-4B-Instruct-2507-GGUF' | grep -q 'Q4_K_M.gguf'"
  curl -s -X POST -H 'content-type: application/json' -d '{"source":"url","url":"https://planetcompute.ai/favicon.png","name":"not a model"}' $B/local/models/add > /dev/null
  for i in $(seq 30); do curl -sf $B/local/models | grep -q 'not a GGUF model file' && break; sleep 1; done
  check "a link that is not a GGUF model is refused" "curl -sf $B/local/models | grep -q 'not a GGUF model file'"
  curl -s -X POST -H 'content-type: application/json' -d '{"source":"ollama","model":"qwen2.5:0.5b"}' $B/local/models/add > /dev/null
  for i in $(seq 300); do curl -sf $B/local/models | grep -q '"from":"Ollama: qwen2.5:0.5b"[^}]*"state":"ready"' && break; sleep 2; done
  check "Ollama: qwen2.5:0.5b downloaded, SHA-256 verified" "[ \"\$(mstate ollama-qwen2.5-0.5b)\" = 'ready verified' ] && curl -sf $B/local/models | grep -q '\"from\":\"Ollama: qwen2.5:0.5b\"'"
  check "disk use and free space reported" "curl -sf $B/local/models | grep -qE '\"free\":[1-9][0-9]*' && curl -sf $B/local/models | grep -qE '\"used\":[1-9][0-9]*'"
  curl -s -X POST -H 'content-type: application/json' -d '{"id":"ollama-qwen2.5-0.5b"}' $B/local/models/delete > /dev/null
  curl -s -X POST -H 'content-type: application/json' -d "{\"id\":\"$M\"}" $B/local/models/delete > /dev/null
  check "deleted models are gone (can be downloaded again)" "! curl -sf $B/local/models | grep -q '\"from\":\"Ollama' && curl -sf $B/v1/models | grep -q '\"data\":\[\]'"
fi

# Images (the built-in stable-diffusion.cpp engine)
check "image engine is in this build" "curl -sf $B/local/image/info | grep -q '\"engine\":true'"
check "the library lists image models, their parts marked" "curl -sf $B/local/models | grep -q '\"id\":\"flux1-schnell-q4\"' && curl -sf $B/local/models | grep -q '\"partOf\":\"flux1-schnell-q4\"'"
check "no image without a model" "[ \"\$(code -X POST -H 'content-type: application/json' -d '{\"model\":\"nope\",\"prompt\":\"x\"}' $B/local/image)\" = 400 ]"
if [ "${WITH_IMAGE:-0}" = 1 ]; then
  J='-H content-type:application/json'
  Z=zimage-turbo-q4k
  check "Stable Diffusion 1.5 is no longer in the library" "! curl -sf $B/local/models | grep -q '\"id\":\"sd15-q8\"'"
  curl -s -X POST $J -d "{\"id\":\"$Z\"}" $B/local/models/download > /dev/null
  for i in $(seq 1 240); do [ "$(mstate $Z) $(mstate flux1-ae) $(mstate qwen3-4b-instruct-2507)" = "ready verified ready verified ready verified" ] && break; sleep 5; done
  check "Z-Image Turbo downloaded with its parts (the FLUX decoder and the chat model Qwen3 4B), SHA-256 verified" "[ \"\$(mstate $Z) \$(mstate flux1-ae) \$(mstate qwen3-4b-instruct-2507)\" = 'ready verified ready verified ready verified' ]"
  check "an image model is not offered for chat (its shared text encoder is)" "! curl -sf $B/v1/models | grep -q $Z && curl -sf $B/v1/models | grep -q qwen3-4b-instruct-2507"
  check "chat with an image model refused" "[ \"\$(code -X POST $J -d '{\"model\":\"$Z\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}' $B/v1/chat/completions)\" = 400 ]"
  check "bad picture size refused" "[ \"\$(code -X POST $J -d '{\"model\":\"$Z\",\"prompt\":\"x\",\"width\":301}' $B/local/image)\" = 400 ]"
  ID=$(curl -s -X POST $J -d "{\"model\":\"$Z\",\"prompt\":\"a red apple on a wooden table\",\"width\":256,\"height\":256,\"steps\":4,\"seed\":42}" $B/local/image | sed -E 's/.*"id":"([0-9a-f]+)".*/\1/')
  t0=$(date +%s); seen=""
  for i in $(seq 1 1200); do
    st=$(curl -sf $B/local/image/job/$ID | sed -E 's/.*"state":"([a-z]+)".*/\1/'); case "$seen" in *"$st"*) ;; *) seen="$seen $st";; esac
    [ "$st" = done ] || [ "$st" = error ] && break; sleep 1
  done
  echo "   picture: states$seen, $(( $(date +%s) - t0 )) s; $(curl -sf $B/local/image/job/$ID)"
  check "a picture is made (256x256, 4 steps), with progress" "[ \"$st\" = done ] && echo '$seen' | grep -q sampling"
  curl -sf -o pic.png $B/local/image/file/$ID
  check "the picture is a PNG" "[ \"\$(head -c 4 pic.png | od -An -c | tr -d ' ')\" = '211PNG' ] && [ \$(wc -c < pic.png) -gt 10000 ]"
  check "OpenAI-style /v1/images/generations answers with a PNG" "curl -sf -X POST $J -d '{\"model\":\"$Z\",\"prompt\":\"a blue bird\",\"size\":\"256x256\",\"steps\":2}' $B/v1/images/generations | grep -q '\"b64_json\":\"iVBOR'"
  ID=$(curl -s -X POST $J -d "{\"model\":\"$Z\",\"prompt\":\"a castle\",\"width\":512,\"height\":512,\"steps\":60}" $B/local/image | sed -E 's/.*"id":"([0-9a-f]+)".*/\1/')
  ID2=$(curl -s -X POST $J -d "{\"model\":\"$Z\",\"prompt\":\"a boat\",\"width\":256,\"height\":256,\"steps\":4}" $B/local/image | sed -E 's/.*"id":"([0-9a-f]+)".*/\1/')
  check "a second picture waits in the queue (1 before it)" "curl -sf $B/local/image/job/$ID2 | grep -q '\"state\":\"queued\"' && curl -sf $B/local/image/job/$ID2 | grep -q '\"ahead\":1'"
  sleep 8
  # restart (a new copy replaces this one): both requests come back from the queue file and the first is made again
  pid1=$(pid_of)
  "$BIN" --headless > headless3.log 2>&1 &
  for i in $(seq 30); do pid3=$(pid_of); [ -n "$pid3" ] && [ "$pid3" != "$pid1" ] && break; sleep 1; done
  echo "   queue after the restart: $(curl -sf $B/local/image/queue)"
  check "after a restart both pictures are back in the queue" "curl -sf $B/local/image/queue | grep -q $ID && curl -sf $B/local/image/queue | grep -q $ID2 && curl -sf $B/local/image/job/$ID | grep -q '\"resumed\":true'"
  for i in $(seq 1 60); do curl -sf $B/local/image/job/$ID | grep -qE '"state":"(loading|sampling|decoding)"' && break; sleep 1; done
  check "the first one is being made again (the second still waits)" "curl -sf $B/local/image/job/$ID | grep -qE '\"state\":\"(loading|sampling|decoding)\"' && curl -sf $B/local/image/job/$ID2 | grep -q '\"state\":\"queued\"'"
  curl -s -X POST $J -d "{\"id\":\"$ID2\"}" $B/local/image/cancel > /dev/null
  curl -s -X POST $J -d "{\"id\":\"$ID\"}" $B/local/image/cancel > /dev/null; sleep 3
  check "Stop ends a picture (waiting or being made), the engine is free and the queue empty" "curl -sf $B/local/image/job/$ID | grep -q '\"state\":\"cancelled\"' && curl -sf $B/local/image/job/$ID2 | grep -q '\"state\":\"cancelled\"' && curl -sf $B/local/image/info | grep -q '\"busy\":null' && curl -sf $B/local/image/queue | grep -q '\"jobs\":\[\]'"
  curl -s -X POST $J -d "{\"id\":\"$ID\"}" $B/local/image/remove > /dev/null
  check "Queue tab: a stopped request can be removed from the list" "! curl -sf '$B/local/image/queue?all=1' | grep -q $ID && curl -sf '$B/local/image/queue?all=1' | grep -q $ID2"
  curl -s -X POST $J -d "{\"id\":\"$Z\"}" $B/local/models/delete > /dev/null
  check "image model deleted with its own part, the shared chat model kept" "[ \"\$(mstate $Z) \$(mstate flux1-ae) \$(mstate qwen3-4b-instruct-2507)\" = 'none none ready verified' ]"
  curl -s -X POST $J -d '{"id":"qwen3-4b-instruct-2507"}' $B/local/models/delete > /dev/null
fi

# Video (the same engine, Wan 2.1 text to video)
check "the library lists the video model, its parts marked" "curl -sf $B/local/models | grep -q '\"id\":\"wan21-t2v-1.3b-q8\"' && curl -sf $B/local/models | grep -q '\"partOf\":\"wan21-t2v-1.3b-q8\"'"
if [ "${WITH_VIDEO:-0}" = 1 ]; then
  J='-H content-type:application/json'
  curl -s -X POST $J -d '{"id":"wan21-t2v-1.3b-q8"}' $B/local/models/download > /dev/null
  for i in $(seq 1 360); do [ "$(mstate wan21-t2v-1.3b-q8)" = "ready verified" ] && [ "$(mstate wan21-vae)" = "ready verified" ] && [ "$(mstate umt5-xxl-q4km)" = "ready verified" ] && break; sleep 5; done
  check "Wan 2.1 and its two parts downloaded, SHA-256 verified (one a safetensors file)" "[ \"\$(mstate wan21-t2v-1.3b-q8) \$(mstate wan21-vae) \$(mstate umt5-xxl-q4km)\" = 'ready verified ready verified ready verified' ]"
  check "frames must be 4n+1" "[ \"\$(code -X POST $J -d '{\"model\":\"wan21-t2v-1.3b-q8\",\"prompt\":\"x\",\"frames\":10}' $B/local/image)\" = 400 ]"
  ID=$(curl -s -X POST $J -d '{"model":"wan21-t2v-1.3b-q8","prompt":"a small boat sailing on a calm lake","width":256,"height":144,"frames":5,"steps":4,"seed":7}' $B/local/image | sed -E 's/.*"id":"([0-9a-f]+)".*/\1/')
  t0=$(date +%s); seen=""
  for i in $(seq 1 2400); do
    st=$(curl -sf $B/local/image/job/$ID | sed -E 's/.*"state":"([a-z]+)".*/\1/'); case "$seen" in *"$st"*) ;; *) seen="$seen $st";; esac
    [ "$st" = done ] || [ "$st" = error ] && break; sleep 1
  done
  echo "   video: states$seen, $(( $(date +%s) - t0 )) s; $(curl -sf $B/local/image/job/$ID)"
  check "a video clip is made (256x144, 5 frames, 4 steps), with progress" "[ \"$st\" = done ] && echo '$seen' | grep -q sampling"
  curl -sf -o clip.webm $B/local/image/file/$ID
  check "the clip is WebM" "[ \"\$(head -c 4 clip.webm | od -An -tx1 | tr -d ' ')\" = 1a45dfa3 ] && [ \$(wc -c < clip.webm) -gt 1000 ]"
  check "served as video/webm" "curl -sfI $B/local/image/file/$ID | grep -qi 'content-type: video/webm'"
  curl -s -X POST $J -d '{"id":"wan21-t2v-1.3b-q8"}' $B/local/models/delete > /dev/null
  check "video model deleted, its parts with it" "[ \"\$(mstate wan21-t2v-1.3b-q8) \$(mstate wan21-vae) \$(mstate umt5-xxl-q4km)\" = 'none none none' ]"
fi

kill %1 %2 2> /dev/null; command -v taskkill > /dev/null && taskkill //F //IM planetCompute.exe > /dev/null 2>&1
echo; [ $fails = 0 ] && echo "ALL PASS" || echo "$fails FAILED"
exit $fails
