# -*- coding: utf-8 -*-
"""Word 投稿前检查（多规则集，只读）：对已保存 DOCX 快照做确定性规则检查。

规则集注册表 RULESETS（详见 docs/preflight-jcip-mvp.md 与本模块注释）：
- jcip-preflight/1（默认）：中文信息学报模板规则，9 条规则 ID 与判定自 MVP 起 100% 不变；
- cn-general/1：通用中文论文投稿规范——待办/占位残留、未处理修订、未关闭批注、
  正文顺序引用 [n] 与文献表对账一致（来源如实标注"通用投稿规范（模板未明示）"，不猜阈值）；
- double-blind/1：双盲匿名审查——按请求 blind_terms 或项目设置 studio.json 的屏蔽词扫描
  正文段落、表格、页眉页脚与 docProps/core.xml（creator/lastModifiedBy），基金词独立核查。

红线（继承 docs/preflight-jcip-mvp.md）：只读，不修改传入字节；解析失败对应条目一律
unknown（绝不输出"全部通过"）；不设模板未明示的阈值类规则。
"""
import io
import re
import zipfile

RULESET_ID = "jcip-preflight"
RULESET_VERSION = "1"
DEFAULT_RULESET = RULESET_ID

# 模板占位段前缀（取自 jcip template.docx 原文）——残留即"仍是模板占位"。
# 注意：「文章编号：1003-0077（2017）00-0000-00」由编辑部录用排期后填写，
# 作者投稿与终稿保留默认占位完全合规，不列入残留告警。
_PLACEHOLDERS = (
    "中文标题题目三号",
    "Author1 , author1,2",
    "摘要：中文摘要100-300字",
    "Abstract :与中文文摘相对应",
    "Key words:三个左右为宜",
    "English title Title四号",
    "摘要楷体小五号",
    "Abstract小五号",
    "关键词：三个左右为宜",
)

_SRC_ABSTRACT_CN = "jcip 模板：「摘要：中文摘要100-300字，用“该文”不用“本文”。…」"
_SRC_KEYWORDS_CN = "jcip 模板：「关键词：三个左右为宜，用分号；分开」"
_SRC_ABSTRACT_EN = "jcip 模板：「Abstract :与中文文摘相对应，英文文摘应符合英文语法…」"
_SRC_KEYWORDS_EN = "jcip 模板：「Key words:三个左右为宜，用分号；分开  Key words五号」"
_SRC_SECTIONS = "jcip 模板：「0  标题一级标题小四黑体，引言、前言、概论等以“0”为章节编号」「1  标题」"
_SRC_PLACEHOLDER = "jcip 模板占位段原文（残留即未替换）"
_SRC_REVISION = "通用投稿规范（模板未明示）：定稿不应携带未处理修订"
_SRC_COMMENT = "通用投稿规范（模板未明示）：定稿不应携带未处理批注"
_SRC_CITATION = "jcip 模板：「篇幅在10000字左右为宜，参考文献按文中出现顺序引用。[1] 参考文献顺序标引」"

# --- cn-general/1 来源（如实标注：模板未明示的通用规范，不设字数/篇幅阈值） ---
_SRC_CN_RESIDUE = "通用投稿规范（模板未明示）：定稿不应残留 TODO/FIXME/【待补】/?? 等待办与占位标记"
_SRC_CN_REVISION = _SRC_REVISION
_SRC_CN_COMMENT = _SRC_COMMENT
_SRC_CN_CITATION = "通用投稿规范（模板未明示）：正文顺序引用 [n] 与文献表条目应对账一致"

# --- double-blind/1 来源（同上：通用双盲评审规范，不做"是否够匿名"的语义判断） ---
_SRC_BLIND = "通用双盲评审规范（模板未明示）：送审稿不应残留作者/单位身份或资助信息"

_CITE_RE = re.compile(r"\[([0-9]{1,3}(?:\s*(?:[,，]|[-–—~])\s*[0-9]{1,3})*)\]")
_ENTRY_RE = re.compile(r"^\[([0-9]{1,3})\]")
_SECTION_RE = re.compile(r"^\d+(\.\s*\d+)?\s+\S")

# cn-general 待办/占位标记：TODO/FIXME（区分大小写，避免命中外文小写词）、【待补】、连续问号
_CN_RESIDUE_RE = re.compile(r"TODO|FIXME|【待补】|\?{2,}|？{2,}")

