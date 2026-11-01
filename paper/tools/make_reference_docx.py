#!/usr/bin/env python3
"""Create the pandoc reference.docx whose styles mirror the LaTeX PDF.

A4, 26 mm side margins, Latin Modern 11 pt, running head with a rule, "x of N" footer,
booktabs-style tables and the blue "Key Insight" box.

Usage: make_reference_docx.py OUT.docx "Running head text"
"""
import subprocess
import sys
import zipfile
from xml.sax.saxutils import escape

out, runhead = sys.argv[1], sys.argv[2]

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
FONT = "CMU Serif"
MONO = "CMU Typewriter Text"
BLUE = "00008C"          # blue!55!black
TINT = "F2F2FF"          # blue!5!white
LINK = "0000B3"          # blue!70!black


def rpr(size=None, bold=False, italic=False, color=None, font=None, caps=False):
    x = ""
    if font:
        x += f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}" w:eastAsia="{font}"/>'
    if bold:
        x += "<w:b/><w:bCs/>"
    if italic:
        x += "<w:i/><w:iCs/>"
    if caps:
        x += "<w:caps/>"
    if color:
        x += f'<w:color w:val="{color}"/>'
    if size:
        x += f'<w:sz w:val="{int(size * 2)}"/><w:szCs w:val="{int(size * 2)}"/>'
    return f"<w:rPr>{x}</w:rPr>" if x else ""


def para_style(sid, name, based="Normal", nxt=None, ppr="", rp="", custom=True, qformat=True):
    cs = ' w:customStyle="1"' if custom else ""
    return (f'<w:style w:type="paragraph"{cs} w:styleId="{sid}">'
            f'<w:name w:val="{name}"/><w:basedOn w:val="{based}"/>'
            + (f'<w:next w:val="{nxt}"/>' if nxt else "")
            + ("<w:qFormat/>" if qformat else "")
            + (f"<w:pPr>{ppr}</w:pPr>" if ppr else "") + rp + "</w:style>")


def char_style(sid, name, rp, custom=True):
    cs = ' w:customStyle="1"' if custom else ""
    return (f'<w:style w:type="character"{cs} w:styleId="{sid}">'
            f'<w:name w:val="{name}"/><w:basedOn w:val="DefaultParagraphFont"/>{rp}</w:style>')


JUST = '<w:jc w:val="both"/>'
CENTER = '<w:jc w:val="center"/>'
SP0 = '<w:spacing w:before="0" w:after="0" w:line="272" w:lineRule="exact"/>'   # 11/13.6 pt, as LaTeX
INDENT = '<w:ind w:firstLine="340"/>'
box_border = (f'<w:pBdr><w:top w:val="single" w:sz="6" w:space="4" w:color="{BLUE}"/>'
              f'<w:left w:val="single" w:sz="6" w:space="8" w:color="{BLUE}"/>'
              f'<w:bottom w:val="single" w:sz="6" w:space="6" w:color="{BLUE}"/>'
              f'<w:right w:val="single" w:sz="6" w:space="8" w:color="{BLUE}"/></w:pBdr>')

