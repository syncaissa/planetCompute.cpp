# planetCompute's two changes to stable-diffusion.cpp's sd-cli (CI runs this on the pinned source before building):
# 1. PC_CROP=WxH in the environment cuts every result (a picture, or each frame of a video) to that size around its
#    centre before it is written. The models need sizes in multiples of 16 or 64: 1920 x 1080 is made 1920 x 1088.
# 2. PC_PROMPT / PC_NEGATIVE in the environment are the prompt and the "leave out" text (user 2026-10-31): any user of
#    a computer can list command lines (ps), only the engine's own user can read its environment, so planetCompute
#    never puts a prompt on the command line (client/src/image.rs private_prompt).
#   python3 scripts/patch_sd_cli.py <stable-diffusion.cpp source folder>
import sys, pathlib
p = pathlib.Path(sys.argv[1]) / "examples" / "cli" / "main.cpp"
s = p.read_text(encoding="utf-8")
prompt_anchor = """    log_level = cli_params.log_level;
    log_color = cli_params.color;
"""
prompt_patch = prompt_anchor + """    // planetCompute: the prompt from the environment (never on the command line, which every user can list)
    if (const char* pp = getenv("PC_PROMPT")) gen_params.prompt = pp;
    if (const char* pn = getenv("PC_NEGATIVE")) gen_params.negative_prompt = pn;
"""
if "PC_PROMPT" not in s:
    if s.count(prompt_anchor) != 1:
        sys.exit("sd-cli: parse_args not found: the PC_PROMPT patch needs updating for this stable-diffusion.cpp")
    s = s.replace(prompt_anchor, prompt_patch)
    if "#include <stdlib.h>" not in s:
        s = s.replace("#include <stdio.h>\n", "#include <stdio.h>\n#include <stdlib.h>\n", 1)
    print("sd-cli: PC_PROMPT patch applied")
if "PC_CROP" in s:
    p.write_text(s, encoding="utf-8"); print("sd-cli: PC_CROP already there"); sys.exit(0)
anchor = """                  const sd_audio_t* generated_audio = nullptr) {
    if (results == nullptr || num_results <= 0) {
        return false;
    }
"""
crop = anchor + """    // planetCompute: PC_CROP=WxH cuts every result to that size around its centre
    if (const char* pc = getenv("PC_CROP")) {
        unsigned cw = 0, ch = 0;
        if (sscanf(pc, "%ux%u", &cw, &ch) == 2 && cw > 0 && ch > 0) {
            for (int i = 0; i < num_results; i++) {
                sd_image_t& im = results[i];
                if (im.data == nullptr || cw > im.width || ch > im.height || (cw == im.width && ch == im.height)) continue;
                const size_t c = im.channel, x0 = (im.width - cw) / 2, y0 = (im.height - ch) / 2;
                for (size_t y = 0; y < ch; y++)
                    memmove(im.data + y * cw * c, im.data + ((y + y0) * im.width + x0) * c, cw * c);
                im.width  = cw;
                im.height = ch;
            }
        }
    }
"""
if s.count(anchor) != 1:
    sys.exit("sd-cli: save_results not found: the patch needs updating for this stable-diffusion.cpp")
s = s.replace(anchor, crop)
if "#include <stdlib.h>" not in s:
    s = s.replace("#include <stdio.h>\n", "#include <stdio.h>\n#include <stdlib.h>\n", 1)
p.write_text(s, encoding="utf-8"); print("sd-cli: PC_CROP patch applied")