# double-blind 基金/资助表述（大小写不敏感；命中即 warn 供人工复核，不做语义判断）
_FUNDING_RE = re.compile(
    r"(?i)基金项目|基金资助|国家自然科学|grant\s*no|funded\s+by|funding|foundation")

_JCIP_RULE_IDS = ("jcip-abstract-cn", "jcip-keywords-cn", "jcip-abstract-en", "jcip-keywords-en",
                  "jcip-sections", "jcip-placeholder", "jcip-revision", "jcip-comment",
                  "jcip-citation-integrity")
_CN_RULE_IDS = ("cn-placeholder-residue", "cn-revision", "cn-comment", "cn-citation-integrity")
_BLIND_RULE_IDS = ("blind-author-terms", "blind-funding-terms", "blind-docprops")


def _unknown_items(ids, source: str, parse_error: str) -> list[dict]:
    return [{"rule_id": rid, "status": "unknown",
             "evidence": f"解析失败，无法检查：{parse_error}", "source": source}
            for rid in ids]


def _unknown_items_jcip(parse_error: str) -> list[dict]:
    return _unknown_items(_JCIP_RULE_IDS, "jcip-preflight/1", parse_error)


def _unknown_items_cn(parse_error: str) -> list[dict]:
    return _unknown_items(_CN_RULE_IDS, "cn-general/1", parse_error)


def _unknown_items_blind(parse_error: str) -> list[dict]:
    return _unknown_items(_BLIND_RULE_IDS, "double-blind/1", parse_error)


def _open_docx(docx_bytes: bytes):
    """共享入口：返回 (zf, document_xml, comments_xml)。
    结构性损坏（非 zip / 无 document.xml / 缺 w:body）抛 ValueError，由路由决定 422。"""
    try:
        zf = zipfile.ZipFile(io.BytesIO(docx_bytes))
        doc_xml = zf.read("word/document.xml").decode("utf-8", "replace")
        try:
            comments_xml = zf.read("word/comments.xml").decode("utf-8", "replace")
        except KeyError:
            comments_xml = ""
    except (zipfile.BadZipFile, KeyError, OSError) as e:
        raise ValueError(f"不是有效的 DOCX（zip）结构：{e}") from e

    if "<w:body" not in doc_xml:
        raise ValueError("document.xml 缺少 w:body——不是有效的 Word 主文档")
    return zf, doc_xml, comments_xml


def _has_revision_markers(xml_text: str) -> bool | None:
    """True=存在修订；False=确认没有；None=XML 无法解析（检查不能完整进行）。
    按 XML 命名空间解析（本轮审查问题 1）：不依赖字符串匹配——标签内换行、属性换行、
    前缀差异都能覆盖；w:ins/w:del/w:moveFrom/w:moveTo 与任意 *Change（格式与属性修订）
    都算未处理修订。"""
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None
    for el in root.iter():
        local = el.tag.split("}")[-1]
        if local in ("ins", "del", "moveFrom", "moveTo") or local.endswith("Change"):
            return True
    return False


def _load_doc(docx_bytes: bytes):
    """python-docx 打开（段落/表格文本提取）。返回 (doc, error)；失败时 doc=None、
    error=异常详情（调用方全 unknown，保留原始原因——与 jcip MVP 行为一致）。"""
    try:
        from docx import Document as _Doc

        return _Doc(io.BytesIO(docx_bytes)), None
    except Exception as e:  # noqa: BLE001 — 段落提取失败→全部 unknown
        return None, str(e)


def _para_has_numpr(para) -> bool:
    """判断段落是否启用了 Word 自动编号列表（自身 pPr/numPr 或样式继承 numPr）。"""
    p_el = getattr(para, "_p", None)
    if p_el is not None:
        ppr = p_el.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pPr")
        if ppr is not None and ppr.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}numPr") is not None:
            return True
    style = getattr(para, "style", None)
    s_el = getattr(style, "_element", None)
    if s_el is not None:
        ppr = s_el.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pPr")
        if ppr is not None and ppr.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}numPr") is not None:
            return True
    return False


def _iter_text_records(container, *, in_table: bool = False):
    """正文所有文本记录 (text, is_list_item, in_table)（含表格单元格，含嵌套）。"""
    for para in container.paragraphs:
        yield para.text, _para_has_numpr(para), in_table
    for table in container.tables:
        for row in table.rows:
            for cell in row.cells:
                yield from _iter_text_records(cell, in_table=True)


