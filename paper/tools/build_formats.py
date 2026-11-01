#!/usr/bin/env python3
"""Build the PlanetCompute paper in four formats from the single LaTeX source.

    paper/dist/planetcompute.pdf           pdflatex (the reference look)
    paper/dist/planetcompute.html          standalone web page
    paper/dist/planetcompute-blogger.html  fragment to paste into Blogger's HTML view
    paper/dist/planetcompute.docx          Word document with embedded Computer Modern fonts

Display equations, figures and algorithms are rendered by LaTeX itself (SVG for the web,
300-dpi PNG for Word), numbered exactly as in the PDF. Text, tables, inline maths and
references are converted with pandoc so they stay selectable and editable.

Usage:  python3 tools/build_formats.py          (run from paper/ or anywhere)
Needs:  pdflatex/latexmk, pdftocairo, pdfinfo, pandoc >= 3.
"""
import base64
import html
import pathlib
import re
import shutil
import subprocess
import sys
import uuid
import zipfile

PAPER = pathlib.Path(__file__).resolve().parent.parent
TOOLS = PAPER / "tools"
DIST = PAPER / "dist"
BUILD = PAPER / "build"
ASSETS = BUILD / "assets"
SRC = PAPER / "planetcompute.tex"
TEXT_WIDTH_MM = 158.0          # A4 210 mm minus 2 x 26 mm margins (geometry in the source)


def run(cmd, cwd=None, **kw):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write(r.stdout[-3000:] + r.stderr[-3000:])
        raise SystemExit(f"failed: {' '.join(map(str, cmd))}")
    return r.stdout


def find_env(text, name, start=0):
    """Return (begin, end) of the next \\begin{name}...\\end{name} at or after start."""
    b = text.find(f"\\begin{{{name}}}", start)
    if b < 0:
        return None
    e = text.find(f"\\end{{{name}}}", b)
    return b, e + len(f"\\end{{{name}}}")


def braced(text, i):
    """text[i] == '{'; return (content, index after the matching '}')."""
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[i + 1:j], j + 1
    raise ValueError("unbalanced braces")


def replace_cmd(text, cmd, fn):
    """Replace every \\cmd{arg} by fn(arg) (one mandatory argument, nesting-safe)."""
    out, i = [], 0
    pat = "\\" + cmd + "{"
    while True:
        j = text.find(pat, i)
        if j < 0:
            out.append(text[i:])
            return "".join(out)
        arg, k = braced(text, j + len(pat) - 1)
        out.append(text[i:j])
        out.append(fn(arg))
        i = k


def unwrap_resizebox(text):
    """\\resizebox{w}{h}{content} -> content."""
    while (j := text.find("\\resizebox{")) >= 0:
        _, k = braced(text, j + len("\\resizebox"))
        _, k = braced(text, k)
        content, k = braced(text, k)
        text = text[:j] + content + text[k:]
    return text


# ---------------------------------------------------------------------------
# 1. PDF and label numbers


def build_pdf():
    run(["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", SRC.name], cwd=PAPER)
    DIST.mkdir(exist_ok=True)
    shutil.copy(PAPER / "planetcompute.pdf", DIST / "planetcompute.pdf")


def read_labels():
    labels = {}
    for line in (PAPER / "planetcompute.aux").read_text().splitlines():
        m = re.match(r"\\newlabel\{([^}]*)\}\{\{([^}]*)\}", line)
        if m and not m.group(1).endswith("@cref"):
            labels[m.group(1)] = m.group(2)
    return labels


# ---------------------------------------------------------------------------
# 2. Assets rendered by LaTeX


def asset_preamble(source):
    pre = source[:source.index(r"\begin{document}")]
    pre = re.sub(r"\\documentclass(\[[^\]]*\])?\{article\}",
                 r"\\documentclass[varwidth=%.1fmm,float,border={0pt 3pt 0pt 3pt}]{standalone}" % TEXT_WIDTH_MM,
                 pre)
    pre = re.sub(r"\\usepackage(\[[^\]]*\])?\{geometry\}\n", "", pre)
    pre = re.sub(r"\\pagestyle\{fancy\}.*?\\fancypagestyle\{plain\}\{[^\n]*\n", "", pre, flags=re.S)
    return pre + "\\usepackage{capt-of}\n\\usepackage{float}\n"


