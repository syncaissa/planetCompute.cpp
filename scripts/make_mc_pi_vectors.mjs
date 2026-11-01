// Regenerate client/src/mc_pi_vectors.rs from the website's own capacity-check function (website/worker.js
// cpuChunkHits), so the Rust WorkPack is tested against exactly what the server checks.
//   node scripts/make_mc_pi_vectors.mjs [website/worker.js] [client/src/mc_pi_vectors.rs]
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(process.argv[2] || "website/worker.js", "utf8");
const body = src.slice(src.indexOf("function cpuChunkHits"), src.indexOf("function gpuGroupHits"));
const cpuChunkHits = new Function(body + "; return cpuChunkHits;")();
const seeds = [1, 2, 12345, 0x7fffffff, 0x80000000, 0xdeadbeef, 4294967295, 2463534242];
let out = "// Generated from worker.js cpuChunkHits by scripts/make_mc_pi_vectors.mjs.\nconst TEST_VECTORS: &[(u32, u32, u32)] = &[\n";
for (const s of seeds) for (const n of [1, 1000, 2000000]) out += `    (${s >>> 0}, ${n}, ${cpuChunkHits(s | 0, n)}),\n`;
out += "];\n";
writeFileSync(process.argv[3] || "client/src/mc_pi_vectors.rs", out);
console.log(out);