def _iter_texts(container):
    """正文所有文本（含表格单元格，含嵌套）：引用与屏蔽词扫描的完整范围（本轮审查问题 2）。"""
    for text, _is_list, _in_tbl in _iter_text_records(container):
        yield text


def _is_ref_heading(text: str) -> bool:
    compact = re.sub(r"\s+", "", text)
    if compact.startswith("参考文献") and len(compact) <= 12:
        return True
    return text.strip().lower() in ("references", "reference")


def _expand_cite_group(raw: str) -> list[int]:
    """解析 [1,2] / [1-3] / [1,3–5] 为顺序编号列表。"""
    nums: list[int] = []
    for seg in re.split(r"[,，]", raw):
        seg = seg.strip()
        if not seg:
            continue
        m_rng = re.match(r"^(\d{1,3})\s*[-–—~]\s*(\d{1,3})$", seg)
        if m_rng:
            lo, hi = int(m_rng.group(1)), int(m_rng.group(2))
            if 1 <= lo <= hi <= 999 and (hi - lo) <= 50:
                nums.extend(range(lo, hi + 1))
        elif seg.isdigit():
            n = int(seg)
            if 1 <= n <= 999:
                nums.append(n)
    return nums


def _frag(text: str, start: int, width: int = 34, ctx: int = 10) -> str:
    """命中片段（命中点前取少量上下文），换行折叠为空格。"""
    lo = max(0, start - ctx)
    return text[lo:min(len(text), start + width)].replace("\n", " ").strip()


