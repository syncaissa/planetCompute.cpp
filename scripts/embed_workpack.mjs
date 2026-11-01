// Put the browser's WorkPack code (website/workpack_kernel.mjs + website/workpack_device.mjs, "export" removed) into
// a site worker file between // WORKPACK_SRC_BEGIN and // WORKPACK_SRC_END, as the string WORKPACK_SRC that the
// contributor page runs (SherpaHub packs, docs/SHERPAHUB.md section 10).
//   node scripts/embed_workpack.mjs <worker.js> [...]          write
//   node scripts/embed_workpack.mjs --check <worker.js> [...]  exit 1 if a file's copy differs (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)), site = join(here, "..", "website");
const parts = ["workpack_kernel.mjs", "workpack_device.mjs"].map((f) => {
  const t = readFileSync(join(site, f), "utf8");
  if (/[\\`]|\$\{/.test(t)) throw new Error(f + ": no backslashes, backticks or dollar-braces (it goes inside the page template)");
  return t.replace(/^export /gm, "");
});
const src = parts.join("\n");
const block = "// WORKPACK_SRC_BEGIN (scripts/embed_workpack.mjs from website/workpack_kernel.mjs + workpack_device.mjs; do not edit here)\n" +
  "const WORKPACK_SRC = " + JSON.stringify(src) + ";\n// WORKPACK_SRC_END";
const args = process.argv.slice(2), check = args[0] === "--check", files = check ? args.slice(1) : args;
let bad = 0;
for (const f of files) {
  const w = readFileSync(f, "utf8"), re = /\/\/ WORKPACK_SRC_BEGIN[^\n]*\n[\s\S]*?\/\/ WORKPACK_SRC_END/;
  if (!re.test(w)) { console.log(f + ": no WORKPACK_SRC markers"); bad++; continue; }
  const now = w.match(re)[0];
  if (check) { if (now !== block) { console.log(f + ": WORKPACK_SRC differs from website/*.mjs: run node scripts/embed_workpack.mjs " + f); bad++; } else console.log(f + ": WORKPACK_SRC up to date"); }
  else if (now !== block) { writeFileSync(f, w.replace(re, () => block)); console.log(f + ": WORKPACK_SRC written (" + src.length + " chars)"); }
  else console.log(f + ": already up to date");
}
process.exit(bad ? 1 : 0);
