# SherpaHub and kernel WorkPacks: specification (stages 1-3, admin tab SherpaHubs)

Status: stages 1-3 BUILT and tested 2026-10-28 (docs/TESTING.md tests 63-68; results in its "Our runs"); the site broker is LIVE (site 26f788c7) but idle until a SherpaHub runs; stage 4 is outlined only. The program is not in
production, so this replaces the old benchmark-lease code paths with no backward compatibility.
Background and decisions: `../../WORKPACKS_STATUS_AND_SCIENCE_LANE.md` (design note, sections 1-14), paper section
"QuickMode and BatchMode", research `../../howWorkPacksNeedtoBeDesigned.txt`.

## 0. Words

| Word | Meaning |
|---|---|
| Job | one piece of work a receiver asks for (here: a large int8 matrix product) |
| Unit | the smallest independent piece of a job (here: one tile of the result) |
| WorkPack (pack) | one or more units of ONE job sent to ONE device |
| Kernel | the maths a pack asks for (`mc_pi`, `matmul_i8`); identical results everywhere |
| Device | a contributor: browser tab or regular program (or a SherpaHub, which is also a contributor) |
| SherpaHub (hub) | the program that ORGANISES a BatchMode job: cuts, dispatches, checks, checkpoints, assembles |
| Block | a piece of an input matrix a device may keep cached (weight-stationary) |

A regular program DOES the work; a SherpaHub ORGANISES the work.

## 1. Stages

| Stage | What | Where it runs | Done when |
|---|---|---|---|
| 1 | Kernel library + binary pack format; the program and the browser compute identical results; benchmark lease uses the same kernel code | `client/workpack` crate, program, website page script | conformance vectors match bit for bit on all 5 builds and in a browser engine; speed printed per platform |
| 2 | SherpaHub core: job store, cutter, sizer, dispatcher, checker, checkpoints, assembler, as a pure state machine; a fault simulator | `client/workpack` crate (no network) | the simulator suite (section 8) passes in CI |
| 3 | Site broker: hubs and devices meet through planetcompute.ai (section 10) | website + program + contributor page | BUILT: tests 65-68 pass; live |
| 4 | First real model work: one image with its matrix multiplies as packs | program | later |

## 2. Code layout

- `client/workpack/` NEW crate, a library with ONE dependency (`sha2`). No async, no threads, no I/O except the
  checkpoint directory. Built and tested on its own in seconds (`cargo test --release` inside `client/workpack`).
  - `kernels.rs`: `mc_pi`, `matmul_i8` (+ Freivalds check), the shared PRNG.
  - `wire.rs`: binary pack / result format, encode + decode with full bounds checks.
  - `hub.rs`: the SherpaHub state machine.
  - `store.rs`: checkpoint directory (result file + done bitmap + job header).
  - `sim.rs` (tests only): fault simulator.
- `client/` (the program) depends on `workpack` (path dependency). The program uses `workpack::kernels` for the
  benchmark leases and adds `--workpack-check` (prints the conformance hashes + kernel speed; CI runs it on all 5).
- Website page script: the browser kernel `matmul_i8` (JS, Int32 maths) next to the existing pi WebAssembly module,
  + `scripts/test_workpack_vectors.mjs` (Node, runs the page's kernel code against the same vectors).

## 3. Kernels (identical everywhere)

### 3.1 PRNG (inputs of tests and synthetic jobs)
`xorshift32`: `x ^= x << 13; x ^= x >> 17; x ^= x << 5` on u32, seed 0 replaced by 0x9E3779B9. An i8 value is
`(next() >> 24) as i8`. Defined so a browser (JS `>>>`, `| 0`) reproduces it exactly.

### 3.2 `mc_pi(seed: u32, n: u32) -> u32` (kernel id 1)
Unchanged maths of today's benchmark (must equal the website's `cpuChunkHits` and the 133-byte WASM module).

### 3.3 `matmul_i8` (kernel id 2)
Inputs: `A` m x k int8 row-major; `BT` = B transposed, n x k int8 row-major (so every dot product reads two contiguous
rows). Output: `C` m x n int32 row-major, `C[i][j] = sum_t A[i][t] * BT[j][t]`, exact (int32 accumulation).
Limit: `k <= 131071` (|sum| <= 127*128*k < 2^31). Implementation: rows of 4 (`i`) x 4 (`j`) register tile, inner
loop over contiguous i8 slices widened to i32 (auto-vectorised; SSE2/NEON baseline, no CPU-specific build).

### 3.4 Freivalds check (the hub, not the device)
To accept `C = A * B` for a tile: draw `r` (n values, each a random i64 in [-2^15, 2^15)), compute
`y = BT^T r` ... i.e. `y[t] = sum_j BT[j][t] r[j]` (k values), then check `A y == C r` (m values), all in i64.
Cost `O(nk + mk + mn)` instead of `O(mnk)`. A wrong `C` passes one round with probability <= 2^-16; the hub runs
TWO rounds with fresh `r` (<= 2^-32). i64 never overflows for k, n <= 4096 per tile (asserted).

## 4. Wire format (binary, little-endian; one WebSocket binary message each)

Every message starts with an 8-byte header: `magic u32` | `kind u8` | `version u8 = 1` | `flags u16`.