def _citation_integrity_item(
    records: list[tuple[str, bool, bool]],
    is_placeholder,
    rule_id: str,
    source: str,
) -> dict:
    """文献编号完整性（顺序标引 + 表条目对账；范围严格界定，本轮审查问题 2）。
    在合并文本流（段落+表格单元格）上定位：托管块只认唯一完整头尾之间的条目；
    孤立/重复/倒置标记明确告警；无托管块退回「参考文献」标题后的**连续条目区**
    （兼容显式 `[n]` 文本前缀与 Word 自动编号 `<w:numPr>` 列表，跳过紧邻空行或英文
    `References` 副标题，首个非条目段即止——附录编号不得补齐缺失文献）；
    正文引用扫描含表格内文本及 `[1-3]` 范围引用，文献表未解析到条目时仍如实统计正文引用数。
    jcip 与 cn-general 共用同一实现，仅 rule_id/来源不同。"""
    try:
        all_texts = [r[0] for r in records]
        _HEAD = "[参考文献-平台生成]"
        _TAIL = "[参考文献-平台生成]（完）"
        head_idx = next((i for i, t in enumerate(all_texts)
                         if t.strip().startswith(_HEAD) and not t.strip().startswith(_TAIL)), None)
        tail_idx = next((i for i, t in enumerate(all_texts) if t.strip().startswith(_TAIL)), None)
        marker_problem = ""
        bib_entries: list[int] = []
        managed_ok = False
        ref_idx = None
        entry_start = -1
        entry_end = -1
        if head_idx is not None or tail_idx is not None:
            # 托管块：只认唯一完整头尾之间的条目；异常形态明确告警，附录编号不补位
            if head_idx is None:
                marker_problem = "存在孤立的托管块尾标记（无对应头标记）"
            elif tail_idx is None:
                marker_problem = "存在孤立的托管块头标记（无对应尾标记）"
            elif tail_idx < head_idx:
                marker_problem = "托管块头尾标记顺序倒置"
            else:
                dup_head = sum(1 for i, t in enumerate(all_texts)
                               if i != head_idx and t.strip().startswith(_HEAD)
                               and not t.strip().startswith(_TAIL))
                dup_tail = sum(1 for i, t in enumerate(all_texts)
                               if i != tail_idx and t.strip().startswith(_TAIL))
                if dup_head or dup_tail:
                    marker_problem = f"存在重复的托管块标记（头 {dup_head + 1}/尾 {dup_tail + 1} 个）"
            if not marker_problem and head_idx is not None and tail_idx is not None:
                managed_ok = True
                for t, is_list, _in_tbl in records[head_idx + 1:tail_idx]:
                    s = t.strip()
                    m = _ENTRY_RE.match(s)
                    if m:
                        bib_entries.append(int(m.group(1)))
                    elif is_list and s:
                        bib_entries.append(len(bib_entries) + 1)
        if not managed_ok:
            # 无托管块（或托管块异常）时退回「参考文献」标题段的连续条目区
            ref_idx = next((i for i, (t, _l, in_tbl) in enumerate(records)
                            if not in_tbl and _is_ref_heading(t)), None)
            if ref_idx is not None:
                i = ref_idx + 1
                # 允许标题后紧跟空行或中英双标题（如 参考文献 + References）
                while i < len(records) and not records[i][2]:
                    s = records[i][0].strip()
                    if not s or s.lower() in ("references", "reference"):
                        i += 1
                        continue
                    break
                entry_start = i
                while i < len(records) and not records[i][2]:
                    s = records[i][0].strip()
                    is_list = records[i][1]
                    m = _ENTRY_RE.match(s)
                    if m:
                        bib_entries.append(int(m.group(1)))
                        i += 1
                    elif is_list and s:
                        bib_entries.append(len(bib_entries) + 1)
                        i += 1
                    else:
                        break  # 连续条目区结束：其后附录编号不再计入
                entry_end = i
        cited_seq: list[int] = []
        if managed_ok:
            # 引用扫描=除托管块（头..尾）以外的全部文本：块前正文+块后附录正文+表格都算
            cite_texts = all_texts[:head_idx] + all_texts[tail_idx + 1:]
        elif ref_idx is not None and bib_entries:
            cite_texts = [t for i, t in enumerate(all_texts) if not (entry_start <= i < entry_end)]
        elif ref_idx is not None:
            # 文献表未解析出条目时，仍扫描标题前的正文与全部表格引用，不再误报「正文引用 0 处」
            cite_texts = [t for i, (t, _l, in_tbl) in enumerate(records) if i < ref_idx or in_tbl]
        else:
            # 无文献表可定位：引用扫描无从对账——条目以 unknown 落条目（见下）
            cite_texts = []
        for t in cite_texts:
            if is_placeholder(t):
                continue
            for m in _CITE_RE.finditer(t):   # 段内/表格单元格内多个 [n]/[1-3] 都要收集
                cited_seq.extend(_expand_cite_group(m.group(1)))
        if marker_problem:
            return {"rule_id": rule_id, "status": "warn",
                    "evidence": (marker_problem + "——请手动处理后重试")[:300], "source": source}
        if not managed_ok and ref_idx is None:
            return {"rule_id": rule_id, "status": "unknown",
                    "evidence": "无法定位文献表（无平台托管块标记，也无「参考文献」标题段）"[:300],
                    "source": source}
        first_seen: list[int] = []
        for num in cited_seq:
            if num not in first_seen:
                first_seen.append(num)
        problems = []
        if not bib_entries:
            problems.append("文献表未解析到 [n] 条目")
        else:
            if len(set(bib_entries)) != len(bib_entries):
                problems.append("文献表条目编号重复")
            expected = list(range(1, len(bib_entries) + 1))
            if bib_entries != expected:
                problems.append(f"文献表编号非连续起 1（实际 {bib_entries[:12]}）")
            missing = [n for n in cited_seq if n not in bib_entries]
            if missing:
                problems.append(f"正文引用了文献表中不存在的编号 {sorted(set(missing))[:8]}")
        if first_seen and first_seen != sorted(first_seen):
            problems.append(f"引用首次出现顺序非递增（{first_seen[:10]}）——模板要求按出现顺序标引")
        if problems:
            return {"rule_id": rule_id, "status": "warn",
                    "evidence": ("；".join(problems) + f"（正文引用 {len(cited_seq)} 处，文献表 {len(bib_entries)} 条）")[:300],
                    "source": source}
        return {"rule_id": rule_id, "status": "pass",
                "evidence": f"顺序标引一致：正文引用 {len(cited_seq)} 处，文献表 {len(bib_entries)} 条"[:300],
                "source": source}
    except Exception as e:  # noqa: BLE001 — 子检查失败→该条 unknown，不连坐全报告
        return {"rule_id": rule_id, "status": "unknown",
                "evidence": f"文献编号检查异常：{e}"[:300], "source": source}


