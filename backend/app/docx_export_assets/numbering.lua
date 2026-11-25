-- numbering.lua — 公式/图/表统一编号与交叉引用一致性（Pandoc AST 过滤器）
-- 机制（依据 AST 探针实测，pandoc 3.6.4 latex reader）：
--   * Figure/Table 块的 id 携带 \label；Caption 无编号 → 按出现顺序补「图N/表N」前缀
--   * DisplayMath 字符串保留 \label{...} → 提取并按出现顺序编号；只给带 label 的公式编号
--     （对应 LaTeX 语义：equation* 不编号、\eqref 只指向带 \label 的公式）；
--     \label 从公式串中剥离（OMML 转换不再携带）
--   * \ref/\eqref → Link（attributes: reference-type/reference）；未解析时文本保持 "[label]"
--     → 用本过滤器的编号表重写全部 ref/eqref 链接文本（单一事实源，题注与正文必然一致）；
--     带编号公式包进 Div(id) 以生成书签，公式链接可点击且不再断链
--   * 章节引用（Header id）交给 --number-sections，不改写
--   * fatal（阻断导出）：重复 label；一个数学环境多个 \label（align 类多编号）；
--     指向不存在对象的 ref/eqref
-- 报告：PANDOC_NUMBERING_REPORT 指向的 JSON（转换报告与门禁消费）

local report_path = os.getenv("PANDOC_NUMBERING_REPORT")
local soft_mode = os.getenv("PANDOC_NUMBERING_SOFT") == "1"
local chapter_mode = os.getenv("PANDOC_CHAPTER_NUMBERING") == "1"
local doc_lang = os.getenv("PANDOC_DOC_LANG") or "zh"
local fig_prefix = (doc_lang == "en") and "Figure " or "图"
local fig_sep = (doc_lang == "en") and ". " or " "
local tab_prefix = (doc_lang == "en") and "Table " or "表"
local tab_sep = (doc_lang == "en") and ". " or " "

local numbering = {
  equations = {},  -- {label=, n=}
  figures  = {},   -- {id=, n=, has_label=}
  tables   = {},   -- {id=, n=, has_label=}
  rewritten = 0,
  fatal = {},
  warnings = {},
}
local chap_n = 0
local eq_n, fig_n, tab_n = 0, 0, 0
local eq_by_label = {}
local fig_by_id, tab_by_id = {}, {}
local section_ids = {}
local owner_of = {}  -- label -> 首次登记（重复诊断）

local function fmt_num(n)
  if chapter_mode and chap_n > 0 then
    return tostring(chap_n) .. "-" .. tostring(n)
  end
  return tostring(n)
end

local function is_unnumbered_header(block)
  if block.attr and block.attr.classes then
    for _, c in ipairs(block.attr.classes) do
      if c == "unnumbered" then return true end
    end
  end
  return false
end

