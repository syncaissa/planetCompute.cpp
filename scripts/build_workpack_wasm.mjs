// Assemble website/workpack_kernel.wat (WebAssembly SIMD matmul_i8) and embed the bytes, base64, in
// website/workpack_kernel.mjs between the WASM_SIMD_BEGIN / WASM_SIMD_END lines. Needs the npm package wabt:
//   cd <folder with node_modules/wabt> && node <repo>/scripts/build_workpack_wasm.mjs <repo>
// (the build is reproducible: the same .wat gives the same bytes; the SHA-256 is printed and kept next to them).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const repo = process.argv[2] || ".";
const wabt = await createRequire(process.cwd() + "/")("wabt")();
const watPath = join(repo, "website/workpack_kernel.wat"), mjsPath = join(repo, "website/workpack_kernel.mjs");
const mod = wabt.parseWat("workpack_kernel.wat", readFileSync(watPath, "utf8"), { simd: true });
mod.validate();
const { buffer } = mod.toBinary({ write_debug_names: false });
const bytes = Buffer.from(buffer), sha = createHash("sha256").update(bytes).digest("hex");
const b64 = bytes.toString("base64");
let src = readFileSync(mjsPath, "utf8");
const begin = "// WASM_SIMD_BEGIN", end = "// WASM_SIMD_END";
const i = src.indexOf(begin), j = src.indexOf(end);
if (i < 0 || j < i) throw new Error("markers not found in " + mjsPath);
const block = `${begin} (scripts/build_workpack_wasm.mjs from website/workpack_kernel.wat; ${bytes.length} bytes, sha256 ${sha})\nconst WASM_SIMD_B64 = "${b64}";\n`;
src = src.slice(0, i) + block + src.slice(j);
writeFileSync(mjsPath, src);
console.log(`workpack_kernel.wasm: ${bytes.length} bytes, sha256 ${sha}`);