def run_checks(docx_bytes: bytes) -> dict:
    """jcip-preflight/1：对已保存 DOCX 快照执行规则集。只读；返回报告体（不含项目/版本元数据）。
    结构性损坏（非 zip / 无 document.xml）抛 ValueError，由路由决定 422 或全 unknown。"""
    _zf, doc_xml, comments_xml = _open_docx(docx_bytes)

    # 修订标记按 XML 命名空间解析（本轮审查问题 1）：不依赖字符串匹配——标签内换行、
    # 属性换行、前缀差异都能覆盖；w:ins/w:del/w:moveFrom/w:moveTo 与任意 *Change
    # （rPrChange/pPrChange 等格式与属性修订）都算未处理修订。
    revision_state = _has_revision_markers(doc_xml)
    if revision_state is None:
        parse_error = "document.xml 无法按 XML 解析，修订检查不能完整进行"
        return {"items": _unknown_items_jcip(parse_error), "parse_error": parse_error}

    # 解析失败兜底：段落提取失败时整份报告 unknown（绝不"全部通过"）
    doc, doc_err = _load_doc(docx_bytes)
    if doc is None:
        parse_error = f"段落提取失败：{doc_err}"
        return {"items": _unknown_items_jcip(parse_error), "parse_error": parse_error}

    text_records = list(_iter_text_records(doc))
    all_texts = [r[0] for r in text_records]
    paragraphs = all_texts
    items: list[dict] = []

    def add(rule_id: str, ok: bool, evidence: str, source: str) -> None:
        items.append({"rule_id": rule_id, "status": "pass" if ok else "warn",
                      "evidence": evidence[:300], "source": source})

    def add_unknown(rule_id: str, evidence: str, source: str) -> None:
        items.append({"rule_id": rule_id, "status": "unknown", "evidence": evidence[:300],
                      "source": source})

    # --- 占位段（先于其余规则：占位段也参与后续 startswith 判定，需排除） ---
    placeholder_hits = []
    for text in paragraphs:
        t = text.strip()
        if t and any(t.startswith(prefix) for prefix in _PLACEHOLDERS):
            placeholder_hits.append(t[:40])
    add("jcip-placeholder", not placeholder_hits,
        "仍残留模板占位段：" + "；".join(placeholder_hits[:4]) if placeholder_hits
        else "未发现模板占位段残留", _SRC_PLACEHOLDER)

    def is_placeholder(text: str) -> bool:
        t = text.strip()
        return any(t.startswith(prefix) for prefix in _PLACEHOLDERS)

    # --- 中文摘要 / 关键词 ---
    abs_cn = next((t for t in paragraphs if t.strip().startswith("摘要：")
                   and not is_placeholder(t)), None)
    add("jcip-abstract-cn", abs_cn is not None,
        abs_cn is not None and f"找到摘要段：{abs_cn.strip()[:60]}" or "未找到以「摘要：」开头的正文段落",
        _SRC_ABSTRACT_CN)
    kw_cn = next((t for t in paragraphs if t.strip().startswith("关键词：")
                  and not is_placeholder(t)), None)
    add("jcip-keywords-cn", kw_cn is not None,
        kw_cn is not None and f"找到关键词段：{kw_cn.strip()[:60]}" or "未找到以「关键词：」开头的正文段落",
        _SRC_KEYWORDS_CN)

    # --- 英文摘要 / Key words：段首匹配（段中提及 Abstract Syntax Tree / Keywords
    # extraction 不算英文摘要与关键词——本轮审查问题 5），且冒号后须有实际内容 ---
    _ABS_EN_RE = re.compile(r"(?i)^\s*abstract\s*[:：]\s*(.+)$", re.S)
    _KW_EN_RE = re.compile(r"(?i)^\s*(?:key\s*words|keywords)\s*[:：]\s*(.+)$", re.S)
    _PLACEHOLDER_EN = re.compile(r"(?i)^\s*abstract\s*[:：]?\s*与中文文摘相对应|^\s*abstract\s*小五号")
    abs_en = next((t for t in paragraphs
                   if (m := _ABS_EN_RE.match(t.strip())) and _PLACEHOLDER_EN.match(t.strip()) is None
                   and re.search(r"[A-Za-z]", m.group(1))), None)
    add("jcip-abstract-en", abs_en is not None,
        abs_en is not None and f"找到英文摘要段：{abs_en.strip()[:60]}" or "未找到英文摘要（Abstract）段落",
        _SRC_ABSTRACT_EN)
    kw_en = next((t for t in paragraphs
                  if (m := _KW_EN_RE.match(t.strip())) and "三个左右为宜" not in t
                  and re.search(r"[A-Za-z]", m.group(1))), None)
    add("jcip-keywords-en", kw_en is not None,
        kw_en is not None and f"找到英文关键词段：{kw_en.strip()[:60]}" or "未找到英文关键词（Key words）段落",
        _SRC_KEYWORDS_EN)

    # --- 编号章节 ---
    sections = [t for t in paragraphs if _SECTION_RE.match(t.strip()) and not is_placeholder(t)]
    add("jcip-sections", len(sections) >= 2,
        len(sections) >= 2 and f"检测到编号章节 {len(sections)} 个，如：{'；'.join(x.strip()[:20] for x in sections[:2])}"
        or "未检测到编号章节段（模板体例 0/1/1.1）", _SRC_SECTIONS)

    # --- 修订 / 批注（按 XML 命名空间解析；不可解析=unknown，本轮审查问题 1） ---
    if revision_state is None:
        add_unknown("jcip-revision", "document.xml 无法解析，修订检查不能完整进行", _SRC_REVISION)
    else:
        add("jcip-revision", not revision_state,
            revision_state and "document.xml 存在未处理修订（ins/del/move/格式与属性 Change）" or "未发现修订标记",
            _SRC_REVISION)
    if not comments_xml:
        add("jcip-comment", True, "文档无 comments.xml 批注部件", _SRC_COMMENT)
    else:
        try:
            import xml.etree.ElementTree as ET

            comment_count = sum(1 for el in ET.fromstring(comments_xml).iter()
                                if el.tag.split("}")[-1] == "comment")
            add("jcip-comment", comment_count == 0,
                comment_count and f"存在 {comment_count} 条批注" or "未发现批注", _SRC_COMMENT)
        except ET.ParseError:
            add_unknown("jcip-comment", "comments.xml 无法按 XML 解析，批注检查不能完整进行", _SRC_COMMENT)

    # --- 文献编号完整性：jcip 与 cn-general 共用同一实现（仅 rule_id/来源不同） ---
    items.append(_citation_integrity_item(text_records, is_placeholder,
                                          "jcip-citation-integrity", _SRC_CITATION))

    return {"items": items}


