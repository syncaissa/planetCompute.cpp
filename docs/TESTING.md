# Testing planetCompute: how to check every claim yourself

This page lists every test we run on the planetCompute program and on the PlanetCompute website, step by step,
so that anyone (users, reviewers, critics) can repeat them and get the same results. Each test says what it
proves, what you need, the exact commands, and what you should see. At the end is a log of our own runs.

Contents

| # | Test | Proves | Needs |
|---|---|---|---|
| 1 | [Build from source](#1-build-from-source) | the program you run is built from this code | Rust, a C/C++ compiler, CMake |
| 2 | [The WorkPack equals the server's check](#2-the-workpack-equals-the-servers-check) | the program computes exactly what the website verifies | Rust, Node.js |
| 3 | [Local web server, takeover, native contributor](#3-local-web-server-takeover-native-contributor) | the guards, "newest start wins", "no work without I agree" | the program |
| 4 | [Sign in on a headless server](#4-sign-in-on-a-headless-server) | the email-code sign-in and that the browser never holds the session | a Linux server, an account |
| 5 | [The tunnel link](#5-the-tunnel-link) | only the owner can open a device from outside | as 4 |
| 6 | [Contributing natively and being credited](#6-contributing-natively-and-being-credited) | capacity check, credit only up to verified capacity | as 4 |
| 7 | [Windows and macOS](#7-windows-and-macos) | the same on the other systems | a Windows PC or a Mac |
| 8 | [The website's heartbeat ledger](#8-the-websites-heartbeat-ledger-staging-copy) | credit is counted once and never lost | your own Cloudflare and AWS accounts |
| 9 | [The models are the original files](#9-the-models-are-the-original-files) | the model files are the publishers' own | Python 3 |
| 10 | [Harness: a real model on your computer](#10-harness-a-real-model-on-your-computer) | models download checked, llama.cpp answers, the OpenAI/llama.cpp API works | the program, 1 GB free disk |
| 11 | [GPU smoke test](#11-gpu-smoke-test) | Harness runs on the graphics card, and how fast | a computer with a GPU (or a cloud GPU server) |
| 12 | ["Email us a question" cannot be abused](#12-email-us-a-question-cannot-be-abused) | the form's limits and anti-spam checks | your own Cloudflare account (staging copy), or just a browser |

Conventions: commands are for a Unix shell (Linux, macOS, or Git Bash on Windows). `planetCompute` is the program
(`planetCompute.exe` on Windows). The program's local web server is `http://localhost:7526`. Nothing here needs a
secret from us; tests 4 to 6 use your own PlanetCompute account, test 8 your own cloud accounts.

---

## 1. Build from source

Proves: the program is built from the published code, with the published dependency versions.

1. Install Rust (https://rustup.rs), CMake, Clang, and a C/C++ compiler. On Ubuntu 22.04 also:
   ```
   sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev cmake clang libclang-dev
   ```
2. Build exactly the pinned versions (`client/Cargo.lock`; llama.cpp comes from the `llama-cpp-sys-2` crate, whose
   source is also in `llama.cpp/`, see `llama.cpp/PLANETCOMPUTE_SOURCE.txt`):
   ```
   cd client
   cargo build --release --locked
   ./target/release/planetCompute --version
   ```
3. Expected: a line `planetCompute <version> (<os> <arch>), local web server port 7526` and a line starting
   `llama.cpp:` that lists the CPU features of the build (for example `AVX2 = 1`).

The release builds are made by GitHub Actions from the same code (`.github/workflows/client.yml`), and every
build runs tests 2 and 3 on Windows, macOS and Linux before its files are kept. The SHA-256 of each released file
is listed next to it (`SHA256SUMS`); compare with `sha256sum planetCompute-*`.

## 2. The WorkPack equals the server's check

Proves: the native WorkPack (`client/src/contribute.rs`, `mc_pi`) gives exactly the numbers the website's capacity
check expects (`website/worker.js`, `cpuChunkHits`, which is also what the browser's WebAssembly module computes).

1. Regenerate the test values from the website code and confirm they equal the ones in the repository:
   ```
   node scripts/make_mc_pi_vectors.mjs website/worker.js /tmp/vectors.rs
   diff <(grep -v '^//' /tmp/vectors.rs) <(grep -v '^//' client/src/mc_pi_vectors.rs) && echo identical
   ```
2. Run the unit test:
   ```
   cd client && cargo test --release
   ```
3. Expected: `identical`, then `test contribute::tests::matches_the_server ... ok`. The values cover seeds at the
   edges of the 32-bit range and the real WorkPack size of 2,000,000 samples.

## 3. Local web server, takeover, native contributor

Proves, on your own computer, without signing in:
- the page and the site's own console are served at `http://localhost:7526`;
- requests under other host names are refused (stops DNS rebinding), and so are form posts and WebSocket
  connections from other web sites;
- the "quit" request only works for the program itself;
- starting planetCompute again replaces the copy that is running (newest build wins);
- the native contributor refuses to start without "I agree", and computes once it is given;
- (security review E1, E4) without the program's key every local answer is refused (401), a wrong key too; the
  printed `?t=` link sets the program's cookie; the website's pages answer only on their own port (port + 10000).
  The script reads the key from the printed link and sends it as `Authorization: Bearer <key>`.

1. Close any planetCompute you are running (the script starts copies on port 7526 and replaces them).
2. Run:
   ```
   bash scripts/test_local_server.sh ./planetCompute        # Windows (Git Bash): ./planetCompute.exe
   ```
3. Expected: every line starts with `PASS` (21 without the model, picture and video parts), then `ALL PASS`. The takeover line shows two different process numbers,
   for example `PASS a second start replaces the first (5204 -> 468)`.

## 4. Sign in on a headless server

Proves: a server without a screen can be signed in from another computer, with the email one-time code, and the
session token stays inside the program (a browser never sees it).

You need: a Linux server (Ubuntu 22.04 or newer) you can reach by SSH, and a PlanetCompute account (any email
address you can read).

1. On the server, install the window libraries the program links to (needed even with `--headless`), copy the
   program there, and start it:
   ```
   sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0
   chmod +x planetCompute
   ./planetCompute --headless
   ```
   Expected: `Sign in and contribute at http://localhost:7526`.
2. On your own computer, open a tunnel to it and look:
   ```
   ssh -L 7526:localhost:7526 <user>@<server>
   ```
   Open `http://localhost:7526` in your browser (the device page), or use curl from a second terminal:
   ```
   curl -s http://localhost:7526/local/info      # "tunnel":"off: sign in to switch on the link"
   curl -s http://localhost:7526/api/me          # {"error":"Not signed in."}
   ```
3. Ask for a code, read it in your email, and sign in:
   ```
   curl -s -X POST -H 'content-type: application/json' -d '{"email":"<your email>"}' http://localhost:7526/api/auth/start
   curl -s -X POST -H 'content-type: application/json' -d '{"email":"<your email>","code":"<the 6 digits>"}' http://localhost:7526/api/auth/verify
   curl -s http://localhost:7526/api/me          # your account
   ```
4. Expected: `/api/me` shows your account. The session is kept only in the program's config folder
   (`~/.config/planetCompute/session` on Linux, readable only by you); your browser holds no PlanetCompute cookie
   for `localhost`.

## 5. The tunnel link

Proves: `https://planetcompute.ai/device/<device id>/` opens the device's page from anywhere, only for the account
the device is signed in to; the "quit" request cannot be sent through it; signing out closes it.

1. Continue from test 4. Within a few seconds `curl -s http://localhost:7526/local/info` shows `"tunnel":"on"` and
   `"link":"https://planetcompute.ai/device/<id>/"`.
2. Open the link in a browser where you are signed in to planetcompute.ai with the SAME account: you see the
   device's page. From a script, the same checks (run them on the server; they read the program's own session
   file, so nothing is printed):
   ```
   T=$(cat ~/.config/planetCompute/session); L=<the link without the trailing slash>
   curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: pc_session=$T" $L/                     # 200
   curl -s -H "Cookie: pc_session=$T" $L/local/info                                            # the device
   curl -s -H "Cookie: pc_session=$T" -X POST -H "Origin: https://planetcompute.ai" -H "x-planetcompute: quit" $L/local/quit   # Not over the tunnel. (403)
   curl -s -H "Cookie: pc_session=$T" https://planetcompute.ai/api/tunnel/devices              # the device, "online":true
   curl -s -o /dev/null -w '%{http_code}\n' $L/                                                # 401 (no session)
   curl -s -o /dev/null -w '%{http_code}\n' https://planetcompute.ai/device/0123456789ab/ -H "Cookie: pc_session=$T"   # 404 (not your device)
   ```
3. Sign out and check that the link closes:
   ```
   curl -s -X POST -H 'content-type: application/json' -d '{}' http://localhost:7526/api/auth/signout
   curl -s http://localhost:7526/local/info      # "tunnel":"off: sign in to switch on the link"
   ```
4. Expected: the codes shown above. A visitor signed in to a different account gets "This device is not
   connected" (the tunnel belongs to the device's account only).

## 6. Contributing natively and being credited

Proves: the program contributes without a browser, passes PlanetCompute's capacity check, and is credited only up
to its verified capacity; credit reaches the balance when the session pauses.

1. On the server, start contributing (I agree, 2 cores, at most 50 % of each):
   ```
   ./planetCompute --headless --contribute --cores 2 --cap 50
   ```
   then sign in as in test 4, steps 2 and 3.
2. Note your balance: `curl -s http://localhost:7526/api/me/credit` (field `available_wu`).
3. Watch the status (repeat every few seconds); within about a minute `verdict` appears with `"pass":true`,
   `"verified":true`:
   ```
   curl -s http://localhost:7526/local/contribute
   ```
4. Let it run for 3 or 4 minutes (a report goes to PlanetCompute once a minute), then pause it:
   ```
   curl -s -X POST -H 'content-type: application/json' -d '{"run":false}' http://localhost:7526/local/contribute
   ```
5. After about a minute, read the balance again.
6. Expected: the balance has grown by this device's credited Work Units, which are never more than it reported
   (`wu` in step 3) and never more than its verified rate (`cpu_band`, WU per second) times the time it ran. If
   other devices of yours contribute at the same time, their credit arrives in the same balance; the website's
   Contributor Sessions list (admin page) shows each device's own `reported` and `credited` numbers.

## 7. Windows and macOS

The program is the same; only the system differs.

- Windows: `planetCompute.exe` opens the window. `planetCompute.exe --headless` works from cmd or PowerShell; the
  prompt returns at once while it keeps running (it is a windowed program, so no console window flashes when
  you double-click it). To keep the terminal waiting: `start /wait planetCompute.exe --headless` (cmd). Stop it with
  `taskkill /im planetCompute.exe`, or by starting planetCompute again (test 3, takeover).
- macOS: `./planetCompute` opens the window; `--headless` as on Linux. The file is not signed yet, so macOS asks
  for confirmation the first time (System Settings, Privacy & Security, "Open Anyway").
- Run test 3 there (Git Bash on Windows, Terminal on macOS). Our CI does this on every build.

## 8. The website's heartbeat ledger (staging copy)

Proves: the website counts each contributor's reports exactly once and never loses credit, in every case: the
first report, reports that are only collected, two reports at the same moment, pause, a capacity-check connection
closed properly, a connection that just disappears, and a new session. Run this only on a STAGING copy with TEST
tables, never on the live site.

You need: a Cloudflare account (Workers, with Durable Objects), an AWS account (DynamoDB), Node.js, Python 3 with
`boto3`.

1. Create the test tables in your AWS account (credentials from your environment or `~/.aws`):
   ```
   DYNAMODB_TABLE_PREFIX=pctest-ai- python3 database/CreateTables.py
   ```
2. Deploy the staging Worker (the same `website/worker.js`, its own Durable Objects, the test tables):
   ```
   cd website
   npx wrangler@3.99.0 deploy --config wrangler-staging.toml
   ```
   Note the `https://...workers.dev` address it prints. Set its three secrets: your AWS key pair (one that may use
   the `pctest-ai-*` tables) and a new random session secret that you also keep in a file:
   ```
   python3 -c "import secrets; print(secrets.token_urlsafe(48))" > session_secret.txt
   npx wrangler@3.99.0 secret put AWS_ACCESS_KEY_ID --config wrangler-staging.toml
   npx wrangler@3.99.0 secret put AWS_SECRET_ACCESS_KEY --config wrangler-staging.toml
   npx wrangler@3.99.0 secret put SESSION_SECRET --config wrangler-staging.toml      # paste the file's content
   ```
3. Run the test:
   ```
   STAGING_URL=https://<your staging worker> SESSION_SECRET_FILE=website/session_secret.txt python3 scripts/test_heartbeat_ledger.py
   ```
4. Expected: 15 lines starting `PASS`, then `ALL PASS`. The last line checks that the balance equals everything
   credited (85,000 micro-Work Units in this script).
5. Clean up: delete the four `pctest-ai-*` tables (switch off their deletion protection first) and, if you like,
   the staging Worker.

What the test relies on, to read along in `website/worker.js` (function `heartbeat`): each report reads the device
item once and writes it once (it stays under 1 KB); its numbers are added to the device's pending totals; the
Contributor-Sessions row and the balance are brought up to date from them at least every 30 minutes (10 before
2026-10-26) and at once on
pause, stop, a new session, or when the capacity-check connection closes (`flushDevice`); a sequence number makes
two simultaneous reports of one device count once.

## 9. The models are the original files

Proves: every model planetCompute offers is byte for byte the file its publisher released (the Ollama registry or
Hugging Face at a pinned revision), identified by its SHA-256 in `models/catalog.json`.

1. Compare the catalog with what the publishers list (no download):
   ```
   python3 scripts/verify_model_sources.py
   ```
2. Optionally download one model from its publisher and hash every byte (sizes are in the catalog; the smallest
   is 0.4 GB):
   ```
   python3 scripts/verify_model_sources.py --download qwen2.5-0.5b-q4km
   ```
3. Expected: `OK` for every model (and for the download). planetCompute checks its own copies against the same
   SHA-256 before it uses them.

## 10. Harness: a real model on your computer

Proves: Harness downloads a model and checks every byte against the catalog's SHA-256, llama.cpp runs it, and the
API that llama.cpp's server and OpenAI speak works at `http://localhost:7526/v1` (plain and streamed answers).

1. Automatic (what our CI runs on Windows, macOS and Linux; it adds 4 checks to test 3):
   ```
   WITH_MODEL=1 bash scripts/test_local_server.sh ./planetCompute
   ```
   Expected: 23 lines starting `PASS` (14 from test 3 and 9 for Harness), among them `model downloaded and SHA-256 checked (qwen2.5-0.5b-q4km)`,
   `/v1/models lists it`, `chat completion answers (Paris)`, `streamed chat completion (chunks, then [DONE])`,
   `Hugging Face: lists a repo's .gguf files`, `a link that is not a GGUF model is refused`,
   `Ollama: qwen2.5:0.5b downloaded, SHA-256 verified`, `disk use and free space reported`,
   `deleted models are gone (can be downloaded again)`.
   Other sources by hand, on the Harness tab under "Add a model": a Hugging Face repo (List files, then Download),
   an Ollama name such as `llama3.2:3b`, or a link (Dropbox share links work; give the SHA-256 to have it verified).
   "Downloaded models" shows each model's size on disk, the total used, the free space, and Delete.
2. By hand: start `./planetCompute` (the window) or `./planetCompute --headless`, open `http://localhost:7526/local/#harness`,
   press Download next to "Qwen2.5 0.5B Instruct" (0.4 GB) and wait for "ready"; then chat on the same page. Or:
   ```
   curl -s -X POST -H 'content-type: application/json' -d '{"id":"qwen2.5-0.5b-q4km"}' http://localhost:7526/local/models/download
   curl -s http://localhost:7526/local/models          # "state":"ready" when done
   curl -s http://localhost:7526/v1/models
   curl -s -X POST -H 'content-type: application/json' \
     -d '{"model":"qwen2.5-0.5b-q4km","messages":[{"role":"user","content":"What is the capital of France? One word."}],"max_tokens":16,"temperature":0}' \
     http://localhost:7526/v1/chat/completions
   ```
3. Expected: the answer contains "Paris"; `usage` counts the tokens. Any tool that talks to llama.cpp's server or to
   OpenAI can use `http://localhost:7526/v1` as its base address. Models are kept in the program's data folder
   (shown on the Harness tab); a model whose bytes do not match the catalog is deleted, never used.

Through the tunnel link (test 5 set-up, signed in): the same API works at `https://planetcompute.ai/device/<id>/v1/`
for the device's owner, with streamed answers passed on piece by piece and no 30-second limit:
```
T=$(cat ~/.config/planetCompute/session); L=<the link without the trailing slash>
curl -s -H "Cookie: pc_session=$T" $L/v1/models
curl -sN -H "Cookie: pc_session=$T" -X POST -H 'content-type: application/json' \
  -d '{"model":"qwen2.5-0.5b-q4km","messages":[{"role":"user","content":"Count from 1 to 20."}],"stream":true}' $L/v1/chat/completions
```

The PlanetCompute library through planetcompute.ai (the list is public; files need a signed-in session, as in test 4):
```
curl -s https://planetcompute.ai/api/models                                   # the library
curl -s -H "Cookie: pc_session=$T" -H 'Range: bytes=0-15' https://planetcompute.ai/api/models/file/qwen2.5-0.5b-q4km | head -c 4   # GGUF
curl -s -X DELETE https://planetcompute.ai/api/models/file/qwen2.5-0.5b-q4km  # {"error":"GET only."}: nobody can change the library
```

Where the bytes come from: PlanetCompute's own copy (B2) when the website gives a signed-in user a download pass,
otherwise the publisher (Ollama registry or Hugging Face at the pinned revision). The check is the same.

## 11. GPU smoke test

Proves: the Vulkan build of planetCompute runs Harness models on the graphics card (all layers on the GPU), and
measures the speed against the CPU build on the same machine.

You need: a computer or cloud server with an NVIDIA, AMD or Intel GPU and its driver (on a Linux server also
`libvulkan1`; `vulkan-tools` to check), at least 8 GB of free disk, and a PlanetCompute account if you want the
library's files through planetcompute.ai.

1. Check that Vulkan sees the GPU: `vulkaninfo --summary` lists it as `PHYSICAL_DEVICE_TYPE_DISCRETE_GPU`.
2. Start the Vulkan build: `./planetCompute-<version>-linux-x86_64-vulkan --headless` (Windows: the
   `windows-x86_64` file, since 2026-10-26 the one Windows program, Vulkan inside). Its log shows `ggml_vulkan: Found 1 Vulkan devices` and the GPU's name.
3. Sign in (test 4) and download two library models on the Harness tab or with
   `curl -s -X POST -H 'content-type: application/json' -d '{"id":"qwen3-4b-instruct-2507"}' http://localhost:7526/local/models/download`
   (and `qwen2.5-coder-7b`). `curl -s http://localhost:7526/local/models` shows them `ready`, "PlanetCompute library",
   verified.
4. Measure: `python3 scripts/bench_harness.py qwen3-4b-instruct-2507 Vulkan` and the same for `qwen2.5-coder-7b`
   (a warm-up loads the model, then a streamed answer of 512 tokens is timed; with `nvidia-smi` it also shows the
   GPU's peak use and memory).
5. Compare: start the CPU build (`./planetCompute-<version>-linux-x86_64 --headless`; it replaces the running copy,
   the downloaded models stay) and run the same two measurements with the label `CPU`.
6. Expected: the Vulkan numbers are several times the CPU ones, the GPU is busy (well above 50 %) and holds the
   model in its memory. Exact speeds depend on the GPU, the CPU and the model.

## 12. "Email us a question" cannot be abused

Proves: the question form on planetcompute.ai mails only PlanetCompute's admins (Reply-To = the sender; nothing is
ever sent to the address typed in), and stops mass mailing: limits per IP address, per network (/24, /48) and per
sender email (lower case, without +tags and Gmail dots) of 2 a minute, 3 in 15 minutes, 5 an hour and 8 a day; for
the whole site 30 an hour and 100 a day; a signed single-use form token (the form open 3 s to 2 h); a hidden
honeypot field; same-origin posts only; names without links; at most three links; no disposable mail domains; a
mail domain that really receives mail; and Cloudflare Turnstile ("Verify you are human").

1. The limit logic, exactly, with a fake clock (Node.js, no account needed): the `ContactGuard` class in
   `website/worker.js` counts in memory; the checks we run are in the session notes of 2026-10-21 (26 checks:
   each window at its exact count, the next day allowed again, IP / network / email counted separately, a token
   used once, the site-wide 30 an hour).
2. The real endpoint, on a staging copy (test 8's set-up; `website/wrangler-staging.toml` sets `CONTACT_DRY_RUN` so
   nothing is mailed, and Cloudflare's documented always-pass Turnstile test keys):
   ```
   STAGING_URL=https://<your staging worker> python3 scripts/test_contact_form.py
   ```
   Expected: 13 lines starting `PASS` (too fast, forged token, honeypot, disposable domain, a domain without mail,
   too many links, a link as a name, a post from another site, a good question accepted, token reuse, the second
   accepted and the third in the same minute refused), then `ALL PASS`. Limits count per IP: a second run from the
   same computer within a day ends in "limited", as it should.
3. On the live site, without an account: a well-formed question without a genuine Turnstile pass is refused:
   ```
   T=$(curl -s https://planetcompute.ai/api/contact/token | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])"); sleep 4
   curl -s -X POST -H 'content-type: application/json' -d "{\"first_name\":\"A\",\"last_name\":\"B\",\"email\":\"you@gmail.com\",\"question\":\"Is the check enforced?\",\"token\":\"$T\",\"turnstile\":\"fake\"}" https://planetcompute.ai/api/contact
   ```
   Expected: `Please complete the check above the Send button`.
4. As a person: fill in the form at https://planetcompute.ai/#ask, tick "Verify you are human", send. Expected: "Thank
   you, your question was sent"; the admins receive it. A sixth question from you within the hour is refused.

---

## 13. "Report Bugs": reports, limits and the admin tab

What it shows: a bug report is saved with who sent it (account, or a working email address), spam is held back by
the same kinds of limits as the question form, and only admins can list reports, change their status, add
timestamped comments and email the reporter.

How it runs: `scripts/test_bug_reports.mjs` loads the website's own `worker.js` in Node and calls it like a browser.
It talks to two throwaway DynamoDB tables, `pctest-ai-user` and `pctest-ai-bugs-reported` (same layout as
`CreateTables.py`, deleted afterwards). The limit counter (the ContactGuard Durable Object) runs in memory. No email
is sent (`CONTACT_DRY_RUN`), and Turnstile is off (the signed-out check is tested on the live site in test 12).

Steps:
1. Create the two test tables (`pctest-ai-bugs-reported` from `table_definitions("pctest-ai-")`, deletion
   protection off; `pctest-ai-user` with keys pk/sk only).
2. Export `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`.
3. `node scripts/test_bug_reports.mjs website/worker.js`. It creates an admin and a normal user with sign-in
   sessions, then checks:
   - a signed-out report is saved; the form token works once; sending within 3 s is refused;
   - missing email, short title or description, disposable email, a domain without mail and a bad token are refused;
   - the hidden honeypot answers "ok" and saves nothing;
   - a signed-in report records the user ID, name and email from the account (4,000-character description);
   - limits: the third report in a minute from one IP address, then from the same /24 network, then from one
     account, is refused with 429; a body over 20,000 characters is refused with 413;
   - the admin list: 401 signed out, 403 for a non-admin; newest first; search by report ID, reporter email, user ID;
   - status + comment become two log entries with time and admin; a comment alone; nothing to save, an unknown
     status and a non-admin are refused; the On hold and New filters follow the change;
   - emailing the reporter is logged (to, subject, text); an empty message and a non-admin are refused;
   - the home page has the Report Bugs button and pop-up, the admin page the Bug reports tab, and every inline
     script on both pages parses.
4. Delete the two test tables.

Pass: every line PASS (35 checks).

## 14. The orchestrator under faults: nothing lost, nothing counted twice

What it shows: when parts of the grid fail (requests refused, messages lost, objects restarting with their
memory gone, replies lost after delivery), the simple design (sender resends until acknowledged, message IDs,
state saved before answering, overdue copies handed out again) loses no job, pack, result or credit and counts
nothing twice. Why there is no load balancer or queue service: [RELIABILITY.md](RELIABILITY.md).

How it runs: the orchestrator simulator gridSim (Node.js, no network, no accounts). It is in the project
folder `gridSim/` and not yet in this repository; it will be published with the orchestrator. It runs the
real orchestrator logic (`gridSim/core`) against simulated devices and Harness users.

Steps:
1. Node.js 20 or newer; about 1.5 GB of free memory. Run ONE simulation at a time.
2. In `gridSim/`, run the three designs one after another:
   `node --max-old-space-size=3000 sim/run.js --devices 20000 --faults true --reliable 0 --name faults-20k-r0`,
   then the same with `--reliable 1` and `--reliable 2`. Each takes a few minutes and writes
   `results/<name>.json`.
3. Read the two lines starting with `faults (` and `LOST:` in each report.

Fault rates (defaults in `sim/config.js`): 1 % of requests between objects refused, 0.2 % of WebSocket
messages lost, 0.5 crashes per object per hour, 0.2 % of replies lost, 2 s restart.

Pass (for `--reliable 2`): jobs lost 0, packs and results lost in shards 0, credit units missing 0, processed
twice 0; jobs keep finishing. Designs 0 and 1 are expected to fail (they show why the rules are needed).

## 15. Paid services: the price is honest, nothing is charged twice, payments are credited once

What it shows: when a Harness job runs on a paid service, the user is shown a price first; at most the quoted
"most it can cost" is held on their prepaid balance; they are charged what the job really cost (the provider's cost
plus our margin) and the rest is returned; a quote works once and only for the job it was made for; if the first
service fails the next one runs the job, and if all fail nothing is charged; the answer never names the provider;
a Stripe payment is credited once even when Stripe sends it twice, and only with a valid, fresh signature.

How it runs: `scripts/test_paid.mjs` loads the website's own `worker.js` in Node and calls it like the app does.
It creates a throwaway DynamoDB table `pctest-ai-user` and deletes it at the end. The AI services and Stripe are
faked inside the script: no request reaches them and no money moves.

Steps:
1. Export `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`.
2. `node scripts/test_paid.mjs website/worker.js`. It creates an admin and a user with sign-in sessions, then checks
   (numbered as printed): signed out 401; a new account has balance 0; a quote has a price and a higher "most it can
   cost"; with no balance the job is refused and no service is called; only admins can add balance; a chat job is
   charged exactly the first service's cost x 1.3 and the hold is returned; the answer names no provider or model;
   the same quote twice, a quote for other messages and a quote with a changed price are refused; first service
   down = the next one answers; every service down = 502 and nothing charged; an image is charged its price; video
   says "coming soon"; a balance below the most a job can cost is refused; top-up: off without Stripe keys, below the
   minimum refused, a Stripe Checkout for the right amount and user; webhook: wrong signature and an hour-old
   signature refused, a paid session credited, the same session again credited once, an unpaid session not
   credited; the ledger holds every move with the provider (for admins only).
3. The script deletes the table.

Pass: every line PASS (29 checks).

## 16. Harness: one box for every model source

What it shows: whatever the user pastes (a Hugging Face repo or address, an Ollama name or ollama.com address, a
GitHub release, release file or repo file, a Dropbox or Google Drive link, any other address), the app finds the
model files; nonsense is refused; the app opens only planetcompute.ai and Stripe Checkout pages in the browser.

How it runs: part of `scripts/test_local_server.sh` (test 3), on every platform in CI, against the real program.
The checks start with "paste:" and "open browser:".

Pass: every "paste:" and "open browser:" line PASS.

## 17. Harness: pictures made on this computer

What it shows: the program carries its own image engine (stable-diffusion.cpp, the llama.cpp of image models, on
the same ggml library) and makes real pictures with no service involved: it downloads Stable Diffusion 1.5 from
the library (SHA-256 checked), shows progress step by step, makes a PNG, answers the OpenAI-style
`/v1/images/generations`, and never offers an image model for chat. The queue: every request is written at once to
`<data>/planetCompute/queue.json` and made one at a time; a second request waits ("ahead": 1); after a restart (a new
copy replaces the running one) both are back (`/local/image/queue`, "resumed": true) and the first is made again from
the start; Stop ends a request that waits or one being made, and the queue is then empty. The Queue tab (`/local/image/queue?all=1`):
every request since the program started (waiting, being made, done, failed, stopped) with its state and progress, a
thumbnail when done, and Delete (stops it) / Remove from list (`POST /local/image/remove {id}`); a finished one also
shows in My Content (Local Content) at once. The checks before a request
(`POST /local/image/check`, also shown under the Inference controls): engine, model and parts, request, graphics card
and its free memory, the computer's memory, disk, and what happened with this model before (kept per model in
`<data>/planetCompute/gpu_results.json`: after the GPU failed, the next request starts on the way that worked, with
"Try the GPU again" to forget it); a request with a failed check is refused before it is queued; when the GPU fails,
the engine's own message is shown under the result ("Why the GPU did not manage it").

How it runs: part of `scripts/test_local_server.sh` with `WITH_IMAGE=1`, in CI on Linux (CPU) and macOS (Metal),
against the real program. The engine checks and the library check run on every platform.

Steps (on your own computer):
1. Close any planetCompute that is running.
2. `WITH_IMAGE=1 bash scripts/test_local_server.sh ./planetCompute` (Windows, Git Bash: `./planetCompute.exe`).
   It downloads 1.8 GB once. The picture test is 256 x 256 pixels and 4 steps, so it is quick even without a GPU.
3. To look at a picture yourself: open the Harness Compute tab, choose Generate image and This computer,
   download Stable Diffusion 1.5 in the library, describe a picture and press Send.

Pass: every line from "image engine is in this build" to "image model deleted" PASS. The line "queue after the restart: ..." shows
both requests. The line "picture: states ..."
shows the stages seen (loading, sampling, decoding, done) and the seconds it took.

## 18. Harness: video made on this computer

What it shows: the same built-in engine makes short video clips with Wan 2.1 text to video (1.3B, Apache 2.0).
The model comes with its two parts (the video decoder, a safetensors file, and the umt5-xxl text encoder), each
checked against its SHA-256. A clip is a WebM file the browser plays. Frame counts must be 4n+1. Deleting the model
removes the parts only it needed.

How it runs: part of `scripts/test_local_server.sh` with `WITH_VIDEO=1`, in CI on Linux (4-core CPU, no GPU). The
CI clip is tiny (256 x 144, 5 frames, 4 steps), so a CPU can make it. A full sample clip (480 x 272, 33 frames, 20
steps) comes from the "Sample pictures" workflow and is shown at https://planetcompute.ai/temp/.

Steps (on your own computer):
1. Close any planetCompute that is running.
2. `WITH_VIDEO=1 bash scripts/test_local_server.sh ./planetCompute`. It downloads 5.4 GB once.
3. To watch one yourself: Harness Compute tab, Generate video, This computer; download Wan 2.1 in the
   library; describe a scene and press Send. With a GPU of 8 GB or more a 2-second clip takes minutes.

Pass: every line from "the library lists the video model" to "video model deleted" PASS.

## 19. PlanetCompute editions: only metadata added, weights identical

What it shows: an edition of a model file differs from the original only by added `planetcompute.*` metadata; the
weights are byte for byte the same. Details and the licence reasoning: [MODELS.md](MODELS.md).

Steps:
1. Download an original model file and its PlanetCompute edition (the program's library, or the change record's
   addresses).
2. `python3 scripts/compare_edition.py <original> <edition>`.

Pass: the last line is `RESULT: only planetcompute.* metadata was added; the weights are identical.`

## 20. The admin Models tab

What it shows: the admin page lists the model library's master table (planetcompute-ai-models) by category,
through its category index, with every model's files, licence and conditions; only admins can see or change it; an
allowed model can be queued for a PlanetCompute edition, a model whose licence is not allowed cannot.

How it runs: `scripts/test_models_tab.mjs` loads the website's own `worker.js` in Node, creates throwaway tables
`pctest-ai-user` and `pctest-ai-models` (a copy of the real list), and deletes them at the end.

Steps: export the AWS keys, then `node scripts/test_models_tab.mjs website/worker.js`.

Pass: every line PASS (15 checks).

## 21. Save to cloud, the shared page and My content

What it shows: only a signed-in user of the planetCompute program (or of planetcompute.ai itself) can save; another web
site cannot; only picture and video files with a plain name are taken (no paths, no programs), at most 95 MB; the
file lands in B2 at `public/users_uploads/<user id>/<name>`; the link `https://planetcompute.ai/u/<token>` (10 random
letters and digits: it shows neither the user ID nor the file name, nor does the page; the same file saved again keeps
its link; a first-style link `/u/<user id>/<name>` redirects to it; after Delete forever the link is dead for good and a
new file of the same name gets a new one) is the shared page (like sushila.ai/c/...: the file full screen, zoom, full-screen button, views, an information panel
with Download and Report abuse), `<link>/file` gives back exactly the same bytes with the right type, `<link>/download`
the same as an attachment; other names and other folders answer 404. Views: one per visitor per 24 hours; link-preview
bots are not counted. Report abuse opens the contact form with the link filled in. My content
(`planetcompute.ai/mycontent`, `/api/mycontent`): only the signed-in owner; it lists the file with its views and size and
the 2 GB limit; Delete moves it to the trash and its link stops working; Restore brings the link back with the same
bytes; Delete forever and Empty trash remove it; another web site is refused; songs (.mp3) are taken and get a player.

How it runs: `scripts/test_uploads.mjs` loads the website's own `worker.js` in Node with a throwaway table
`pctest-ai-user` (one test session) and the REAL B2 bucket; the test file is deleted from B2 at the end.

Steps: export the AWS and B2 keys (AWS_*, B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME), then
`node scripts/test_uploads.mjs website/worker.js`. In the program: Harness Compute, Inference, Generate image; under
the picture, Save picture (it says the path in Downloads) and Save to cloud (it shows the link; open it: the shared page;
scroll to zoom, ⛶ for full screen, ⓘ for the information). Then open planetcompute.ai/mycontent: the file is listed.
The 2 GB limit itself is not filled up by the test (it checks the limit is reported).

Also (checks R1-R12): the page says "Made with planetCompute.ai" and has a ⚑ Report button that opens a pop-up (what is
wrong, details, optional name and email; signed-out visitors pass Turnstile); `POST /api/media/report` refuses a form
sent within 3 s, no reason, "Other" without details, a made-up link and another web site, and saves a report in
`<prefix>reported-media`. The admin page's tab Reported media: the lookup (a link, a bare code or a first-style link)
shows the owner's user ID and email, the real file name, where the file is (live / trash / deleted), size and its
reports; the list (newest, by status, by link) shows each report; a status change and a comment are kept with time
and admin. The test makes its own throwaway reported-media table with the four indexes and fakes only the rate limiter.

Take down (checks T1-T7): it needs a reason; the file moves to `public/users_removed/<user id>/` (kept as evidence),
the link answers 410 "This was removed." and its file is not served; every report about it says Taken down with the
reason in its log; the owner no longer has it (not in My content or the trash, Restore 404); taking it down twice
404; Undo take down: the same link works again with the same bytes and the reports go back to Reviewing.

Pass: every line PASS (47 checks); in the program, the file is in Downloads and the link shows the shared page.

## 22. The program's Local Content and Cloud Content tabs, and Open pictures folder

What it shows: Harness Compute has the tabs Local Content and Cloud Content next to Inference, Models, API and Account.
Local Content lists every file of the pictures folder (Windows `%APPDATA%\planetCompute\images`, macOS
`~/Library/Application Support/planetCompute/images`, Linux `~/.local/share/planetCompute/images`), newest first, with
counts by kind (Pictures, Videos, Music, Other), search, sort, a large view (Esc closes), and for each file Save (a copy
in Downloads), Save to cloud (shows the link) and Delete (asks once more: "Sure? Delete"). `GET /local/content/file/<name>`
serves only plain names inside that folder (no `/`, `\`, `:` or `..`). Cloud Content shows `/api/mycontent` (views, the
2 GB limit, files in the trash) with Share page, Copy link and Delete (moves it to the trash on planetcompute.ai);
signed out it says to sign in. Open pictures folder (Inference image/video rows, under each result, Local Content)
opens the folder in Explorer / Finder; it is hidden and refused (403) through the tunnel link.

How it runs: the page itself in jsdom (Node) with the program's answers faked: the tabs, the counts, the filter,
the viewer, each button and the request it sends. The Rust side is compiled by CI on all five builds.

Steps (page): `npm i jsdom@24.1.3` in a scratch folder, then a script that loads `client/ui/index.html` at
`http://localhost:7526/local/` with `fetch` answering `/local/content` (a .png, a .webm, an .mp3) and `/api/mycontent`
(one file, one in the trash), clicks Harness Compute, Local Content, Music, a thumbnail, Esc, Save, Save to cloud,
Delete twice, then Cloud Content. In the program: make a picture, open Local Content (it is listed), Save, Save to
cloud, open Cloud Content (it is listed with its link), Open pictures folder (Explorer opens it), Delete.

Pass: the tabs read Inference | Models | API | Local Content | Cloud Content | Account; counts All (3), Pictures (1),
Videos (1), Music (1); Music shows only the .mp3; the requests are `/local/content/save|cloud|delete {"name": ...}`;
Cloud Content reads "1 file · 500 KB of 2 GB used · 1 in the trash"; in the program each step does what it says.

## 23. The program's layout, Connect a Browser and device links

What it shows: the top of the program has four buttons, Contribute Compute | Harness Compute | My Content | Access using
URL; My Content opens Harness Compute, Local Content, and Local Tunnel URL opens Harness Compute, Connect a Browser (the
lit button follows the tab: Cloud Content lights My Content); `/local/#content`, `#access`, `#harness` open the same
(the bar the program adds to website pages links there; "This device" is gone). Harness Compute's tabs: Inference,
Models, Local Content, Cloud Content, Connect a Browser, API, Account. Connect a Browser shows this computer's local
address and its planetcompute.ai/device link (Copy, Make a new link) and every device link of the account (on now /
off, Open, Copy, Delete; Delete all links). Deleting a link takes it off the list, the site refuses it from then on
(`/api/tunnel/connect` answers 410) and a computer connected with it is disconnected (close 4003); that computer's
program then makes a new link by itself. Make a new link deletes the old link and connects with a new one; through
the device link it is hidden and refused (403). The header: the window opens on the program's own page (`/local/`), so the four buttons
are always on top; a website page opened on its own in the window comes back inside it (`/local/#site=<path>`, shown in
Contribute Compute, Compute; only paths on this site); top right: Sign in when signed out (opens the Account tab), the
account's initials when signed in, with a menu (name and email, Account, My Content, Sign out). Harness Compute, Disk space
(`GET /local/storage`): the program, Models, Pictures / videos / songs, and App data (image engine, queue, settings),
each with its size, files and folder (Open folder, `POST /local/storage/open {key}`, not through the tunnel), the
total and the drive's free space; CI checks the four parts and the free space, and that an unknown part is refused. The link ID is kept apart from the device ID (Contribute's credit and
capacity check are not touched): the first link stays the device ID, so links made before keep working.

How it runs: `node scripts/test_device_links.mjs website/worker.js` (the website's own DeviceTunnel code with an
in-memory storage and fake sockets; no keys); the page in jsdom with faked answers; the live site's answers with curl.

Pass: ALL PASS (10 checks); in jsdom the tabs and requests as above; live: delete and delete-all 401 signed out, 403
from another site. In the program: Local Tunnel URL lists your computers; Delete one that is running: within a minute
it is listed again with a new link and the old link shows "Device offline".

## 24. Licence agreement step (models whose licence passes use rules on to users)

What it shows: only models with a licence in LICENCE_AGREEMENTS (website code: Llama 3.3, LTX-2.x Community, Stability AI
Community, OpenRAIL++) are marked "needs additional licence agreement"; their files are refused (403 needs_agreement)
until the signed-in user accepts; the acceptance is saved in <prefix>model-agreements (user, model, licence + version,
time, IP address, email, user agent) for the model and its parts under the same licence, and the user gets a
confirmation email at once; other licences need nothing; a second licence needs its own agreement.

How it runs: `scripts/test_licence_agreements.mjs` loads the website's own `worker.js` in Node, creates throwaway tables
`pctest-ai-user` and `pctest-ai-model-agreements` (deleted at the end), and fakes B2 (a 4-model catalog) and Resend
(emails are captured, none is sent).

Steps: export the AWS keys, then `node scripts/test_licence_agreements.mjs website/worker.js`.

Pass: every line PASS (16 checks). The program side (pop-up, Agree & download, note in the list) is checked by hand
in the real program: download DeepSeek-R1-Distill-Llama-70B signed in -> pop-up -> Agree -> download starts, email arrives.

## 27. A 1M simulation on AWS EC2 (when RunPod has no working CPU pods)

What it gives: the same gridSim run as on a RunPod pod (Section 1d of the README), on an AWS machine that cannot be
left running by mistake.

How it runs: `scripts/aws_gridsim.py run <name> --devices 1000000 --sim "<sim options>"` (from planetCompute-CPP/, AWS
keys in ../.env). It imports the public half of `~/.ssh/planetcompute_pod` as a key pair for this run, makes a security
group with SSH open only to the caller's address, starts an Ubuntu 24.04 r7a.xlarge (4 cores, 32 GB) that powers
itself off after 120 minutes, with power-off set to TERMINATE it, copies gridSim, runs the simulation, copies the log
back and mirrors it to B2 every 2 minutes, saves the result JSON, and then ALWAYS (also on any error or Ctrl-C)
terminates the instance and deletes the security group and the key pair. Every resource is tagged
`Project=planetcompute-gridsim` and written to `.ops/aws_gridsim.json` as soon as it exists.

Steps: the command above; afterwards `python3 scripts/aws_gridsim.py status` must print "nothing of
planetcompute-gridsim on AWS". After a crash of the machine that started it: `python3 scripts/aws_gridsim.py cleanup`.

Pass: the result JSON exists in gridSim/results/ and status shows nothing left.

## 25. Heartbeat servers (admin tab Servers, server-first heartbeats, hand-in, reminder email)

What it shows: only admins see and change the list of heartbeat servers; a pasted private key, a bad hostname or one
outside planetcompute.ai is refused; a new server starts inactive; GET /api/hb/config offers only active servers
that pass the health check, with a one-day pass whose HMAC checks with the shared secret, and nothing without the
secret; batches handed in by a server (POST /api/hb/ingest) need a valid signature, go through the normal heartbeat
(the device row gets the server's time and the volunteer's address and country), count once when resent, and refuse
a forged pass or another device; when no server runs the admins are emailed once per period (day by default; week,
month or never on the tab), also from the hourly Cron Trigger.

How it runs: `scripts/test_hb_servers.mjs` loads the website's own `worker.js` in Node against the test tables
`pctest-ai-user`, `pctest-ai-HeartbeatEtcEC2TypeServers` (emptied at the start and the end) and the other
`pctest-ai-*` tables a heartbeat writes (create them with `DYNAMODB_TABLE_PREFIX=pctest-ai- python3 CreateTables.py`);
the servers' /health answers and Resend are faked (no email is sent).

Steps: export the AWS keys, then `node scripts/test_hb_servers.mjs website/worker.js`.

Pass: every line PASS (35 checks).

The server program itself (hbserver/): CI workflow "Heartbeat server" builds it for Linux x86_64 and aarch64 and
checks /health, a genuine pass (200), a forged pass (401), another device (403), the browser preflight (CORS), and
that a beat survives a restart (journal).

## 26. Heartbeat-server agent: Start / Restart / Stop and automatic restart from the admin page

What it shows: the agent (`hbserver/agent/hbagent.py`) starts the heartbeat program and reports it (running, pid,
since, version, tunnel); Stop on the admin page stops it and it stays stopped even with automatic restart on; Start
starts it; a crash is restarted automatically when the box is ticked (and recorded with its exit code), and stays
down, reported "crashed", when it is not; Restart replaces a running process; an unsigned report is refused; the
admin page shows the controls and its scripts parse.

How it runs: `scripts/test_hb_agent.mjs` runs the real agent with python3 in a temporary folder laid out like a
server's (bin/, etc/, data/, logs/, run/) with a stand-in program (a shell script that only waits), against the
website Worker's own code behind a local HTTP bridge and the pctest-ai-* tables; crashes are made with kill -9.

Steps: export the AWS keys, then `node scripts/test_hb_agent.mjs website/worker.js` (about 3 minutes: the agent
reports every 15 s).

Pass: every line PASS (11 checks).

## 28. The program's Inference pages (menu on the left, Images / Video / Music / Chat / Code, Queue, My Content)

What it shows: Harness Compute, Inference has a menu on the left: CREATE (Images, Video, Music "coming soon", Chat, Code)
and YOUR WORK (Queue with the number waiting, My Content). On a phone the menu sits above the page. Images and Video:
the form (model, size, steps; for video length), Describe the picture with Random and Prompt history, How many (1-4),
Seed (empty = the program picks one and keeps it), Leave out (negative prompt), Generate Images / Generate N Images (Generate Videos for video); beside
it the live cards (the one being drawn first with its step and bar, then the waiting ones in turn, each with Stop) and
the gallery of that kind only, newest first, searchable by prompt. A thumbnail opens large with how it was made (prompt,
model, size, steps, seed, leave out, time and where, date, file), arrow keys go to the next one, and Use these settings
fills the form to make it again exactly. Made pictures keep their settings in `<id>.json` beside the file
(`/local/content` sends it as `meta`; deleting the picture deletes it). Chat and Code keep separate conversations; Code
sends a programming instruction first and picks a coder model. Queue lists every request waiting or being made, and failed
ones (with "Remove failed from list"); a done one leaves the Queue by itself, because it is in My Content (case 25).

How it runs: `cd <folder with jsdom> && node scripts/test_inference_ui.mjs client/ui/index.html` (the page in jsdom,
a fake program answers; no keys). Looked at in headless Chromium too (wide 1400x900 and phone 390x844, light and dark):
no script errors and no sideways scrolling on the phone.

Pass: 25 passed, 0 failed. In the program: make 2 pictures with a seed, open one, Use these settings, make it again:
the same picture.

## 29. One Windows program for every PC (with or without a graphics card)

What it shows: there is one Windows program, `planetCompute-<version>-windows-x86_64.exe` (the Vulkan build; the
separate processor-only Windows build is gone). `vulkan-1.dll` is delay-loaded, so the program starts on a PC without a
graphics driver; it then writes the Khronos Vulkan loader it carries (client/VULKAN_LOADER.txt) to
`%APPDATA%\planetCompute\bin` and uses it: Vulkan finds no GPU, chat runs on the processor, the image engine (in the
same folder) starts and falls back to `--backend cpu`. With a graphics driver it uses the PC's own loader and deletes
the copy. `planetCompute --version` says which: "this computer's loader" or "no graphics driver found, the carried
loader is used".

How it runs: in CI (`.github/workflows/client.yml`, Windows job). The runner has no GPU, so the usual local-server
test with a real chat model (WITH_MODEL=1) is the no-GPU case with a loader. Then the step "Windows PC without any
Vulkan loader" moves every `vulkan-1.dll` away (System32, SysWOW64, the SDK) and takes the SDK off PATH, and checks:
`--version` says the carried loader is used, the copy is in the data folder, the image engine starts next to it
(`sd-cli --help`), and the local-server test with a real chat model passes again.

Pass: both steps green. On a real PC: the program starts and chats on a PC with no graphics driver (a fresh Windows VM);
on a PC with a GPU, Inference says it will be made on the graphics card.

## 30. The website's top bar and Harness Compute tabs

What it shows: every page of planetcompute.ai has four buttons on top, Contribute Compute | Harness Compute | My Content |
Local Tunnel URL (phones: Contribute | Harness | My Content | Local Tunnel URL in one row under the brand); there is no tab bar at the
bottom any more (the account button stays on top on phones). Harness Compute (/harness, also inside the home page) has
tabs: Inference, Models and Local Content show the planetCompute program of the user's computer that is on, through its
link (`/device/<id>/local/?embed=1&tab=<tab>`: the program then hides its own header and tabs; a computer picker when
there are several; "Start planetCompute on your computer" when none is on; "Sign in" when signed out); Cloud Content
shows planetcompute.ai/mycontent; Connect a Browser lists the links (on / off, Open, Copy, Delete; Delete all) and the
localhost address. My Content opens Cloud Content, Local Tunnel URL opens Connect a Browser; the lit button follows the tab, the
address bar follows (/harness#models), Back goes back a tab. While Harness or Admin is open the volunteer status is a
pill in the top bar (hidden from 640 to 899 px wide), so it covers nothing.

How it runs: `cd <folder with playwright-core + chromium> && node scripts/test_site_topbar.mjs website/worker.js <dir> in`
and again with `out` (headless Chromium; the worker answers in-process, account and computers faked). The program side:
the page with `?embed=1&tab=models` in Chromium (no header, Models open; `#content` unchanged).

Pass: signed in 19 passed, signed out 13 passed, no script errors; phone 390 px: no sideways scroll.

## 31. Website downloads and email sign-in on My content

What it shows: Harness Compute, Inference has "Download our client app for Windows, Mac or Linux." in big letters with
Windows / Mac / Linux / All downloads (smaller while the user's program is showing). /download lists Windows, Mac,
Linux and Linux with a GPU, each with its size, version and SHA-256 (from B2 client/LATEST.json); /download/<system>
streams the latest file through Cloudflare, named planetCompute.exe (Windows) or planetCompute; the old
/download/planetComputeClient.exe goes to /download/windows. Harness Compute, Cloud Content (My content) signed out:
an email box, "Email me a one-time code", the 6-digit code, then the pictures, videos and songs show at once, and the page
around it (header) is signed in too; already signed in: the files at once.

How it runs: `cd <folder with playwright-core + chromium> && B2_KEY_ID=.. B2_APPLICATION_KEY=.. node
scripts/test_site_download_signin.mjs website/worker.js <dir>` (the worker in-process; the account faked; the B2 list
read for real, the downloads checked with HEAD only). Without the B2 keys check 2 expects "Not available right now".

Pass: 14 passed (with B2 keys), no script errors; phone 390 px: no sideways scroll.

## 32. Zoom with the mouse wheel (My content on the website; the program's large view)

What it shows: on planetcompute.ai/mycontent (also inside Harness Compute, Cloud Content) a click on a picture or video
opens a large view; in it, and in the program's large view (Inference gallery, Local Content, Cloud Content), the mouse
wheel zooms in and out around the pointer (fit to 800%), drag moves a zoomed picture, double-click gives 250% / fit,
+ - 0 keys, left / right arrows the previous / next file (each starts at fit), Esc closes.

How it runs: website `node scripts/test_site_zoom.mjs website/worker.js .ops/media_samples/out` (Chromium, worker
in-process, files faked); program: the same checks on client/ui/index.html with a fake program (Chromium).

Pass: website 13 passed; program 11 passed; Inference pages (test 28) still 24 passed.

## 33. System tray, one copy at a time, quit keeps the queue

What it shows: the program has an icon in the system tray (Windows notification area, macOS menu bar; Linux when
libayatana-appindicator3 / libappindicator3 is installed): left click or "Open planetCompute" shows the window, "Stop
contributing" presses the console's own "Yes, stop", "Quit planetCompute" ends it. With the icon, the window's close
button hides the window (contributing and the queue go on). Starting the program again replaces the running copy
(/local/quit, then force-close; older copies by any file name planetCompute*). Every quit stops the picture engine;
the queue is on disk all the time (queue.json) and the next start makes the waiting requests, the one being made again.

How it runs: CI compiles it and runs the takeover and queue-restart checks (test 17, scripts/test_local_server.sh);
the tray itself only on a real desktop: start the program, close the window (icon stays, the console keeps computing),
tray: Stop contributing, Open, Quit; start it twice (the first copy goes, the second shows).

Pass: as described; NOT yet tried on a real desktop.

## 34. Names, icons, full screen everywhere, and the tunnel label

What it shows: the two sides are called Share Compute and Receive Compute (were Contribute Compute and Harness Compute),
the people Sharers and Receivers; addresses (/contribute, /harness), API paths and table names are unchanged. The
information and full-screen buttons are Lucide icons (inline SVG, ISC licence, no icon font): on every Local / Cloud
Content card and Inference gallery tile in the program, and on every file on My content; the full-screen button opens
the large view straight in full screen. Pages from the user's computer through the device link (/device/<id>/...,
also inside Receive Compute's Inference / Models / Local Content) carry a see-through, click-through corner label
"Using a Tunnel to Your Local Machine"; pictures, videos and API answers through the link are unchanged.

How it runs: scripts/test_site_topbar.mjs (names), test_site_zoom.mjs (icons, full screen), test_site_tunnel_label.mjs
(the label: in-process worker with a faked user and program, then Chromium); the program's checks in Chromium with a
fake program (information panel, Maximize on cards and tiles, zoom).

Pass: topbar 19 / 13, zoom 18, label 5, download 11; program info 6, maximize 10, zoom 15, Inference 24.

## 35. My Balance

What it shows: a fifth button on top, My Balance (website: every page, it opens /balance; program: a section of its
own). It shows, in Work Units (WU), never as coins: Compute Shared (verified work the account's computers did),
Compute Received (work the grid did for the account; 0 until the pool opens: lifetime_received_uwu in the BALANCE
item), Difference (shared minus received, can go below zero), Lifetime Compute Contributed, Lifetime Compute
Transferred (Work Units redeemed and sent out). Data: GET /api/me/balance (signed in; 401 otherwise). Signed out the
page offers the email sign-in; the program says to sign in on Share Compute, Account.

How it runs: `node scripts/test_site_balance.mjs website/worker.js <dir>` (the worker in-process, DynamoDB answer and
user faked, then Chromium, wide and phone); the program in Chromium with a fake program (five buttons, the numbers,
signed out, header width).

Pass: website 11 passed; program 7 passed; the other site tests (topbar 19 / 13, zoom 18, label 5) still pass.

## 36. Device link offline page, and workhorses

What it shows: a device link (/device/<id>/, also inside Receive Compute's tabs) whose computer is not connected shows
"Your computer is not connected right now." with Try again, Get planetCompute and a retry every 15 s, and may be shown in
this site's own frames (no refused-frame page); signed out: "Sign in to open your computer." with Sign in / Try again.
Workhorses (docs/WORKHORSES.md): the agent asks for its orders first, then runs the copies (own HOME, port 7530+N, the
row's account's sign-in, cores and cap), follows copies / cores / cap / Restart / Stop / Start within 15 s, reports each
copy, and stops all copies when it is stopped.

How it runs: `node scripts/test_site_device_offline.mjs website/worker.js <dir>` (worker in-process, user and device
faked, Chromium). Workhorse agent: against the live website with a temporary row and a stand-in program on the admin
machine (see "Our runs"); the server build in CI (no desktop libraries, local-server test with a real chat model).

Pass: offline 6 passed (the old code fails check 1: 404 with X-Frame-Options DENY); agent run as in "Our runs".

## 37. Many devices of one account sharing at the same time: every one credited, nothing lost or counted twice

What it shows: N devices of one account (already verified by the capacity check) send their status reports at the same
moment, several rounds, and one of them sends each report 3 times at once (racing itself); then all stop. Every
report is answered, every device item ends with its final report and no pending credit, and the BALANCE is exactly the
sum of what all devices reported. The design that makes it so: each device has its own item, written only with a
sequence-number condition (a racing report reads again and adds itself on top, up to 4 tries with a short random
wait); the BALANCE is only ever changed with DynamoDB ADD (never read-modify-write); a device's report carries its
running total, so even a lost report is made good by the next one. Also: a report without an IP address is kept
(ip "unknown") instead of failing on the sessions' by-ip index.

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_credit_concurrency.mjs website/worker.js 50 4`
(the real website code in-process against the TEST tables pctest-ai-*, real DynamoDB, a controllable clock).

Pass: 4 passed with 20 devices x 3 rounds (60 WU of 60) and 50 devices x 4 rounds (200 WU of 200). Before the fix:
the balance was right but 23 of 66 reports failed (empty IP key in the test; a device racing itself beyond 1 retry).

## 38. Wallets on My Balance (testing, devnet)

What it shows: with the Worker variable WALLET_TEST=1 (off = the section is hidden, for production) My Balance has
Wallets (testing · devnet) with Create a wallet, Transfer to my wallet, List wallets. Create offers Phantom
(recommended), Solflare, or a test wallet made in this browser (tweetnacl): its secret key is shown once with Copy /
Download and never sent to the website; the wallet is linked by signing a message. Asked again when you already have
one ("You already have a wallet ... create another one?"). Several wallets per account; the newest is the default;
Make default, Remove; a transfer only to one of your own wallets.

How it runs: `cd <folder with playwright-core, tweetnacl, chromium> && AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_site_wallets.mjs website/worker.js <shots>`
(real DynamoDB TEST tables pctest-ai-*, the Solana network faked, a fake Phantom for the extension path; it cleans up).

Pass: 18 passed.

## 39. Maximized pictures and videos: the text fades after 3 s, a mouse move brings it back; Copy Cloud URL

What it shows: in the program's large view and the website's My Content large view, once maximized (full screen), the
buttons, the information panel, the caption, a video's controls and the pointer fade out after 3 s without a mouse
move (they stay while the pointer rests on a button or the panel); any move, key or wheel brings them back; not
maximized nothing fades. The share page (/u/...) already did this; its video controls now fade with it. In the program,
Save to cloud then shows the link with Copy link, and the program remembers the link beside the file
(<name>.cloud.json), so from then on the button says Copy Cloud URL (copies it, sends nothing again).

How it runs: `node scripts/test_app_viewer_idle.mjs client/ui/index.html` and
`node scripts/test_site_idle.mjs website/worker.js <a picture.png>` (both headless Chromium, no keys).

Pass: 13 passed (program), 6 passed (website).

## 40. Workhorse copies are not listed as the account's own computers

What it shows: the copies of the server program on workhorse servers (device IDs from each agent's report) are left
out of Your computers (Receive Compute), Delete all links, My Balance (Where your compute is being shared) and the
program's list; the admin Workhorses tab links each copy's device page instead.

How it runs: `node scripts/test_site_workhorse_hidden.mjs website/worker.js` (in-process, DynamoDB and tunnel faked).

Pass: 4 passed.

## 41. A real transfer on the Solana devnet (coins are a bonus: Work Units are never taken)

What it shows: the website code (in-process, TEST tables pctest-ai-*) with the real devnet treasury
EFAkhAkLaGSoE1ThuQT7RP2Lw3vCYiHdvNxcJJpkBjG2 and test token 7vSuZp6HJ7pi23gUHbrbtLJWVtjfH43chMhtHeiQpm2z (9 decimals,
1,000,000 minted to the treasury). Coins are a BONUS earned with each Work Unit at the award rule in force when the WU
is earned (locked then, never changed later); sending them never lowers the WU (available or lifetime), which stay
usable for compute 1:1. Steps: a test account with 100000 WU (credited before bonus tracking began) links a wallet made in
the test by signature; its bonus is exactly 100000 x the rule then in force; sending 0.009999 is refused (the
smallest transfer is 0.01; nothing is sent); it sends a third of the bonus; the transfer
settles on devnet with an explorer link; the WU are still 100000 available and 100000 lifetime; the wallet holds on chain
exactly the tokens the website reported; List wallets shows them; more than the bonus left is refused; 2 WU credited
now raise the WU to 100002 and the bonus by exactly 2 x the rule in force. The test account is deleted after.

Move my lifetime balance (user: "'Lifetime Compute Contributed' or 'Lifetime Compute Transferred' is NEVER touched by Receive
Compute"; Transferred goes up when moved to the wallet; when the two are equal everything was moved): a transfer adds
to Lifetime Compute Transferred the same share of what is left (Contributed minus Transferred) as its share of the bonus,
all of it when the whole bonus goes; Compute Shared, Received and the Difference never change. Added steps: 2c the payout
wallet without SOL (faked for one try): refused before anything is reserved; 3b Transferred went up by a third of 100000;
3c My Balance: Shared and Difference unchanged; 8 move everything left (no amount): settled, Transferred = Contributed =
100002, no bonus left; 9 0 WU left to move; 10 on chain the wallet holds both transfers exactly; 11 moving again is
refused and Transferred stays.

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. PCC_MINT=7vSuZp6HJ7pi23gUHbrbtLJWVtjfH43chMhtHeiQpm2z TREASURY_SECRET_FILE=.ops/devnet_treasury.secret node scripts/test_wallet_devnet.mjs website/worker.js`
(in a folder with tweetnacl installed).

Pass: 16 passed (with SITE_PAYS_FEES=1: the site paying the fees is off in production since claims).

## 42. Standby and working bonus rates

What it shows: the website code (in-process, TEST tables pctest-ai-*, real DynamoDB, a controllable clock) pays the
bonus per status report at the award rule in force then. A test rule is put in the test rules table: 0.00000126 per WU,
standby 0.0001 per hour, working at least 0.0002 per hour per verified core x CPU cap. Seven devices report every 5 minutes for 15 minutes, then stop:
an RTX 4090 (verified, 300 WU per 5 minutes) earns per WU (0.004536 per hour); one CPU core (verified, 0.025 WU per 5
minutes) earns the working minimum (0.0002 per hour); three verified cores (0.075 WU per 5 minutes) earn 3 x the working
minimum (0.0006 per hour); eight verified cores at a 20% CPU cap (0.05 WU per 5 minutes) earn 8 x 20% = 1.6 x the
minimum (0.00032 per hour); an idle verified device earns standby (0.0001 per hour); a
verified device that says it is running but does no work earns only standby; an unverified device that claims 1,000 WU
earns nothing. The bonus on the balance must equal the sum of every report computed by the test itself from the rule
(not from the website code), the Work Units credited must be unchanged by the bonus, and /api/me/credit must show the
bonus and the rates in force. Verified cores (measured CPU speed / one reference core, 1/17,000 WU/s since 10/27 14:10; 1/12,000 before) are checked: 3
measured with 4 said -> 3; 2 measured with 8 said -> 2; 64 measured with 4 said -> 4; a slow core -> 1. The clock
is frozen (only the test moves it). The test account is deleted after; the test rule stays (it is the rule now in force on
the test tables).

Rule: while a verified device works (running and some Work Units credited) it earns the larger of (WU x credit per WU)
and (time x working minimum x verified cores x CPU cap / 100); idle, or running with nothing credited, earns time x standby rate.

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_bonus_rates.mjs website/worker.js`

Pass: 13 passed.

## 43. Commit + random audit of the work (credit only for checked work)

What it shows: a device is credited only for work the website has checked. Over the capacity-check socket the
website leases WorkPacks with seeds it chooses (pack i: seed leaseSeed(base, i), 4,000,000 samples, about 10 minutes of
work at the measured speed); the device computes them, commits to all results with a Merkle root (leaves
sha256(le32 i | le32 hits), padded with zero leaves), and only then is told which 20 packs to prove. The website
checks each proof's path to the root and recomputes the pack. A device that computed only a fraction f of its packs
passes with probability f^20 (f = 0.9: 12 %, f = 0.5: one in a million). Passed: all its packs' Work Units are
credited, and the bonus max(WU pay, seconds x working minimum x the cores the work proves). Failed: nothing, and a
strike; 3 strikes in a row hold the device for an hour. A device that works on leases is credited only by audits (its
heartbeats then earn idle standby only).

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_work_audit.mjs website/worker.js`. The
website's own code runs in-process against the TEST tables (pctest-ai-*, real DynamoDB); its capacity-check object
is driven with an in-memory stand-in for the Durable Object, and the script plays the device. Steps:
1 an honest device: hello with leases gets a lease sized to its speed; commit -> 20 distinct packs to prove; the
proofs pass; exactly packs x samples / samples per WU credited, and the bonus by the rule; the next lease follows.
2 half the packs faked (the commitment consistent with the fakes): fails "wrong result", nothing credited, strike 1.
3 right results but a root that is not theirs: fails "proof does not match the commit", strike 2.
5 a commit after 10 minutes + 2 minutes grace: void, no strike. 4 a proof left out: the third strike, the device is
held for an hour and gets no lease; the device row shows 1 passed, 3 failed, held, the audited WU.
6 heartbeats of this device credit no WU ("credited by audits of the work"); the admin list (tab Audits) has all 5.
7 the browser console's own lease code, cut from the served /contribute page: its SHA-256 equals Node's, its seeds
the server's; two stand-in Web Workers compute a lease; its commit and proofs pass the server's audit.
The program's side (client/src/contribute.rs) is checked by `cargo test` in CI (lease_seed, the Merkle root and paths
against vectors this test prints). The test account, devices and audit rows are deleted after.

8 GPU leases, with the console's own graphics card code (from the served page; the dispatches computed by the police
kernel's arithmetic in place of WebGPU): a hello with a graphics card gets a GPU lease (site seeds, 16,384 samples per
invocation, at most 8,192 workgroups a dispatch); the console's dispatches (varying group counts) are committed with
a Merkle SUM tree (each node also carries the number of groups below it, so the root commits to the total); 16 random
group numbers in [0, total) are audited: the console computes those dispatches again and sends their counts and
paths; the site checks the path and sums (the number lies in that dispatch), the leaf, and recomputes 2 groups:
pass, the groups' WU credited; made-up counts: "wrong result", a strike; a commit claiming 50 x its groups: fails.

Pass: 23 passed (and the CI test leases_match_the_server).

## 44. Ledger options (the pool of coins the bonus is paid in, and their shares)

What it shows: the table <prefix>ledger-options (database/CreateTables.py) and the admin tab Ledger options. Coins
are added to a pool (name, symbol, mainnet and devnet mint, decimals, token program, and address_from: the public
wallet address the coin is sent from) and switched active / inactive. Share sets say what share of the bonus each
coin gets; they are effective-dated like the credit rules (never edited; a change is a new set from a future time; a
set not started can be cancelled) and every change is recorded.

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_ledger_options.mjs website/worker.js`
(the website's code in-process, the TEST table pctest-ai-ledger-options, real DynamoDB). Steps: 1 the seed is
PlanetComp, active, 100 % in force; 2 an address that is not a Solana public address is refused; 3 a second coin is
added; 4 shares not adding up to 100 %, or a start in the past, are refused; 5-7 a 60 % / 40 % set is scheduled, shows
as scheduled, and the coins in force are 100 % PlanetComp now and 60 / 40 after it starts; 8 a coin in a scheduled set
cannot be made inactive; 9 the set is cancelled; 10 then the coin can be made inactive and cannot be put in a set;
11 every change is in the audit trail. What the test added is deleted after; the seed stays.

Pass: 12 passed.

## 45. The bonus sent in the coins of the share set in force (a real devnet transfer)

What it shows: a transfer of bonus to a wallet is split by the share set in force (<prefix>ledger-options): each coin
gets its share, in its own decimals (rounded down), and ONE Solana transaction sends every coin (all or nothing),
each from its send-from address, as Token or Token-2022 (read from the mint on chain). The website pays the fees from
the treasury; a coin is sent only when the website holds the key of its send-from address (TREASURY_SECRET_KEY, or
COIN_SEND_KEYS); otherwise the transfer is refused before anything is reserved.

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. PCC_MINT=7vSuZp6HJ7pi23gUHbrbtLJWVtjfH43chMhtHeiQpm2z
TREASURY_SECRET_FILE=.ops/devnet_treasury.secret COIN2_FILE=.ops/devnet_coin2.json SENDER2_SECRET_FILE=.ops/devnet_sender2.secret
node scripts/test_payout_shares.mjs website/worker.js` (in a folder with tweetnacl). Coin 2 is a devnet Token-2022
test coin, 6 decimals like PlanetComp, held by a second wallet (sender 2), made once with setup_coin2.mjs (devnet
only; its key in .ops, never printed). The test puts coin 2 and a set of PlanetComp 60 % + coin 2 40 % (in force
from a second ago) straight into pctest-ai-ledger-options. Steps: 1 without sender 2's key: refused, bonus unchanged;
2 with it: 0.02 bonus goes out as 0.012 PlanetComp + 0.008 coin 2, settled; 3 that one transaction leaves the wallet
holding 0.012 and 0.008; 4 coin 2 is a Token-2022 account, sender 2 signed; 5 the bonus went down by exactly 0.02, the
WU did not move; 6 the transfer's record lists each coin with its FROM address, plus from_wallets, fee_payer and to_wallet. The coin, the set and the account are deleted after.

Pass: 6 passed.

## 46. The account's Solana wallet address (profile and My Balance)

What it shows: an account keeps one Solana wallet address of its own (PROFILE.solana_address on the user table); it
is shown and updated on the profile panel and on My Balance (the same address, the same tables). Every change writes
the old and new address with the time to <prefix>address-audit, and emails the primary address; Previous addresses
lists them. A transfer of the bonus goes to this address (no wallet linking needed). Under the address field on both
pages is the token notice (free of charge, a record of contribution, bragging rights only, not an asset, no value
promised, at your own risk). Only an address is accepted: never a key; a token account or a mint is refused.

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. PCC_MINT=7vSuZp6HJ7pi23gUHbrbtLJWVtjfH43chMhtHeiQpm2z
TREASURY_SECRET_FILE=.ops/devnet_treasury.secret node scripts/test_solana_address.mjs website/worker.js <screenshot dir>`
(in a folder with playwright-core, tweetnacl and chromium; the TEST tables; real devnet; emails captured). Steps: 1 a
new account has none; 2 a non-address refused; 3 a real devnet token account refused; 4 the first address saved;
5 the same again refused; 6 a change: profile updated, two audit rows newest first with times; 7 each change emails
the owner; 8 a transfer to an address not the account's refused; 9-11b the profile panel: shows it, Update (after a
From / To confirmation) saves, Previous addresses lists three changes, the notice is under the field; 12-14b My
Balance: the same address, Update there goes to the same tables (four changes listed), the text never asks for a key,
the notice is under the field; 15 no page errors; 16 a real devnet transfer with no wallet linked arrives at the
account's address. The test account and its rows are deleted after.

Pass: 18 passed. (test_site_balance check 7 now allows exactly this notice on My Balance: 11 passed.)

## 47. The grid, step 1: chat jobs from Receive Compute to volunteers' programs

What it shows: POST /v1/jobs (signed in, an OpenAI chat body) is answered by a volunteer's planetCompute program
that has the model; sometimes a second program runs it too and the answers are compared; the volunteer is credited,
the receiver's Compute Received goes up, and every job is logged (admin tab Grid jobs). See old-testing-code-retired/hungrywolves/HUNGRYWOLVES.md (the wolves were retired on 30 October 2026; DemandSimulation now sends these jobs).

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_grid_jobs.mjs website/worker.js` (the
website's code in-process, the TEST tables, real DynamoDB; its Durable Objects in-process with in-memory storage; each
volunteer program a stand-in that answers jobs as the program does). Steps: 1 no program has the model: 503; 2 one
program: answered in the OpenAI shape with the grid's facts, not checked; 3 the volunteer credited tokens x WU per
token, the receiver's received WU up by the same; 4 a model nobody has: 503; 5 two honest programs, check forced on:
both ran it, agree, both credited; 6 an honest program and one answering differently: disagree, nobody credited;
9-10 the queue: one program answering in 0.4 s, 5 jobs at once: all answered, in the order they came (waits ~0, 0.4,
0.8, 1.1, 1.5 s); 11 a program taking 5 s and a 3 s queue limit: the second job gets 503 "stayed busy";
7 the programs leave: 503 again; 8 the admin list has the 13 jobs with results and times. The program's side
(contribute.rs run_job) is compiled and tested by CI; the live run is the hungrywolves on the InterServer.

Pass: 11 passed.

Added 2026-10-27 (priority and My activity), cases 12-16:
12. Priority: three jobs with `"priority": "low"` (test traffic, the hungry wolves) queued first, then a normal job: the
    normal one runs next (it waits less than the second and third low ones).
13. My activity (`GET /api/me/activity`) before the grid writes: today's totals come from the grid's memory (received,
    of them low priority); details only for normal jobs (low-priority ones keep 1 in 1,000).
14. After the write (`actFlush`, every 10 minutes in production): one item per account and day in user-credits
    (`ACT#<day>`): the receiver's received / failed / disagreed, the volunteer's answered and WU.
15. My activity after the write reads the same totals from DynamoDB.
16. Every per-job row (`JOB#...`) carries `ttl_expires` 90 days ahead (DynamoDB TTL is on for that attribute).
Details go to B2 `activity_logs/<user>/<day>/<time>.jsonl` (not in this test: no B2 key in the test environment; checked
live). The bucket's lifecycle rule deletes that folder's files after 90 days; the folder can be deleted by hand any time.

## 48. The console inside the program's window (Start computing)

What it shows: the program's window shows the website's volunteer console embedded (/?console=1). It opened itself
before its counters were set up, so its script stopped ("Cannot read properties of undefined (reading 'packs')") and
Start computing did nothing in the program, while it worked in a browser tab (user: "'Start Computing' button is not
working on exe. [works fine on browser]"). Fixed: the embedded console opens once the script has run.

How it runs: `node scripts/test_console_embed.mjs website/worker.js <screenshot>` (in a folder with playwright-core and
chromium; the website's code in-process, the signed-in user faked). For /?console=1 and for / (the browser): no
script error while the console opens; with I agree on, Start computing shows "Running: ...". The old website code
fails the /?console=1 checks (the bug reproduced). Also checked by hand through the real program (server build on
Cloud9, its proxy to the live site): the embedded console loads with no error. The "Download our client app" box
("Itching to share more compute? ...") is hidden in the program's window (it is the app) and shown on the website.

Pass: 6 passed.

## 49. Admin tab Move coins (a real devnet transfer)

What it shows: an admin moves a coin of the pool from a wallet the website holds the key of (TREASURY_SECRET_KEY,
COIN_SEND_KEYS; keys never shown) to any wallet address, on the cluster the website is on; the source pays the fee.

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. PCC_MINT=7vSuZp6HJ7pi23gUHbrbtLJWVtjfH43chMhtHeiQpm2z
TREASURY_SECRET_FILE=.ops/devnet_treasury.secret SENDER2_SECRET_FILE=.ops/devnet_sender2.secret node scripts/test_move_coins.mjs website/worker.js`
(folder with tweetnacl; the TEST ledger table; real devnet). Steps: 1 the tab lists the two wallets with SOL and coin
balances; 2 a wrong confirmation (not the destination's last 4 characters) refused; 3 a source without a key
refused; 4 a token account as destination refused; 5 more than the source holds refused; 6 0.5 PlanetComp (devnet)
moved to a new wallet, settled, exactly 0.5 on chain; 7 the move is in the audit trail. The audit row is deleted after.

Pass: 7 passed.

## 50. The program's page: image checks under "details", 1920 x 1080, the wallet address in My Balance

`scripts/test_ui_wallet_checks.mjs` opens `client/ui/index.html` in a headless browser (Chromium, playwright-core); every call
to the program and to planetcompute.ai is answered by the script (the check lines are the ones a Windows PC with Intel Iris Xe showed).

    node scripts/test_ui_wallet_checks.mjs client/ui/index.html <folder for screenshots>

1. All checks pass: the outcome line ("It will be made on the graphics card (GPU).") shows; the 4 lines are folded under "details", closed.
2. A click on "details" opens them.
3. A line that needs attention (Before: warn): "details" opens by itself, with its "Try the GPU again" button.
4. My Balance shows "Your Solana wallet address", its text ("... It is the same address as on your profile."), the current address, since when, and the token notice.
5. "Previous addresses" lists the history (GET /api/me/solana-address/history).
6. Update (after the confirm) posts to /api/me/solana-address and shows "Saved".
7. No page errors.
8. Size has 1920 x 1080 for every image model; picked, the request asks for 1920 x 1080.
9. The video Size has 1920 x 1080 too (marked very slow; the checks warn: many times the pixels of 832 x 480).
10. Under the address: what the wallet holds (each coin and SOL), when it was read, and a "View on Solscan" link.
11. Copy next to View on Solscan copies the Solscan address (the program opens only listed sites in the browser; the Solana
    explorers are now on that list too).
12. Move my lifetime balance: the WU left and the bonus to send; the button on.
13. Next to the button the real charge (fee + one-time deposit = total) and the history (sent, View + Copy).
14. The button opens planetcompute.ai/balance in the browser (a browser wallet cannot connect to the program's window).

Videos: the engine itself cuts every frame. CI patches sd-cli (`scripts/patch_sd_cli.py`): with PC_CROP=WxH in its
environment (set by the program when it had to make the size larger) each result is cut around its centre before the
.webm (or the picture) is written. `python3 scripts/test_sd_crop.py <sd source>/examples/cli/main.cpp <folder>` compiles
that block alone with 3 frames of 1920 x 1088: they must come out 1920 x 1080, starting at row 4.

The engine needs sizes in multiples of 16 (Z-Image) or 64 (FLUX, SD): the program makes 1920 x 1088 and cuts 4 rows from the
top and the bottom (image.rs crop_png). Unit tests (CI, linux-x86_64): `sizes_between_multiples_are_made_larger` (1920 x 1080 ->
-W 1920 -H 1088; 1081 refused), `cuts_png_to_the_size_asked_for` (a 64 x 40 PNG cut to 64 x 32 starts at row 4).

## 51. The program's My Balance: My activity

`scripts/test_ui_activity.mjs` opens `client/ui/index.html` in a headless browser; the script answers /api/me/balance, /api/me and
/api/me/activity (in the program these go through its local server to planetcompute.ai with its sign-in, like the balance).

    node scripts/test_ui_activity.mjs client/ui/index.html <folder for screenshots>

1. My Balance shows "My activity" and asks /api/me/activity?days=14.
2. The day table: a header and one line per day: received (with failures), answered, received and earned WU, tokens, typical wait + run.
3. "Recent jobs" lists each job: time, role (the answering device, or "(test)" for test traffic), model, result, tokens, wait, run, checked, WU.
4. A second click hides the jobs.
5. No jobs yet: a plain line ("No AI jobs yet ..."), no table.
6. Signed out: the activity section is hidden with the balance.
7. No page errors.

## 52. What the saved wallet address holds (website My Balance and the program's My Balance)

`GET /api/me/solana-address/holdings` reads the account's saved address from its profile, then from the Solana network:
SOL (getBalance) and, for every active coin of the ledger options, its token account (the associated account of that
mint, read with getAccountInfo, bytes 64-72) in the coin's decimals. Answers are kept 30 s per address. The Worker variable
WALLET_HOLDINGS=false (also 0, off or no, any capitals) hides the line on both pages; unset or true shows it. `scripts/test_site_holdings.mjs` runs the given worker.js in-process
(DynamoDB and the network answered by the script):

    node scripts/test_site_holdings.mjs website/worker.js <folder for screenshots>

1. The saved address: each active coin read from its token account (6 decimals) and SOL, with a Solscan link.
1b. Every account the wallet owns for our coins, each with its links (user, 2026-10-28: "add all the links for each
   wallet address created by user owner wallet address"; "This will help people looking for a transfer"): the wallet
   (SOL; Solscan, Transfers, Solana Explorer, and "All its coins" = Solana Explorer's token list, which also shows coins
   we do not list) and each coin's account (its address follows from the wallet and the coin; Solscan, Transfers, Solana
   Explorer, Mint). No indexed call (getTokenAccountsByOwner): the public endpoint refuses it ("Indexed requests require a
   personal token") and then blocks the site's other calls for a while (found live, 2026-10-28).
2. The network fails: amounts unknown and the error said, not a made-up 0; the wallet's links are still listed.
3. WALLET_HOLDINGS false, False, 0, off or no hides it (nothing read from the network); true, 1 or unset shows it.
4. No address saved: nothing to read.
5. Signed out: 401.
4a. The wallet holds no SOL but holds PlanetComp: the Solscan link opens its PlanetComp token account (Solscan says "not
    found" for a wallet that never held SOL), with a note why. 4b. No SOL and no coins: the wallet link stays.
6. /balance: under the address, what it holds, when it was read, and a Solscan link. 6b under it, "Accounts this wallet
   owns": one line per account (amount, address, its links, Copy). Screenshot balance_accounts.png.
7. No page errors.
8. /balance, Move my lifetime balance to my wallet: the WU left and the bonus to send, the button on. 8b next to the button the
   real charge (fee + one-time account deposit, total) and what the wallet holds; no transfers yet.
9. After the confirm (address, coins, WU, the SOL the wallet pays, "cannot be undone"): the connected wallet goes to
   claim/prepare, the wallet approves once; says what was sent, receipt, link; 0 left, button off. 9b history row (sent,
   View); the charge line now says fee only. WALLET_MOVE=false (or 0, off, no) hides the box.

The program's page: test 50 step 10. Live check: the same functions on the user's own public wallet address read
1,000,000 PlanetComp at its token account B3yJmc...eyYt1F (the mint has 6 decimals on chain, as in the ledger options).

## 53. Claim: the user's own wallet approves and pays every transfer (a real devnet claim)

What it shows (user, 2026-10-28: "go with claim 100%, add receipt email and history"; "near the button for claim - say -
it may charge a small amount - give actual figure"): Move my lifetime balance to my wallet is a claim. The site reserves the
whole bonus and the WU left, builds ONE transaction whose fee payer is the user's wallet (open its PlanetComp account if
new, then the coins from the send-from wallet, with a one-time reference), signs it only as the send-from wallet and
gives it to the browser; the user's wallet signs and sends it. Landed -> settled + one receipt email; never sent -> released
once its blockhash can no longer land (last valid height + 40 blocks). The site paying fees (/api/wallet/withdraw) is off
unless SITE_PAYS_FEES=1. GET /api/wallet/claim/quote gives the real charge (fee 0.00001 SOL for 2 signatures + the
network's own deposit figure for each account the wallet lacks: 0.00148844 SOL for a Token account, 0.00151384 SOL for
Token-2022 on 2026-10-28) shown next to the button; GET /api/wallet/history lists every transfer.

How it runs: `AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. PCC_MINT=7vSuZp6HJ7pi23gUHbrbtLJWVtjfH43chMhtHeiQpm2z TREASURY_SECRET_FILE=.ops/devnet_treasury.secret node scripts/test_claim_devnet.mjs website/worker.js`
(in a folder with tweetnacl; about 3 minutes: it waits for an unapproved claim to expire). A wallet made in the test
plays the user and signs as fee payer like Phantom; e-mails are captured, not sent.

1. /api/wallet/withdraw refused (403) unless SITE_PAYS_FEES=1.
2. A wallet other than the saved address: refused, names the address to connect.
3. The user's wallet has no SOL: refused with what it needs; nothing reserved. 3b the quote: fee 0.00001, the deposit
   (= getMinimumBalanceForRentExemption), what the wallet holds.
4. Prepared: whole bonus + all WU left reserved; new account; half-signed transaction. 5 history: waiting for your wallet.
6. A second claim while one waits: refused.
7. The user signs and sends; confirm: settled with the link.
8. The coins are in the user's wallet; the USER paid exactly deposit + 10000 lamports; the site's wallet paid nothing.
9. One receipt e-mail (amount, wallet, WU, link). 10 asking again sends no second one. 11 history: sent, link, receipt.
11b. After the first transfer the quote is the fee only.
12. A second claim (account exists): needs only the fee. 13 never approved: released after expiry, bonus and Transferred
    back. 14 that expired transaction signed and sent later: the network refuses it.
15. Claimed again: the user paid exactly 10000 lamports; site wallet nothing. 16 Transferred = Contributed = 110000,
    Compute Shared untouched. 17 history: sent, not approved in time, sent.

Pass: 21 passed. Pages: test 52 steps 8-9b (website: the charge next to the button, the wallet connects and approves once,
receipt + link, history) and test 50 steps 13-14 (program: the charge and history; the button opens planetcompute.ai/balance).

## 54. Who pays for a transfer: two settings, and the admin tab Who Pays for Transfer

What it shows (user, 2026-10-28: "use both and a CF variable will decide that realtime. TRANSFER_CLAIM_USER_PAY = YES or NO
and TRANSFER_PLANETCOMPUTE_PAYS = YES or NO. Make BOTH YES for now. When the users reach 1000 I will make the second one NO";
"PUT this info in the admin tab new one - Who Pays for Transfer - so it will be reminder for me to change the flags later"):
TRANSFER_PLANETCOMPUTE_PAYS=YES: Move sends from the payout wallet, which pays (works in the program too);
TRANSFER_CLAIM_USER_PAY=YES: the user may approve and pay in their own wallet (test 53). Both YES: Move = PlanetCompute pays,
second button "Approve it in my own wallet instead". YES/NO, also true/false, 1/0, on/off; read on every request (a change
in the Cloudflare dashboard applies at once). Both are Worker secrets, set to YES on 2026-10-28. The admin tab shows both
values, the number of accounts, the payout wallet's SOL, the reminder (DUE NOW in red at 1,000 accounts while the first is
still YES), the four combinations with the one in force marked, and how to change them.

How it runs: `node scripts/test_admin_whopays.mjs website/worker.js <screenshots>` (in a folder with playwright-core):
1-3 the settings' meaning, other spellings, unset (old SITE_PAYS_FEES=1); 4 the tab: values, accounts (3, 997 to go), payout
wallet SOL; 5 the reminder and the four combinations, (now) marked; 6 at 1,004 accounts: DUE NOW; 7 after NO: done, NO/YES
marked; 8 no page errors. Pages: test 52 steps 10-11 (website, both YES: PlanetCompute pays, no wallet approval; second
button with its real charge), test 50 steps 15-17 (program: Move sends from the program; claim opens the website).
Test 53 steps 1b-1c (TRANSFER_CLAIM_USER_PAY=NO refuses a claim; TRANSFER_PLANETCOMPUTE_PAYS=YES turns PlanetCompute on).

Pass: 8 passed.

## 55. Messages in the page, never the browser's own windows

What it shows (user, 2026-10-28: "change all the window messages to toast type of messages 100%"): every alert, confirm
and prompt of the website (31) and the program (5) is gone. One kit in every page (the site's HEAD, the program's head):
pcToast(message, "err" | "good") shows a message at the bottom that goes by itself (× closes it); await pcConfirm(question)
asks in the page (OK / Cancel; Enter = OK, Esc = Cancel); await pcPrompt(label, value) asks for a value (the program's
"Add how much to your balance"); pcCopy(label, text) shows a link to copy. The page tests answer these questions in the
page (they used to accept the browser's window).

How it runs: `node scripts/test_toast_kit.mjs website/worker.js client/ui/index.html` (in a folder with playwright-core):
1 every site page (/, /?console=1, /admin, /balance, /harness, /contribute, /mycontent) and the program's page: the kit
once, no alert( / confirm( / prompt( left, every inline script parses; 2 a toast shows and goes by itself; 3 pcConfirm OK
true, Cancel false, Esc false, Enter true; 4 pcPrompt returns what was typed, Esc null; 5 pcCopy read-only with Copy /
Close; 6 no browser window opened, no page errors.

Pass: 6 passed. Also (user: "update wallet address should be active only if the field was changed ... Also if no
history - it has to say that"): Update stays off until the address differs from the saved one (spaces ignored), on the
website's My Balance (test 52 steps 12-13), the profile, and the program (test 50 steps 5-6b); Previous addresses with no
replaced address says "No previous addresses: this is the first wallet address on your account, saved <date> UTC."

## 56. Sign-in codes: no racing the 5-guess limit, one use, limits per address (security review W4)

`AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_auth_codes.mjs website/worker.js` (test tables; e-mails captured).
1 a code is sent; 2 twenty wrong guesses at the same moment: exactly 5 counted, 15 refused as too many; 3 after that even
the right code is refused; 4 the right code sent twice at the same moment signs in once; 5 the same code again: refused;
6 more than 20 guesses from one IP in 10 minutes: 429; 7 codes for many addresses from one IP: more than 10 in 10
minutes refused. Pass: 7 passed. The code before the fix failed 2, 4, 6 (17 of 20 parallel guesses got through).

## 57. Device pages on their own origin, device.planetcompute.ai (security review T1)

`node scripts/test_device_host.mjs website/worker.js`: 1 not signed in: sign-in page; 2 signed in: planetcompute.ai sends
the browser to the device host with a 2-minute ticket (nothing relayed on planetcompute.ai); 3 a POST on
planetcompute.ai/device/... refused; 4 the ticket becomes the link's own cookie (HttpOnly, Secure, Path=/device/<id>/),
the ticket leaves the address; 5 with it the page is relayed, framed only by planetcompute.ai; 6 one link's cookie does
not open another device; 7 forged / 8 altered ticket: no cookie; 9 the device host serves nothing else (/, /api/me,
/balance, /admin, /u/...: 404); 10 a POST from another origin refused; 11 the site frames only itself and the device
host, the device frame is sandboxed; 12 a page over 4 MB refused (T3). Pass: 12 passed. Live: the workhorse's real
link opens through the device host (ticket, cookie, page with the ribbon, frame-ancestors planetcompute.ai).

## 58. Tunnel: device keys, link limits, size limits (security review T2, T3, T4)

`node scripts/test_tunnel_security.mjs website/worker.js` (the DeviceTunnel code with stand-in WebSockets): 1 the first
connection binds the program's key; 2 without it: refused, the program is NOT replaced; 3 another key: refused; 4 the
program itself reconnects; 5 a program without a key is refused even on a new link and told to update (permanent since
2026-10-28, no setting); 6 the old TUNNEL_REQUIRE_KEY setting no longer matters (=0 still refuses); 7 Delete closes the link and names the session that registered it (signed out); 8 a deleted link is refused inside
the link (connect and every request); 9 at most 16 requests at once: the 17th waits its turn (2026-10-30, user: "it has to queue and wait"), 9b it is sent and answered when a slot frees, 9c the line holds at most 400 (then 429 "very busy", retry-after 30; a wait is at most 90 s, then 503); 10 at most 10 new links an hour; 11
at most 20 links per account; 12 deletions are forgotten after 30 days. Pass: 12 passed.

## 59. Server keys, one-time signatures, worker sign-ins (security review W5)

`AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_wh_keys.mjs website/worker.js`: 1 a workhorse row signs
with its own derived key; 2 the same signed request again: no second sign-in (409); 3 row A's key cannot act for row
B; 4 the sign-in reads /api/me; 5 it cannot change the wallet address, move coins, claim, open admin (although the
account is an admin) or delete links (403); 6 no device pages; 7 it is a "worker" sign-in for 8 days. Pass: 7 passed.
Heartbeat servers: test 36's script now signs with the derived key; 28a a replayed batch refused, 28b the derived key
accepted, 28c the master secret itself refused (38 passed); the agent test signs with the derived key (11 passed).

## 60. The program's page after the security review

`node scripts/test_ui_security.mjs client/ui/index.html` (headless Chromium, answers faked): 1 the website console comes
from the site port (E4); 2 the theme reaches that frame by message; 3 the key for tools is shown and the browser link
carries the secret (E1); 4 a new wallet address asks for the emailed code in the page (W6); 5 the outside-the-library
switch asks first (E5); 6 no page errors; 7 #site=/balance from the site port; 8 #site=/\evil.example refused (E6).
Pass: 8 passed. The Rust side (E1 secret, E2 names, E3 headers, E4 site port, E5 engine process, E6 queues, T2 key, T3
streaming) is compiled and checked by CI; the live checks after install are in the runs table.

## 61. The engines run in the operating system's sandbox

Proves (user, 2026-10-28: "yes add the OS sandbox for all three"): the model engine (the program's second copy started
with `--llm-worker`) and the image engine (sd-cli) are started inside the operating system's sandbox, so a hostile model
file that took over an engine can read only the models and the engine's own folder, write only the pictures folder (the
image engine; the model engine writes nothing), cannot connect anywhere and cannot start other programs.

How (client/src/sandbox.rs):
- Linux: a launcher copy of the program (`--sandbox-exec`) sets Landlock (files: the system's libraries and drivers, the
  models, the engine's folder, the pictures folder for the image engine; only the engine itself may be run) and seccomp
  (no sockets, io_uring, ptrace, process_vm_*, bpf, userfaultfd, keys, perf events; the model engine also no execve), then
  becomes the engine. Both stay for the engine's life. Without Landlock (Linux older than 5.13, or switched off) only
  seccomp applies, and `--version` says so.
- macOS: the same launcher calls sandbox_init with a profile: no network, no fork, no other programs, no Apple events or
  Launch Services, no clipboard or keychain service, no writing except the pictures folder and the GPU cache, no reading
  of /Users, /Volumes, the temporary folders or the keychains except the engine's own folders. The program's folder
  and the folders above it, up to (not including) the home folder, may be listed (names only; Metal looks for its GPU programs next to the program and the
  engine stops without it), never read into.
- Windows: an AppContainer ("planetCompute.engine", no capabilities, so no network) that may use only the folders the
  program gave it (the models and the engine's folder: read; the pictures folder: write), inside a job that allows one
  process (no other programs) and ends it when the program ends.

How it runs: `planetCompute --sandbox-check`, first in `scripts/test_local_server.sh` on all five CI builds. It writes a
file in the models folder and one in the temporary folder, then starts each kind of engine in its sandbox; inside, the
probe (`--sandbox-probe`) tries to read both files and one next to the program, list the home folder, write in its folder and in the temporary
folder, connect to 1.1.1.1:443 and start /bin/sh (Windows: cmd.exe). A check is skipped (SKIP) only when the program
itself cannot do it either.

1. Run `planetCompute --sandbox-check`.
2. Expected, for both the model engine and the image engine: PASS reads the models; PASS cannot read a file outside its
   folders; PASS cannot list your home folder; PASS cannot read a file next to the program; PASS cannot write into the models folder (model engine) / PASS writes the
   pictures folder (image engine); PASS cannot write outside its folders; PASS has no network; PASS cannot start another
   program; then `ALL PASS`.
3. The same CI run then answers chat (Paris) through the sandboxed model engine on all five builds, and makes real
   pictures and a video through the sandboxed image engine on Linux and macOS (tests 3, 25, 27).

## 62. The program's About box in plain words

`scripts/test_ui_about.mjs` opens `client/ui/index.html` in headless Chromium (playwright-core) with `/local/info` faked
(a Windows build's real engine line). No keys.

    node scripts/test_ui_about.mjs client/ui/index.html <screenshot.png>

1 a table: Version, Computer (Windows, 64-bit (Intel / AMD)), Local address, Device ID; 2 Model engine named without
the raw line, Processor features by name (no "= 1", no LLAMAFILE/OPENMP/REPACK); 3 Engine safety in plain words, no
Graphics row unless the engine names a graphics backend; 4 the raw llama.cpp system line and the sandbox line kept
under "Technical details" (folded); 5 no page errors.

## 63. WorkPack kernels: the same exact answer on every machine (SherpaHub stage 1)

Spec: `docs/SHERPAHUB.md` sections 3-4. Code: `client/workpack` (crate), `website/workpack_kernel.mjs` (browser).
No keys, no network.

1. Crate tests (any machine with Rust; CI job `workpack`):

       cd client/workpack && cargo test --release -- --nocapture

   - `matmul_matches_naive_on_200_shapes`: the fast `matmul_i8` equals the plain triple loop on 206 shapes
     (1x1x1 to 67x301x71, odd sizes, k up to 4096).
   - `matmul_extremes_are_exact`: all -128 / all 127 / mixed at k = 4096 give exactly va x vb x k.
   - `freivalds_accepts_correct_and_catches_every_single_change`: a correct tile passes; 1,000 single-cell changes
     (+1, -1, sign flip, random) are ALL caught; an all-zero tile and a wrong length fail.
   - `conformance_vectors` + `pinned_vectors_match`: the 6 cases' SHA-256 equal `client/workpack/tests/vectors.txt`.
   - `mc_pi_and_lease_seed_unchanged`: the benchmark kernel moved into the crate unchanged.
   - wire tests: round trip of all 4 message kinds; EVERY truncation and a 1-byte extension refused; lying sizes,
     wrong kernel, magic and version refused; 20,000 randomly damaged / junk messages never panic.
   - `speed` prints GOP/s of `matmul_i8` (logged, not a pass rule).
2. The program on every platform (CI, each of the 5 builds, step "WorkPack kernel conformance"):
   `planetCompute --workpack-check` prints the 6 hashes and the speed; CI compares them with `vectors.txt`. Expected:
   identical on Windows, macOS, Linux (x86_64 and the ARM Mac), `ALL PASS`.
3. The browser kernels: `node scripts/test_workpack_vectors.mjs client/workpack/tests/vectors.txt` runs BOTH the
   WebAssembly SIMD kernel (`website/workpack_kernel.wat`, embedded in `website/workpack_kernel.mjs`) and the plain
   JavaScript fallback: SIMD available; for each kernel the 6 cases = naive and = the Rust hashes, 200 random shapes
   = naive, the 3 extremes at k = 4096 exact (33 checks); speed of both logged.
4. The embedded WebAssembly bytes are exactly the `.wat` source (CI job `workpack`): `npm i wabt@1.0.36` in a temp
   folder, `node scripts/build_workpack_wasm.mjs <repo>` from there, then `git diff --exit-code
   website/workpack_kernel.mjs` must show no change.

## 64. SherpaHub fault simulator (SherpaHub stage 2)

Spec: `docs/SHERPAHUB.md` sections 5 and 8. Code: `client/workpack/src/hub.rs`, `store.rs`, `device.rs`; test
`client/workpack/tests/sim.rs`. A REAL hub and REAL devices (the real kernel computes every tile) on a virtual clock;
messages arrive in order per device (as on a WebSocket), 20-100 ms each way; device speeds log-normal (sigma 0.8)
around 50 ms per unit; devices join over the first 2 s.

    cd client/workpack && cargo test --release --test sim -- --nocapture --test-threads=4

Every scenario must end with: Done; the assembled product equal to the reference byte for byte; the final
whole-product Freivalds check passed; no honest device ever struck; credit = checked units (= units without
crashes); no panic. Each prints one `SIM` line (makespan, ideal, packs, hedges, timeouts, duplicates, refused,
stale, needs, blocks, traffic, struck, banned).

| Scenario | Trouble | Extra pass rule |
|---|---|---|
| a-one / a-500 | 1 device; 500 devices, 16,384 units | - |
| b-leave | 300 devices, 30% leave per hour, back after 5-15 min | - |
| c-hedge / c-nohedge | 5% devices 20x slower, with and without hedged copies | hedging used and never slower |
| d-liars | 5% devices change one cell or a whole tile in every pack | liars caught and banned; only liars struck |
| e-dups | 30% of results delivered twice, up to 30 s late; leaves | duplicates seen, credited once |
| f-crash | the hub killed and restarted 5 times (state from the checkpoint directory only) | old-epoch results dropped |
| g-damage | 5% of messages to the hub cut, junk, foreign job, wrong epoch | refused / stale counted |
| h-cache | devices hold only 2 blocks | finishes (packs sized to the cache) |
| i-scale | 65,536 units, 2,000 devices | under 60 s real time |
| j-effic | 100 devices, ~160 units each | makespan < 1.35 x ideal, duplicate work < 5% |
| replay | leaves + liars + duplicates | same seed = same event trace and same stats |

## 65. SherpaHub broker on the site (SherpaHub stage 3)

Spec: `docs/SHERPAHUB.md` section 10. Code: `website/worker.js` (`SherpaBroker`, `sherpaConnect`, `sherpaStatus`,
`sherpaAdmin`). The REAL class runs in the local Cloudflare runtime through a test-only entry that replaces sign-in
with `?user=&device=&key=` (`scripts/sherpa_dev/entry.js`, never deployed). No keys, nothing live.

1. Start the broker (empty state each time):

       cd scripts/sherpa_dev && cp ../../website/worker.js . && rm -rf .wrangler
       npx -y wrangler@3.99.0 dev --port 8799 --ip 127.0.0.1

2. `node scripts/test_sherpa_broker.mjs http://127.0.0.1:8799` (29 checks, about 40 s):
   no hub -> devices refused, status 0 hubs; a hub connects, a device's hello reaches it with a device ID, cache and
   cores; device -> hub binary arrives prefixed with the device ID, junk (bad magic) dropped; hub -> device arrives
   byte-identical; credit and strike counted per account; a newer connection of the same device replaces the old
   (4000, hub hears gone + a new ID); ping -> pong; another copy of the program (other device key) cannot take a hub
   name; the hub restarts and is introduced to the devices still connected (they stay connected); ban -> closed 4008
   and refused on reconnect; two hubs share new devices; a hub whose job is finished gets none; a device leaving ->
   gone; a hub leaving -> its devices closed 4010 and it is off the directory; a message over 1 MiB is never relayed.
3. Live, after a deploy (no sign-in needed): `/api/sherpa/status` = `{"hubs":0}` (until a hub runs); WebSocket
   requests over HTTP/1.1 (`curl --http1.1 -H Upgrade:websocket ...`): `/api/sherpa/hub` and `/api/sherpa/device`
   signed out -> "Not signed in.", with a foreign Origin -> "Cross-site request refused."; `/api/admin/sherpa`
   signed out -> "Not signed in.".

## 66. The browser's SherpaHub device code through the real broker

Code: `website/workpack_device.mjs` + `website/workpack_kernel.mjs` (the text the page runs; `node
scripts/embed_workpack.mjs --check website/worker.js` proves the page carries exactly these files: CI job
`workpack`). With the broker of test 65 running:

    node scripts/test_sherpa_device_js.mjs http://127.0.0.1:8799

The JavaScript test hub (`scripts/sherpa_test_hub.mjs`: PACK -> NEED -> BLOCKs -> PACK -> RESULT, every unit compared
with the plain kernel) leads two jobs. Pass (7 checks): WebAssembly SIMD available; 16 units exact with one device,
NEED used, a corrupted block refused by the device; 32 units exact with 3 devices (one with room for 2 blocks only,
one on the plain JavaScript kernel), the small cache never holds more than 2 blocks, nothing refused.

## 67. The contributor page computes SherpaHub packs (headless Chromium)

    cd <folder with playwright-core and chromium> && node <repo>/scripts/test_sherpa_page.mjs <worker.js> http://127.0.0.1:8799 [screenshot]

The page (given `worker.js`, in-process; `/api/me` faked signed in; `/api/sherpa/status` says 1 hub) starts
computing; its `/api/sherpa/device` WebSocket is piped to the broker of test 65 where the JavaScript test hub leads a
64-unit job. Pass (6 checks): all 64 units exact, one device connection; the meter "SherpaHub work" shows 64 pieces;
WebAssembly SIMD used (not "plain JavaScript"); the pi WorkPacks run again after the packs (they pause only while a
pack computes); no script error. Also re-run test 48 (`test_console_embed.mjs`) and 30 (`test_site_topbar.mjs`).

## 68. The real SherpaHub and real devices end to end (program + browser code + broker)

Needs a Linux machine with Rust, Node, cmake and clang (a RunPod CPU pod: RESUME_HERE 10.4). Build the server
program (`cd client && cargo build --release --no-default-features --features llama`; `models/` must be next to
`client/`), then from the repo root:

    bash scripts/test_sherpa_e2e.sh client/target/release/planetCompute

It starts the broker (test 65), `planetCompute --headless --sherpahub` with `PLANETCOMPUTE_SITE=http://127.0.0.1:8799`
(the program sends its session and device key to planetcompute.ai only), 3 JavaScript devices, 2 lying JavaScript
devices (`scripts/sherpa_js_devices.mjs --lie`: one wrong number per tile) and 3 programs `--headless --contribute
--cores 2` (their own HOME each). Pass (8 checks):
1. job 4096x4096x4096 (4,096 units) DONE = every unit Freivalds-checked AND the whole product passed the final
   check; program devices and JavaScript devices both computed; both liars banned (closed 4008); the hub logged it;
2. a new job 8192x4096x8192 (16,384 units); the hub is killed (`kill -9`) after ~500+ units and started again: it
   continues THE SAME job in epoch 2, keeps the units done before the kill, and ends DONE.
Crate tests (`cd client/workpack && cargo test --release`) include `tests/stage3.rs`: packs computed on 4 threads
give byte-identical RESULTs to 1 thread; with a 64 KiB message limit no RESULT is larger (packs of 2-3 units).

## 69. Jobs of the admin tab in the SherpaHub rooms (local runtime)

Start the broker as in test 65, then `node scripts/test_sherpa_jobs.mjs http://127.0.0.1:8799` (23 checks): a job
given while the hub is offline reaches it when it connects, then `jobs_end`; a matrix job's log (running, credits and
strikes per device with its name, progress from the status, done); a prompts batch: the hub gets the prompts, each
prompt's line is built from tsent / tresult / tcheck (done by whom, AGREE, failed after the last try, waiting); a
picture in 3 parts is joined (B2 is not reachable locally: the log says so); cancel reaches the hub and the job is not
sent again after a reconnect; the list is newest first; a device with models goes to the hub with prompts waiting, a
browser-like one to the hub with packs; a hub with no work sends its devices on (4010).

## 70. The admin tab SherpaHubs (headless Chromium)

    cd <folder with playwright-core and chromium> && node <repo>/scripts/test_admin_sherpahubs.mjs <worker.js> <screenshot dir>

Answers faked. Pass (20 checks; 8 added for Update, Log, Console, Drain and the models panel): the server row (folder, agent reporting, copy #1 connected with its job and devices,
copy #2 not yet), not on the Workhorses tab; Start and Stop (after the question) and the copies select (4, role
sherpahub) send the right calls; image prompts offer picture models only; Give this work sends the batch (model, 3
prompts, check 34%, width 768, any hub) and shows the answer; a matrix job shows pieces and GOP and is sent with its
sizes; the jobs list; the job detail with who did each prompt (e-mail, device name and id), the check, the failure, the
log; the picture links to the private file route; no script error.

## 71. The real SherpaHub with jobs from the tab, end to end

On a Linux machine with Rust and Node (a RunPod pod), the server build as in test 68, then from the repo root:

    bash scripts/test_sherpa_jobs_e2e.sh client/target/release/planetCompute

`planetCompute --headless --sherpahub` (no job of its own) behind the broker; 3 JavaScript devices taking whole
prompts for the fake models `fake-chat` / `fake-image` (`scripts/sherpa_js_devices.mjs --prompts`), 2 pack devices;
jobs given through the room as the tab does (`scripts/sherpa_jobs_e2e.mjs`). Pass (18 checks): start-up line; a chat
batch of 20: all done with the right answers, by prompt devices, each its own seed, the checked ones on ANOTHER device
and AGREE, the log; 3 pictures of ~3 MB arrive whole (main and check copy, in parts) and AGREE; a matrix job DONE with
where the pieces went; a batch and a matrix job side by side; a running matrix job cancelled and the next job goes on;
a lying prompt device: every DIFFERENT check involves it and no AGREE does; the hub killed (kill -9) in a 40-prompt
batch and started again: the batch finishes (40 of 40) from where it was.
Unit tests: `cargo test --release --no-default-features --features llama sherpa` (4: every prompt once and checks
on another device, retries then failure, a device leaving and lonely checks, pictures in parts and compared).

## 72. The PlanetCompute pool: free with a daily limit (POOL_DAILY_LIMIT)

User 2026-10-28: "free for now with a daily limit (the limit needs to be a CF non secret env variables)". Variable:
**POOL_DAILY_LIMIT** (plain Text on the Worker in the Cloudflare dashboard; requests per account per UTC day; `0` =
the pool is closed; not set or not a whole number >= 0 = 50). Routes: `GET /api/pool` (open, limit, used today, the
chat models volunteers' programs offer with how many computers have each) and `POST /api/pool/chat` (= the grid's
`/v1/jobs`: the request goes whole to one volunteer's planetCompute). Counter: `<prefix>user-credits` item
(user, `POOL#<day>`), given back when the pool could not answer; low-priority test traffic (hungry wolves) is not
counted.

    node scripts/test_pool_limit.mjs <worker.js>

In-process with an in-memory DynamoDB and a scripted grid (12 checks): signed out 401; `/api/pool` shows the limit from
POOL_DAILY_LIMIT, use, models with computer counts; 3 answered then 429 with the limit and the reset time; refused
requests never reach the grid; an unanswered request (503) does not count; wolves not counted; 0 closes the pool
(403); unset or bad = 50; the answer keeps the chat-completion shape.
The program's side is in test 28 (`test_inference_ui.mjs`, checks 26-30): the pool button on Chat (its model list with
computer counts, today's use, Send), the answer with who answered and the double-check, Send off at the limit, not
offered for pictures and video yet, and About shows the Mode (Regular / SherpaHub).

## 73. Pictures and videos from the pool

Site (in `scripts/test_pool_limit.mjs`, checks 10-18; fake B2, workhorse rows and a SherpaHub room): picture models the
in-house computers have READY (2 computers), not parts, not from stale servers or SherpaHub rows; a request becomes a
one-prompt hub job for that account (no check copy, sizes kept as asked, any even number 128-2048 such as 1080 x 1350 for Instagram, `for_user`); a model no computer has ready is
refused; the list (waiting -> done, who made it, how long); the file only for the account that asked (another gets
404); the media limit is its own (POOL_DAILY_MEDIA_LIMIT, 429 at the limit; chats not touched); no hub = 503, not
counted; unset = 10, 0 closes it.
Program (in `scripts/test_inference_ui.mjs`, checks 29, 31, 32): the pool on Images shows the pool's picture models,
the time and today's count; Make asks the pool and a card says it waits; when it is done the program saves it into
the pictures folder once (with who made it) and it is in the gallery.
End to end (in `scripts/test_sherpa_jobs_e2e.sh`, step 8): the broker is restarted (as a site deploy drops every
WebSocket) while 6 slow prompts are being made: all finish and no prompt is given out twice. Unit test in
`sherpa_prompts.rs`: a device that reconnects keeps its prompt and its answer is accepted under the old task number.

## 74. my.planetcompute.ai: shared pictures and videos from Cloudflare's cache

Plan and decisions: `planetCompute/ways2SaveMoneyOnStorageAndViews.txt` sections 8-14. Cloudflare
rules (re-runnable): `BrowserCFWorkerCode/my_planetcompute_rules.py`.
Site (in `scripts/test_my_planetcompute.mjs <worker.js>`, 25 checks; fake B2 with two buckets, fake DynamoDB, fake
Cloudflare API): before the bucket planetcompute-user-media exists saving works as before (old /u/ link); after: saving gives
my.planetcompute.ai/<token> and writes the folder (index.html, d.png as a server-side copy, meta.json, views.json; the
shared s-assets script and style once), kept a year (b2-cache-control), views.json 10 minutes, Cloudflare purged;
the page has the picture and every detail without script, Download through planetcompute.ai, og:image, the script as
a file (no inline script); the program's multipart upload publishes f.webp / p.webp (a part that is not WebP is
refused), the page shows p.webp and zooms to f.webp, user text (model name) escaped; the same file saved again under
another name gets the same link and no second copy; an old /u/<token> link gets its folder (keeping its views) and a
301 to my.; /api/view writes one Analytics Engine point (no database), sample size as weight, not for link-preview
bots or with MEDIA_VIEWS_COUNT_ACTIVE=0, bad token 400; CORS: preflight and /api/me, /api/contact/token,
/api/media/report allowed for my. with credentials, any other site still refused; trash leaves only a stub index.html
that goes to planetcompute.ai (purged), restore publishes again, My content lists my. links; Download falls back to
f.webp when the original is gone; the hourly job (cron 47) writes config.json from the variables and adds the
Analytics Engine totals into DynamoDB and views.json (41 + 100 = 141), and switching counting off reaches config.json.
Program (unit tests in `client/src/webshare.rs`): a 1080 x 1350 PNG gives three WebP files (full, small 1024 x 1280,
small with the tag), smaller than the PNG; a 512 x 512 picture keeps its size; shrink averages; the tag goes bottom
right; the multipart body.
Live (after the bucket exists): `curl -sI` on my.planetcompute.ai, /, /xxxxxxxxxxxx, /abc, /.env, /<token>/x.exe,
?x=1, POST -> 302 https://planetcompute.ai/; /<token> 200 text/html, second request cf-cache-status HIT; a foreign
Referer on f.webp gets pt.webp.

## 75. Top bar on every page: day/night and the account menu always on screen

User (2026-10-29): the day/night button was hidden; on phones the sign-in/profile button must ALWAYS show at the top
right on every page, as a person icon (initials when signed in) that opens a menu. Found: on phones the status pill
(fixed, 62 px from the right) sat on top of the account button; at 768 px the bar was wider than the screen; Receive
Compute, Balance and My content had no account button.
In headless Chromium with the given worker.js answering in-process (cd to a folder with playwright-core):
- `scripts/test_site_header_visible.mjs <worker.js> <dir>`: /, /mycontent, /harness, /balance, /admin at 320, 360,
  390, 430, 600, 768, 1024, 1440 px, signed in and out (80 cases): the day/night and account buttons are displayed,
  inside the screen and nothing is on top of their centre (elementFromPoint); the page is not wider than the screen.
- `scripts/test_site_account_menu.mjs <worker.js>` (10 checks): signed out the person icon opens Sign In / Sign Up;
  Escape and a click elsewhere close it; Sign Up on another page goes home and opens the email sign-in, which shows
  the new note and "Email me a one-time code"; signed in the button shows the initials (MG); the menu shows name +
  email, My Account / Profile, Settings, Sign Out; Profile opens the profile sheet; Sign Out posts /api/auth/signout
  and the person icon comes back; Settings from another page opens the profile sheet at home.
- `scripts/test_site_pill_room.mjs <worker.js>` (48 checks): the phone status pill with 0.00, 999.9, 12.3M, 100M,
  1.23B, 5000T never covers the site name or the buttons at 320-600 px (credit is shown in at most ~5 characters).
- `scripts/test_site_pill_lifetime.mjs <worker.js>` (5 checks; user: "show life time balance - this always either grows or
  constant"): signed in the pill shows the lifetime contribution (162.9 on a phone, "Lifetime Compute Credit" on the desktop
  card); a lower later answer never lowers it, a higher one raises it; signed out it shows this tab (0.00). Server: addCredit
  only ever adds (negative amounts become 0).
Regressions: test_site_topbar 19/19, test_site_tunnel_label 6/6, test_site_workhorse_hidden 4/4, test_console_embed
3/3, test_site_balance 11/11; test_site_download_signin 10 + 1 failure that the code before this change has too.

## 76. Numbers with commas, at any size (My Balance, activity, account sheet, admin tables)

User (2026-10-29, with 1 trillion WU on the account for testing): "planetcompute.ai/balance is messed up with big numbers -
overflowing - also I do not see commas". Every page now has `pcNum(value, decimals)` (in HEAD): commas, rounding done on the
digits (BigInt), so 1,000,000,000,000.00 is exact. My Balance cards: 2 decimals (under 1 WU up to 6, so 0.0012 is not shown
as 0.00), smaller type for long figures, wrap instead of overflow.
`scripts/test_site_numbers.mjs <worker.js>` (10 checks, headless Chromium): at 360, 390, 768, 1280 px every balance card fits
and the page is not wider than the screen, lifetime shows 1,000,000,000,000.00 WU; the formatter (1,234,567.89 / 0.01 / 5 /
0.00 / 1,000,000,000,000,000,000.00); the activity table has commas in jobs, tokens and WU. test_site_balance check 5 now
expects the new format (123.46, 0.00, 20.00).

## 77. Receive Compute with no PC connected: Express mode

User (2026-10-29): a message and button on Receive Compute: full inference needs the app on your PC; until then Express mode
with most fields greyed out; Connect when the app runs. Design and texts: planetCompute/WORKPACKS_STATUS_AND_SCIENCE_LANE.md 17.4.
`scripts/test_express_mode.mjs <worker.js> [shots]` (19 checks, headless Chromium, the site's own code, pool/devices faked):
desktop banner with ONE "Download for Windows" (by the browser's system) + Other systems, the sign-in note with the email,
the old three-button line not drawn; chat: model active, Length/Creativity/System prompt/Attach files locked with "Available
when your PC is connected"; today's use; a chat question answered by the pool; Picture: "Generate Images", sizes incl. 1080 x
1350, How many/Steps/Seed/Leave out/Engine locked; Generate Images sends 1080 x 1350 to /api/pool/media, "Queued", the card
"Waiting in the queue…", then the picture and Download (planetCompute-<job>.png); the PC comes online: within ~10 s the page
shows it with "Connected to DESKTOP-HOME" (no click); Connect with a PC known but off / with none: the two messages; a later
visit: the slim strip, its button opens the banner; phone: phone text (Local Tunnel URL), "Email me the download link" posts
/api/me/email-download-link and says "Sent to ..."; the phone page fits and its buttons share the first row with the logo;
signed out: "Sign in to use Express mode or to connect your PC." + Sign In; six computers: only "WASMONE, ip-172-31-82-204
(off now) and 4 more: see Local Tunnel URL." and Connect names WASMONE.
Also: "Generated on" on shared pages = "the user's own computer using Client" (Express results, once shareable: "the
PlanetCompute pool using Browser (Express mode)"); test_my_planetcompute check 4. The 4 pages already shared were rewritten in
B2 and purged (a purge during the 2026-10-29 Cloudflare incident missed one data centre; purged again: 24/24 new).
Changed checks: test_site_download_signin 1 (the banner, not the old line), test_site_topbar 19 (the Express sign-in title).

## 78. The computer list is checked live (Connect to my PC)

User (2026-10-29): "it is not connecting to my PC ... keeps saying Your PC WASMONE is offline ... it has to query and get the
active tunnel connection". Cause: the account list (Durable Object tunnels:<user>) was told "online" once at connect and
"offline" at close; a lost message (the Durable Objects incident that day) left it wrong until the program reconnected.
Now: /api/tunnel/devices?verify=1 (Connect to my PC, the page's first look) asks each computer's tunnel
(tunnel:<user>:<device>/status: open connections) and corrects the list; a connected tunnel repeats "online" every 5 minutes
(alarm); the notice is retried 3 times. `scripts/test_tunnel_verify.mjs <worker.js>` (7 checks, fake Durable Objects): the
stored list unchanged without verify; with verify WASMONE (connected) online, the list corrected with one /set, LAPTOP stays off,
the plain list right afterwards, and the other way round (list online, no connection -> offline); alarm + retries in the code.

## 80. The capacity check accepts a right answer that came late

User (2026-10-29), in the program: "PlanetCompute's capacity check failed: the answer arrived too late" every minute at 4
cores 20% + GPU 30%. Cause: the first check is sized for a guessed speed; the real speed was only recorded on a PASS, so a
machine slower than the guess stayed late forever. Now the answers are checked first; a right answer up to POLICE_SLOW_X (6)
times past its deadline passes at the measured (lower) speed; later than that it fails "too slow" but the speed is kept so the
next check fits the machine; a wrong answer fails and its speed is not used.
`scripts/test_police_slow.mjs <worker.js>` (4 checks, the CapacityPolice Durable Object with a fake storage): right 2x late
-> pass, speed measured; right in time -> pass; right 10x late -> fail, speed kept; wrong -> fail, speed not taken. On the
code before the change checks 1 and 3 fail (the bug reproduced).

## 81. Express mode = the program's own page on the pool (planetcompute.ai/express/local/)

User (2026-10-29): with no PC connected Receive Compute must look like the program, with what a browser cannot do greyed and a
note "connect to PC to activate more features"; "This computer free, private" greyed; Same prompt new seeds / Copy prompt /
Save picture / Save to cloud (returns the link) / Delete all working. Built: client/ui/index.html has an Express mode (address
/express/: the pool is chosen, This computer disabled, the PC's settings shown greyed with "🔒 Connect to your PC to activate
more features", Size stays active and is sent to the pool, Save picture downloads); the Worker serves that page (embedded by
website/embed_express_ui.py: run it before a deploy that should carry a newer page) and answers its calls: /express/api/* =
the site API; /express/local/content = the account's finished pool pictures; content/file (?download=1); content/cloud =
into Cloud Content (2 GB) + my.planetcompute.ai ("Generated on: the PlanetCompute pool using Browser (Express mode)");
content/delete; PC-only calls 403. Receive Compute shows it in a frame under the Express banner.
`scripts/test_express_app.mjs <worker.js> [shots]` (15 checks, headless Chromium, fake DynamoDB / SherpaHub room / B2):
frame /express/local/; This computer disabled with the note, pool chosen; the Express note; picture settings greyed with
the note, Size active; subtitle "on the PlanetCompute pool (Express mode)"; Generate Images sends 1080 x 1350 to the pool;
the finished picture in the gallery; viewer: Same prompt new seeds, Copy prompt, Save picture, Save to cloud, Delete; Save
picture downloads; Save to cloud copies into Cloud Content, publishes my.planetcompute.ai with the Browser wording, shows the
link, then Copy Cloud URL; Same prompt puts the prompt back; Delete takes it off the list; a PC-only call answers 403.
test_express_mode (18) now checks the frame instead of the old simple form; test_inference_ui 35/35 (the program unchanged).
Later the same day (user: "the appearance and all should look SAME"; "pending ... in the same place as Stop"; the Queue
"has to show all"): one row above one frame for both modes (PC: Computer / Open in its own tab / Disconnect; Express: ⚡ Express
mode, Download, Connect to my PC); default size "1920 × 1080 (Full, HD, Wide)"; Code "coming soon" (disabled); a status chip
(Pending / Making / Failed / Saving) where Stop is; the Queue lists the account's pool pictures/videos (asked here or in a
browser) in both modes, and Delete on one = POST /api/pool/media/cancel {hub, job} (own job only: the room's /jobs/cancel,
then the record goes) so a hub is not kept busy. test_express_app now 19 checks (5c size + Code; 6b pool picture in the
Queue; 6c Delete cancels it); test_express_mode 18 (the shared row/frame); test_inference_ui 35 (checks 20-22: Code disabled).
Video prompts (user: "write the 100 video prompts - hard code into the website and exe ... keep the history of image video
etc prompts separate so no mix"): client/ui/video_prompts.txt (100 detailed prompts: subject, motion, camera, light, mood),
built into the program (server.rs include_str!, /local/image/examples answers {image, video}) and the Worker
(embed_express_ui.py: EXPRESS_PROMPTS = {image, video}). Prompt history was already kept per page (localStorage pc-hist-image /
pc-hist-video; made items filtered by kind); the dialog now says "Picture prompt history" / "Video prompt history".
test_express_app now 21: 5d Random on the Video page gives only video_prompts.txt prompts; 5e Video history has no picture
prompt, Picture history has the one just made.

## 82. The crypto confirmation on My Balance (website and program)

User (2026-10-30): next to "Your Solana wallet address" the box "I confirm that cryptocurrency transactions are permitted
in my country, and I accept responsibility for complying with local laws."; every check AND uncheck recorded with
timestamp and user id in <prefix>crypto-allowed; the latest record sets the box on refresh; only when checked is everything
between "Your Solana wallet address" and "Where your compute is being shared" shown. Built: table
planetcompute-ai-crypto-allowed (user_id + sk "<at>#<id>"; at, allowed BOOL, text, email, country, ip, user_agent, via;
database/CreateTables.py); GET / POST /api/me/crypto-allowed; the site's /balance and the program's My Balance
(client/ui/index.html, also served in Express) hide the wallet part and My activity while unchecked (class nocrypto).
`scripts/test_crypto_allowed.mjs <worker.js> [shots]` (12 checks, headless Chromium, the given worker with a fake DynamoDB):
site: the exact sentence under the heading, unchecked with no record; hidden parts (address, Update, notice, My activity;
"Where your compute is being shared" stays); check -> row {user_id, at, allowed true, text, email, via website} and shown;
uncheck -> second row, hidden; refresh follows the latest row (both ways); a failed save puts the box back with "Could not
save"; API 400 for a non-boolean, 401 signed out. Program page (as served at /express/local/#balance): the same sentence,
hidden while unchecked, rows on check / uncheck, refresh follows the latest row. test_ui_wallet_checks now answers
/api/me/crypto-allowed (checked) so its wallet checks still see the wallet part.
Rate line (user 2026-10-30: "on the My Balance put a message - current WU = 0.0000xxxx Token (get the conversion from the
latest table)"): under the balance cards, on both pages, "Current rate: 1 WU = <credit_per_wu of the rule in force now
(howCreditAwarded)> <coin(s) of the share set in force (ledger-options)>"; /api/me/credit now also returns bonus_coin.
Checks 1b (site) and 9b (program): with an old rule 0.0000003 and the rule in force 0.00000126 the line says
"Current rate: 1 WU = 0.00000126 PlanetComp", shown even while the box is unchecked. Test 82 now 14 checks.
Heading and second statement (user 2026-10-30): the heading is now "Your Tokens wallet address"; the paragraph starts "Your
Solana wallet address: the address of your own wallet (Phantom, Solflare, ...). Transfers ..."; a second box "I understand
that [Token Name] is a ledger record only, may have no real value, and could lose 100% of any value it ever has. I accept it
at my own discretion and risk." ([Token Name] = the coin(s) of the share set in force: PlanetComp) that, once checked, cannot
be unchecked: one row per account in planetcompute-ai-token-risk-accepted (sk ACCEPTED, conditional put, never rewritten;
at, token_name, text, email, country, ip, user_agent, via); GET / POST /api/me/token-risk (accepted false -> 400). Test 82 now
24 checks: 3b paragraph; 8b-8f site (text with PlanetComp, one row, locked, a click changes nothing, refresh keeps it, API
400 / already); 12b-12e program (heading + paragraph, the box, one row, locked, refresh). test_site_balance check 7 (no
coin wording) now also excepts the new heading and statement; test_ui_wallet_checks check 4 reads the new heading.
Then (user 2026-10-30): "Where your compute is being shared" moved above the token section (right under the balance and
the rate); the token section (address, Update, transfers, notice) shows only when BOTH boxes are checked; My activity is
no longer hidden. Test 82 now 25: 2 (devices above, My activity shown), 3 (first box alone: still hidden), 3a/3c (second
box, both -> shown), 12c/12d (program: first alone hidden, both shown). test_ui_wallet_checks fakes both boxes checked.
Then (user 2026-10-30): "Where your compute is being shared" (the account's devices: "0 of your 4 devices sharing right
now. Every device is credited on its own; they all add up in your balance." + one row each) moved off My Balance to the very
bottom of Local Tunnel URL (the Harness page's Connect a Browser tab, /harness#connect); it loads when that tab opens, every
30 s while it is open, and on its Refresh. My Balance keeps its own Refresh and message line. Test 82 now 27: 2 (not on My
Balance), 13 (at the bottom of the tab, after the computer links, the sentence and 4 device rows), 14 (Refresh asks again).
Then (user 2026-10-30, "no one earned so many tokens"): My activity's "Tokens" column (AI text tokens of the day's jobs,
not PlanetComp) is now "Input/output words", in the day table and Recent jobs, website and program. Test 82 now 29: 15 (site:
the column, 534,765 on 2026-10-29, no "Tokens"), 15b (program). test_ui_activity check 2 reads the new header.

## 83. "My Balance" always on screen; the account menu goes to every page

User (2026-10-30): "some times the item My Balance is not shown next to Share Compute / Receive Compute / My Content / Local
Tunnel URL"; "when you click on the profile icon a menu is displayed - add more navigation items so users have two options
to get there (Local Tunnel URL, Cloud Content etc)". Found: the website's bar was fine at every width (probe, 7 pages x 18
widths, signed in/out, pill normal/sharing); the PROGRAM's page (also the Local Tunnel URL page and Express) below ~700 px
pushed My Balance off behind a hidden scroll. Now short labels (Share | Receive | My Content | Tunnel URL | Balance) and a
second row if ever needed. The account menu (website and program) has "Go to": Share Compute, Receive Compute, Models,
Local Content, Cloud Content, Local Tunnel URL, My Balance (+ Download planetCompute on the website); on the home page they
open in place as the top buttons do (window.pcNavHook). Found while testing: on a phone the longer menu's Sign Out lay under
the cookie notice -> the notice steps aside while the menu is open.
`scripts/test_nav_menu.mjs <worker.js> <client/ui/index.html> [shots]` (18 checks): site menu lists the 8; from My Balance
to Local Tunnel URL (Connect a Browser, lit); Cloud Content and Models switch tabs in place; My Balance; Share Compute
closes Receive Compute; 6b phone + cookie notice: Sign Out tappable, the notice back after; program at 320/390/600/700 px all
five tabs on screen with short labels; 1280 px full labels; program menu lists the 7; Models, Local Tunnel URL, Cloud
Content, My Balance, Share Compute open the right tab, lit. test_site_account_menu checks 1 and 7 now include the Go to list.

## 84. Save to cloud only what was made here (the server registry)

User (2026-10-30): "check if there is a way for users to upload images to cloud ... that are not those created by
planetcompute" (yes: copy any photo into the program's pictures folder, or POST /api/uploads with a session); then "start
with the server registry". Built: table planetcompute-ai-media-made (user_id + sk "SHA512#<hex>"; at, bytes, kind, name,
via program|pool|api, device, model, prompt, negative, seed, width, height, steps, seconds, ran_on, app; the first
registration kept). The program (image.rs `made`, in memory only) registers each picture or video the moment it makes it
(server.rs register_made: POST /api/media/made with the file's SHA-512, every 5 s while signed in, and right before a Save to
cloud); a file put in the folder by hand, or a .json written beside it, is never registered. A pool picture or video is
registered by the site when its owner fetches it (/api/pool/media/file). /api/uploads checks the bytes are the type the
name says, hashes them (SHA-512) and keeps the file only if THIS account registered it: else 403 "This picture or video was
not made here ...". Not covered (by design, next step): a modified program or a script calling /api/media/made with any
file (kept as via "api" when not from the program) -> the random re-generation audit.
`scripts/test_media_made.mjs <worker.js>` (13 checks, Node, fake DynamoDB / SherpaHub / B2): register signed out 401, bad
SHA 400, a row with every field, a second registration keeps the first; Save to cloud of a registered picture kept; a photo
never registered 403; the same picture from another account 403; a JPEG named .png 400; one byte changed 403; a pool picture
fetched by its owner is served unchanged and registered (via pool); then saved; another account cannot fetch it; a
non-program registration kept as via api. On the code before: 10 of 13 fail (the photo was accepted).
test_my_planetcompute and test_uploads (live, pctest-ai- tables + B2; run with B2_KEY_ID / B2_APPLICATION_KEY /
B2_BUCKET_NAME from ../.env) register their pictures first.
Then (user 2026-10-30: "make sure the API ... does not do mass uploads ... not used as a free storage", items 2-6):
(2) only PNG (at most 15 MB) and WebM (at most 50 MB); a PNG must look like one made here: known parts only, at most 64 KB of
text, at most 2048 px a side, nothing after its end (no file hidden in it). (3) per account: 50 saves and 500 MB a day; 6
registrations a minute and 500 a day (the program keeps a 429 and tries again). (4) per IP (the ContactGuard, as sign-in):
saves 30 a minute / 300 a day, registrations 30 a minute / 1,500 a day, new accounts 3 a day. (5) a NEW account: a permanent
address (no throwaway domains), one account per address (Gmail dots and +tags, any +tag: CANON#<address> in the user table,
written with the account), Cloudflare Turnstile (the home page shows the check when the site answers 428 need_turnstile;
/balance and /mycontent send a new address to it; the program shows "Sign up on planetcompute.ai", opening it in the
browser). (6) over 20 GB saved in a day, accounts younger than 30 days wait until tomorrow (503) and the admins get one
email. Counters: media-made items COUNT#... (TTL "expires").
test_media_made now 35 checks: (a) 1-13 as before; 14 a 2050 px PNG, 15 data after the end, 16 an unknown part, 17 a JPEG,
18 over 15 MB; 19 the 51st save today, 20 over 500 MB today; 21 the 7th registration in a minute, 22 counters expire; 23 the
31st save a minute from one IP (its words); 24 an existing account needs no check; 25 a new one 428 need_turnstile, 26 a
failed check, 27 a throwaway address, 28 the same Gmail with dots and +tag 409, 29 passed -> code, 30 the account and its
CANON marker, 31 the 4th new account a day from one IP 429; 32 over 20 GB a young account 503, 33 an older one saves and
the admins get the email, 34 only once. `scripts/test_signup_check.mjs <worker.js> <client/ui/index.html>` (4 checks,
headless Chromium, Turnstile faked): home shows the check and sends again with its token; /balance hands a new address to
the home sign-up; the program's "Sign up on planetcompute.ai" opens it in the browser. test_my_planetcompute builds real
PNG parts; test_uploads 22: a song is refused (only PNG / WebM).
Prompt privacy (user 2026-10-30: "the prompt should be visible only to its creator ... local or cloud ... without extra
worker processing"): the picture engine wrote the prompt INTO every file (PNG tEXt "parameters", WebM COMMENT tag), so a
shared link's Download gave it away. Now the program runs the engine with --disable-image-metadata (the prompt stays only in
<id>.json beside the file, on the user's own computer, and in the owner-only lists); the site refuses a PNG with text parts
or a WebM with a COMMENT tag (it already reads those bytes for the fingerprint: no extra work); Express does not share pool
pictures made before 2026-10-30 (they still carry the prompt). The 27 files already saved: 25 carried prompts and were cleaned
in place (scratchpad clean_prompts.py: PNG text parts removed, the WebM COMMENT value blanked, same size; the old versions
deleted; the public copies too; Cloudflare cache purged). Test 84 now 37: 18b a PNG with hidden text, 18c a WebM with COMMENT.

## 85. Sign-in alerts and "Where you are signed in" (security issue 3)

User (2026-10-30): "do all these" (the five issues: keys as secrets, signed releases, sign-in alerts + sessions, content
safety, pool privacy). Sessions now keep where they were made (browser label, country, IP); a sign-in from a browser /
country the account has not used before sends "New sign-in to your PlanetCompute account" (not for a new account, not for
the first sign-in recorded, once per place: SEEN#<hash> items); the profile sheet lists the sign-ins (the user table's
by-user index, user_id + sk SESSION) with Sign out and Sign out everywhere else (the in-house servers' own sign-ins stay).
`scripts/test_sessions.mjs <worker.js>` (10 checks, Node, fake DynamoDB with the index, fake mail; the real code flow): new
account no email; same place no email; Firefox/Mac/DE one email with the place and the sign-out link; not twice; the list
(5 incl. the server's, this one first); Sign out one; everywhere else (server kept); a signed-out session 401; this one by
ID refused; another account sees only its own. test_signup_check 5-6: the list on the profile sheet and its two buttons.

## 86. Signed releases (security issue 2)

The release key (Ed25519) is made and kept only on Cloud9 (planetCompute-CPP/.ops/release_ed25519.key: git-ignored, not in
B2 backups: *.key is excluded; KEEP A COPY OFFLINE). scripts/publish_client.py signs "planetCompute release|<sha256>" of each
build into client/LATEST.json; /download/latest.json passes "sig" on; the download page says "signed". The servers' agent
(workhorse/whagent.py) verifies it in plain Python with the built-in public key bKDl4tSPBczPVVFT0I17coFKVUn3c7TwA4KJC0uIPgY=
and refuses an unsigned or wrongly signed build ("FAILED: the build is not signed by PlanetCompute's release key").
`python3 -I scripts/test_release_signing.py` (7 checks): 20 real signatures pass; another message, one changed bit, another
key, empty/short/nonsense signatures fail; the RFC 8032 test vector; the key on this machine matches the agent's.
Not covered yet: code-signing certificates for the Windows .exe and the Mac build (to buy: Windows OV/EV, Apple Developer ID).

Content safety (issue 4) and pool privacy (issue 5), in test 84 and test 81: the program refuses a sexual/explicit prompt
(client/src/image.rs refused + unit test; the "leave out" text is not checked), the site refuses it for the pool and does not
register a file made from it (18d-18f); the first Save to cloud asks once: public, legal, not sexual, no real person without
consent, 18+ (test 81 9b); the pool notice says where a request goes and that pool results are deleted after 30 days (B2
lifecycle rule on sherpa_jobs/: hidden after 30 days, deleted a day later); the registry keeps the prompt's SHA-256, never
its words (test 84 3, 10); a "Your prompts" note on the home page.

## 87. In-house SherpaHubs do the cows' and the wolves' work (SupplySimulation, DemandSimulation)

User (2026-10-30): "since we have sherpahub do we need generouscow and hungry wolf - we can make sherpahub do both right";
"yes build it". The two switches of paper sec:inhouse, on a SherpaHub row of the admin tab SherpaHubs (and fleet buttons for
all rows). SupplySimulation: the agent starts the copies as --sherpahub --contribute --cores N --cap P (they organise AND
contribute: pool chat, pool pictures as a device of a SherpaHub, grid work); switching it restarts them; the pool now counts
a SherpaHub row's models only with SupplySimulation on (found while testing: it skipped every SherpaHub row, so with the cows
gone the pool would have had no picture model). DemandSimulation: the agent (whagent.py Demand thread) sends chat jobs an
hour (POST /v1/jobs, up to 8 at once) and pictures a day (POST /api/pool/media), all "priority low"; the site lets a server's
own sign-in send only such test requests to the pool: not counted, marked "demand" and low, not listed for the account; the
SherpaHub program takes a real user's prompts job before a low one (sherpa.rs next_prompts + unit test). Today's numbers go
to the tab. The computing is real, only the users are simulated.
`python3 -I scripts/test_sim_switches.py` (13 checks, the agent with a stand-in website): supply off/on and its restart, the
exact flags, a regular row never gets it, kept on disk; demand at the rate set, every job low + the row's session, chat
model/prompts, pictures paced per day, today's numbers, demand.jsonl, off = none, a stopped row sends none.
`node scripts/test_sim_site.mjs <worker.js>` (11 checks, fake DynamoDB / SherpaHub): the admin saves the switches, bad values
and non-admins refused; the agent's orders carry them (signed agent call) and its numbers are kept; a regular row never gets
them; a server sign-in without "low" 403, with "low" a demand job not counted or listed; a user's request as before; with
no cows a SherpaHub with SupplySimulation offers its model, without it does not. On the code before: 8 of 11 fail.
test_admin_sherpahubs 14-16: the box (supply, cores, cap, demand, numbers), Save simulation, the fleet button.

## 88. Live: the SherpaHub beside the wolves and cows, then instead of them (2026-10-30)

User: "so will the sherpahub do the work of hungrywolves and generouscow. They should 100%", then "retire the hungrywolves
and generouscows". Proves on the real grid that one in-house SherpaHub row with both switches (test 87) does the work of the
5 hungry wolves (test traffic) and the 2 generous-cow copies (always-on contribution), before and after they are stopped.
Paper: sec:inhouse, Table "Hungry wolves and DemandSimulation side by side".

Needs: the shared server (203.0.113.10), the admin tab SherpaHubs, `scripts/compare_demand.py` (standard library).

Steps (side by side):
1. The SherpaHub row (sherpahubs folder) gets the models on the Models panel (qwen2.5-0.5b-q4km, zimage-turbo-q4k).
2. SupplySimulation on, 4 cores, cap 100 (= the cows' 2 x 2 cores); DemandSimulation on, 600 chat jobs an hour (below the
   wolves' rate, so both together do not overload the shared server), 0 pictures. Wolves and cows keep running.
3. After some hours, on the server, from /root/REMOTESERVERSACCESS:
   `python3 -I compare_demand.py 2026-10-30T07:45 2026-10-30T15:42` (copy the script there first, remove it after).
4. Expect: both answered about equally often and fast, by the same computers; the SherpaHub's own copy among the
   computers that answer (its SupplySimulation works).

Steps (switch-over):
5. Wolves: `/root/REMOTESERVERSACCESS/hungrywolves/wolvesctl stop`, then `wolvesctl status` prints nothing (no boot line).
6. Cows: their row Stop (DynamoDB Workhorses desired_state "stopped"); their agent log says "copy N stopped (Stop on the
   admin page)" within 15 s; the agent keeps running so the tab says "stopped by an admin".
7. The SherpaHub row: copies 1 -> 2 (cores stay 4 per copy: the same 8 cores the cows + SherpaHub used; copy 1 is not
   restarted, so a picture it is making survives), DemandSimulation 600 -> 800.
8. A NEW copy has no models: give them on the Models panel, or on the server hard-link copy 1's (no extra disk):
   `mkdir -p <root>/data/i2/.local/share/planetCompute && cp -al <root>/data/i1/.local/share/planetCompute/models <root>/data/i2/.local/share/planetCompute/models`,
   then stop copy 2 BY PID (the agent restarts it; `pgrep -f`/`pkill -f` would also match your own ssh shell).
9. `python3 -I compare_demand.py 2026-10-30T16:32:10`: expect no wolf jobs, DemandSimulation answered ~99.8%, the cows'
   two computers gone, both SherpaHub copies answering.

Result: see Our runs (2026-10-30 07:45-15:42 and 16:32-20:30). Undo: `wolvesctl start 5`; cows row Start; SherpaHub row 1 copy.
Old code: old-testing-code-retired/ (README there).

## 89. Pictures keep their computer while their steps come; out of time goes to another computer (2026-10-30)

User: "the user's 1920x1088 picture on the SherpaHub has restarted 3 times", then "yes build 1-4". The fixed 3-hour limit
(hub 180 min, device 175 min) cut a picture that was progressing, twice, and the retry went to the same computer
from zero (docs/SHERPAHUB.md 11.7). Code: `client/src/sherpa_prompts.rs` (Watch, late tasks, PROGRESS / CANCEL),
`client/src/sherpa.rs` (device reports, CANCEL, own watch), worker `poolEtaMin` + the program page `poolEta`.

Steps (unit tests, on a RunPod CPU pod, from client/: `cargo test --no-default-features --features llama sherpa`):
1. `watch_fixed_limit_until_the_first_step_then_steps_must_keep_coming`: no step = old limits (picture 3 h, chat
   15 min); the incident's 8 steps of ~22 min = never given up; stalled = given up after max(30 min, 3 x slowest step);
   12 h hard limit.
2. `progress_keeps_a_slow_picture_with_its_computer`: 8 steps of 25 min (3 h 25 min): no time-out, not given to another.
3. `out_of_time_goes_to_another_computer_and_the_first_answer_wins`: an older device (no PROGRESS) past 3 h: try 1 used,
   not final, given to device 2 and never back to device 1; device 1's late answer counts; device 2 gets CANCEL;
   device 2's later answer and its "cancelled" error are dropped.
4. `the_retry_wins_and_the_slow_one_is_stopped`: stalled device 1 (30 min without a step), device 2 delivers, device 1
   gets CANCEL.
5. `the_only_computer_gets_it_again_after_a_while`: only device 1 has the model: back to it only after 10 minutes,
   its late error counted once.
6. `tries_used_up_while_late_fails_only_when_the_last_computer_ends`: 3 late tries; final failure only when the last
   of the three ends.
7. `progress_and_cancel_frames_parse`; the older tests (retries, orphans, reconnect, parts) still pass.
8. Estimate (site, Node): 512 x 512 8 steps 4 cores = about 20 min; 1920 x 1088 = about 3 h (the incident); 2048 x 2048
   30 steps = 22 h = refused (`too_big`). The site form shows "Time on the pool: ..." under Size; the program's pool
   line shows the same.
Live check after the release: a big pool picture's hub log shows no "no answer in time" while its steps come; the
admin tab shows one "sent to" per picture.

## 90. Which build of the program; update notice; "too old to earn" (2026-10-31)

User: "some people download exe and never upgrade it ... what are crucial logic that needs to be read realtime", then "plan
#1 and #2 and #3 and #4" and "go with the recommendations". Until now every build reported "planetCompute 0.1.0", so the
website could not tell an old program from a new one, and the program never said a newer one exists.
Built:
- Program (`client/build.rs`, `client/src/main.rs`): each build carries its commit and the commit's time (unix seconds;
  `git log -1 --format=%ct`, the same number for the same commit). User-Agent of every request and socket:
  `planetCompute/0.1.0+<commit>.<time>`; status reports and the capacity-check hello also carry `build` / `build_time`.
  `--version` and About show them.
- Program (`client/src/server.rs` update_loop, `client/ui/index.html` #updBar): 30 s after the start and then once a day it
  reads planetcompute.ai/download/latest.json; a newer build of its own kind -> "A new PlanetCompute is ready (made <date>)."
  with Download / Later (24 h). Below the site's minimum: "old and will soon stop earning" (warn) or "too old to earn ...
  making pictures and chat here still work" (enforce). Offline or any error: nothing shown, nothing waits.
- Website: `/download/latest.json` lists `commit` + `build_time` per platform (scripts/publish_client.py writes them) and
  `min_earn_build` / `min_earn_mode`. Plain variables MIN_EARN_BUILD (unix seconds or a date; missing = rule off) and
  MIN_EARN_MODE (warn | enforce). Only the program is checked (host "app"; the browser console is served by the site).
  Enforce = no credit of any kind for older builds (WU, working minimum, standby, audits, chat jobs); warn = credited as
  before, flagged on "Your computers" (site /harness#connect and the program's list), in admin, and ONE email per account
  per minimum. Local use, sign-in, My Balance and moving coins already earned are never touched. `/api/app-build` gives the
  console inside the window its program's build (read from the relay's User-Agent).
- Website decides audits: a program build with an id is credited only by audits of its work (as every current program
  already is), even if its hello leaves out "leases".
Steps:
1. Site, in-process (fake DynamoDB, B2, Resend): `node scripts/test_build_gate.mjs <worker.js>` (17 checks): rule off ->
   old program credited as before; a build id is stored and audited; warn -> credited + flagged + one email (not two);
   enforce -> 0 WU and 0 bonus for the old program, a new build and a browser tab not affected; build from the report
   body (heartbeat-server path); a date as MIN_EARN_BUILD; /api/app-build for program / old program / browser;
   /api/me/devices flag; latest.json per-platform build times and the minimum.
2. Program page, headless Chromium: `node scripts/test_ui_update_notice.mjs client/ui/index.html [shots]` (9 checks): no
   notice without a newer build; About "Build"; ready notice; Download opens planetcompute.ai/download; Later hides it,
   also after a restart; warn and enforce wording; no script errors.
3. Rust unit test (RunPod CPU pod, from client/: `cargo test --release --no-default-features --features llama`):
   `build_identity_and_update_notice` (dates incl. a leap day, the User-Agent, newer / same / old list / other platform /
   dev build).
4. Rendered pages: every inline script of /, /?console=1, /harness, /balance, /admin, /download, /express/local/ and the
   program page passes `node --check`.
Live after the release: admin device details show "build <commit> of <date>"; programs older than this release show
"build before 2026-10-31 (no id)".

## 91. Start asks the website again before asking to sign in (2026-10-31)

User: "I was already logged on - but when I tried to contribute compute (added cores etc) - it kept asking me to signin
again - signin and start". In the program window, Share Compute shows the website's console page, which asked "who is
signed in?" (/api/me) only once, when it loaded. Signing in afterwards on the program's Account tab (or in another tab)
did not reach it, so Start opened the sign-in box; signing in a second time inside it worked (live: two program
sessions 41 s apart, 13:27:20 and 13:28:01 UTC). Fix (website only, no new download): when Start is pressed and the
page thinks it is signed out, it asks /api/me again first, and it asks again whenever the page comes back into view.
`scripts/test_console_signin_later.mjs <worker.js> [shots]` (5 checks, headless Chromium, the given worker answers the
pages, /api/me faked signed out at load): 1 loaded signed out; 2 signed in since -> Start asks again and computes, no
sign-in box; 3 the account button shows the name; 4 really signed out -> the sign-in box with its reason, not
started; 5 no script errors. On the code before the fix checks 2 and 3 fail (the user's case).

## 92. Closing the window: "keeps running in the background" for 10 seconds (2026-10-31; first 5)

User: "when we x out the exe - I want the users to see this toast type message for 5 seconds with ok and cancel button
'App will still be running in the background. Use its icon in the system tray (Windows) or menu bar (Mac) to open or
quit it.' (fix grammar)". Text now: "PlanetCompute keeps running in the background. To open or quit it, use its icon in
the system tray (Windows and Linux) or the menu bar (Mac)." Code: `client/src/tray.rs` close_pressed / close_answer
(the close button no longer hides at once: the window stays and its page asks; a second press while asking hides at
once; if the page cannot answer, the window hides after 8 s anyway), `client/src/main.rs` (on_window_event; the
server build's stub), `client/src/server.rs` POST /local/close {hide} (refused over the tunnel, `client/src/tunnel.rs`),
`client/ui/index.html` window.pcCloseAsk (OK with a 10-second countdown, Cancel, Enter = OK, Escape = Cancel). User, later
the same day: "the message is to be displayed for 10 seconds": countdown 10 s, the program's fallback 13 s (was 5 / 8).
`scripts/test_ui_close_ask.mjs client/ui/index.html [shots]` (9 checks, headless Chromium): the message with Cancel and
"OK (5)"; the countdown; Cancel -> {hide: false}; OK -> {hide: true}; 5 s with no answer -> {hide: true} once; Escape =
Cancel; asked twice -> one message and one answer (this check found the first version answering twice). Rust: window
build and server build compile (`cargo check --release`, RunPod CPU pod with WebKitGTK).

## 93. Who made a pool picture, in the cloud's information panel (2026-10-31)

User: "how will I know where the image was created and if wholemode was used", then "yes go with this": Generated on the
PlanetCompute pool; Made by SherpaHub <server>, computer <device>, <cores>; How WholeMode (not split) · BatchMode queue;
steps; time to make; no seed (not asked public), no prompt. Before, a pool picture saved to the cloud from the program
said "the user's own computer using Client". Built (website only): when the account's program fetches a finished pool
picture (/api/pool/media/file) the media-made registry row gets made_hub (the SherpaHub's server row name), made_device
and made_cores (only for the operator's own computers; anyone else is "a volunteer computer", no device ID on a public
page), mode, queue, steps (asked, else the model's), seconds (poolMadeBy). Save to cloud (/api/uploads) reads that row
(never what the program sends) into the my.planetcompute.ai page (ⓘ) and meta.json (myPoolDetails). Pictures fetched
before this change keep the old wording (the registry keeps the first row).
`scripts/test_pool_madeby.mjs <worker.js>` (9 checks, fake DynamoDB / SherpaHub room / B2): registry row with hub, computer,
4 cores, WholeMode, BatchMode, 8 steps, 1260 s; saved; ⓘ Generated on the pool; Made by; How, Steps, "21 minutes"; no
seed or prompt in the page or meta.json; meta.json fields; the page's note; a picture from the user's own computer keeps
its wording with no pool rows. On the code before the change 6 of 9 fail.

## 94. Pool pictures: the prompt off the command line; WorkPacks wait while a picture is made (2026-10-31)

User: "I queued one image for the sherpahub - small image - still not done after 1 hour", then "yes fix both and turn off
demandsimulation". Found on the shared server: (1) the picture engine was started with the prompt on its command line
(`sd-cli ... -p <prompt>`), which every user of a computer can list (`ps`); (2) a 512 x 512 pool picture took 38 minutes
instead of about 20 because the same copy kept computing WorkPacks on the cores the picture used. Fixed:
- `client/src/image.rs` private_prompt: "-p" / "-n" leave the engine's arguments and go in its environment as
  PC_PROMPT / PC_NEGATIVE (a process's environment is readable only by its own user); `scripts/patch_sd_cli.py`
  second change: sd-cli takes them right after reading its arguments (before its checks). The two patches are
  independent and the script can run twice.
- `client/src/image.rs` Making + `client/src/contribute.rs`: while the engine runs (any attempt, made, failed or
  stopped), the WorkPack threads step aside as they already did for a chat job. (The SherpaHub maths packs, which come
  only with matmul jobs, are not paused.)
- DemandSimulation switched off on the SherpaHub row (d0257f91c822, demand=off) for the user's tests.
Steps: Rust unit tests on a RunPod CPU pod (`cargo test --release --no-default-features --features llama`):
`prompt_goes_in_the_environment_not_the_command_line` (the program's real Z-Image arguments carry no prompt; PC_PROMPT
holds it, "-n" inside a prompt is not cut), `workpacks_wait_while_a_picture_is_made`; all 28 pass; the window build
compiles. The patched sd-cli built on the pod from the pinned source: with PC_PROMPT set and no "-p" it accepts the
prompt; without either it asks for one. CI's Linux and macOS builds make a real picture through the program (no "-p"
any more), so a patch that did not work fails the release. Live after the release: `ps` on the server while a pool
picture is made shows no prompt.

## 95. A split job live: matmul 4096 x 4096 x 4096 across the server copies (2026-10-31)

User: "now I want to test quick or batch mode", then "start a small matmul job for me to watch and document it" (started
from the admin tab SherpaHubs by the user: an admin's session is needed). Today pictures and chat are WholeMode; the
matrix job is the one split into WorkPacks across computers (BatchMode, split). Steps and what to look at:
docs/SHERPAHUB.md section 13. Result: job fbe4e26b81136039 (4,096 units of 64 x 64, 137.4 GOP) on 4 devices (both
SherpaHub copies and both workhorse copies), 79 packs sent, 0 hedges, 0 timeouts, 0 failed units, 0 strikes; every unit
checked and the whole product passed the final check; done at 17:22:00 UTC, about 15-20 s. Second run: 65536 x 4096 x 65536, tile 128 (262,144 units, 35,184 GOP) on the same 4 devices, 42 min 44 s,
0 failed units, 0 strikes, 33 timeouts resent, every unit and the final check passed (docs/SHERPAHUB.md 13). QuickMode to try next: pool
chat from the program (Receive Compute -> PlanetCompute pool -> Chat), answered in seconds by one copy (WholeMode).

## 96. Packs in flight and block reuse (SherpaHub, 2026-10-31)

Why: the live 65536 x 4096 x 65536 job (test 95) reached 13.7 GOP/s on 16 cores, 1.5% of the kernel's speed: a RESULT
must fit one broker message (1 MiB), so a pack holds at most 15 tiles of 128 x 128 (~9 ms of work on 4 cores), each
device had one pack in flight, and each pack waited ~0.42 s for its round trip through the broker; also the device's
cache holds about one column of A blocks and rows were always taken from the top, so almost every A block was re-sent.
What changed: client/workpack/src/hub.rs (Config.max_inflight, window per device, rounds, A-block reuse, deadlines
count the queue, T_o from lone packs) and client/src/sherpa.rs (16 in flight, PC_SHERPA_INFLIGHT, 1 GiB hub blocks).
Steps (on a RunPod CPU pod; no Rust on Cloud9):
1. `cd client/workpack && cargo test --release -- --nocapture` : every old test unchanged, plus
   `k_pipelining_on_the_live_shape` (4 devices, 128 x 128 tiles, 1 MiB results, 0.6 ms per tile, 150-250 ms each way,
   cache = the A blocks of one column; 1 vs 16 in flight: must be >= 4x faster, < 0.4 blocks sent per unit) and
   `l_pipelining_keeps_every_guarantee` (liars, departures + duplicates + damage, 5 hub crashes, tiny caches,
   stragglers, all at 8 in flight: exact product, no honest device struck, credit once).
2. `cd client && cargo build --release --no-default-features --features llama && ./target/release/planetCompute --workpack-check`
   and `cargo test --release --no-default-features --features llama`.
3. Live: the same 65536 x 4096 x 65536, tile 128 job from the admin tab on the same 4 server copies; compare time and
   GOP/s with test 95.
Result (pod bzkon9irz0x89v, 16 vCPU): crate 26/26 (sim 13/13); live shape 87.3 s -> 9.8 s (8.9x), 0.33 / 0.28 blocks
per unit; trouble scenarios at 8 in flight match the one-in-flight ratios (liars 1.04, leave 1.77, crash 2.69);
program 28/28, --workpack-check ALL PASS. Live: see Our runs.

## 97. Documentation and Disclaimer page (website /docs and the program's Docs tab, 2026-11-01)

One source, `website/docs_content.html` (12 sections: what PlanetCompute is, sharing, checking, credit and balance,
receiving, the program, safety, privacy, account, built vs not built, disclaimers incl. the crypto disclaimer, contact),
placed into `website/worker.js` (page `/docs`, also `/documentation`; footer link on every page with the credit terms;
account-menu item) and `client/ui/index.html` (tab "Docs & Disclaimer", menu item) by `python3 scripts/embed_docs.py`.
Also: the site footer said "PlanetCompute.org" (the brand is PlanetCompute.ai): fixed; the program header now hides its
tagline below 1440 px and wraps the tab bar below 1140 px (six tabs).
Steps: `python3 scripts/embed_docs.py` (twice: the second run must change nothing but the content), `node --check
website/worker.js`, then `cd <folder with playwright-core> && node scripts/test_docs_page.mjs website/worker.js
client/ui/index.html [shots]`: /docs and /documentation answer 200; 12 sections, every contents link has its section,
the crypto disclaimer word for word, nothing wider than the screen at 360/768/1280 px, footer and menu links, no
PlanetCompute.org; in the program at 480/900/1141/1280/1441 px the Docs tab shows only its section and is selected,
tab bar and page fit, My Balance still opens, the menu item exists.
Result (Cloud9, 2026-11-01): 34/34. Regression: test_inference_ui 34/35, the same as before the change (check 29 expects
older pool-note wording; not caused by this change).

## 98. Security fixes from the 2026-11-01 code review (website, program, servers, release signing)

Two independent read-only reviews of the open-source code; every fix below was re-checked in the code.
Website (`website/worker.js`): "priority: low" (unpaid test traffic) only for worker-scoped sessions, and low jobs earn
nothing; a device counts as checked by the capacity check only while the check is under 15 minutes old, and the mark is
cleared when its last connection closes; a withdrawal to a wallet linked in the last 24 hours waits until the 24 hours
are over, and every wallet link sends an e-mail "A wallet was linked to your PlanetCompute account"; the device page
gives its ticket only to a same-site request (otherwise an "Open your computer?" page asks first); adding an e-mail
address is limited per network and per account (5 an hour, 10 a day); a sign-in code for a new account is honoured only
if the new-account checks ran at its start; the shared sign-in limit is larger and refuses (503) when it cannot be read;
the view counter counts each view once; wrong sign-in codes lock the address for the day after 15.
Program (`client/src`): SherpaHub prompt results only from the device given the task (or another device of the same
owner taking it over after 5 minutes), the check copy never from the same owner, at most 256 MB per task; job folders
must be hex ids; the heartbeat-server address is checked after parsing; tunnel paths with `..` and other tricky forms
are refused; the instance check kills only a process that is really planetCompute; on Windows the Vulkan loader is
loaded from System32 only; saved files refuse symbolic links and the Linux sandbox gives no right to make links,
devices, sockets or pipes; the local page link with its secret is printed only on a terminal (otherwise the path of the
file holding it). Heartbeat server (`hbserver`): at most 3 sessions per device and one beat per 5 s. Releases: a second
signature `sig2` covers sha256, build time and key (`scripts/publish_client.py`); `workhorse/whagent.py` checks it and
refuses a build older than the one it runs (and a build with only the old signature once it has seen a new one); its
logs are 0600. CI: workflows read-only (`permissions: contents: read`), actions pinned by commit SHA.
Steps: (1) RunPod CPU pod: `cargo build --release`, `cargo test --no-default-features --features llama` (the SherpaHub
reconnect test now checks that a stranger cannot take over a task), `planetcompute --workpack-check`; `cargo build
--release` in `hbserver`. (2) Cloud9, old (live) and new worker side by side with the same scripts:
`node scripts/test_my_planetcompute.mjs website/worker.js` (checks 12 and 13: the view counter), `node
scripts/test_grid_jobs.mjs website/worker.js` with the pctest AWS tables (12b low jobs earn nothing, 12c "low" from an
ordinary sign-in is a normal job), `test_work_audit`, `test_signup_check`, `test_auth_codes`.
Result (2026-11-01): Rust 28/28, workpack check ALL PASS, hbserver builds; test_my_planetcompute 26/26, test_grid_jobs
22/22, test_work_audit 23/23, test_signup_check 6/6, test_auth_codes 6/7 (the same on the old code: not caused by this
change). test_site_wallets and test_solana_address fail the same way on the old and the new code (a time-out and a
missing path argument): not caused by this change, still to be looked at. Windows-only code (the Vulkan loader) is
compiled only by CI. Not changed (accepted or later): the "made here" registry accepts any registered hash; CSP still
allows inline scripts; the B2 key can write the releases bucket; the model list is not signed offline; no seccomp on
ARM Linux; the macOS sandbox profile allows by default.

## Our runs

| Date (UTC) | Test | Build / site version | Result |
|---|---|---|---|
| 2026-11-01 10:25 | 98 security fixes | site dea135ea; program (this commit) | Rust 28/28, workpack ALL PASS; site tests as old code + new checks pass (grid 22/22, my 26/26, audit 23/23); deployed |
| 2026-10-31 19:00 | 92 close message now 10 s (fallback 13 s) | program (this commit) | 92 9/9 with OK (10), countdown 8-7 after 2 s, hide after 10 s once |
| 2026-10-31 18:09 | 95 split matmul job live (65536x4096x65536, tile 128) | site 44f9a1a5; program ef32a3d | DONE in 42 min 44 s: 262,144/262,144 units checked + final check passed, 4 devices, 0 failed, 0 strikes, 33 timeouts resent, ~13.7 GOP/s |
| 2026-10-31 17:22 | 95 split matmul job live (4096^3, tile 64) | site 44f9a1a5; program ef32a3d | DONE: 4,096/4,096 units checked + final check passed, 4 devices, 0 strikes, ~15-20 s |
| 2026-10-31 16:50 | 94 prompt off the command line; WorkPacks wait during a picture | program (this commit) | Rust 28/28 (2 new) + window build compiles (RunPod pod); patched sd-cli built from the pinned source, PC_PROMPT read with no -p |
| 2026-10-31 14:50 | 93 pool picture: who made it, in the cloud ⓘ | site edfb0132 | 93 9/9 (6 fail on the code before); 84 media registry 40/40; page scripts parse |
| 2026-10-31 13:55 | 92 close button: background message (OK / Cancel, 5 s) | program (this commit) | 92 9/9 (check 8 failed on the first version: fixed); window + server builds compile on a RunPod pod |
| 2026-10-31 13:40 | 91 Start re-checks sign-in (program window) | site b7c4277a | 91 5/5 (2 fail on the code before); 48 console embed 6/6; 90 build gate 17/17; page scripts parse |
| 2026-10-31 12:40 | 90 build id, update notice, minimum for earning | site 0d189157; program 123b75c (Mac dcc662b) | 90 site 17/17; program page 9/9; Rust 26/26 (RunPod CPU pod); live: 4 server copies report 123b75c, audits pass |
| 2026-10-30 23:10 | 89 time limits follow progress; late answers count; retry on another computer; pool estimate | site 4d21acf7; program (this commit), RunPod CPU pod 8 cores | sherpa 14/14 (7 new); whole crate 25/25, 0 warnings; release server build clean; estimate 1920 x 1088 = about 3 h, 2048 x 2048 30 steps refused; live: /harness and /express/local/ carry the estimate |
| 2026-10-30 07:45-15:42 | 88 LIVE side by side: hungry wolves vs DemandSimulation on the same server and computers (scripts/compare_demand.py) | site ad1cf71e; program 0b29ab7 | wolves 5,769 jobs (730/h) 99.9% answered, median 3.2 s, p95 25 s; DemandSimulation 4,384 (555/h, set 600) 99.8%, median 3.5 s, p95 41 s; same 5 computers; the SherpaHub's own copy answered ~600 grid jobs |
| 2026-10-30 16:32-20:30 | 88 LIVE after retiring wolves + cows (sherpahubs 2 copies x 4 cores, DemandSimulation 800/h) | site 2fb5b446 | first 6.5 min: 83 jobs, 0 failed, median 1.7 s; to ~20:30: 2,992 jobs (722/h) 99.8% answered (5x503, 2x504), median 1.9 s, p95 13 s; 4 computers (2 workhorse, 2 SherpaHub) |
| 2026-10-30 | 87 SupplySimulation / DemandSimulation | site ad1cf71e | 87 13/13 + 11/11 (old code 3/11); admin SherpaHubs 23/23; pool 23/23; 81 22/22; 84 40/40; 85 10/10; workhorse hidden 4/4 |
| 2026-10-30 | 85 sessions + alerts; 86 signed releases; 84 content filter + prompt hash; 81 share confirmation | worker (deploy after the program build) | 85 10/10; 86 7/7; 84 40/40; signup 6/6; 81 22/22; 82 29/29; 83 18/18; 77 18/18; 74 26/26; 58 14/14; ui_wallet 22/22; ui_activity 7/7; inference_ui 35/35 |
| 2026-10-30 | 84 not a free storage (items 2-6) + browser sign-up check | worker (deploy after the program build) | 84 35/35 + 4/4; 74 26/26; uploads (live) 47/47; 75 10/10; 83 18/18; 82 29/29; 81 21/21; 77 18/18; topbar 19/19; inference_ui 35/35; download_signin 10/11 (2 as before) |
| 2026-10-30 | 84 media registry: Save to cloud only what was made here | worker (deploy after the program build) | 84 13/13 (old code 3/13); 74 26/26; uploads (live) 47/47; 81 21/21 |
| 2026-10-30 | 83 My Balance always on screen (program), Go to in the account menu (site + program) | site (this commit) | 83 18/18; 75 10/10, 80/80, 35/35, 48/48; topbar 19/19; site_balance 11/11; 77 18/18; 81 21/21; 82 29/29; ui_wallet_checks 22/22; ui_activity 7/7; inference_ui 35/35 |
| 2026-10-30 | 82 'Input/output words' column (site + program) | site (this commit) | 82 29/29; ui_activity 7/7; ui_wallet_checks 22/22; site_balance 11/11; 76 10/10; 81 21/21; inference_ui 35/35 |
| 2026-10-30 | 82 'Where your compute is being shared' moved to Local Tunnel URL (bottom) | site (this commit) | 82 27/27; site_balance 11/11; tunnel_label 6/6; 78 7/7; 77 18/18; 81 21/21; topbar 19/19; 76 10/10; 75 35/35, 5/5 |
| 2026-10-30 | 82 both boxes gate the token section; devices section moved up | site 0724627c | 82 25/25; ui_wallet_checks 22/22; site_balance 11/11; 81 21/21; topbar 19/19; 76 10/10; inference_ui 35/35 |
| 2026-10-30 | 82 heading 'Your Tokens wallet address', paragraph, permanent token risk box (site + program) | site 7d5f7677 | 82 24/24; ui_wallet_checks 22/22; site_balance 11/11; 81 21/21; 77 18/18; topbar 19/19; inference_ui 35/35 |
| 2026-10-30 | 82 + rate line 'Current rate: 1 WU = ... PlanetComp' (site + program) | site d5feb92e | 82 14/14; ui_wallet_checks 22/22; site_balance 11/11; 81 21/21; topbar 19/19; inference_ui 35/35 |
| 2026-10-30 | 82 crypto confirmation (site + program); wallet/balance/Express regressions | site 57f3be6a | 82 12/12; ui_wallet_checks 22/22; site_balance 11/11; 81 21/21; 77 18/18; topbar 19/19; inference_ui 35/35 |
| 2026-10-30 | 58 tunnel: requests over 16 wait in line (FIFO, max 400 waiting, 90 s) instead of 429 | site 07b882ac | 58 14/14 (9: the 17th waits; 9b: then answered 200; 9c: line cap 429 'very busy'; old code fails 9); 78 7/7; 77 18/18; tunnel_label 6/6 |
| 2026-10-29 ~22:00 | 81 + 100 video prompts, separate prompt histories | site ea938aad | 81 21/21; 77 18/18; inference_ui 35/35; topbar 19/19; pool 23/23; 74 26/26 |
| 2026-10-28 07:15 | SECURITY REVIEW FIXES (user: "fix all 100% - we are not risking any user machines and data"): 47 grid (20, cases 17-20 W1), 53 claim (23, case 18 real junk-flood attack W2), 41 (18, cases 12-13 W3), 56 (7, W4; old code fails), 57 (12, T1), 58 (12, T2-T4), 59 (7) + 36 (38) + agent (11) (W5), 46 address (21, codes + hold W6), 49 move (9, code W6), 60 (8), 55 toast (6), page tests | sites 1a096ef0 ... 002e1c11; program 4720b85 (CI) | all PASS. Live: wolves answered throughout (stopped 05:29-05:44 for the grid deploy); device link through device.planetcompute.ai; servers on derived keys; worker sign-ins refused admin/balance |
| 2026-10-28 03:40 | 53 (22, step 10b: the coin account in history + receipt) + 41 (16) + 52 (18, step 9c) + 50 (21, step 13b) + 55 (6) (user: "not sure how my end users will get it - they will be lost and may blame company for not sending the token") | site (this deploy); client (this commit, CI) | all PASS; transaction links now Solscan; "Can't see your PlanetComp?" help on both My Balance pages; "Your coin account" column; receipt e-mail gives the coin account and why the wallet may show "does not exist" |
| 2026-10-28 03:06 | 52 (17, steps 4a-4b: Solscan link to the PlanetComp account when the wallet has no SOL) (user: "yes link to the PlanetComp account when no SOL") | site 29ba571b | 17/17 PASS. Live: the support account (0 SOL) links to its PlanetComp token account |
| 2026-10-28 02:40 | 55 toasts (6) + 50 (20) + 52 (15) + 30 top bar (19) + 38 wallets (18) + 46 address (18) + 54 (8) + balance, console, activity, inference (user: "update wallet address should be active only if the field was changed"; "if no history - it has to say that"; "change all the window messages to toast type of messages 100%"; "do not encrypt the TRANSFER_CLAIM_USER_PAY and TRANSFER_PLANETCOMPUTE_PAYS CF variables and any other that are not secrets") | site 8f021b29 then 100f3884 (7 settings now plain Text); client (this commit, CI) | all PASS: 6/6, 20/20, 15/15, 19/19, 18/18, 18/18, 8/8, 11/11, 6/6, 7/7, 25/25. Live: the 7 are plain_text with the same values; payout key still read (AzsTA listed), cluster mainnet-beta, sitekey served |
| 2026-10-28 03:20 | 54 who pays (8) + 53 claim (21, real devnet) + 41 (16, real devnet) + 52 (13) + 50 (18) + balance, activity, inference (user: "use both and a CF variable will decide that realtime"; "PUT this info in the admin tab new one - Who Pays for Transfer") | site beee7abf; client (this commit, CI); secrets TRANSFER_PLANETCOMPUTE_PAYS=YES, TRANSFER_CLAIM_USER_PAY=YES | 54: 8/8; 53: 21/21; 41: 16/16; 52: 13/13; 50: 18/18; 11/11, 7/7, 25/25 PASS. Live: who-pays YES/YES, 3 accounts, payout AzsTA 0 SOL |
| 2026-10-28 02:30 | 53 claim (19, real devnet) + 41 (16, SITE_PAYS_FEES=1) + 52 (11) + 50 (14) + balance, topbar, console, activity (user: "go with claim 100%, add receipt email and history"; "give actual figure") | site 81bb3b72; client (this commit, CI) | 53: 19/19 (user paid deposit 1488440 + fee 10000 lamports exactly; site wallet 0); 41: 16/16; 52: 11/11; 50: 14/14; 11/11, 19/19, 6/6, 7/7 PASS. Live (support, read only): quote 0.00152384 SOL (Token-2022 deposit 0.00151384), history empty, withdraw 403 |
| 2026-10-28 00:30 | 41 (16 steps, real devnet) + 52 (9) + 50 (13) + balance, topbar, console, activity, inference (user: "on the my balance page - add - move my lifetime balance to my wallet"; "on EXE client 'View on Solscan' not working so have copy button next to it") | site a3379eea; client (this commit, CI) | 41: 16/16 (devnet txs 2SQeMd... and 2MCp5s...); 52: 9/9; 50: 13/13; 11/11, 19/19, 6/6, 7/7, 25/25 PASS. Live: the operator's account 65.825901 WU left, bonus 0.018645963 |
| 2026-10-27 23:50 | 48 + new step: the "Download our client app" box hidden in the program's window, shown on the website (user: "dont show this when on clint exe - Itching to share more compute? ...") | site 4d46d48d | 6/6 PASS; the site before the change fails the new step (box shown in the program) |
| 2026-10-27 22:50 | 52 wallet holdings (user: "on my balance page - can I now find out how much my wallet has?"; "yes add it on both. Later I may hide it") + 50 (step 10) + 51 + balance | site 0b34486f; client aa689a1 (CI) | 52: 7/7; 50: 10/10; 51: 7/7; balance 11/11 PASS; live: the support account reads 0 PlanetComp, 0 SOL, the same as the chain |
| 2026-10-27 22:10 | 28 (case 25 added: done requests leave the Queue) (user: "the queue item stays and I need to delete it manually. queue item should be gone once completed") | client page (this commit, CI) | 25/25 PASS; the page before the change fails case 25 (done item still listed) |
| 2026-10-27 21:55 | 30 top bar (in + out), balance, 50, 51 after "Get URL" -> "Local Tunnel URL" (user: "change to 'Local Tunnel URL' on all buttons") | site c1e18da1; client page (this commit, CI) | 19/19, 13/13, 11/11, 9/9, 7/7 PASS; phone width 390: the five buttons fit in one row |
| 2026-10-27 21:10 | 51 My activity in the program's My Balance (user: "add the activity section to the exe's My Balance too") + 50 regression | client page (this commit, CI) | 51: 7/7 PASS; 50: 9/9 PASS |
| 2026-10-29 ~21:05 | 81 one look for PC + Express, one Queue, pool cancel, chips, default size; full site regression | site c7903d24; program d6a4517 published | 81 19/19; 77 18/18; inference_ui 35/35; topbar 19/19; 75 80/80, 35/35, 10/10, 48/48, 5/5; 76 10/10; pool 23/23; 74 26/26; 78 7/7; 80 4/4; download_signin 10/11 (2: as before) |
| 2026-10-29 ~21:30 | 81 Express = the program's page; 77 updated; full site regression | site 03f148fb | 81 15/15; 77 18/18; inference_ui 35/35; topbar 19/19; 75 80/80, 10/10; 79 35/35; 76 10/10; balance 11/11; 74 26/26; pool 23/23; 78 7/7; 80 4/4; download_signin 10/11 (2: as before) |
| 2026-10-29 ~20:10 | 80 capacity check: right-but-late answers; pool, my., tunnel regressions | site 3daee38b | 80 4/4 (old code 2/4); pool 23/23; 74 26/26; 78 7/7 |
| 2026-10-29 ~18:50 | 78 live check of the computer list; 77, topbar, tunnel_label regressions | site ffad7a3b | 78 7/7; 77 19/19; topbar 19/19; tunnel_label 6/6 |
| 2026-10-29 ~18:30 | 77 Express mode; 74 Generated on; regressions | site 209f020e | 77 19/19; 74 26/26; download_signin 10/11 (2 /download without keys: as before); topbar 19/19 + 13/13; 75 80/80, 10/10; 76 10/10; balance 11/11; tunnel_label 6/6; pool 23/23 |
| 2026-10-29 ~17:55 | 76 numbers with commas; 75 lifetime pill; regressions | site (this commit) | 76 10/10; balance 11/11; 75 80/80, 10/10, 5/5; topbar 19/19; admin_whopays 8/8 |
| 2026-10-29 ~16:40 | 75 top bar: day/night + account menu on every page, phone pill room; 74 my.planetcompute.ai | site 6cfbeb22 | 75: 80/80, 10/10, 48/48; 74 26/26; regressions as listed in 75 |
| 2026-10-29 ~00:10 | 28 extended: 🎲 Random uses the built-in picture prompts (client/ui/image_prompts.txt, 100 prompts from good_prompts_for_images.txt, served at /local/image/examples) | program = this commit | 28 35/35 |
| 2026-10-28 ~23:55 | 73 pool pictures/videos + connection drops; 72 extended; 28 extended; RunPod CPU pod o6tp96qr39tkg6: unit + 71 (with step 8) + 68; log docs/results/sherpa_pool_media_20261028_pod.txt | site 204054e4; program = this commit | site 72+73 23/23; program UI 28 34/34 (+ ui suites 5/7/8/22); unit 5/5 (new: reconnect keeps the prompt); 71 20/20 incl. NEW step 8: the broker restarted mid-batch (hub "Connection reset without closing handshake", as live): all 6 done, none given twice; 68 8/8. Found live first: a finished picture was lost after a site deploy (all WebSockets drop) -> prompts outlive connections |
| 2026-10-28 ~22:20 | 72 pool daily limit + 28 extended (pool, Mode in About); regressions 30-ish program UI tests | site 8f145f4a; program = this commit | 72 12/12; 28 30/30; ui_about 5/5, ui_activity 7/7, ui_security 8/8, ui_wallet_checks 22/22. Found + fixed: the two pool routes were placed after the /api/ dispatcher (never reached) |
| 2026-10-28 ~21:30 | 69 + 70 extended (hub log, Drain, Update, models on in-house computers) and 65 regression, Cloud9 | site 968cf7cd; program d3db114 (compiled in the release build, no pod) | 69 28/28 (new: log keeps the last 300, drain reaches the hub and is sent again after a reconnect, drained status); 70 20/20 (new: Update, version line, Console link, Log, Drain, models table, Download order, parts left out); 65 29/29. Live: the new agent reports every copy's models (qwen2.5-0.5b-q4km, zimage-turbo-q4k + parts on all 4 workhorse/cow copies). A Z-Image Turbo 512 x 512 test picture: 1,037 s on ~9 cores, good. Found live: 4 pictures at once after an agent reinstall (2 resumed orphans) -> fixed (not resumed) + core limit + one picture per folder |
| 2026-10-28 ~20:30 | 69-71 admin tab SherpaHubs + jobs (user: "start and stop the inhouse Sherpahub from admin page tab ... give work to it with prompts ... see the logs where the work went"); Cloud9 (69, 70, regressions 65-67, 48, 30) and RunPod GPU pod 0pyxnt2exg2kvx used as a build box (71, 68, unit tests; no CPU pods were available) | site before deploy; program = this commit | 69 23/23; 70 12/12; 71 18/18; sherpa_prompts unit 4/4; regressions 65 29/29, 66 7/7, 67 6/6, 48 6/6, 30 19/19. Found + fixed: the model list kept a chat model when switching to image prompts (empty model sent); one borrow error (compiled on the pod); the test devices did not retry a refused connection (Node reports it as an error only) |
| 2026-10-28 ~19:00 | 65-68 SherpaHub stage 3 (site broker), Cloud9 (65-67, wrangler 3.99 local runtime, Chromium) and RunPod pod 1sjvp4e2kwwpqb (68 + crate tests, 16 vCPU); log docs/results/sherpa_stage3_20261028_pod.txt | site 26f788c7 (deployed after the tests); program = this commit | 65 29/29; 66 7/7; 67 6/6 (+ 48 6/6, 30 19/19 unchanged); 68 8/8: job 1 4,096 units DONE, 2 liars banned, JS devices 3,729 units; job 2 killed at 4,476 of 16,384, continued in epoch 2 with 4,476 kept, DONE, credited 11,908; crate kernels 7/7, sim 11/11, stage3 2/2, wire 4/4. Found + fixed during the runs: `4 << 30` = 0 in JavaScript (device cache cap); the directory missed updates inside its 15 s throttle (now an alarm sends them); a restarted hub "continued" a finished job; devices took ~60 s to return after a hub restart (status now edge-cached 15 s, devices re-check every 20 s: ~20-30 s) |
| 2026-10-28 ~19:20 | 63 browser kernels + Rust SIMD, on RunPod pod 2dsx9fucrdw5le (AMD EPYC 9575F, Node 22.11) and Cloud9 (Node 24) | workpack_kernel.wasm 655 bytes (sha256 fd1eeedb13da1f6e); kernels.rs SSE2/NEON | 33/33 browser checks (SIMD + JS: 6 hashes = Rust, 200 shapes, extremes); crate 7/7 + sim 11/11 + wire 4/4 still pass. Speed per core on the EPYC: browser JS 2.05, browser WASM SIMD 24.65, Rust before 18.67 -> after SSE2 57.93 GOP/s (Cloud9: JS 0.97, SIMD 13.38) |
| 2026-10-28 ~18:40 | 63 kernels + 64 SherpaHub simulator, on a RunPod CPU pod (2dsx9fucrdw5le, AMD EPYC 9575F, 8 vCPU) before any commit; log docs/results/workpack_tests_20261028_pod.txt | client/workpack (first version) | 63: kernels 7/7, wire 4/4, browser kernel 12/12 (same 6 hashes); matmul_i8 19.2 GOP/s per core (Rust, SSE2 baseline) vs 1.14 GOP/s (browser JS: needs a WASM SIMD kernel). 64: 11/11 scenarios exact; j-effic ratio 1.09 with 0.1% duplicate work; liars 8 struck 8 (only liars), banned 3-4; i-scale 65,536 units / 2,000 devices in 5.6 s real. Fixed during the run: pack across columns could need more blocks than a 2-block cache (NEED loop) -> one column per pack + NEED guard; hedging copied every out unit (11% duplicates) -> only packs past 2x their expected time; simulator delivered out of order (15,468 NEEDs) -> in order per device (0 NEEDs) |
| 2026-10-28 14:55 | 62 About box (user: "This is not looking professional"), 60 program page wallet (+11b Copy address), 52 site holdings (+Copy address), 58 tunnel keys now required always (user: "permanently set this for secure communication - I deleted all the old exe") | client page after 56964b4; site af44b3c6 then 5c2c06bc | 62 5/5, 60 22/22, 52 20/20, 58 12/12 PASS; live: all 4 server copies tunnel "on" (keyed) after the deploy |
| 2026-10-27 20:35 | 47 cases 1-16 (priority + My activity) + live: 2 jobs then /api/me/activity; support account totals | site 68b9937a | 16/16 PASS; live: the operator's account shows its 2 jobs at once (1 answered by its workhorse), support shows 12 wolf jobs received (all low priority) and 8 answered by the cows |
| 2026-10-27 19:05 | 50 (9 page steps) + sd-cli PC_CROP block (g++ on Cloud9) | client page + scripts/patch_sd_cli.py | 9/9 PASS; crop PASS (3 frames 1920x1088 -> 1920x1080, first row 4) |
| 2026-10-27 18:37 | 47 live with 5 hungrywolves, workhorse 2 copies x 4 cores | client f6eba41 (CI run 40556775837), site b4807e80 | run ms p50 786 (max 1,859) vs 36,813 on 25901be: llama threads = shared cores. 12 jobs, 8 answered, 1 double-checked AGREE; 4 failed only around the restart (busy 2 min / no answer) |
| 2026-10-27 18:20 | 50 (headless browser) | client page after 25901be | 8/8 PASS |
| 2026-10-27 ~05:25 | 42 standby and working rates (user: "build the standby and working rates on devnet") + 41, 38, balance, 37, page parse | site eae8ab0b | 42 9/9 PASS (bonus 0.001234 = expected, GPU 0.004536/h, CPU 0.0002/h, standby 0.0001/h, zero-work standby, unverified 0); 41 8/8 (real devnet, legacy WU at the rule then in force); 38 18/18; balance 11/11; 37 4/4; all pages parse (admin 10/10). Live rule 3ada45336f1f (same rates) from 2026-10-27T05:27:34Z, audit entry written |
| 2026-10-27 ~05:00 | 41 (bonus model) + 38 wallets UI + balance + 37 credit concurrency (user: "I let users double dip - it is by design") | site c14d0f4a | 41 8/8 PASS: tx 5bX674wCnBm4usjqALkJSEGUBHCRWG3T3jt7b3tA648QcQ6FzJz85GB2wDTQTVzoNJXTWBi2BZj9uCXHJcynom7y (devnet), 0.0001 bonus sent, WU stayed 1000; 38 18/18; balance 11/11; 37 4/4. Live: no account had WU taken by an earlier transfer (scan of the live credits table: 0), so nothing to restore |
| 2026-10-27 ~02:40 | 41 real devnet transfer (user: "I funded the treasury, go ahead with wallet setup") | site 9b51dc17 + Worker secrets PCC_MINT, TREASURY_SECRET_KEY, SOLANA_RPC_URL, SOLANA_CLUSTER=devnet, WALLET_TEST=1 | 6/6 PASS: tx 36TCaNsFZiNAQ3aSGa76Ken6rHe9Gcx3UL2YUgSxhk4kvYSk3C6VcYg969bFGNz7nzHTKNpGhuHc2VtCgA7zbzWH (devnet), 0.00012 tokens arrived |
| 2026-10-27 ~02:15 | 38 wallets, 39 fade on maximize + Copy Cloud URL, 40 workhorses hidden (user: "yes go ahead with the wallet on devnet"; "when an image or video is maximized ... text ... should disappear after 3 seconds"; "there is no copy link button"; "when a image is already on the cloud ... say 'Copy Cloud URL'"; "why is it showing computer that are not mine? ... List all only for admin and only in the right tab") | site 2345ad79 then 9b51dc17; client (this commit, CI) | 38: 18/18; 39: 13/13 program, 6/6 website; 40: 4/4; regressions: test_site_balance 11/11, test_inference_ui 24/24, program info/max/zoom/live-panel 6+10+15+4 PASS |
| 2026-10-27 16:20 | 49 Move coins (user: "add a new tab on admin page to move from source to destination"), real devnet; payout wallet made (key held only as a website secret, never printed), sending address set | site 919aa3fe | PASS 7/7 (tx 2Lu4mP8N...5VHPTK) |
| 2026-10-27 16:13 | 47 LIVE with the queue (after stopping the wolves so the grid object restarted on the new code) | site 919aa3fe | PASS: a job checked on both workhorse copies, answers AGREE (36.9 s run); next job waited 9.5 s in the queue, 14.3 s run. Wolves started again |
| 2026-10-27 16:15 | 47 + the job queue (user: "add the job queue so wolves don't get busy errors") | site 5accaca8 | PASS 11/11; wolves restarted (timeout 330 s), old logs in logs/before-queue/ |
| 2026-10-27 16:05 | 48 Start computing in the program's window (user: "'Start Computing' button is not working on exe"); program window layout (user: "Make use of real estate mindfully") | site 212ede1c; program (this commit, CI) | PASS 4/4 (old code: fails, bug reproduced); layout checked on screenshots of Images, Video, Chat |
| 2026-10-27 15:54 | 47 LIVE: 5 hungrywolves, workhorse copies with qwen2.5-0.5b (build 240922e) | site 3c9aabb0 | first answers: 4 answered, total 14-143 s for 2-32 tokens (the copies' WorkPack threads compete with llama.cpp: fixed in this commit, grid jobs pause WorkPacks); 89 'all busy' (2 programs, 1 job each, 5 wolves); 4 timeouts (180 s) |
| 2026-10-27 15:15 | 47 grid step 1 + hungrywolves (user: "yes go ahead with the hungrywolves"); also 43 (4 runs) | site 3c9aabb0; program 240922e (CI) | PASS 8/8; 43 23/23 x4 (8f made robust: an inflated total either fails its proof or cannot be proved = void, never credited). Live: 2 wolves on the InterServer signed in, jobs answered 503 'No volunteer computer has this model yet' until the workhorse copies run the new build with the model |
| 2026-10-27 14:30 | 45 + the from address on each transfer record (user: "yes add the from address to each transfer record"), real devnet; also 41 | site 442a8cf4 | PASS 6/6, 41 9/9 |
| 2026-10-27 14:20 | 43 + GPU leases in the browser console (user: "yes also do the - GPU leases"); also site balance, 42, all pages | site e644da5a | PASS 23/23 (8a-8f GPU); 11/11, 13/13; pages parse. Not yet run on a real WebGPU graphics card |
| 2026-10-27 13:49 | 43 live: workhorse interserver-1 on the audit build (user: "publish the new build to the workhorses") | server build deed33d (CI run 40505017200, sha256 008a83ec35ff3232...), installed with --binary; site 1364c206 | PASS: both copies audit_mode on, first audits passed: 154,959 / 153,062 packs in 505 / 500 s, 20 checked each, 0.206612 / 0.204082 WU credited, proven cores 3 (capped at the verified 3) |
| 2026-10-27 14:00 | 46 the account's Solana wallet address + token notice (user: "In the userid profile - add a new field solana based wallet address ...", "add this to the profile page and also the balance place UNDER the address fields - tokens are awarded free of charge ..."); also 38, 41, 45, site balance, 42, all pages; CI run 40505017200 Linux unit tests | site 1364c206 | PASS 18/18 (devnet tx 5T6GgVEs...m9x6); 18/18, 9/9, 6/6, 11/11, 13/13, pages parse; CI: leases_match_the_server ok (3 passed); mac job failed only on model downloads (network) |
| 2026-10-27 13:40 | 45 withdrawal by the share set in force (user: "yes wire the withdrawal to the share set in force"), real devnet; also 41 | site 9ead2953 | PASS 6/6 (tx 2wSJwhs9...99DD9i: 0.012 PlanetComp + 0.008 Token-2022 coin 2 in one transaction); 41 9/9 (tx 5U5QWPwk...SBNLBGbYb, through the set: PlanetComp 100 %) |
| 2026-10-27 13:25 | 44 ledger options (user: "create a table <prefix>-ledger-options and add it to the admin page - enter planetcomp with active status and 100%", "add a field ... address_from") | site 9fdd4263; tables pctest-ai-ledger-options, planetcompute-ai-ledger-options created and seeded | PASS 12/12; admin and contribute pages parse |
| 2026-10-27 12:36 | 43 commit + random audit (user: "build the commit and random audit plan"); also 42, credit concurrency, site balance, site wallets, heartbeat servers, all pages | site 91360092 | PASS 17/17; 13/13, 4/4, 11/11, 18/18, 35/35, all pages parse (admin 10/10, contribute 9/9) |
| 2026-10-27 07:40 | 42 working minimum scaled by the CPU cap (user: "yes scale the minimum by the CPU cap"); also credit concurrency, site balance, all pages | site 51adf327 | PASS 13/13 (8 verified cores at 20% cap = 0.00032/h); 4/4, 11/11, admin 10/10 |
| 2026-10-27 07:33 | 42 working minimum per verified core (user: "yes make the minimum per verified core"); also site wallets, site balance, credit concurrency, all pages | site 9ee2708d | PASS 12/12 (3 verified cores 0.0006/h; core count from measured speed, capped by cores said, at least 1); 18/18, 11/11, 4/4, admin 10/10 |
| 2026-10-27 07:30 | 41 minimum transfer 0.01 (user: "add the 0.01 minimum transfer on devnet"), real devnet; also 42, site wallets | site d74dd8a2 | PASS 9/9: 0.009999 refused with "The smallest transfer is 0.01", nothing sent; 0.01 sent and settled (tx 38hyJJrr...heEJ7v), on chain exactly 0.01; WU unchanged. 42 9/9, site wallets 18/18 |
| 2026-10-27 00:53 | workhorse install on the InterServer (user: "add another folder ... planetcomputeworkhorse", "yes add the boot entry too") | server build 0.1.0 f40d00a (CI run 40425426147: no desktop libraries, chat "Paris"); site ca128638 | PASS: installed only in /root/REMOTESERVERSACCESS/planetcomputeworkhorse (+ the one approved @reboot line); agent got a sign-in for the row's account; 2 copies x 4 cores (auto: half of 16), ports 7531/7532, both "signed in as user@example.com", native engine running, ~15,000 WorkPacks each in 25 s, capacity check passed (police_verified, 0 fails); the admin row shows both running with their devices; load ~3 then rising toward 8 |
| 2026-10-27 ~00:15 | 36 workhorse agent, live website, temporary row feedface0001 (deleted after), stand-in program on Cloud9 | site 6d25640d, workhorse/whagent.py | PASS: sign-in issued for the row's account and written to each copy; the website recorded each report; 2 copies at cap 50 from the row; admin 3 copies + cap 60 + Restart -> 3 copies restarted with cap 60 (ports 7531-7533); agent stopped -> all copies stopped; started with the row on Stop -> no copy started (after the fix: orders first); Start -> 3 running. The test sign-in was signed out after (API 401) |
| 2026-10-26 ~21:40 | Z-Image Turbo the default picture model (user: "make z-image turbo default everywhere") | client (this commit); B2 Models/catalog.json (old: Models/catalog.before-zimage-default-20261026.json) | catalog: zimage-turbo-q4k "recommended" and listed first (FLUX.1 schnell no longer recommended), local + B2, live /api/models shows it. Program in Chromium: both downloaded -> Z-Image Turbo selected (8 steps); the user's FLUX choice kept after a refresh; only FLUX -> FLUX. Test 28 24/24 |
| 2026-10-26 ~20:30 | 29 one Windows program, 2nd build (CI run 40390371720) + 31 (compact download line) | client 58a0c6f; site 80a733c5 | ALL 4 GREEN: image engine built fresh with Vulkan (82 MB, "image engine: Vulkan inside"), no-Vulkan step: carried loader used, image engine starts, chat answers (Paris). Published; https://planetcompute.ai/temp/planetcompute.exe and /download/windows both 146,343,936 B, SHA-256 3a66d8e81bb691214c137c8a25cb426781823a996fd3643f96dad35856abfdec (checked on the downloaded bytes). Test 31 11/11 (no B2 keys in that run). NOT yet tried on a real PC |
| 2026-10-26 ~20:10 | 31 downloads + sign-in on My content (user: "under /harness#inference add in big letters: Download our client app for Windows, Mac or Linux", "/harness#cloud: give email login option and after login display all the user images video") | site 5811042d (backup before: worker_20261026_200402.js) | 14/14 in headless Chromium (B2 list real, downloads HEAD); live after deploy: /download 200, /download/windows 200 attachment planetCompute.exe 102,036,992 B (the build with the processor-only image engine until the fixed one is published) |
| 2026-10-26 ~20:30 | 30 top bar + Harness tabs (user: "add two buttons - my content and get URL ... ALWAYS visible", "/harness need to have all the tabs", "the bottom ... 4 menu items not needed") | worker.live.js (before deploy) + client (embed commit) | signed in 19/19, signed out 13/13 in headless Chromium; found on the way and fixed: the status card covered the tabs and the program's page (now a pill in the top bar); frame changes made Back step inside frames (now location.replace). Program embed: 4/4 |
| 2026-10-26 ~20:00 | 29 one Windows program (CI run 40384938826) | client 0933404 | ALL 4 GREEN; without any vulkan-1.dll: "the carried loader is used", the image engine starts, real chat model answers (Paris, streamed). FOUND: the Windows image engine came from the OLD processor-only cache (sd-...-windows-x86_64-v1, 22 Oct; exe 102 MB instead of ~145 MB): pictures would not use the GPU. Fixed: cache key has the backend (-vulkan-v2) + CI check that a Vulkan build's image engine contains Vulkan. Published to B2 client/0.1.0 meanwhile; NOT put on /temp/ |
| 2026-10-26 ~19:30 | site: Harness Compute and Admin from the home page (user: "this not displaying the page - https://planetcompute.ai/harness") | site 2b609b04 | FOUND in headless Chromium (jsdom does not apply CSP, so tests 20/25 never saw it): the home page's CSP `frame-src https://challenges.cloudflare.com` blocked its own frames /harness?embed=1 and /admin?embed=1 (blank area, address bar /harness), since at least 2026-10-22; likely the admin page 'not working'. Fixed: `frame-src 'self' https://challenges.cloudflare.com`. After deploy, live, Chromium: the Harness frame shows the page, the Admin frame loads; /, /harness, /admin, /api/credit-rate 200 |
| 2026-10-26 ~18:45 | 28 Inference pages (user: "menu on the left for images and below it video, music, chat ... Queue ... like sushila.cpp inference, only better") | client (Inference pages commit) | 24/24 PASS in jsdom; headless Chromium wide + phone, light + dark: no script errors, phone width 390 (was 536: the header tabs and the CSS `nav` rules also hit the new menu, now `header nav`). Found on the way: the Prompt history dialog came after the script, so the page script stopped at load and Make pictures did nothing; fixed. Rust side (seed kept, `<id>.json`): waiting for CI; NOT yet tried in the real program |
| 2026-10-26 ~16:50 | 25 + failover credit (user: "add the website fix for credit after a server fails"), 8 on staging | staging bf9b2b78, live 6682e588 | 25: 35/35 on worker.live.js and worker.js (new 32-34: a beat through a server 25 min ago, then a direct one: credited 1,500 s, not 600; the next one limited normally); the OLD live code fails 33 (credited 600 of 1,500 s), as expected. 8: 15/15 on staging |
| 2026-10-26 ~16:22 | 26 agent (user: "start restart and stop button with a checkbox ... automatically restart") + 25 again | site 46cfdfb1 (tested on worker.live.js before deploy) | 26: 11/11 PASS; 25: 32/32. LIVE on storage-bz-1 (hb1): agent reports to the website every 15 s; Stop -> program stopped after 26 s (Cloudflare then answers the hostname with an error, volunteers fall back to the website); Start -> running again after 30 s; only the folder changed (plus the one boot line). Note: Cloudflare answers the default "Python-urllib" client name with 403 (bot filter): use your own User-Agent |
| 2026-10-26 ~15:30 | client CI 40338199037 (heartbeat every 5/15 min + server-first) and hbserver CI 40341088622 (after the smoke-test pipe fix; 40338198922 failed only in the x86_64 smoke test: grep -q under pipefail) | client 1fe6666, hbserver ae453a5; site 041dbfb7 (consent text, FAQ, admin note) | ALL GREEN: client 5/5 PUBLISHED (B2 client/0.1.0; /temp/ vulkan 144,590,336 B, cpu 55,132,672 B); hbserver x86_64 + aarch64 smoke tests pass (health, pass 200 / forged 401 / other device 403, CORS preflight, journal across restart). Test 25 32/32 on the live worker before deploy; home page and admin page probe (jsdom) without errors |
| 2026-10-26 ~14:40 | 25 heartbeat servers (user: table + admin tab + server-first + "email to admin daily ... week / month ... or cancelled") | site 9bb6846f (tested on worker.live.js and worker.js before deploy; a8699074 had the tab, hand-in and email without the console's server-first part) | 32/32 PASS on both; test 8 (ledger) on staging 76abdbba again 15/15 after heartbeat() learned the server's time and address. Live: tables planetcompute-ai-HeartbeatEtcEC2TypeServers created, HB_SERVER_SECRET set, Cron "17 * * * *". hbserver build: waiting for CI |
| 2026-10-26 ~14:30 | client CI run 40329733916 (licence step + its compile fix) | client eead16c | ALL 5 GREEN; PUBLISHED to B2 client/0.1.0 + LATEST.json; Windows programs on the /temp/ links (vulkan 144,572,928 B, cpu 55,114,752 B). The licence pop-up not yet tried in the real program |
| 2026-10-26 ~13:45 | 8 heartbeat ledger, on STAGING (planetcompute-website-staging, fresh pctest-ai-* tables, new staging session secret), after the heartbeat cost fix (reports every 5 min working / 15 min idle, active window 20 min, live index bucket 20 min, flush every 30 min) | staging b46d27b1, then live 586b235e | 15/15 PASS, ALL PASS (balance = everything credited, 85,000 uWU). Every inline script of /, /?console=1, /admin, /mycontent parses (found and fixed on the way: the home page's "Email us a question" script did not parse on the live site since the Report-abuse prefill: backslashes lost inside the page template). App side (contribute.rs schedule): waiting for CI |
| 2026-10-26 | 24 licence agreement step (user: "build the licence step ... save the acceptance ... userid, model, acceptance, timestamp, ip address to dynamodb ... send email to them immediately") | site 5480a475 (tested on worker.live.js before deploy); table planetcompute-ai-model-agreements created by CreateTables.py (index by-model ACTIVE, point-in-time recovery on) | 16/16 PASS; test 20 15/15 still PASS (admin page scripts parse). Live: /api/models/agreement and /api/models/accept 401 signed out, the Llama file 401 signed out. App side: waiting for CI; NOT yet tried in the real program |
| 2026-10-22 ~18:30 | 3, 10, 16, 17, 22, 23 incl. the new checks (Disk space parts, unknown part refused, Queue tab list / remove; CI run 39827350333) | client 406fe29 (header always on top + Sign in / initials, Connect a Browser heading, Disk space tab, Queue tab) | ALL PASS on all five; PUBLISHED (B2 client/0.1.0), Windows exes on the temp links (vulkan 144,531,456 B, cpu 55,078,400 B). Not yet tried in the real program |
| 2026-10-22 (this session) | 17 Queue tab (user: "a tab that shows the queued job and status and delete button") | client (queue tab commit) | page in jsdom PASS: "Queue (2)", rows with thumbnail / state / progress / Delete or Remove from list, a job finishing updates the row and the count, Delete and Remove finished send the right requests. Rust side + CI checks: waiting for CI |
| 2026-10-22 (this session) | 23 Disk space tab (user: "tell the diskspace used by the app ... and a open folder for each") | client (disk commit) | page in jsdom PASS: tab after API; four parts with size, files, folder, Open folder (sends {key}); total, drive free space and bar. Rust side + CI checks: waiting for CI |
| 2026-10-22 (this session) | 23 header (user: "these 4 items should be permanently on the header", "sign in button and profile image") | client (header commit) | page in jsdom PASS: Sign in shown signed out and opens the sign-in form; signed in "MP" with name and email, menu closes on a click outside, My Content / Account / Sign out work; #site=/admin?x=1 shown in Contribute, Compute; #site=//evil.example ignored. Rust side + CI check "opens inside the program's page": waiting for CI |
| 2026-10-22 (this session) | 21 + Take down (user: "add the take down button") | site 0f323dd4 (tested on worker.live.js and worker.js before deploy) | 47/47 PASS on both; 9 admin page scripts parse; live takedown / untakedown 401 signed out; the user's picture still 200 |
| 2026-10-22 ~17:10 | 3, 10, 16, 17, 23 (CI run 39816447253; run 39813377250 before it FAILED to compile on every platform: reqwest RequestBuilder::json, fixed in 4ea84f3) | client 4ea84f3 (new layout) | ALL PASS on all five; PUBLISHED, Windows exes on the temp links (vulkan 144,468,992 B, cpu 55,014,400 B) |
| 2026-10-22 (this session) | 21 + Report pop-up + admin Reported media (user: "admin page ... get the userid and actual file name", "make a popup to report", "Made with planetCompute.ai") | site 6f2cc1b4 (tested on worker.live.js and worker.js before deploy); table planetcompute-ai-reported-media created by CreateTables.py (4 indexes ACTIVE, point-in-time recovery on) | 40/40 PASS on both; all 9 admin page scripts parse; live share page: "Made with planetCompute.ai" x4, ⚑ Report button, both scripts parse, CSP allows Turnstile; /api/media/report 400 without a form, admin lookup 401 signed out. NOT yet seen in a real browser |
| 2026-10-22 (this session) | 21 with share tokens (user: "hide the userid and the actual filename" in /u/ links) | site 0163d025 (tested on worker.live.js and worker.js before deploy) | 28/28 PASS on both; live: the user's first link /u/<uid>/<name> answers 301 to /u/H6JgGby7RJ, page 200 with neither the user ID nor the name in it, file 200 image/png, download named planetCompute-H6JgGby7RJ.png (the check counted one view on that picture) |
| 2026-10-22 (this session) | 23 | site bd29d7c9 (tested on both workers before deploy), client (layout commit) | test_device_links.mjs 10/10 PASS on worker.live.js and worker.js; live delete / delete-all 401 signed out, 403 cross-site; page in jsdom PASS (4 top buttons, tabs, #content/#access/#harness, list, Delete, Delete all, Make a new link; hidden through the tunnel). Rust side: waiting for CI; NOT yet tried in the real program |
| 2026-10-22 ~16:40 | 3, 10, 16, 17 incl. queue + restart + checks (CI run 39809232306) | client 34b0c8a | ALL PASS on all five; PUBLISHED (B2 client/0.1.0, Windows exes on the temp links) |
| 2026-10-22 15:29 | 3, 10, 16, 17 incl. queue + restart (CI run 39802608786) | client 9c772d3 | Windows, Windows Vulkan, Linux Vulkan PASS; Linux FAIL "the first one is being made again" (Z-Image still loading after 120 s on a 4-core CPU: the test now accepts loading); macOS FAIL "after a restart both pictures are back" (queue read before the background resume listed them: now read before the server answers). Also seen: the kept GPU reason was an info line, now the engine's error lines. Fixed in 34b0c8a |
| 2026-10-22 (this session) | 17 checks before a request, page side (jsdom, faked answers) | client (checks commit) | page PASS: the checks show with pass / warn marks and "It will be made on the processor" after a GPU failure; Try the GPU again forgets it ("on the graphics card"); the GPU's error shows under the result. Found by the user: Z-Image Turbo on their Windows PC, "The GPU did not manage it: trying again on the processor" with no reason shown and no check first |
| 2026-10-22 (this session) | 17 queue, page side (jsdom, faked answers) | client (queue commit) | page PASS: a request from before a restart shows again ("Started again after a restart"), two new requests show "1 / 2 before it" and finish in turn, Stop on a waiting one shows (stopped); Send stays free. Rust side: CI (WITH_IMAGE=1 queue + restart checks) |
| 2026-10-22 (this session) | 22 (page in jsdom with faked answers) | client d0403b4 | page PASS: tabs, counts, Music filter, viewer + Esc, Save / Save to cloud / Delete send the right requests, Cloud Content summary right. Rust side: waiting for CI; NOT yet tried in the real program |
| 2026-10-22 (this session) | 21 | site 31822291 (tested on worker.live.js before deploy; share page first live as 2c1a172c with 15/15) | 24/24 PASS; test files removed from B2. Page scripts syntax-checked (My content, share page for picture/video/song with a mocked B2); NOT yet looked at in a real browser |
| 2026-10-22 07:20 | 21 | site 73b8bdb4 (tested on worker.live.js before deploy) | 9/9 PASS; test file removed from B2. The program side (Save picture into Downloads, Save to cloud) waits for the next build |
| 2026-10-22 05:25 | 20 | site 2a60b9e0 (tested before deploy on the same worker.js, and on the dev copy with paid services) | 15/15 PASS (a first run listed 16 of 72: the brand-new test table's index was still filling; the test now waits for it; the real table's index lists all 72). Live: /admin has the Models tab, /api/admin/models 401 signed out, /api/models still the 7 originals |
| 2026-10-22 05:05 | cross-machine match: the same request (model, prompt, size, steps, seed) on Linux + RTX 4090 and Windows + Tesla T4 | client 114f763 | pictures look the same but are not bit-identical; SSIM FLUX 0.941 / 0.956, SD 1.5 0.987 / 0.992; different pictures 0.24-0.35. A fixed SSIM 0.98 would reject honest FLUX work: thresholds are per model (provisional FLUX 0.90, SD 1.5 0.97). Paper Table xplat |
| 2026-10-22 04:46 | 17 + 18 on WINDOWS with a GPU: AWS g4dn.xlarge, Windows Server 2022, NVIDIA Tesla T4 16 GB (GRID 596.86, WDDM), scripts/aws_windows_gpu_test.py | client 114f763 (CI artifacts windows-x86_64-vulkan and windows-x86_64) | pass. Vulkan .exe: "Tesla T4" found, every job on the GPU at 100 %: SD 1.5 512x512 20 steps 89.8 s first / 15.9 s; FLUX 1024 4 steps 111.4 s first / 36.8 s; Wan 832x480 33 frames 492.5 s. CPU .exe: SD 1.5 256x256 4 steps 62.9 s on the CPU. Results at https://planetcompute.ai/temp/ (win-*). Script bug found (asked the old copy during the takeover, waited forever); the CPU step was run by hand; everything on AWS deleted after 1 h |
| 2026-10-22 04:40 | 19 (and the edition tools) on small real files (stories15M GGUF, a tiny safetensors) | scripts edition_header.py, pod_editions.py, compare_edition.py | pass: llama.cpp's gguf reader and the safetensors loader see every tensor identical and only the new keys; streamed build over 19 and 8 parts byte for byte right, original / weights / edition SHA-256 all right; compare_edition.py RESULT line as expected |
| 2026-10-22 03:35 | 17 + 18 on a real GPU: rented NVIDIA RTX 4090 24 GB (driver 595.91, Vulkan), script scripts/pod_media_samples.py | client 114f763 (CI artifact linux-x86_64-vulkan) | pass, all on the GPU, no fallback. 8 library files (SD 1.5, FLUX.1 schnell + 3 parts, Wan 2.1 + 2 parts) verified, 60 s. FLUX 1024x1024 4 steps: 38.7 s first (model load), then 9.4-12.0 s, GPU 100 %, 12-14 GB; SD 1.5 512x512 20 steps: 21.2 s first, then 4.4-4.5 s, 4 GB; Wan 2.1 832x480 33 frames 20 steps: 87.8 s and 77.2 s, 10 GB. Results at https://planetcompute.ai/temp/ ; pod deleted after 7 min |
| 2026-10-22 03:10 | 3, 10, 16, 17, 18 (CI run 39713920674) | client 114f763 | Linux: ALL PASS incl. video: Wan 2.1 + parts verified, 256x144 5-frame 4-step WebM clip in 429 s on a 4-core CPU; picture 64 s (CPU). Linux Vulkan, macOS, Windows: ALL PASS |
| 2026-10-22 02:35 | 3, 10, 16, 17 on Windows, Windows Vulkan, macOS, Linux, Linux Vulkan (CI run 39710020900) | client c3bf4b0 (image engine stable-diffusion.cpp a1ded76) | ALL PASS on all five. Pictures (17): Linux CPU 256x256 4 steps in 64 s; macOS made it on the CPU after Metal failed (46 s) |
| 2026-10-22 02:30 | Metal diagnosis (CI run 39710020845, GitHub macOS runner) | stable-diffusion.cpp a1ded76 and master-987-a77d362 | every variant with any stage on Metal FAILS ("buffer is nil" on tensor views); CPU only works. Not yet tried on a real Apple-silicon Mac |
| 2026-10-22 01:30 | 15 | site worker.js with paid services (not deployed: waits for the Stripe key) | 29/29 PASS, incl. closed without card payments (an earlier run found 0.005 x 1.3 charged as 0.006501 by float rounding; fixed) |
| 2026-10-22 01:25 | 16 on Windows, macOS, Linux (CI run 39703844929) | client 4e10cc2 | every paste: and open browser: line PASS; ALL PASS |
| 2026-10-22 01:35 | Report Bugs button (headless browser, live site) | site 9503c248 | FOUND BROKEN by the user: the pop-up script ran before the pop-up's HTML and stopped. Fixed (it waits for the page); live: contact button, footer link and #report-bug open the pop-up at 1440 and 390 px. Test 13 now checks this |
| 2026-10-22 00:55 | 14 (gridSim, 20,000 devices, 1 h, faults on) | gridSim of 2026-10-22 | pass for the simple design: 0 jobs lost, 0 of 1,051,195 credit units wrong, 0 processed twice (6,447 repeats dropped), 6,426 of 6,637 jobs finished. For comparison: nothing retried lost 493 jobs and 10,202 credit units; retries without IDs lost 113 jobs and paid 1,123 units twice |
| 2026-10-21 | 1, 2, 3 on Windows, macOS, Linux (CI) | client 0.1.0, every push | pass (see the Actions history) |
| 2026-10-21 20:10 | 3 with the published `scripts/test_local_server.sh`, on Windows, Windows Vulkan, macOS, Linux, Linux Vulkan (CI run 39665653341) | client 6ed791d | 14/14 PASS on all five; takeover e.g. Windows 5324 -> 6864, macOS 2917 -> 2945 |
| 2026-10-21 19:00 | 4, 5 on a Linux cloud server (Ubuntu 22.04, 4 vCPU) | client 4fed0ef, site 6ef264be | pass: tunnel on within 3 s; owner 200, no session 401, other device 404, quit 403; signed out, link closed |
| 2026-10-21 19:34 | 8 on a staging copy | site worker as deployed 5979e0aa | 15/15 pass (an earlier run found that a vanished connection did not flush; fixed by handling the socket error) |
| 2026-10-21 19:45 | 6 on a Linux cloud server (4 vCPU, 2 cores at 50 %) | client 1481467, site 5979e0aa | pass: capacity verified within 10 s; 5 reports, 0.052475 WU reported, 0.034231 WU credited (capped at the verified rate), all of it in the balance after pause, nothing left pending |
| 2026-10-21 | 9 | catalog of 2026-10-21 | 7/7 OK against the publishers |
| 2026-10-21 20:45 | 10 (CI run 39671487744) on Windows, macOS (Metal), Linux | client 2674e31 | 18/18 PASS on all three: model downloaded from the publisher, SHA-256 checked, answer "Paris", streaming ends with [DONE] |
| 2026-10-21 21:25 | 10 with all sources (CI run 39675387528) on Windows, macOS, Linux | client 5c00c80 | 23/23 PASS on all three: Hugging Face listing, non-GGUF link refused, Ollama download SHA-256 verified, disk use and free space, delete; Vulkan builds 14/14 |
| 2026-10-21 23:50 | 13 | site 1937ccd2 (tested before deploy on the same worker.js) | 35/35 PASS; then the live site: home page shows Report Bugs, admin page the Bug reports tab, /api/admin/bugs 401 signed out, /api/bugs refuses a request without a form token |
| 2026-10-21 23:05 | site look (headless browser, then removed) | site 22d369e1 | pass: "Give Compute \| Get Compute" button fits the top bar with no overflow at 1440, 1280, 1100 and 960 px (short "Give"/"Get" below 1240 px); Give opens the console, Get opens Harness |
| 2026-10-21 22:10 | 12 | site 5df39aba (staging acb3e1d7) | pass: limit logic 26/26 (fake clock); staging 13/13; live site refuses a missing or fake Turnstile pass; a headless browser was shown the "Verify you are human" box instead of passing. A person then sent a real question through the form: the email reached the admins (confirmed by the user) |
| 2026-10-21 21:40 | 11 on a cloud server: NVIDIA RTX A4000 16 GB, driver 550, 112 shared CPU threads | client 5c00c80, site 9b08627e | pass. Vulkan: Qwen3 4B 83.1 tokens/s (first token 0.10 s, GPU 81 %, 2.8 GB), Qwen2.5-Coder 7B 58.9 tokens/s (0.12 s, 86 %, 4.6 GB); all layers on the GPU. CPU build on the same server: 23.6 and 17.4 tokens/s (3.4-3.5x slower). Library downloads through planetcompute.ai 17-18 MB/s (2.5 GB in 143 s, 4.7 GB in 262 s), SHA-256 verified; a newer start replaced the running copy |
| 2026-10-21 21:19 | 10, the library through planetcompute.ai | site 9b08627e | pass: 7 models listed; signed in: GGUF signature, resume (206, exact content-range), 100 MB in 3.3 s; unknown model 404; POST/PUT/DELETE/PATCH 405; signed out 401 |
| 2026-10-21 20:55 | 10 through the tunnel link, Linux cloud server (4 vCPU), signed in | client 5732199, site f9685158 | pass: /v1/models; plain answer "Paris"; streamed: first piece after 0.27 s, 50 pieces in 1.06 s, [DONE]; long streamed 474 pieces in 7.5 s; long plain answer 6,000 tokens after 127 s (beyond the old 30 s limit); quit refused (403); signed out, server deleted |