local function fail(msg)
  if soft_mode then
    numbering.warnings[#numbering.warnings + 1] = msg
  else
    numbering.fatal[#numbering.fatal + 1] = msg
  end
end

local function claim(label, kind, n)
  if owner_of[label] then
    fail(("重复 label「%s」：%s 与 %s 冲突，无法生成无歧义编号"):format(label, owner_of[label], kind))
    return false
  end
  owner_of[label] = kind .. " n=" .. tostring(n)
  return true
end

local function extract_labels(mathstr)
  local out = {}
  for l in mathstr:gmatch("\\label%s*{([^}]*)}") do
    out[#out + 1] = l
  end
  return out
end

local function strip_labels(mathstr)
  return (mathstr:gsub("\\label%s*{[^}]*}", ""))
end

local function has_caption_text(caption)
  if not caption or not caption.long or #caption.long == 0 then
    return false
  end
  local txt = pandoc.utils.stringify(caption.long)
  return txt ~= nil and txt:match("%S") ~= nil
end

local function number_caption(caption, prefix)
  local long = caption.long
  if long and #long > 0 and long[1].content then
    table.insert(long[1].content, 1, pandoc.Str(prefix))
  else
    caption.long = pandoc.Plain{ pandoc.Str(prefix) } and pandoc.Blocks{ pandoc.Plain{ pandoc.Str(prefix) } } or caption.long
  end
end

-- ---------- pass 1：编号 + 题注前缀 + 公式书签 Div ----------

local function handle_display_math_para(block)
  -- 返回替换该块的块列表；Para 恰好只含一个带 label 的 DisplayMath 时包 Div 生成书签
  if block.t ~= "Para" or #block.content ~= 1 or block.content[1].t ~= "Math"
     or block.content[1].mathtype ~= "DisplayMath" then
    -- 多元素段落：仍要剥离 label/计数；混排中的带编号公式用 Span(id) 生成书签
    for i, el in ipairs(block.content) do
      if el.t == "Math" and el.mathtype == "DisplayMath" then
        local labels = extract_labels(el.text)
        if #labels >= 2 then
          fail(("一个公式环境含 %d 个 \\label（多编号公式环境不受支持）：%s")
               :format(#labels, table.concat(labels, ", ")))
        elseif #labels == 1 then
          local label = labels[1]
          eq_n = eq_n + 1
          local eq_str = fmt_num(eq_n)
          eq_by_label[label] = eq_str
          claim(label, "equation", eq_str)
          numbering.equations[#numbering.equations + 1] = { label = label, n = eq_str }
          el.text = strip_labels(el.text)
          -- 混排中的带编号公式：Span(id) 生成书签，并在公式后印编号 (N) 或 (章-N)
          local numbered = pandoc.Inlines{ el, pandoc.Str("(" .. eq_str .. ")") }
          block.content[i] = pandoc.Span(numbered, pandoc.Attr(label))
        end
      end
    end
    return { block }
  end
  local math = block.content[1]
  local labels = extract_labels(math.text)
  if #labels >= 2 then
    fail(("一个公式环境含 %d 个 \\label（多编号公式环境不受支持）：%s")
         :format(#labels, table.concat(labels, ", ")))
    return { block }
  end
  if #labels == 0 then
    return { block }  -- equation*：不编号
  end
  local label = labels[1]
  eq_n = eq_n + 1
  local eq_str = fmt_num(eq_n)
  eq_by_label[label] = eq_str
  claim(label, "equation", eq_str)
  numbering.equations[#numbering.equations + 1] = { label = label, n = eq_str }
  math.text = strip_labels(math.text)
  -- Div(id) → docx 书签；公式后印编号 (N) 或 (章-N)（静态编号，与正文 eqref 同源）
  local numbered = pandoc.Inlines{ math, pandoc.Str("(" .. eq_str .. ")") }
  return { pandoc.Div({ pandoc.Plain(numbered) }, pandoc.Attr(label)) }
end

local function pass1_block(block)
  if block.t == "Figure" then
    fig_n = fig_n + 1
    local f_str = fmt_num(fig_n)
    local has_label = block.identifier ~= ""
    numbering.figures[#numbering.figures + 1] = { id = block.identifier, n = f_str, has_label = has_label }
    if has_label then
      fig_by_id[block.identifier] = f_str
      claim(block.identifier, "figure", f_str)
    end
    number_caption(block.caption, fig_prefix .. f_str .. fig_sep)
    -- pandoc 3.1 的 docx writer 不为 Figure 块生成书签（3.6 会）：
    -- 带 label 的图包 Div(id) 强制书签；同时清空内部 Figure 的 identifier，
    -- 否则 Div 与 Figure 各出一个同名书签（重复书签会被一致性校验拦截）
    if has_label then
      local fid = block.identifier
      block.identifier = ""
      return { pandoc.Div({ block }, pandoc.Attr(fid)) }
    end
  elseif block.t == "Div" then
    -- pandoc 3.x 把 \begin{table} 浮动包成 Div(id)[Table]：label 在 Div 上，题注在内部 Table
    for _, sub in ipairs(block.content) do
      if sub.t == "Table" and (block.identifier ~= "" or has_caption_text(sub.caption)) then
        tab_n = tab_n + 1
        local t_str = fmt_num(tab_n)
        local has_label = block.identifier ~= ""
        numbering.tables[#numbering.tables + 1] = { id = block.identifier, n = t_str, has_label = has_label }
        if has_label then
          tab_by_id[block.identifier] = t_str
          claim(block.identifier, "table", t_str)
        end
        number_caption(sub.caption, tab_prefix .. t_str .. tab_sep)
      end
    end
  elseif block.t == "Table" then
    -- 仅对有 caption 或有 label 的正式数据表编号；封面等裸 tabular 布局表不编号
    if block.identifier ~= "" or has_caption_text(block.caption) then
      tab_n = tab_n + 1
      local t_str = fmt_num(tab_n)
      local has_label = block.identifier ~= ""
      numbering.tables[#numbering.tables + 1] = { id = block.identifier, n = t_str, has_label = has_label }
      if has_label then
        tab_by_id[block.identifier] = t_str
        claim(block.identifier, "table", t_str)
      end
      number_caption(block.caption, tab_prefix .. t_str .. tab_sep)
    end
  elseif block.t == "Header" then
    if chapter_mode and block.level == 1 and (not is_unnumbered_header(block)) then
      chap_n = chap_n + 1
      eq_n, fig_n, tab_n = 0, 0, 0
    end
    if block.identifier ~= "" then
      section_ids[block.identifier] = true
      claim(block.identifier, "section", block.identifier)
    end
  end
  return { block }
end

-- ---------- pass 2：重写 ref/eqref 链接文本 ----------

local function rewrite_link(link)
  local ref = link.attr.attributes["reference"]
  local rtype = link.attr.attributes["reference-type"]
  if not ref or not rtype then
    return link
  end
  local n
  if rtype == "eqref" or rtype == "ref" then
    if eq_by_label[ref] then
      n = eq_by_label[ref]
    elseif fig_by_id[ref] then
      n = fig_by_id[ref]
    elseif tab_by_id[ref] then
      n = tab_by_id[ref]
    end
  end
  if n then
    local text = (rtype == "eqref") and ("(" .. n .. ")") or tostring(n)
    link.content = { pandoc.Str(text) }
    numbering.rewritten = numbering.rewritten + 1
  elseif not section_ids[ref] then
    fail(("未解析引用「%s」（%s）：目标不存在于任何公式/图/表/章节"):format(ref, rtype))
  end
  return link
end

function Pandoc(doc)
  local out = {}
  for _, block in ipairs(doc.blocks) do
    if block.t == "Para" or block.t == "Plain" then
      for _, nb in ipairs(handle_display_math_para(block)) do
        out[#out + 1] = nb
      end
    else
      for _, nb in ipairs(pass1_block(block)) do
        out[#out + 1] = nb
      end
    end
  end
  doc.blocks = out
  doc = doc:walk({ Link = rewrite_link })

  if report_path then
    local fh = io.open(report_path, "w")
    if fh then
      fh:write(pandoc.json.encode({
        scheme = "paper-studio/numbering@1",
        equations = numbering.equations,
        figures = numbering.figures,
        tables = numbering.tables,
        rewritten_refs = numbering.rewritten,
        fatal = numbering.fatal,
        warnings = numbering.warnings,
      }))
      fh:close()
    end
  end

  if (not soft_mode) and #numbering.fatal > 0 then
    error("编号/交叉引用校验失败（阻断导出）：" .. table.concat(numbering.fatal, "；"))
  end
  return doc
end