| kind | Name | From -> to | Body after the header |
|---|---|---|---|
| 1 | PACK | hub -> device | job u64, pack u64, epoch u32, kernel u8, units u8, 0 u16; then per unit: unit u32 + kernel params |
| 2 | RESULT | device -> hub | job u64, pack u64, epoch u32, compute_ms u32; then per unit: unit u32 + output |
| 3 | NEED | device -> hub | job u64, pack u64, epoch u32, count u32, count x block id [16] |
| 4 | BLOCK | hub -> device | block id [16], len u32, bytes |

`matmul_i8` unit params: m u32, k u32, n u32, a_block [16], bt_block [16]. Blocks are sent ONCE per device (kind 4)
and kept in a bounded LRU on the device (weight-stationary: the hub sends a device units that reuse the blocks it
holds). A device missing a block answers NEED; the hub sends the blocks and the pack again (only blocks that pack uses; a
third NEED for the same pack withdraws it). Block id = first 16
bytes of SHA-256 of the block bytes (the device re-hashes on receipt: a corrupted block is never used).
`matmul_i8` unit output: m*n i32. Decoding checks every length against the declared sizes before any allocation;
caps: 64 MiB per message, 255 units per pack.
Magic: `0x50574350` ("PCWP").

## 5. SherpaHub: a pure state machine

    hub.on_hello(now, device, caps)      a device can take packs (caps: kernels, cache bytes)
    hub.on_result(now, device, bytes)    a RESULT / NEED arrived
    hub.on_gone(now, device)             the device left
    hub.tick(now) -> Vec<Out>            time passes: timeouts, hedges, assignments
    Out = Send(device, bytes) | Credit(device, units) | Strike(device) | Done(job)

Time is passed in (`now` in ms), never read: the same calls give the same result, so the simulator can run a
million virtual seconds in real seconds and every failure replays exactly. The network layer (stage 3) only moves
bytes and calls these.

### 5.1 Unit states
`Waiting -> Out(copies 1..2) -> Done`. A unit is Done exactly once: the first RESULT that passes the check. Later
copies of a Done unit are ignored and never credited. A pack whose deadline passes puts its unfinished units back to
Waiting (the device is not blamed for being slow; it may still deliver and is accepted if the unit is not Done).

### 5.2 Cutting (synthetic matmul job)
`C` (M x N) is cut into tiles of `tm x tn` (defaults 64 x 64; edge tiles smaller). Unit `u` = tile (row block, col
block). Blocks: A row block `i` (tm x K) and BT col block `j` (tn x K). With weight-stationary reuse a device holding
BT block `j` gets the units of column `j` first.

### 5.3 Sizing (the research's square-root law)
Per device the hub keeps `t_d` = time per unit (EWMA of `compute_ms / units`, alpha 0.3; first guess 2 s).
Overhead `T_o` = EWMA of (round trip - compute) over all packs, first guess 1 s. `T_ideal` = remaining units x median
`t_d` / devices. Pack time `tau = sqrt(T_o * T_ideal / kappa)` with kappa 1.5, clamped to
`[9 * T_o, min(tau_max, 0.05 / lambda)]`, `tau_max` 300 s, `lambda` = observed departures per device-second (first
guess 1/1800). Units per pack `b_d = clamp(round(tau / t_d), 1, 255)`. Deadline = issue time + `3 * b_d * t_d + 2 * T_o`.

### 5.4 Dispatch order
1. idle device + Waiting units: build its pack from ONE column (prefer a column whose BT block it holds), at most
   cache_blocks - 1 units, so a whole pack always fits the device's cache; within the column, rows whose A block the
   device already holds go first (no transfer; the old order, always from the top row, re-sent almost every A block
   when a device moved to its next column, because its cache holds about one column of A blocks);
2. no Waiting units, some Out (end game): an idle device gets a COPY of units of the oldest LATE pack (past 2x its
   expected time) with copies 1 (hedge; at most 2 copies; at most cache_blocks / 2 units);
3. packs in flight per device (built 2026-10-31 after the live 65536 x 4096 x 65536 job ran at 1.5% of the kernel's
   speed with one): window = 1 + round(T_o / pack time), at most `max_inflight` (program: 16, environment
   `PC_SHERPA_INFLIGHT`, 1 = the old way; crate default 1), and the blocks of the packs in flight within half the
   device's cache. Where the square-root law makes packs long compared with the round trip the window is 1, as before;
   on the live broker (~9 ms packs of 15 tiles, the 1 MiB message limit; ~0.4 s round trips) it is 16. Devices (program
   and browser) already handle messages strictly in order, so they need no change. Packs are handed out in rounds
   (emptiest pipelines first), a pack's deadline counts the packs queued before it, and T_o is measured only from
   packs sent to an empty pipeline. Hub block memory: 1 GiB in the program (was 256 MiB).

### 5.5 Checking and strikes
Every returned unit is Freivalds-checked (2 rounds) before it counts. A failed unit: Strike(device), the unit stays
or goes back to Waiting, and ALL the device's packs in flight are withdrawn. 3 strikes: the device is banned for the
job (hellos ignored). Credit is emitted only for checked units.