styles = [
    f'<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:cs="{FONT}" w:eastAsia="{FONT}"/>'
    '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>'
    f'<w:pPrDefault><w:pPr>{SP0}</w:pPr></w:pPrDefault></w:docDefaults>',
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>',
    para_style("BodyText", "Body Text", ppr=JUST + INDENT, custom=False),
    para_style("FirstParagraph", "First Paragraph", "BodyText", "BodyText", ppr='<w:ind w:firstLine="0"/>'),
    para_style("Compact", "Compact", "BodyText", ppr='<w:spacing w:before="40" w:after="40"/><w:ind w:firstLine="0"/>'),
    para_style("Title", "Title", nxt="Subtitle", custom=False,
               ppr=CENTER + '<w:spacing w:before="240" w:after="200" w:line="420" w:lineRule="exact"/>',
               rp=rpr(17.28, bold=True)),
    para_style("Subtitle", "Subtitle", "Normal", "Author", custom=False,
               ppr=CENTER + '<w:spacing w:before="0" w:after="240" w:line="300" w:lineRule="exact"/>',
               rp=rpr(12)),
    para_style("Author", "Author", ppr=CENTER + '<w:spacing w:before="0" w:after="0" w:line="300" w:lineRule="exact"/>', rp=rpr(12)),
    para_style("Date", "Date", ppr=CENTER + '<w:spacing w:before="160" w:after="240"/>', rp=rpr(11)),
    para_style("PCCenter", "PC Center", ppr=CENTER, rp=rpr(11)),
    para_style("PCMonoCenter", "PC Mono Center", ppr=CENTER, rp=rpr(11, font=MONO)),
    para_style("AbstractTitle", "Abstract Title", ppr=CENTER + '<w:keepNext/><w:spacing w:before="300" w:after="80"/>',
               rp=rpr(10, bold=True)),
    para_style("Abstract", "Abstract", nxt="BodyText",
               ppr=JUST + '<w:spacing w:line="240" w:lineRule="exact"/><w:ind w:left="567" w:right="567" w:firstLine="284"/>',
               rp=rpr(10)),
    para_style("Keywords", "Keywords", ppr=JUST + '<w:spacing w:before="200" w:after="0"/>', rp=rpr(11)),
    para_style("Bibliography", "Bibliography", ppr='<w:ind w:left="284" w:hanging="284"/><w:spacing w:before="0" w:after="120"/>', custom=False),
    para_style("Heading1", "heading 1", nxt="FirstParagraph", custom=False,
               ppr='<w:keepNext/><w:keepLines/><w:spacing w:before="420" w:after="200"/><w:outlineLvl w:val="0"/>',
               rp=rpr(14.4, bold=True)),
    para_style("Heading2", "heading 2", nxt="FirstParagraph", custom=False,
               ppr='<w:keepNext/><w:keepLines/><w:spacing w:before="300" w:after="140"/><w:outlineLvl w:val="1"/>',
               rp=rpr(12, bold=True)),
    para_style("Heading3", "heading 3", nxt="FirstParagraph", custom=False,
               ppr='<w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="2"/>',
               rp=rpr(11, bold=True)),
    para_style("BlockText", "Block Text", "BodyText", custom=False, ppr='<w:ind w:left="567" w:right="567" w:firstLine="0"/>'),
    para_style("FootnoteText", "footnote text", custom=False, rp=rpr(9)),
    para_style("Caption", "caption", custom=False, ppr=CENTER + '<w:spacing w:before="120" w:after="120"/>', rp=rpr(11)),
    para_style("TableCaption", "Table Caption", "Caption", ppr='<w:keepNext/><w:spacing w:before="240" w:after="60"/>'),
    para_style("ImageCaption", "Image Caption", "Caption"),
    para_style("Figure", "Figure", ppr=CENTER + '<w:spacing w:before="160" w:after="160" w:line="240" w:lineRule="auto"/>'),
    para_style("CaptionedFigure", "Captioned Figure", "Figure", ppr='<w:keepNext/>'),
    para_style("Asset", "Asset", ppr=CENTER + '<w:keepLines/><w:spacing w:before="120" w:after="120" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/>'),
    para_style("KeyInsightTitle", "Key Insight Title", nxt="KeyInsight",
               ppr=box_border + f'<w:shd w:val="clear" w:color="auto" w:fill="{BLUE}"/><w:keepNext/>'
               '<w:spacing w:before="240" w:after="0" w:line="300" w:lineRule="auto"/><w:ind w:left="170" w:right="170"/>',
               rp=rpr(11, bold=True, color="FFFFFF")),
    para_style("KeyInsight", "Key Insight",
               ppr=box_border + f'<w:shd w:val="clear" w:color="auto" w:fill="{TINT}"/>' + JUST +
               '<w:spacing w:before="0" w:after="0"/><w:ind w:left="170" w:right="170" w:firstLine="0"/>'),
    para_style("Proposition", "Proposition", "BodyText", ppr='<w:spacing w:before="120" w:after="120"/><w:ind w:firstLine="0"/>',
               rp=rpr(italic=True)),
    para_style("Definition", "Definition", "BodyText", custom=False, ppr='<w:spacing w:before="120" w:after="120"/><w:ind w:firstLine="0"/>'),
    para_style("DefinitionTerm", "Definition Term", "BodyText", custom=False, ppr='<w:ind w:firstLine="0"/>', rp=rpr(bold=True)),
    para_style("Footer", "footer", custom=False, ppr=CENTER, rp=rpr(11)),
    para_style("Header", "header", custom=False,
               ppr='<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="000000"/></w:pBdr>', rp=rpr(9.5)),
    char_style("Hyperlink", "Hyperlink", rpr(color=LINK), custom=False),
    char_style("VerbatimChar", "Verbatim Char", rpr(font=MONO)),
    char_style("SectionNumber", "Section Number", ""),
    char_style("FootnoteReference", "footnote reference", '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>', custom=False),
    char_style("BodyTextChar", "Body Text Char", ""),
    # booktabs: heavy top/bottom rule, light rule under the header row, no verticals.
    '<w:style w:type="table" w:default="1" w:styleId="Table"><w:name w:val="Table"/><w:qFormat/>'
    '<w:pPr><w:spacing w:before="20" w:after="20"/><w:jc w:val="left"/></w:pPr>'
    '<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>'
    '<w:tblPr><w:jc w:val="center"/><w:tblBorders><w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/>'
    '<w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/></w:tblBorders>'
    '<w:tblCellMar><w:left w:w="85" w:type="dxa"/><w:right w:w="85" w:type="dxa"/></w:tblCellMar></w:tblPr>'
    '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/></w:rPr><w:tcPr><w:tcBorders>'
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tcBorders></w:tcPr></w:tblStylePr></w:style>',
]