def render_asset(name, preamble, body):
    tex = ASSETS / f"{name}.tex"
    tex.write_text(preamble + "\\begin{document}\n" + body + "\n\\end{document}\n")
    run(["pdflatex", "-interaction=nonstopmode", "-halt-on-error", tex.name], cwd=ASSETS)
    pdf = ASSETS / f"{name}.pdf"
    run(["pdftocairo", "-svg", pdf.name, f"{name}.svg"], cwd=ASSETS)
    run(["pdftocairo", "-png", "-r", "300", "-singlefile", pdf.name, name], cwd=ASSETS)
    m = re.search(r"Page size:\s+([\d.]+) x ([\d.]+) pts", run(["pdfinfo", pdf.name], cwd=ASSETS))
    w_mm, h_mm = float(m.group(1)) * 25.4 / 72, float(m.group(2)) * 25.4 / 72
    return w_mm, h_mm


# ---------------------------------------------------------------------------
# 3. Source -> pandoc-friendly LaTeX


def preprocess(source, labels):
    pre = asset_preamble(source)
    body = source[source.index(r"\begin{document}") + len(r"\begin{document}"):source.index(r"\end{document}")]
    macros = "\n".join(l for l in source[:source.index(r"\begin{document}")].splitlines()
                       if l.startswith(r"\newcommand{\paper") or l.startswith(r"\newcommand{\coderepo")
                       or l.startswith(r"\newcommand{\shorttitle"))
    ASSETS.mkdir(parents=True, exist_ok=True)
    assets = {}

    # Title block and the footer block are produced by the templates.
    t = find_env(body, "center")
    body = body[:t[0]] + body[t[1]:]
    body = body[:body.rindex(r"\bibliographystyle")]   # references come from citeproc; footer from the templates

    # Plain-text name macros (coin, ticker, chain): expand in place so they survive pandoc and equations.
    for name in ("cointicker", "coin", "chain"):
        value = re.search(r"\\newcommand\{\\%s\}\{([^}]*)\}" % name, source).group(1)
        body = re.sub(r"\\%s(?![A-Za-z])(\{\})?" % name, lambda m: value, body)
    body = re.sub(r"\\bibliographystyle\{[^}]*\}\s*\\bibliography\{[^}]*\}", "", body)

    # Generated tables.
    body = re.sub(r"\\input\{([^}]*)\}", lambda m: (PAPER / (m.group(1) if m.group(1).endswith(".tex")
                                                             else m.group(1) + ".tex")).read_text(), body)

    # Pass 1: display equations, numbered in document order (also inside theorems).
    eqno = 0
    out, i = [], 0
    eq_token = re.compile(r"\\begin\{(equation|align)\}")
    while (m := eq_token.search(body, i)):
        env = m.group(1)
        b, e = find_env(body, env, m.start())
        chunk = body[b:e]
        n_eq = 1 if env == "equation" else chunk.count("\\\\") + 1
        name = f"eq{eqno + 1}"
        # Full text width so the number sits at the right margin, as in the PDF.
        src = (f"\\setcounter{{equation}}{{{eqno}}}\n\\begin{{minipage}}{{\\linewidth}}\n"
               f"{chunk}\n\\end{{minipage}}")
        assets[name] = render_asset(name, pre, src)
        eqno += n_eq
        out.append(body[i:b])
        out.append(f"\n\n\\includegraphics{{{name}}}\n\n")
        i = e
    out.append(body[i:])
    body = "".join(out)

    # Pass 2: figures, algorithms and theorem-like environments, numbered like LaTeX.
    counters = {"figure": 0, "algorithm": 0, "section": 0, "definition": 0, "proposition": 0}
    out, i = [], 0
    token = re.compile(r"\\section\{|\\begin\{(figure|algorithm|definition|proposition|proof)\}")
    while True:
        m = token.search(body, i)
        if not m:
            out.append(body[i:])
            break
        out.append(body[i:m.start()])
        if m.group(0) == "\\section{":
            counters["section"] += 1
            counters["definition"] = counters["proposition"] = 0
            out.append(m.group(0))
            i = m.end()
            continue
        env = m.group(1)
        b, e = find_env(body, env, m.start())
        chunk = body[b:e]
        if env in ("figure", "algorithm"):
            name = f"{env}{counters[env] + 1}"
            inner = chunk
            if env == "figure":
                inner = chunk.replace(r"\begin{figure}[ht]", "").replace(r"\end{figure}", "")
                inner = inner.replace(r"\caption{", r"\captionof{figure}{")
            else:
                inner = chunk.replace(r"\begin{algorithm}[ht]", r"\begin{algorithm}[H]")
            src = f"\\setcounter{{{env}}}{{{counters[env]}}}\n" + inner
            counters[env] += 1
            assets[name] = render_asset(name, pre, src)
            out.append(f"\n\n\\includegraphics{{{name}}}\n\n")
        elif env in ("definition", "proposition"):
            counters[env] += 1
            num = f"{counters['section']}.{counters[env]}"
            content = chunk[len(f"\\begin{{{env}}}"):-len(f"\\end{{{env}}}")]
            title = ""
            if content.startswith("["):
                close = content.index("]")
                title, content = f" ({content[1:close]})", content[close + 1:]
            content = re.sub(r"\\label\{[^}]*\}", "", content).strip()
            head = f"\\textbf{{{env.capitalize()} {num}}}{title}\\textbf{{.}} "
            cls = "pcdef" if env == "definition" else "pcprop"
            out.append(f"\\begin{{{cls}}}\n{head}{content}\n\\end{{{cls}}}")
        elif env == "proof":
            content = chunk[len(r"\begin{proof}"):-len(r"\end{proof}")].strip()
            out.append(f"\\begin{{pcproof}}\n\\emph{{Proof.}} {content} \\hfill$\\square$\n\\end{{pcproof}}")
        i = e
    body = "".join(out)

    # Cross-references and small macros.
    body = re.sub(r"\\eqref\{([^}]*)\}", lambda m: f"({labels[m.group(1)]})", body)
    body = re.sub(r"\\ref\{([^}]*)\}", lambda m: labels[m.group(1)], body)
    body = re.sub(r"\\label\{[^}]*\}", "", body)
    body = re.sub(r"\\paragraph\{([^}]*)\}\s*(.*?)\n\s*\n",
                  lambda m: f"\\begin{{pcrunin}}\n\\textbf{{{m.group(1)}}} {m.group(2)}\n\\end{{pcrunin}}\n\n",
                  body, flags=re.S)
    body = body.replace(r"\cmark", "✓").replace(r"\xmark", "✗").replace(r"\pmark", "∼")
    body = body.replace(r"\tbd", r"\textbf{TBD}")
    body = body.replace(r"\shortstack{", r"\pcstack{")
    body = replace_cmd(body, "pcstack", lambda a: a.replace("\\\\", " "))
    body = unwrap_resizebox(body)
    body = re.sub(r"\\(small|centering|noindent|newpage)\b\s*", "", body)
    body = re.sub(r"\\vspace\{[^}]*\}", "", body)

    # Number table captions like LaTeX.
    tnum = [0]

    def table_caption(arg):
        tnum[0] += 1
        return f"\\caption{{Table {tnum[0]}: {arg}}}"
    body = replace_cmd(body, "caption", table_caption)

    # Abstract and keywords.
    body = body.replace(r"\begin{abstract}", "\\begin{pcabstract}\n\\begin{pcabstracttitle}\nAbstract\n\\end{pcabstracttitle}\n")
    body = body.replace(r"\end{abstract}", r"\end{pcabstract}")
    body = re.sub(r"\\textbf\{Keywords:\}(.*?)\n\n", lambda m: "\\begin{pckeywords}\n\\textbf{Keywords:}" + m.group(1) + "\n\\end{pckeywords}\n\n",
                  body, flags=re.S)
    body += "\n\\section*{References}\n"
    doc = "\\documentclass{article}\n" + macros + "\n\\begin{document}\n" + body + "\n\\end{document}\n"
    (BUILD / "pandoc-input.tex").write_text(doc)
    return assets