### 5.6 Checkpoints (crash-safe, cheap)
Job directory: `job.hdr` (job id, epoch, M K N tm tn, input seeds or block file names), `result.bin` (M*N i32,
pre-allocated), `done.bits` (1 bit per unit). On a checked unit: write its tile into `result.bin` at its offset;
every 250 ms or 256 units (whichever first): `fsync(result.bin)` THEN write + `fsync(done.bits)`. Order makes it
safe: a bit is only ever set after its tile is on disk. Restart: read header, `epoch += 1`, load bits; everything
not done is Waiting. RESULTs carrying an old epoch are dropped (packs from before the restart).

### 5.7 Assembly
`result.bin` IS the assembled product. Done(job) when every bit is set; the hub then re-checks the WHOLE `C` with
Freivalds (2 rounds over the full matrix) before reporting done.

### 5.8 After a restart
Units checked but not yet durable (between two flushes) are done again and credited again: honest work, at most
`flush_units` units per crash. Everything durable is never redone.

## 6. Efficiency rules
- Binary messages, no JSON, no base64 on the pack path. One copy from socket buffer to kernel input.
- Blocks sent once per device (LRU), not once per pack: traffic per unit is the A block id + the C tile out.
- Kernel inner loops on contiguous slices; no bounds checks inside (lengths checked once at decode).
- Hub work per unit is O(tile) (check + copy), never O(tile * K) except the 2 Freivalds dot products.
- Hub memory: unit table (16 bytes per unit) + packs in flight + blocks it serves; result on disk, not in RAM.

## 7. Limits
`k, n <= 4096` per tile; M, N up to 2^20 each; units per job <= 2^26; packs in flight = devices; message <= 64 MiB.

## 8. Tests (all automated; documented in docs/TESTING.md test 63 and 64)

### Test 63: kernel conformance (stage 1)
1. `cargo test` in `client/workpack`: `matmul_i8` vs a naive reference on 200 random shapes (1x1x1 to 67x301x71,
   odd sizes, k up to 4096, extreme values -128 / 127); wire encode/decode round trip; every truncated / oversized /
   lying-length message is refused without panic.