def run_cn_general(docx_bytes: bytes, blind_terms=()) -> dict:
    """cn-general/1 通用中文论文投稿规范：待办/占位残留、未处理修订、未关闭批注、
    正文引用与文献表对账。blind_terms 参数与其它规则集签名统一（本规则集不使用）。"""
    del blind_terms
    _zf, doc_xml, comments_xml = _open_docx(docx_bytes)

    revision_state = _has_revision_markers(doc_xml)
    if revision_state is None:
        parse_error = "document.xml 无法按 XML 解析，检查不能完整进行"
        return {"items": _unknown_items_cn(parse_error), "parse_error": parse_error}

    doc, doc_err = _load_doc(docx_bytes)
    if doc is None:
        parse_error = f"段落提取失败：{doc_err}"
        return {"items": _unknown_items_cn(parse_error), "parse_error": parse_error}

    text_records = list(_iter_text_records(doc))
    all_texts = [r[0] for r in text_records]
    items: list[dict] = []

    def add(rule_id: str, ok: bool, evidence: str, source: str) -> None:
        items.append({"rule_id": rule_id, "status": "pass" if ok else "warn",
                      "evidence": evidence[:300], "source": source})

    def add_unknown(rule_id: str, evidence: str, source: str) -> None:
        items.append({"rule_id": rule_id, "status": "unknown", "evidence": evidence[:300],
                      "source": source})

    # --- 待办/占位残留（段落+表格单元格都扫） ---
    residue_hits = []
    for text in all_texts:
        if not text.strip():
            continue
        m = _CN_RESIDUE_RE.search(text)
        if m:
            residue_hits.append(_frag(text, m.start()))
    add("cn-placeholder-residue", not residue_hits,
        "残留待办/占位标记：" + "；".join(f"…{h}…" for h in residue_hits[:4]) if residue_hits
        else "未发现 TODO/FIXME/【待补】/?? 残留", _SRC_CN_RESIDUE)

    # --- 未处理修订（与 jcip 同口径：XML 命名空间解析） ---
    add("cn-revision", not revision_state,
        revision_state and "document.xml 存在未处理修订（ins/del/move/格式与属性 Change）" or "未发现修订标记",
        _SRC_CN_REVISION)

    # --- 未关闭批注 ---
    if not comments_xml:
        add("cn-comment", True, "文档无 comments.xml 批注部件", _SRC_CN_COMMENT)
    else:
        try:
            import xml.etree.ElementTree as ET

            comment_count = sum(1 for el in ET.fromstring(comments_xml).iter()
                                if el.tag.split("}")[-1] == "comment")
            add("cn-comment", comment_count == 0,
                comment_count and f"存在 {comment_count} 条批注" or "未发现批注", _SRC_CN_COMMENT)
        except ET.ParseError:
            add_unknown("cn-comment", "comments.xml 无法按 XML 解析，批注检查不能完整进行", _SRC_CN_COMMENT)

    # --- 正文引用与文献表对账（与 jcip 共用实现；待办占位段不参与引用扫描） ---
    items.append(_citation_integrity_item(text_records, lambda t: bool(_CN_RESIDUE_RE.search(t)),
                                          "cn-citation-integrity", _SRC_CN_CITATION))

    return {"items": items}