# ---------------------------------------------------------------------------
# 4. HTML and Blogger


def inline_svg(name, w_mm, idx):
    svg = (ASSETS / f"{name}.svg").read_text()
    svg = re.sub(r"<\?xml[^>]*\?>\s*", "", svg)
    prefix = f"pc{idx}-"
    svg = re.sub(r'id="([^"]+)"', lambda m: f'id="{prefix}{m.group(1)}"', svg)
    svg = re.sub(r'(xlink:href|href)="#([^"]+)"', lambda m: f'{m.group(1)}="#{prefix}{m.group(2)}"', svg)
    svg = re.sub(r'url\(#([^)]+)\)', lambda m: f"url(#{prefix}{m.group(1)})", svg)
    svg = re.sub(r'<svg ([^>]*?)width="[^"]*" height="[^"]*"',
                 lambda m: f'<svg {m.group(1)}style="width:{w_mm:.2f}mm;max-width:100%;height:auto" '
                           f'role="img" aria-label="{name}"', svg, count=1)
    return f'<div class="pc-asset">{svg}</div>'


def pandoc_html(assets):
    out = run(["pandoc", str(BUILD / "pandoc-input.tex"), "-f", "latex", "-t", "html5",
               "--mathml", "--citeproc", "--bibliography", str(PAPER / "references.bib"),
               "--number-sections", "--lua-filter", str(TOOLS / "pc-filter.lua"),
               "--metadata", "link-citations=true", "--wrap=none"], cwd=BUILD)
    idx = [0]

    def swap(m):
        name = m.group(1)
        w_mm, _ = assets[name]
        idx[0] += 1
        return inline_svg(name, w_mm, idx[0])
    out = re.sub(r'<p><img src="([^"]+)"[^>]*/></p>', swap, out)
    out = re.sub(r'<img src="([^"]+)"[^>]*/>', swap, out)
    return out