2. Conformance vectors: 6 fixed (seed, m, k, n) cases; SHA-256 of `C` as bytes. Same hashes from: the crate tests,
   `planetCompute --workpack-check` on all 5 CI builds, and `scripts/test_workpack_vectors.mjs` (the page's kernel).
3. Freivalds: a correct tile passes; flipping ANY single i32 of C (1,000 random positions, +1 / -1 / x-1 / random) is
   caught; an all-zero C is caught.
4. Speed: `--workpack-check` prints GOP/s of `matmul_i8` per platform (logged, not a pass rule).

### Test 64: SherpaHub fault simulator (stage 2)
Virtual clock; devices with log-normal speeds (sigma 0.8), Poisson departures and returns; the job's exact answer is
known (reference computed once). Every scenario must end with: job Done; `result.bin` equal to the reference byte for
byte; every injected wrong answer caught (count injected = count struck); no unit credited twice; credited units =
total units; no panic; deterministic (same seed = same event log hash).
Scenarios:
  a. 1 device, then 500 devices (no faults): baseline makespan vs ideal (`total work / total speed`), reported;
  b. devices vanish mid-pack (30% leave per hour);
  c. stragglers (5% of devices 20x slower): end-game hedging bounds the tail (makespan < 1.5 x scenario b);
  d. liars: 5% return wrong tiles (random single-cell and whole-tile); all struck, banned after 3, job still exact;
  e. late duplicates: results arriving after a timeout or after a hedge copy finished: accepted once, credited once;
  f. hub killed and restarted 5 times at random moments (state rebuilt from the checkpoint directory only): job exact,
     no unit lost, old-epoch results dropped;
  g. corrupted / truncated / foreign-job / wrong-epoch messages: refused, no state change;
  h. cache pressure: devices with room for 2 blocks only: correct, traffic counted and reported;
  i. scale: 2^16 units, 2,000 devices, finishes in under 60 s of real time on a CI runner.

CI: a new fast job in `.github/workflows/client.yml` (`workpack`: ubuntu, `cargo test --release` in
`client/workpack`, runs on every push touching `client/**`), plus `--workpack-check` in each of the 5 builds.

## 9. Measured (2026-10-28, RunPod AMD EPYC 9575F) and follow-ups
- `matmul_i8` per core, AMD EPYC 9575F (same machine for all): program (Rust) 57.9 GOP/s with explicit SSE2
  (`pmaddwd`; NEON `vmull_s8` + `vpadalq_s16` on ARM; plain loop elsewhere; it was 18.7 with the auto-vectorised
  loop); browser WebAssembly SIMD 24.7 GOP/s (`i32x4.dot_i16x8_s`, 655-byte module); browser plain JavaScript 2.05
  GOP/s (fallback for engines without WebAssembly SIMD). All bit-identical (pinned vectors).
- Browser kernel files: `website/workpack_kernel.wat` (source) -> `scripts/build_workpack_wasm.mjs` (needs npm wabt
  1.0.36) -> base64 between `// WASM_SIMD_BEGIN` / `// WASM_SIMD_END` in `website/workpack_kernel.mjs`;
  `makeSimdMatmul()` returns the SIMD function or null (then use `matmulI8`). CI checks the embedded bytes = source.
- FOLLOW-UP: keep a device's cached blocks INSIDE the WebAssembly memory so a pack copies only its A block in and C
  out (today every call copies A and BT in, and the page copies the blocks into each Web Worker per pack).
- Simulator: exact in every scenario; with real work per device the makespan is 1.09 x ideal with 0.1% duplicate
  work. With very little work per device (2,000 devices x 33 units) the end game dominates (about 2 x ideal; hedges
  use idle devices only and are never credited).
- Who feeds browsers: a browser contributor gets real work only while at least one SherpaHub is running a BatchMode
  job (otherwise only the benchmark). Company SherpaHubs guarantee that at the start.

## 10. Stage 3: the site broker (BUILT 2026-10-28)

Nobody opens a port. The SherpaHub and every device keep ONE outbound WebSocket to planetcompute.ai; the site relays
the binary PCWP messages (section 4) between them untouched and decodes none of them (it checks size and magic only;
the hub checks everything).

### 10.1 Site (`website/worker.js`, Durable Object class `SherpaBroker`, binding `SHERPA`, migration `v4-sherpa-broker`)
| Route | Who | What |
|---|---|---|
| `GET /api/sherpa/status` | anyone | `{"hubs": n}` hubs with an open job and room; edge-cached 15 s (a million waiting devices cost a few reads) |
| `WS /api/sherpa/hub?device=` | the program, signed in, NO Origin, an ADMIN account (in-house SherpaHubs only for now), device key required | the hub's socket; one copy of the program owns a hub name (first device key bound, as tunnel links) |
| `WS /api/sherpa/device?device=` | signed-in account; browser (same origin) or program (no Origin) | the directory picks the open hub with the fewest devices; one connection per device (a newer one replaces it) |
| `GET /api/admin/sherpa` | admins | every hub on the directory: job, done / total, devices, and the accounts it credited (units, strikes) |

Roles of the one class: `sherpa:dir` (the directory: hubs, their device counts and job status, 120 s TTL) and
`sherpa:hub:<user>:<device>` (one room per hub: its socket and its devices' sockets, hibernation API, per-device tags
so a frame to device N finds its socket directly). A room tells the directory on hub up / down and at most every 15 s
otherwise (an alarm sends what the throttle held back).

Frames: hub socket binary `[device id u32 LE][PCWP]` both ways; text room -> hub `{"t":"hello","dev","cache","cores"}`,
`{"t":"gone","dev"}`; hub -> room `{"t":"credit","dev","units"}`, `{"t":"strike","dev"}`, `{"t":"ban","dev"}`,
`{"t":"status","job","done","total","open"}`. Device socket: binary = one PCWP message; text device -> room
`{"t":"hello","cache","cores","kernels"}`. `{"t":"ping"}` is answered `{"t":"pong"}` without waking the object.
Close codes to devices: 4000 replaced, 4008 banned for this hub's job (24 h for that account + device in that room),
4010 the hub left (connect again: another hub), 4013 full. Limits: 1 MiB per message (the hub sizes packs to it:
`Config.max_message`), 2,000 devices per hub. Device IDs are new for every connection, so packs of an old connection
can never be answered by a new one. Checked units are counted per account in the room (`cred:<user>`); turning them
into Compute Credit is a later decision.

### 10.2 Program (`client/src/sherpa.rs`)
- `planetCompute --headless --sherpahub [--sherpa-job MxKxN] [--sherpa-tile T] [--sherpa-repeat]` prints "started as a
  SherpaHub" (else "started in regular mode") and leads a synthetic int8 matmul job (default 2048x4096x2048, tiles
  64) on its own thread and runtime: `workpack::hub` + the socket above; status every 10 s on the console and to the
  site. The job lives in `<data dir>/planetCompute/sherpahub/current` (checkpoint, section 5.6): after a crash or a
  restart the SAME job continues in a new epoch. Done jobs are logged in `sherpahub/jobs.log`; without
  `--sherpa-repeat` the hub then closes (its devices go to other hubs) and the program runs on in regular mode.
- Device role: a headless program with contributing on checks `/api/sherpa/status` (every 20 s while there is no hub)
  and connects while a hub runs; packs are computed by `Device::handle_on(bytes, cores)` on the chosen cores (units
  split over scoped threads; byte-identical to one thread), under the cap (rest in proportion), and the pi WorkPacks
  wait while a pack computes (`Engine::pack_begin` guard). The program's window passes the console's
  `/api/sherpa/device` socket through its site port like `/api/police/ws`.
- `PLANETCOMPUTE_SITE=http://...` points both roles at a test broker; the session cookie and device key are sent to
  planetcompute.ai only.

### 10.3 Contributor page (browser)
While running and signed in, the console asks `/api/sherpa/status` once a minute and connects when a hub runs. The
protocol code is `website/workpack_device.mjs` (block cache checked by SHA-256 via `crypto.subtle`, LRU 128 MiB,
PACK -> RESULT or NEED, = `device.rs`) with the kernels of `workpack_kernel.mjs` (WebAssembly SIMD, plain JavaScript
fallback); `scripts/embed_workpack.mjs` puts both into the page as `WORKPACK_SRC` (CI checks the copy). A pack's
units are split over Web Workers (one per chosen core); the pi workers pause meanwhile; the cap rests after each
pack. Meter "SherpaHub work" shows the pieces done.