def _hf_part_texts(zf) -> tuple[list[str], str | None]:
    """页眉页脚部件（headerN.xml / footerN.xml）的 w:t 文本汇总。返回 (texts, parse_error)。
    解析失败如实上报（调用方把受影响条目降为 unknown），绝不静默跳过。"""
    texts: list[str] = []
    err = None
    for name in zf.namelist():
        base = name.rsplit("/", 1)[-1].lower()
        if not base.endswith(".xml") or not (base.startswith("header") or base.startswith("footer")):
            continue
        try:
            import xml.etree.ElementTree as ET

            root = ET.fromstring(zf.read(name).decode("utf-8", "replace"))
        except ET.ParseError:
            err = f"页眉页脚部件 {base} 无法按 XML 解析，扫描范围不完整"
            continue
        buf = [el.text for el in root.iter()
               if el.tag.split("}")[-1] == "t" and el.text]
        if buf:
            texts.append("".join(buf))
    return texts, err


def _core_props(zf) -> tuple[dict | None, str | None]:
    """docProps/core.xml 的 creator / lastModifiedBy。返回 (props, error)；
    部件缺失 → (None, None)；解析失败 → (None, error)。"""
    try:
        raw = zf.read("docProps/core.xml").decode("utf-8", "replace")
    except KeyError:
        return None, None
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(raw)
    except ET.ParseError:
        return None, "docProps/core.xml 无法按 XML 解析，文档属性作者核查不能进行"
    out: dict[str, str] = {}
    for el in root.iter():
        local = el.tag.split("}")[-1]
        if local in ("creator", "lastModifiedBy"):
            out[local] = (el.text or "").strip()
    return out, None