styles_xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {W}>' + "".join(styles) + "</w:styles>")

A4 = '<w:pgSz w:w="11906" w:h="16838"/>'
MAR = ('<w:pgMar w:top="1588" w:right="1474" w:bottom="1588" w:left="1474" '
       'w:header="851" w:footer="851" w:gutter="0"/>')
document_xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W} {R}><w:body>'
                '<w:p><w:r><w:t>Reference</w:t></w:r></w:p>'
                '<w:sectPr><w:headerReference w:type="default" r:id="rIdPcHeader"/>'
                '<w:footerReference w:type="default" r:id="rIdPcFooter"/>'
                f'{A4}{MAR}</w:sectPr></w:body></w:document>')

header_xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr {W}>'
              f'<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t xml:space="preserve">{escape(runhead)}</w:t></w:r></w:p></w:hdr>')


def field(instr):
    return (f'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> {instr} </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>')


footer_xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr {W}>'
              '<w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>' + field("PAGE") +
              '<w:r><w:t xml:space="preserve"> of </w:t></w:r>' +
              field("NUMPAGES").replace("<w:r><w:t>1</w:t></w:r>", f'<w:r><w:rPr><w:color w:val="{LINK}"/></w:rPr><w:t>1</w:t></w:r>') +
              '</w:p></w:ftr>')

default = subprocess.run(["pandoc", "--print-default-data-file", "reference.docx"], capture_output=True, check=True).stdout
import io  # noqa: E402
zin = zipfile.ZipFile(io.BytesIO(default))
files = {n: zin.read(n) for n in zin.namelist()}
files["word/styles.xml"] = styles_xml.encode()
files["word/document.xml"] = document_xml.encode()
files["word/header1.xml"] = header_xml.encode()
files["word/footer1.xml"] = footer_xml.encode()
rels = files["word/_rels/document.xml.rels"].decode()
rels = rels.replace("</Relationships>",
                    '<Relationship Id="rIdPcHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
                    '<Relationship Id="rIdPcFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
                    "</Relationships>")
files["word/_rels/document.xml.rels"] = rels.encode()
ct = files["[Content_Types].xml"].decode()
ct = ct.replace("</Types>",
                '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
                '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
                "</Types>")
files["[Content_Types].xml"] = ct.encode()
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for n, d in files.items():
        z.writestr(n, d)