### 10.4 Measured (tests 65-68)
Through the local broker on a 16 vCPU pod: 4,096 units (137 GOP) with 3 browser-code devices + 3 programs (2 cores
each), every unit checked + the final check; liars banned after 3 strikes; a hub killed with kill -9 continued the
same job (4,476 of 16,384 units kept) and finished. Transfer note for stage 4: a RESULT tile carries 4 bytes per
cell for 2K operations, so at K = 4096 a browser core at ~25 GOP/s sends ~12 MB/s of results: real jobs need large
K, few devices per hub link, or results kept near the hub (stage 4 design).

### 10.5 Not yet (next steps)
Volunteer (non-admin) SherpaHubs with the opt-in of design note section 12; the admin tab "SherpaHubs (in-house)"
(section 13.2, the data is already in `/api/admin/sherpa`); Compute Credit for checked units; more than 2,000
devices per hub; stage 4 (first real model work).

## 11. In-house SherpaHubs on the admin tab SherpaHubs (BUILT 2026-10-28)

User: "I should be able to start and stop the inhouse Sherpahub from admin page tab: Sherpahubs - upto 5 instances. And
give work to it with prompts etc. And see the logs where the work went." Decisions (user): the hubs run in their own
folder `/root/REMOTESERVERSACCESS/sherpahubs` on 203.0.113.10; "work with prompts" = batches of WHOLE prompts
(stage 4, packs cut from one prompt, is not this).

### 11.1 Servers and copies
A server is a row of `<prefix>Workhorses` with `role = "sherpahub"` (1-5 copies, default folder
`/root/REMOTESERVERSACCESS/sherpahubs`, ports from `port_base`, an ADMIN account). The same agent as the workhorses
(`workhorse/whagent.py`, installed with `scripts/startWorkhorseOnAnyServer.py --server-id <id> --boot`, which adds
the line `# planetcompute sherpahubs` to the crontab) gets the role in its orders and starts each copy as
`planetCompute --headless --port <p> --sherpahub` (no contributing: a SherpaHub organises). Start / Restart / Stop
and the number of copies on the tab reach the agent within 15 s. The Workhorses tab does not list these rows.

### 11.2 Jobs: given on the tab, kept by the hub's room
`POST /api/admin/sherpa/jobs` (admins) picks a hub (or the running hub with the fewest jobs waiting) and stores the
job in that hub's room (`job:<id>`, the last 100 per hub; body up to 500 KB):
- `kind: "matmul"`: M, K, N, tile (the stage 3 test job); log: per device the checked pieces and strikes.
- `kind: "prompts"`: `task` chat | image, `model` (a library model), up to 200 prompts (one per line, 2,000
  characters each), `check_pct` (default 10), chat `max_tokens` (default 512), image width / height (256-1536,
  default 512) and steps, `seed` (each prompt gets seed + its position).
The room sends every job still to do to its hub when the hub connects (then `{"t":"jobs_end"}`: a running job not
sent again was cancelled meanwhile), and new jobs at once; `{"t":"cancel","job"}` stops one. The hub runs ONE
matrix job and ONE prompts batch at a time, side by side, the others wait in order; it reports
`{"t":"jstate","job","state":"running"|"done"|"failed","note"}`.
Admin routes: `GET /api/admin/sherpa` (rows, hubs online, jobs of every hub seen), `GET /api/admin/sherpa/job?hub=&id=`
(every prompt with the account e-mail and device of whoever did it, the check, the result, the log),
`POST /api/admin/sherpa/cancel`, `GET /api/admin/sherpa/file?key=` (a picture result, private in B2 under
`sherpa_jobs/<job>/<n>-<copy>.png`).

### 11.3 Whole prompts (`client/src/sherpa_prompts.rs`, a pure state machine like `workpack::hub`)
- Devices: a program with downloaded chat or picture models connects with `kinds=packs,prompts` and lists them in its
  hello (`models: [{id, kind}]`, `name`); the directory sends such devices first to hubs with prompts waiting
  (status `wants: ["packs","prompts"]`). While a batch runs, the programs that have its model work on prompts, not
  matrix packs; browsers only ever get packs. A hub with no work left sends its devices on (4010).
- One prompt per device at a time; a failed prompt is tried on another device, 3 tries at most; a device that leaves
  gives its prompt back. Time limits: see 11.7 (a picture is given up when its steps stop coming, not after a fixed
  3 hours; chat: 15 min).
- Checks: `check_pct` of the prompts (chosen from the job id, the same after a restart) run a second time on ANOTHER
  device with the same seed. Chat: the same text = AGREE. Picture: mean difference of 32 x 32 grey thumbnails, up to 8
  of 255 = AGREE. A check no second computer can make (only one has the model) is given up after 2 minutes.
  Disagreements are logged (no strikes yet: which copy is wrong is not known).
- The device runs a chat prompt like a grid job (`contribute::run_job`, temperature 0) and a picture with the picture
  engine (`images.start`), deletes its local copy, and answers. The pi WorkPacks wait meanwhile.
