-- Map the paper's LaTeX environments to HTML classes / Word paragraph styles.
-- Used by tools/build_formats.py for both the HTML and the DOCX builds.

local is_docx = FORMAT:match("docx") ~= nil
local widths = {}
local meta_vals = {}

local function styled(style, blocks)
  return pandoc.Div(blocks, pandoc.Attr("", {}, {["custom-style"] = style}))
end

local function para(style, inlines)
  return styled(style, {pandoc.Para(inlines)})
end

function Meta(m)
  if m.pc_asset_widths then
    for k, v in pandoc.utils.stringify(m.pc_asset_widths):gmatch("([^=,]+)=([%d%.]+)") do
      widths[k] = v
    end
  end
  for _, k in ipairs({"pc_author", "pc_affil", "pc_email", "pc_date", "pc_repo"}) do
    if m[k] then meta_vals[k] = pandoc.utils.stringify(m[k]) end
  end
  return m
end

function Image(img)
  if is_docx then
    local name = img.src
    if widths[name] then
      img.attributes.width = widths[name] .. "mm"
    end
    img.src = name .. ".png"
  end
  return img
end

local function only_image(block)
  return block.t == "Para" and #block.content == 1 and block.content[1].t == "Image"
end

function Div(div)
  local c = div.classes
  if c:includes("pcnotice") then                    -- the paper's Disclaimer box (same look as Key Insight)
    if is_docx then
      return {para("Key Insight Title", {pandoc.Str("Disclaimer")}), styled("Key Insight", div.content)}
    end
    return pandoc.Div({pandoc.Div({pandoc.Plain({pandoc.Str("Disclaimer")})}, pandoc.Attr("", {"ki-title"})),
                       pandoc.Div(div.content, pandoc.Attr("", {"ki-body"}))}, pandoc.Attr("", {"keyinsight"}))
  end
  if c:includes("keyinsight") then
    if is_docx then
      return {para("Key Insight Title", {pandoc.Str("Key"), pandoc.Space(), pandoc.Str("Insight")}),
              styled("Key Insight", div.content)}
    end
    local title = pandoc.Div({pandoc.Plain({pandoc.Str("Key"), pandoc.Space(), pandoc.Str("Insight")})},
                             pandoc.Attr("", {"ki-title"}))
    local body = pandoc.Div(div.content, pandoc.Attr("", {"ki-body"}))
    return pandoc.Div({title, body}, pandoc.Attr("", {"keyinsight"}))
  end
  if not is_docx then return nil end
  if c:includes("pcabstracttitle") then return styled("Abstract Title", div.content) end
  if c:includes("pcabstract") then return styled("Abstract", div.content) end
  if c:includes("pckeywords") then return styled("Keywords", div.content) end
  if c:includes("pcprop") then return styled("Proposition", div.content) end
  if c:includes("pcdef") then return styled("Definition", div.content) end
  if c:includes("pcrunin") then return styled("First Paragraph", div.content) end
  if c:includes("center") then return styled("PC Center", div.content) end
  return nil
end

function Blocks(blocks)
  if not is_docx then return nil end
  -- Text that continues after a displayed equation is not indented, as in LaTeX.
  local out, after_asset = {}, false
  for _, b in ipairs(blocks) do
    if only_image(b) then
      table.insert(out, styled("Asset", {b}))
      after_asset = true
    elseif after_asset and b.t == "Para" then
      table.insert(out, styled("First Paragraph", {b}))
      after_asset = false
    else
      table.insert(out, b)
      after_asset = false
    end
  end
  return out
end

function Pandoc(doc)
  if not is_docx then return doc end
  local m = meta_vals
  local head = {
    para("Title", {pandoc.Str("PlanetCompute: Toward a Verifiable AI Grid"), pandoc.LineBreak(), pandoc.Str("of Idle Browsers and Desktops")}),
    para("Subtitle", {pandoc.Str("Design, First Measurements, and a Simulation at a Million Devices")}),
    para("Author", {pandoc.Str(m.pc_author or "")}),
    para("PC Center", {pandoc.Str(m.pc_affil or "")}),
    para("PC Mono Center", {pandoc.Code(m.pc_email or "")}),
    para("Date", {pandoc.Str(m.pc_date or "")}),
  }
  local foot = {
    pandoc.HorizontalRule(),
    para("PC Center", {pandoc.Str(m.pc_affil or ""), pandoc.Space(), pandoc.Str("•"), pandoc.Space(),
                       pandoc.Code(m.pc_email or ""), pandoc.LineBreak(),
                       pandoc.Link(m.pc_repo or "", m.pc_repo or "")}),
  }
  local blocks = {}
  for _, b in ipairs(head) do table.insert(blocks, b) end
  for _, b in ipairs(doc.blocks) do table.insert(blocks, b) end
  for _, b in ipairs(foot) do table.insert(blocks, b) end
  return pandoc.Pandoc(blocks, doc.meta)
end

-- Meta must run first so asset widths are known when images are visited.
return {
  {Meta = Meta},
  {Image = Image, Div = Div},
  {Blocks = Blocks},
  {Pandoc = Pandoc},
}
