# Test of planetCompute's sd-cli patch (scripts/patch_sd_cli.py, TESTING.md test 50): the PC_CROP block, taken from
# the patched main.cpp, compiled on its own with 3 fake video frames of 1920 x 1088 (each pixel holds its row number);
# after the cut they must be 1920 x 1080 and start at row 4 (4 rows cut from the top, 4 from the bottom).
#   python3 scripts/patch_sd_cli.py <sd source>; python3 scripts/test_sd_crop.py <sd source>/examples/cli/main.cpp <work folder>
import sys, subprocess, pathlib
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"); work = pathlib.Path(sys.argv[2]); work.mkdir(parents=True, exist_ok=True)
a = src.index("    // planetCompute: PC_CROP"); b = src.index("\n    }\n", a) + 6
prog = """#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
typedef struct { uint32_t width, height, channel; uint8_t* data; } sd_image_t;
bool save_results(sd_image_t* results, int num_results) {
""" + src[a:b] + """    return true; }
int main() {
  const int W = 1920, H = 1088, C = 3, N = 3; sd_image_t r[N];
  for (int i = 0; i < N; i++) { r[i] = {W, H, C, (uint8_t*)malloc(W*H*C)};
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) { uint8_t* p = r[i].data + (y*W + x)*C; p[0] = y & 255; p[1] = y >> 8; p[2] = i; } }
  setenv("PC_CROP", "1920x1080", 1); save_results(r, N);
  int bad = 0;
  for (int i = 0; i < N; i++) { if (r[i].width != 1920 || r[i].height != 1080) bad++;
    for (int y = 0; y < 1080; y++) for (int x = 0; x < 1920; x += 97) { uint8_t* p = r[i].data + (y*1920 + x)*3; int row = p[0] | (p[1] << 8); if (row != y + 4 || p[2] != i) bad++; } }
  printf("%s: 3 frames 1920x1088 -> %ux%u, first row kept = %d\\n", bad ? "FAIL" : "PASS", r[0].width, r[0].height, r[0].data[0] | (r[0].data[1] << 8));
  return bad != 0; }
"""
(work / "t.cpp").write_text(prog)
subprocess.run(["g++", "-O1", "-Wall", "-o", str(work / "t"), str(work / "t.cpp")], check=True)
sys.exit(subprocess.run([str(work / "t")]).returncode)