- After a hub restart the room sends the batch again with the prompts already done; only the rest is done.
Wire (PCWP, after the 8-byte header: u32 JSON length, JSON, bytes; files in parts of at most 900 KB):
| kind | Name | From -> to | JSON |
|---|---|---|---|
| 5 | TASK | hub -> device | task_id, job, n, task, model, prompt, params |
| 6 | TASK_RESULT | device -> hub | task_id, ok, error, ms, text, ext, part, parts (+ picture bytes) |
| 7 | STORE | hub -> room (frame to device 0) | job, n, copy, part, parts, ext (+ bytes); the room joins the parts and writes B2 |
| 8 | PROGRESS | device -> hub, every 30 s while a picture is made | task_id, job, n, copy, state, step, steps |
| 9 | CANCEL | hub -> device | job, n, copy: another computer delivered it first; the device stops that picture |
Room log lines from the hub: `tsent {job,n,dev,copy}`, `tresult {job,n,dev,copy,ok,ms,text,error,final}`,
`tcheck {job,n,agree,diff,note}`; `credit` / `strike` carry the matrix job's id.

### 11.5 Controls on the tab (user: "yes build 1-3 with the core limit")
- **Log** per copy: the hub sends what it prints to its room (`{"t":"log"}`, the last 300 lines; also lines from
  while it was offline); `GET /api/admin/sherpa/log?hub=`. **Console**: the copy's own page through its device link
  (`/device/<device id>/`, for the row's account).
- **Drain** per copy: `POST /api/admin/sherpa/drain {hub, on}`; the room keeps it and sends it again after a reconnect;
  the hub finishes the jobs running and starts no new one; its status says `draining` and `idle` ("DRAINED: safe to
  Stop"); "any hub" jobs skip draining hubs.
- **Update to newest build** per server: control action `update`; the agent reads `/download/latest.json` (versions and
  SHA-256 of every published build; new public route, also `/download/linux-server`), downloads the server build,
  checks its SHA-256, swaps it in and restarts the copies; the result is reported (`update_last`).
- **Models on in-house computers**: every minute the agent asks each copy's local API for its models and reports them
  (`[id, percent, error]`); `POST /api/admin/workhorses/models {server_id, action download|delete, model, copies}`
  becomes an order (`model_cmd`, `model_seq`) that the agent carries out through the copies' local APIs.
- **Pictures on shared servers**: the picture engine uses the copy's cores (not the whole machine), and the copies of one
  server folder make one picture at a time (`PLANETCOMPUTE_IMAGE_LOCK`, set by the agent). Measured: a 512 x 512 Z-Image
  Turbo picture took 1,037 s on ~9 cores of the interserver; a 1920 x 1088 one ~3 h on 4 busy cores (11.7). Pictures a
  SherpaHub asked for are not resumed after a restart (the hub gives them again). A device whose connection to the hub ends cancels the picture it was waiting for (found live: two updates had left 8 duplicate pictures queued on the copies).

### 11.6 Pictures and videos from the PlanetCompute pool (user: "now add functionality so the pool also accepts create images and create videos")
A picture or video asked on the program's Images / Video page with "PlanetCompute pool" becomes a ONE-PROMPT job of
an in-house SherpaHub (no check copy), kept for the account that asked (`for_user`, `source: "pool"`):
- `GET /api/pool` adds `image_models` / `video_models` (models the in-house computers have READY, from their agents'
  reports in the last 3 minutes, not SherpaHub rows; kinds from the library), `hubs`, `media_open`, `media_limit`,
  `media_used`.
- `POST /api/pool/media {task, model, prompt, width, height, steps, frames, seed}`: limit POOL_DAILY_MEDIA_LIMIT per
  account per UTC day (plain-text Worker variable; 0 = off; not set = 10; its own counter `POOLM#<day>`, given back
  when no hub can take it); the running hub with the fewest jobs waiting; index item `POOLMEDIA#<time>#<job>` (30 days).
- `GET /api/pool/media`: the account's newest 20 with state (waiting, making, done, failed) and who made it;
  `GET /api/pool/media/file?hub=&job=`: the file, only for the account that asked.
- The program lists them as cards ("In the PlanetCompute pool: waiting / being made"), checks every 20 s while one is
  open, and fetches a finished one into the pictures folder once (`POST /local/pool/save`): it is in My Content and
  the gallery with "ran on: PlanetCompute pool". Videos: the same, with a video model (`.webm`; not compared).
Connections drop (every site deploy restarts the Durable Objects and closes every WebSocket), so whole prompts
outlive them: the device runs each prompt in a task of its own, keeps a finished answer in an outbox until a
connection sends it (whole, from part 0), and a new connection's hello lists the prompts still being made (`busy`);
the hub keeps a vanished device's prompt for 2 minutes (orphan), gives it back to the device that says it is still
making it (`adopt`), and accepts an answer by job / prompt / copy even under an older task number. Found live: a
finished picture was lost after a deploy.

### 11.7 Time limits that follow progress (2026-10-30; user: "yes build 1-4")
Incident: a user's 1920 x 1088 pool picture (Z-Image Turbo, 8 steps) on the SherpaHub's own copy (4 cores, server
load ~18 on 16) needed ~3 h. The device gave up after a fixed 175 min and the hub after 180 min, the hub gave the
prompt to the same copy (most cores) and it started from zero: made three times, delivered ~9 h after it was asked.
Now (`sherpa_prompts::Watch`, the same rule on the hub and on the device):
- The device reports its picture's progress every 30 s (PROGRESS: engine state and sampling step).
- Until the first sampling step is reported the old fixed limits hold (chat 15 min, picture 3 h, video 6 h; also
  for older programs that send no PROGRESS). From the first step: given up only when no new step (or state) came for
  max(30 min, 3 x the slowest step so far; the first step counts with the model loading). Hard limit 12 h (video 24 h).
- Out of time on the hub = one try used, but the task stays with its computer (`late`): the prompt goes to ANOTHER
  computer as well, and whichever delivers first wins; the other is sent CANCEL (it stops its picture; an older
  program finishes it and its answer is dropped). A late task is let go at the hard limit.
- A computer that ran out of time on a prompt gets it again only when no other computer took it for 10 minutes
  (a model only one computer has). An error from a computer for a prompt another computer is making changes nothing.
- A prompt fails only when its 3 tries are used AND no computer is making it any more.
- Before asking: the site and the program show an estimate, 42 core-minutes per megapixel per step on the cores of
  the computers that have the model (`GET /api/pool` image_models: `cores`, `steps`); the answer of `POST
  /api/pool/media` carries `eta` and `eta_minutes`; a picture estimated over 12 h is refused (`too_big`).
Unit tests: `sherpa_prompts.rs` (watch rules, progress keeps a slow picture, late answer wins + CANCEL, the retry wins
+ CANCEL, the only computer again after 10 min, failing only when the last computer ends, frames); TESTING.md 89.

### 11.4 Tests
docs/TESTING.md 69 (room jobs, local runtime), 70 (the tab in Chromium), 71 (the real SherpaHub with jobs from the
room, prompt and pack devices, a liar, cancel, kill -9 in a batch), plus the unit tests in `sherpa_prompts.rs`.

### 11.x SupplySimulation, DemandSimulation and test-traffic priority (2026-10-30)
A pool prompts job may carry `low: true` (DemandSimulation test traffic, sent by a server's own sign-in with
`priority: low`; source "demand"). The room passes it in the job message (`jobMsg`: `low`); the SherpaHub program picks
the next prompts job with `next_prompts`: a real user's first, a low one only when no real one waits. SupplySimulation
copies are SherpaHubs that also contribute, so they are also devices (of a SherpaHub the directory picks) and make pool
pictures. Details: WORKHORSES.md, TESTING.md test 87.

## 12. One program, six roles: how to use a SherpaHub as each (2026-10-30; paper sec:fiveroles, Table "The six roles")

A SherpaHub is the ordinary planetCompute program started with `--sherpahub`: it keeps everything the regular program
does and adds organising. Rule: a regular program DOES the work; a SherpaHub ORGANISES it (and can do it too). Today a
SherpaHub must be signed in with an ADMIN account (site: "SherpaHubs are in-house only for now"), so roles 1-3 and 6 run on
the operator's servers; on volunteers' PCs roles 4-5 are the regular program, and SherpaHub mode there is PLANNED.

| # | Role | How to switch it on | What it does | Status |
|---|---|---|---|---|
| 1 | Generous cow (gives a lot of compute) | Admin page, tab SherpaHubs, the server's row: SupplySimulation on, cores per copy, cap %, copies 1-5; models on the Models panel. The agent (whagent.py) starts each copy as `planetCompute --headless --sherpahub --contribute --cores N --cap P` | answers pool chat, makes pool pictures, does grid work; credit to the row's account | LIVE (row d0257f91c822: 2 copies x 4 cores; replaced the generous cows 2026-10-30) |
| 2 | Hungry wolf (sends requests, consumes a lot) | Same row: DemandSimulation on, chat jobs an hour 0-3,600, pictures a day 0-48, chat model, picture model (empty = qwen2.5-0.5b-q4km / zimage-turbo-q4k) | the AGENT beside the program (whagent.py `Demand`, not the program) sends real jobs: at most 8 at once, `priority: low`, not counted in daily limits, marked test; numbers on the tab, one line per job in `<root>/logs/demand.jsonl` | LIVE at 800 chat jobs an hour; operator servers only (no agent on a volunteer PC) |
| 3 | Orchestrator (middle man between contributors and receivers) | `--sherpahub` + admin sign-in; work given on the admin tab SherpaHubs (Give work), or one matrix job on the command line `--sherpa-job MxKxN [--sherpa-tile T] [--sherpa-repeat]` | one outbound WebSocket to the site's SherpaBroker; browser tabs (console) and programs with contributing on join the hub with the fewest devices; whole prompts to programs holding the model (10% made twice on different computers to check); matrix jobs cut into packs for browsers and programs, every pack checked (Freivalds), strikes/bans; pool pictures/videos as one-prompt jobs; Log / Console / Drain / Update / Models on the tab | LIVE in-house. NOT yet: real model work cut into packs for browsers (stage 4), receivers sending their own BatchMode jobs, volunteer SherpaHubs |
| 4 | Receive Compute app on a PC | nothing extra: the program's page `/local/` and local API stay on in SherpaHub mode (server: `ssh -L <port>:localhost:<port> <server>`, then the link the program prints with `?t=`) | local chat / pictures / video on its own models, the PlanetCompute pool, Express through the Local Tunnel | LIVE in regular mode on every PC; as a SherpaHub on a volunteer PC: PLANNED |
| 5 | Contribute Compute app on a PC | `--contribute --cores N --cap P` (or the switches on the program's page) | shares cores under the cap: WorkPacks, grid jobs, pool prompts | LIVE in regular mode on every PC; on operator servers = role 1; as a SherpaHub on a volunteer PC: PLANNED |
| 6 | WholeMode (a prompt in, the finished product out) | a pool request for a picture or video (program's pool choice, or Express: POST /api/pool/media), or Give work on the admin tab (a batch of whole prompts, up to 200); with SupplySimulation on, the hub's own copies hold the models and make it themselves | the prompt is NOT split: one program holding the model does every step (picture: text encoder, diffusion, decoder; sd-cli) and returns the finished file, kept for the account (B2; My Content "ran on: PlanetCompute pool"); in a batch 10% made twice on another computer and compared (32x32 grey thumbnail within 8/255); one picture at a time per server folder, given up when its steps stop coming (11.7); 512x512 Z-Image ~17 min on ~9 cores. Chat is WholeMode too but goes through the grid (/api/pool/chat), no SherpaHub | LIVE in-house for pictures and videos |

Roles combine: each in-house copy today is roles 1 + 3 + 4 + 5 + 6 at once, and the agent beside it is role 2, so one server
exercises the whole grid. Start-up line tells the mode: "started as a SherpaHub" or "started in regular mode".

## 13. How to run a split (matmul) job and watch it (2026-10-31, first live run)

Pictures and chat are WholeMode today (one program does the whole prompt). The one job that is **split into WorkPacks
across many computers** today is the matrix (matmul) test job: an int8 matrix product cut into 64 x 64 tiles; each tile is
one unit, units go out in packs to every device of the hub (the server copies, and any browser with the contributor page
open), every unit is checked (Freivalds) and the whole product gets a final check.

**Start one** (needs an admin signed in): planetcompute.ai/admin -> tab **SherpaHubs** -> New job -> **Matrix (matmul)** ->
M, K, N, tile (limits: K 1-4096; M, N up to 1,048,576; tile 8-1024; tile x K and a tile of results must fit 1 MiB) ->
Hub "any" -> Start. Size guide on the operator's server (4 copies x 4 cores, AMD, int8 SSE2): about 9 GOP/s in all:

| M x K x N, tile 64 | Units | Work | About |
|---|---|---|---|
| 4096 x 4096 x 4096 | 4,096 | 137 GOP | 15-20 s |
| 8192 x 4096 x 8192 | 16,384 | 550 GOP | about 1 minute |
| 16384 x 4096 x 16384 | 65,536 | 2.2 TOP | about 4 minutes |

**Watch it:** the tab's job row (units done, devices, the log: who got which packs, checks, strikes); on the server, the
hub copy's log `/root/REMOTESERVERSACCESS/sherpahubs/logs/i1.log` prints every 10 s
`SherpaHub: job <id>: <done> of <total> units, <n> devices, <packs> packs sent, <hedges> hedges, <timeouts> timeouts,
<failed> failed units, <strikes> strikes`, and at the end `DONE: every unit checked, and the whole product passed the
final check (...)`. To join from a browser: open the contributor page (planetcompute.ai, Share Compute) while it runs.

**First live run (2026-10-31 ~17:21 UTC, started by the user from the tab; test 95):** job fbe4e26b81136039, 4096 x 4096 x
4096, tile 64, hub sherpa:hub:0123456789ab:872ab30c92b3 (copy 1 of interserver-1-sherpahubs). One progress line (2,493 of
4,096 units, 4 devices, 79 packs sent, 0 hedges, 0 timeouts, 0 failed units, 0 strikes), then DONE at 17:22:00 UTC: every
unit checked, the whole product passed the final check, 137.4 GOP, 4,096 units credited, 0 strikes. The 4 devices were
the two SherpaHub copies and the two workhorse copies on 203.0.113.10 (no browser joined). About 15-20 s in all
(progress is printed every 10 s), so about 7-9 GOP/s over 16 cores.

**Second live run (2026-10-31 17:27-18:09 UTC, started by the user from the tab; test 95):** job ce013bcfde4f68ec,
65536 x 4096 x 65536, tile 128 = 262,144 units, 35,184 GOP, 4 devices (the two SherpaHub and two workhorse copies; no
browser). Devices joined about 30 s after it was received (17:27:06; the first two progress lines showed 0 devices).
DONE at 18:09:50 (42 min 44 s): every unit checked, the whole product passed the final check, 262,144 units credited,
0 failed units, 0 strikes; 24,359 packs sent, 0 hedges, 33 timeouts (a pack not answered in time is sent again; none
gave a wrong answer). Speed about 13.7 GOP/s over 16 cores (about 6,100-6,500 units per 5 minutes, steady). Disk: the
result file is 16 GiB (4 x M x N bytes), filled as pieces return (used space 746 -> 762 GB on the shared 3.5 TB disk).
The form does not yet check the hub's free disk (proposed: refuse a job needing more than half of it).