def title_block(meta):
    return f"""<header class="pc-title">
<h1 class="pc-h1">PlanetCompute: A Verifiable AI Grid<br>from Idle Browsers and Desktops</h1>
<p class="pc-subtitle">Design, Early Measurements, and a Million-Device Simulation</p>
<p class="pc-author">{meta['author']}</p>
<p class="pc-affil">{meta['affil']}</p>
<p class="pc-email">{meta['email']}</p>
<p class="pc-date">{meta['date']}</p>
</header>"""


def footer_block(meta):
    return f"""<footer class="pc-footer"><hr>
<p>{meta['affil']} &bull; <code>{meta['email']}</code><br><a href="{meta['repo']}">{meta['repo']}</a></p>
</footer>"""


def read_meta(source):
    def m(name):
        return re.search(r"\\newcommand\{\\%s\}\{(.*)\}" % name, source).group(1)
    affil = m("paperaffil").replace(r"\ \textbullet\ ", " • ").replace(r"\ ", " ")
    return {"author": m("paperauthor"), "affil": html.escape(affil), "email": m("paperemail"),
            "date": m("paperdate"), "repo": m("coderepo"), "short": m("shorttitle")}


def build_html(body, meta):
    css = (TOOLS / "planetcompute.css").read_text()
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(meta['short'])}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/computer-modern@0.1.3/cmu-serif.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/computer-modern@0.1.3/cmu-typewriter-text.css">
<style>
{css}
</style>
</head>
<body>
<article class="pc-paper">
<div class="pc-runhead">{html.escape(meta['short'])}</div>
{title_block(meta)}
{body}
{footer_block(meta)}
</article>
</body>
</html>
"""
    (DIST / "planetcompute.html").write_text(page)

    blog = f"""<!-- PlanetCompute paper: paste into Blogger's HTML view (Edit post > pencil icon > HTML view). -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/computer-modern@0.1.3/cmu-serif.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/computer-modern@0.1.3/cmu-typewriter-text.css">
