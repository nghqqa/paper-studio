-- layout.lua — 中文期刊版式：标题区跨栏（首页单栏节）
-- 依据官方模板 format.docx 与终稿 sample.docx 的结构实测：
--   标题/作者/单位/摘要/关键词区为通栏（单栏节），正文起为双栏节。
-- 实现：在第一个 Header（level 1，即正文第一节）之前插入一个带 sectPr 的段落
--   （OOXML 分节语义：段落内 sectPr 结束上一节），该节为单栏；
--   文档末节 sectPr（来自 reference.docx）保持双栏。
-- 使用 pandoc RawBlock('openxml') 官方机制注入，参数全部取自 profile（经环境变量传入），
--   不做任何 XML 正则拼接。

local function env(name, default)
  local v = os.getenv(name)
  return (v and v ~= "") and v or default
end

local PAGE_W = env("LAYOUT_PAGE_W", "11419")
local PAGE_H = env("LAYOUT_PAGE_H", "15600")
local MAR_L = env("LAYOUT_MAR_L", "907")
local MAR_R = env("LAYOUT_MAR_R", "907")
local MAR_T = env("LAYOUT_MAR_T", "623")
local MAR_B = env("LAYOUT_MAR_B", "284")
local COL_SPACE = env("LAYOUT_COL_SPACE", "424")
local TITLE_PG = env("LAYOUT_TITLE_PG", "1")

-- 单栏节的 sectPr（与 reference.docx 同页参数；无 header/footer 引用 → 标题区节无页眉；
-- cols 无 num=2 即单栏；末节（reference 提供）为双栏+页眉页脚）
local SECTION_BREAK_P =
  '<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  .. "<w:pPr><w:sectPr>"
  .. '<w:type w:val="continuous"/>'
  .. '<w:pgSz w:w="' .. PAGE_W .. '" w:h="' .. PAGE_H .. '"/>'
  .. '<w:pgMar w:top="' .. MAR_T .. '" w:right="' .. MAR_R .. '" w:bottom="' .. MAR_B
  .. '" w:left="' .. MAR_L .. '" w:header="567" w:footer="170" w:gutter="0"/>'
  .. '<w:cols w:space="' .. COL_SPACE .. '"/>'
  .. "</w:sectPr></w:pPr></w:p>"

function Pandoc(doc)
  local out = {}
  local inserted = false
  for _, block in ipairs(doc.blocks) do
    if not inserted and block.t == "Header" and block.level == 1 then
      -- 正文第一个一级标题前：结束通栏的标题区节
      out[#out + 1] = pandoc.RawBlock("openxml", SECTION_BREAK_P)
      inserted = true
    end
    out[#out + 1] = block
  end
  if not inserted then
    io.stderr:write("[layout] 未找到正文一级标题，标题区单栏节未插入（版式将整篇双栏）\n")
  end
  doc.blocks = out
  return doc
end
