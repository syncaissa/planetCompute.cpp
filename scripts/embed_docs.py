#!/usr/bin/env python3
"""Place website/docs_content.html (Documentation and Disclaimer, one source) into the website and the program.

  python3 scripts/embed_docs.py            (from planetCompute-CPP/, or anywhere)

Website: website/worker.js gets DOCS_CONTENT between // DOCS_BEGIN and // DOCS_END (first run also adds the /docs page,
its route, a footer link and an account-menu item). Program: client/ui/index.html gets the content between
<!-- DOCS_BEGIN --> and <!-- DOCS_END --> inside <section id="docs"> (first run also adds the Docs tab, a menu item and
the tab switch). Running it again only refreshes the content. Then copy website/worker.js to
../BrowserCFWorkerCode/worker.live.js (and forGithub/website) as usual before deploying.
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SRC = os.path.join(ROOT, "website", "docs_content.html")
WORKER = os.path.join(ROOT, "website", "worker.js")
UI = os.path.join(ROOT, "client", "ui", "index.html")


def once(s, old, new, what):
    if new in s:
        return s
    if s.count(old) != 1:
        sys.exit(f"{what}: expected one '{old[:60]}', found {s.count(old)}")
    return s.replace(old, new)


def main():
    doc = open(SRC, encoding="utf-8").read()
    doc = re.sub(r"<!--.*?-->\s*", "", doc, count=1, flags=re.S)   # the file's own header comment
    for bad in ("`", "${", "\\"):
        if bad in doc:
            sys.exit(f"docs_content.html contains {bad!r}: not allowed inside a page template")

    # ---- website ----
    w = open(WORKER, encoding="utf-8").read()
    block = "// DOCS_BEGIN (scripts/embed_docs.py from website/docs_content.html; edit that file, not this)\nconst DOCS_CONTENT = `" + doc + "`;\n// DOCS_END\n"
    if "// DOCS_BEGIN" in w:
        w = re.sub(r"// DOCS_BEGIN.*?// DOCS_END\n", lambda m: block, w, count=1, flags=re.S)
    else:
        page = block + (
            "const DOCS_PAGE = `<!doctype html><html lang=\"en\"><head>${HEAD}<title>Documentation and Disclaimer · PlanetCompute</title>\n"
            "<style>body { min-height: 100vh; background: var(--bg); } main.wrap { padding-top: 26px; padding-bottom: 60px; } .pcdocs a { color: var(--gold); }</style></head><body>\n"
            "${topBar(\"docs\")}\n<main class=\"wrap\">${DOCS_CONTENT}</main>\n</body></html>`;\n\n")
        w = once(w, "const NOT_FOUND = simplePage(", page + "const NOT_FOUND = simplePage(", "page")
    w = once(w, """      case "/balance":
      case "/balance/":
        return html(BALANCE_PAGE);""", """      case "/balance":
      case "/balance/":
        return html(BALANCE_PAGE);
      case "/docs":                       // Documentation and Disclaimer (website/docs_content.html, also in the program)
      case "/docs/":
      case "/documentation":
        return html(DOCS_PAGE);""", "route")
    if 'href="/docs">' not in w:      # every footer that lists the credit terms
        w = w.replace("""<a href="#credit-terms">Compute Credit and Tokens</a>""",
                      """<a href="#credit-terms">Compute Credit and Tokens</a><a href="/docs">Docs and Disclaimer</a>""")
    w = w.replace("<span>PlanetCompute.org</span>", "<span>PlanetCompute.ai</span>")   # the brand is PlanetCompute.ai, never .org
    w = once(w, """["My Balance", "/balance"], ["Download planetCompute", "/download"]];""",
             """["My Balance", "/balance"], ["Download planetCompute", "/download"], ["Docs and Disclaimer", "/docs"]];""", "menu")
    open(WORKER, "w", encoding="utf-8").write(w)

    # ---- program ----
    u = open(UI, encoding="utf-8").read()
    sec = "<!-- DOCS_BEGIN (scripts/embed_docs.py from website/docs_content.html) -->\n" + doc + "<!-- DOCS_END -->\n"
    if "<!-- DOCS_BEGIN" in u:
        u = re.sub(r"<!-- DOCS_BEGIN.*?<!-- DOCS_END -->\n", lambda m: sec, u, count=1, flags=re.S)
    else:
        u = once(u, "  </section>\n</main>", "  </section>\n  <section id=\"docs\" hidden>\n    <div class=\"card wide\">\n" + sec + "    </div>\n  </section>\n</main>", "section")
    u = once(u, """<span class="lg">My Balance</span><span class="sm">Balance</span></button>
  </nav>""", """<span class="lg">My Balance</span><span class="sm">Balance</span></button>
    <button role="tab" data-tab="docs" aria-selected="false" title="How the website and this program work, and the disclaimers"><span class="lg">Docs and Disclaimer</span><span class="sm">Docs</span></button>
  </nav>""", "tab")
    u = once(u, """        <button type="button" role="menuitem" data-go="balance">My Balance</button>
""", """        <button type="button" role="menuitem" data-go="balance">My Balance</button>
        <button type="button" role="menuitem" data-go="docs">Docs and Disclaimer</button>
""", "menu item")
    u = once(u, """s.hidden = s.id !== (tab === 'contribute' ? 'contribute' : tab === 'balance' ? 'balance' : 'harness'));""",
             """s.hidden = s.id !== (tab === 'contribute' ? 'contribute' : tab === 'balance' ? 'balance' : tab === 'docs' ? 'docs' : 'harness'));""", "go")
    u = once(u, """const key = !$('contribute').hidden ? 'contribute' : !$('balance').hidden ? 'balance' :""",
             """const key = !$('contribute').hidden ? 'contribute' : !$('balance').hidden ? 'balance' : !$('docs').hidden ? 'docs' :""", "paintNav")
    open(UI, "w", encoding="utf-8").write(u)
    print("embedded:", len(doc), "bytes into website/worker.js and client/ui/index.html")


main()