def run_double_blind(docx_bytes: bytes, blind_terms=()) -> dict:
    """double-blind/1 双盲匿名审查：按屏蔽词扫描正文段落、表格、页眉页脚与
    docProps/core.xml（creator/lastModifiedBy）的身份残留；基金/资助表述独立核查。
    未配置屏蔽词时作者词与文档属性条目如实 unknown（宁可 unknown 绝不假 pass），
    仅基金词条目可独立给出确定结论。"""
    zf, doc_xml, _comments_xml = _open_docx(docx_bytes)

    if _has_revision_markers(doc_xml) is None:
        parse_error = "document.xml 无法按 XML 解析，检查不能完整进行"
        return {"items": _unknown_items_blind(parse_error), "parse_error": parse_error}

    doc, doc_err = _load_doc(docx_bytes)
    if doc is None:
        parse_error = f"段落提取失败：{doc_err}"
        return {"items": _unknown_items_blind(parse_error), "parse_error": parse_error}

    all_texts = list(_iter_texts(doc))
    hf_texts, hf_err = _hf_part_texts(zf)
    props, props_err = _core_props(zf)
    terms = [str(t).strip() for t in (blind_terms or ()) if str(t).strip()][:50]
    scan_pool = all_texts + hf_texts
    items: list[dict] = []

    def add(rule_id: str, ok: bool, evidence: str, source: str) -> None:
        items.append({"rule_id": rule_id, "status": "pass" if ok else "warn",
                      "evidence": evidence[:300], "source": source})

    def add_unknown(rule_id: str, evidence: str, source: str) -> None:
        items.append({"rule_id": rule_id, "status": "unknown", "evidence": evidence[:300],
                      "source": source})

    # --- 作者/单位屏蔽词（正文+表格+页眉页脚；无词/hf 解析失败 → unknown） ---
    if not terms:
        add_unknown("blind-author-terms",
                    "未配置作者/单位屏蔽词（可在请求 blind_terms 或项目设置 studio.json 的 "
                    "blind_terms 配置），无法核对正文与页眉页脚的身份残留；基金词与文档属性仍已检查",
                    _SRC_BLIND)
    elif hf_err:
        add_unknown("blind-author-terms", hf_err + "，作者词扫描不完整", _SRC_BLIND)
    else:
        hits = []
        for text in scan_pool:
            for term in terms:
                idx = text.lower().find(term.lower())
                if idx >= 0:
                    hits.append(f"「{term}」…{_frag(text, idx)}…")
        add("blind-author-terms", not hits,
            "命中作者/单位屏蔽词 " + "；".join(hits[:3]) if hits
            else f"正文/表格/页眉页脚未命中屏蔽词（{len(terms)} 词）", _SRC_BLIND)

    # --- 基金/资助表述（不依赖屏蔽词，可独立给确定结论；hf 解析失败 → unknown） ---
    if hf_err:
        add_unknown("blind-funding-terms", hf_err + "，基金词扫描不完整", _SRC_BLIND)
    else:
        hits = []
        for text in scan_pool:
            m = _FUNDING_RE.search(text)
            if m:
                hits.append(f"…{_frag(text, m.start())}…")
        add("blind-funding-terms", not hits,
            "命中资助/基金表述：" + "；".join(hits[:3]) if hits
            else "正文/表格/页眉页脚未发现基金或资助表述", _SRC_BLIND)

    # --- 文档属性作者字段（creator/lastModifiedBy；无词 → unknown 并如实列出字段值） ---
    if props_err:
        add_unknown("blind-docprops", props_err, _SRC_BLIND)
    elif props is None:
        add_unknown("blind-docprops", "DOCX 无 docProps/core.xml 部件，无法核查文档属性作者字段", _SRC_BLIND)
    elif not terms:
        shown = "；".join(f"{k}=「{v[:40]}」" for k, v in props.items() if v) or "creator/lastModifiedBy 均为空"
        add_unknown("blind-docprops",
                    f"未配置屏蔽词，无法判断文档属性是否泄露作者身份（{shown}）", _SRC_BLIND)
    else:
        hits = []
        for k in ("creator", "lastModifiedBy"):
            v = props.get(k) or ""
            for term in terms:
                if term.lower() in v.lower():
                    hits.append(f"{k} 命中屏蔽词「{term}」")
        add("blind-docprops", not hits,
            "文档属性泄露：" + "；".join(hits[:3]) if hits
            else "creator/lastModifiedBy 未命中屏蔽词", _SRC_BLIND)

    return {"items": items}


# 规则集注册表：id → {version, run(模块属性名字符串), title}。
# run 存**模块属性名**而非函数对象——路由按名 getattr 取，测试 monkeypatch
# word_preflight.run_checks 等模块属性时才不会被注册表里的旧引用绕过。
RULESETS: dict[str, dict] = {
    "jcip-preflight": {
        "version": "1",
        "run": "run_checks",
        "title": "中文信息学报（jcip 模板规则）",
    },
    "cn-general": {
        "version": "1",
        "run": "run_cn_general",
        "title": "通用中文论文投稿规范",
    },
    "double-blind": {
        "version": "1",
        "run": "run_double_blind",
        "title": "双盲匿名审查",
    },
}


def resolve_ruleset(ruleset: str | None) -> tuple[str, dict]:
    """规则集名（None=默认）→ (id, entry)；未知名称抛 ValueError（路由转 422）。"""
    rid = (ruleset or "").strip() or DEFAULT_RULESET
    entry = RULESETS.get(rid)
    if entry is None:
        raise ValueError(f"未知规则集：{ruleset}（允许：{'、'.join(RULESETS)}）")
    return rid, entry