<style>
{css}
</style>
<div class="pc-paper pc-blogger">
<div class="pc-runhead">{html.escape(meta['short'])}</div>
{title_block(meta)}
{body}
{footer_block(meta)}
</div>
"""
    (DIST / "planetcompute-blogger.html").write_text(blog)


# ---------------------------------------------------------------------------
# 5. Word


def build_docx(meta, assets):
    ref = BUILD / "reference.docx"
    run([sys.executable, "-I", str(TOOLS / "make_reference_docx.py"), str(ref), meta["short"]])
    tmp = BUILD / "planetcompute.raw.docx"
    sizes = ",".join(f"{k}={v[0]:.2f}" for k, v in assets.items())
    run(["pandoc", str(BUILD / "pandoc-input.tex"), "-f", "latex", "-t", "docx",
         "--citeproc", "--bibliography", str(PAPER / "references.bib"),
         "--number-sections", "--lua-filter", str(TOOLS / "pc-filter.lua"),
         "--reference-doc", str(ref), "--resource-path", str(ASSETS),
         "--metadata", "link-citations=true", "--metadata", f"pc_asset_widths={sizes}",
         "--metadata", f"pc_author={meta['author']}", "--metadata", f"pc_affil={html.unescape(meta['affil'])}",
         "--metadata", f"pc_email={meta['email']}", "--metadata", f"pc_date={meta['date']}",
         "--metadata", f"pc_repo={meta['repo']}",
         "-o", str(tmp)], cwd=BUILD)
    embed_fonts(tmp, DIST / "planetcompute.docx")


FONT_DIR = TOOLS / "fonts"     # CMU (Computer Modern Unicode) TrueType, SIL OFL: see fonts/OFL.txt
EMBED = {  # Word font name -> {style: file}. Word embeds only TrueType-outline fonts.
    "CMU Serif": {"Regular": "cmu-serif-500-roman.ttf", "Bold": "cmu-serif-700-roman.ttf",
                  "Italic": "cmu-serif-500-italic.ttf", "BoldItalic": "cmu-serif-700-italic.ttf"},
    "CMU Typewriter Text": {"Regular": "cmu-typewriter-text-500-roman.ttf"},
}

def embed_fonts(src, dst):
    """Embed the Latin Modern fonts (obfuscated per ECMA-376 Part 1, 17.8.1)."""
    zin = zipfile.ZipFile(src)
    files = {n: zin.read(n) for n in zin.namelist()}
    font_table = files["word/fontTable.xml"].decode()
    rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    entries = []
    rid = 0
    for family, styles in EMBED.items():
        tags = []
        for style, fname in styles.items():
            data = (FONT_DIR / fname).read_bytes()
            key = uuid.uuid4()
            kb = bytes.fromhex(key.hex)[::-1]
            head = bytearray(data[:32])
            for i in range(32):
                head[i] ^= kb[i % 16]
            rid += 1
            files[f"word/fonts/font{rid}.odttf"] = bytes(head) + data[32:]
            rels.append(f'<Relationship Id="rIdF{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font{rid}.odttf"/>')
            tags.append(f'<w:embed{style} r:id="rIdF{rid}" w:fontKey="{{{str(key).upper()}}}"/>')
        entries.append(f'<w:font w:name="{family}"><w:charset w:val="00"/><w:family w:val="roman"/>'
                       f'<w:pitch w:val="variable"/>{"".join(tags)}</w:font>')
    rels.append("</Relationships>")
    if "xmlns:r=" not in font_table.split(">", 2)[1]:
        font_table = font_table.replace("<w:fonts ", '<w:fonts xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ', 1)
    for family in EMBED:
        font_table = re.sub(r'<w:font w:name="%s">.*?</w:font>' % re.escape(family), "", font_table, flags=re.S)
    font_table = font_table.replace("</w:fonts>", "".join(entries) + "</w:fonts>")
    files["word/fontTable.xml"] = font_table.encode()
    files["word/_rels/fontTable.xml.rels"] = "".join(rels).encode()
    ct = files["[Content_Types].xml"].decode()
    if 'Extension="odttf"' not in ct:
        ct = ct.replace("<Types ", "<Types ", 1).replace(
            "</Types>", '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/></Types>')
    files["[Content_Types].xml"] = ct.encode()
    settings = files["word/settings.xml"].decode()
    # Schema order matters to Word: embedTrueTypeFonts goes right before embedSystemFonts.
    if "embedTrueTypeFonts" not in settings:
        if "<w:embedSystemFonts" in settings:
            settings = settings.replace("<w:embedSystemFonts", "<w:embedTrueTypeFonts/><w:embedSystemFonts", 1)
        else:
            settings = re.sub(r"(<w:zoom[^>]*/>)", r"\1<w:embedTrueTypeFonts/>", settings, count=1)
    files["word/settings.xml"] = settings.encode()
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for n, d in files.items():
            z.writestr(n, d)


def main():
    if BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir()
    DIST.mkdir(exist_ok=True)
    build_pdf()
    source = SRC.read_text()
    meta = read_meta(source)
    assets = preprocess(source, read_labels())
    body = pandoc_html(assets)
    build_html(body, meta)
    build_docx(meta, assets)
    for f in sorted(DIST.iterdir()):
        print(f"{f.stat().st_size:>10,}  {f}")


if __name__ == "__main__":
    main()
