# -*- coding: utf-8 -*-
"""GB/T 7714-2015（顺序编码制）参考文献渲染器（v0.6.18，P1-0-A）。

设计约束：
- **纯 Python 确定性**：不依赖 citeproc/网络/当前时间——同一条目永远产出同一字符串（可测试、可对账）；
- 输入 = LibraryEntry（文献面板字段模型），输出 = "[n] 条目文本" 列表 + 引用标签；
- 覆盖中文期刊常见类型：[J] 期刊 / [C] 会议 / [D] 学位论文 / [M] 专著 / [R] 报告 /
  [EB/OL] 电子文献 / [Z] 其他；
- 中西文作者区分：作者列表按 CJK 字符占比判定主语言——中文姓名整名保留（最多 3 人后接
  「，等」），西文按「姓 名缩写无点」规范（最多 3 人后接 ", et al"）；
- 缺卷/期/页码时优雅省略多余标点，绝不产出 ", ," 或悬空冒号。
"""

from __future__ import annotations

import re
from typing import Any

from app.domain.library import LibraryEntry

# CJK 统一表意字符（含扩展 A；不含假名/谚文——那是日韩文，按西文处理不合适但罕见，容忍）
_CJK_CHAR_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_LETTER_RE = re.compile(r"[A-Za-z]")
_RANGE_DASH_RE = re.compile(r"\s*[-–—−]+\s*")
# 仅接受纯编号连字号范围（1-999），端点超界或倒序按整段放弃（防误展开年份区间）
_RANGE_TOKEN_RE = re.compile(r"^(\d{1,3})\s*[-–—−]\s*(\d{1,3})$")
_NUM_TOKEN_RE = re.compile(r"^\d{1,3}$")

STYLE_ID = "gb-t-7714-2015"

# entry_type → 文献类型标识（GB/T 7714-2015 表 4；未知类型一律 [Z]）
_TYPE_MARKERS = {
    "article": "J",
    "inproceedings": "C",
    "conference": "C",
    "proceedings": "C",
    "phdthesis": "D",
    "mastersthesis": "D",
    "book": "M",
    "inbook": "M",
    "incollection": "M",
    "techreport": "R",
    "standard": "S",
    "patent": "P",
    "newspaper": "N",
}
MAX_AUTHORS_SHOWN = 3


def count_cjk(text: str) -> int:
    return len(_CJK_CHAR_RE.findall(text or ""))


def authors_mostly_cjk(authors: list[str]) -> bool:
    """作者列表主语言：按「含 CJK 字符的作者人数」判定（人数过半或平局 → 中文）。
    中文期刊对外合作者也用「等」收尾，故平局按中文处理；西文名在中文列表内仍按西文规范展开。"""
    names = [a for a in authors if a and a.strip()]
    if not names:
        return False
    cjk_persons = sum(1 for a in names if count_cjk(a) > 0)
    return cjk_persons * 2 >= len(names)


def _strip_protective_braces(name: str) -> tuple[str, bool]:
    """剥掉 BibTeX 保护性花括号；返回 (净化名, 是否原本是字面量名)。"""
    s = name.strip()
    if s.startswith("{") and s.endswith("}") and s.count("{") == 1:
        return s[1:-1].strip(), True
    return s, False


def _split_person(name: str) -> dict[str, Any]:
    """单个人名 → {family, given, cjk, literal}。兼容「Last, First」与「First Last」。"""
    cleaned, literal = _strip_protective_braces(name)
    if not cleaned:
        return {"family": "", "given": "", "cjk": False, "literal": literal}
    if count_cjk(cleaned) > 0:
        # 中文姓名（或含中文的机构名）：整名保留，绝不拆缩写
        return {"family": cleaned, "given": "", "cjk": True, "literal": literal}
    if literal:
        return {"family": cleaned, "given": "", "cjk": False, "literal": True}
    if "," in cleaned:
        family, _, given = cleaned.partition(",")
        return {"family": family.strip(), "given": given.strip(), "cjk": False, "literal": False}
    parts = [p for p in cleaned.split() if p]
    if len(parts) <= 1:
        return {"family": cleaned, "given": "", "cjk": False, "literal": False}
    return {"family": parts[-1], "given": " ".join(parts[:-1]), "cjk": False, "literal": False}


def _given_initials(given: str) -> str:
    """名 → 缩写无点："Ashish" → "A"；"Jean-Pierre" → "JP"。"""
    tokens = [t for t in re.split(r"[\s.\-]+", given or "") if t]
    return "".join(t[0].upper() for t in tokens)


def _surname_display(family: str) -> str:
    """西文姓规范形式：全小写姓氏首字母大写，其余保留（McDonald / van der Berg 不破坏）。"""
    if not family:
        return ""
    if family.islower():
        return family[0].upper() + family[1:]
    return family


def format_western_person(name: str) -> str:
    """西文单作者 → "姓 名缩写"（如 "Vaswani, Ashish" / "Ashish Vaswani" → "Vaswani A"）。"""
    p = _split_person(name)
    if p["cjk"] or p["literal"] or not p["given"]:
        return p["family"]
    initials = _given_initials(p["given"])
    return f"{_surname_display(p['family'])} {initials}".strip()


def format_authors_gbt(authors: list[str]) -> str:
    """作者列表 → GB/T 7714 作者段（≤3 人全列；>3 人前 3 + 「等」/「et al」按主语言）。"""
    names = [a.strip() for a in authors if a and a.strip()]
    if not names:
        return ""
    cn = authors_mostly_cjk(names)
    if cn:
        shown = names[:MAX_AUTHORS_SHOWN]
        text = ", ".join(shown)
        return f"{text}, 等" if len(names) > MAX_AUTHORS_SHOWN else text
    shown = [format_western_person(n) for n in names[:MAX_AUTHORS_SHOWN]]
    text = ", ".join(shown)
    return f"{text}, et al" if len(names) > MAX_AUTHORS_SHOWN else text


def type_marker(entry: LibraryEntry) -> str:
    """entry_type → 文献类型标识；misc 含 url 判电子文献 [EB/OL]，否则 [Z]。"""
    t = (entry.entry_type or "").lower()
    if t == "misc":
        if (entry.url or "").strip():
            return "EB/OL"
        return "Z"
    return _TYPE_MARKERS.get(t, "Z")


def normalize_pages(pages: str | None) -> str:
    """页码范围统一半角短横（--/–/—/− → -），去空白。"""
    if not pages:
        return ""
    return _RANGE_DASH_RE.sub("-", str(pages)).strip()


def _volume_part(entry: LibraryEntry) -> str:
    vol = (entry.volume or "").strip()
    num = (entry.number or "").strip()
    if vol and num:
        return f"{vol}({num})"
    return vol


def _source_tail(entry: LibraryEntry, marker: str) -> str:
    """类型标识之后、句点之前的出版信息段（不含前导分隔）。"""
    year = (entry.year or "").strip()
    pages = normalize_pages(entry.pages)
    venue = (entry.venue or "").strip()
    publisher = (entry.publisher or (entry.fields or {}).get("school") or "").strip()
    address = ((entry.fields or {}).get("address") or "").strip()

    if marker == "EB/OL":
        url = (entry.url or "").strip()
        doi = (entry.doi or "").strip()
        access = url or (f"https://doi.org/{doi}" if doi else "")
        seg = f"({year})" if year else ""
        return f"{seg} {access}".strip() if access else seg

    if marker == "C":
        # 题名[C]//会议名, 年, 卷(期): 页码.
        items = [venue, year, _volume_part(entry)]
        tail = ", ".join(x for x in items if x)
        if pages:
            tail = f"{tail}: {pages}" if tail else pages
        return f"//{tail}" if tail else ""
    if marker == "D":
        # 题名[D]. 城市: 学校, 年.
        head = f"{address}: {publisher}" if address and publisher else (publisher or address)
        items = [head, year]
        return ", ".join(x for x in items if x)
    if marker == "M" or marker == "R":
        head = f"{address}: {publisher}" if address and publisher else (publisher or address)
        items = [head, year, _volume_part(entry)]
        tail = ", ".join(x for x in items if x)
        if pages:
            tail = f"{tail}: {pages}" if tail else pages
        return tail
    # 默认（[J]/[N]/[Z]/[S]/[P]…）：题名[X]. 刊名, 年, 卷(期): 页码.
    items = [venue, year, _volume_part(entry)]
    tail = ", ".join(x for x in items if x)
    if pages:
        tail = f"{tail}: {pages}" if tail else pages
    return tail


def _clean_title(title: str) -> str:
    t = (title or "").strip()
    t = t.strip("{}").strip()
    # 题名内部不必句点结尾（导入来源常带尾点）
    return t.rstrip(".").strip()


def format_gbt7714_entry(entry: LibraryEntry, index: int) -> str:
    """单条 → "[n] 作者. 题名[标识]. 出版信息."（缺字段优雅省略）。"""
    marker = type_marker(entry)
    authors = format_authors_gbt(entry.authors or [])
    title = _clean_title(entry.title)
    head = f"{authors}. {title}" if authors else title
    tail = _source_tail(entry, marker)
    # [C]//析出：GB/T 惯例 // 紧贴类型标识（题名[C]//会议名…），不插句点与空格
    if marker == "C" and tail.startswith("//"):
        text = f"{head}[{marker}]{tail}." if tail else f"{head}[{marker}]."
    else:
        text = f"{head}[{marker}]." + (f" {tail}." if tail else "")
    return f"[{index}] {text}"


def format_gbt7714_bibliography(entries_in_order: list[LibraryEntry]) -> dict[str, Any]:
    """按正文首次出现顺序渲染 GB/T 7714-2015 参考文献表。

    返回对齐 /library/bibliography 既有形状：{style, labels, bibliography, note}。"""
    labels: dict[str, str] = {}
    items: list[str] = []
    for i, e in enumerate(entries_in_order, 1):
        labels[e.reference_id] = f"[{i}]"
        items.append(format_gbt7714_entry(e, i))
    return {
        "style": STYLE_ID,
        "labels": labels,
        "bibliography": items,
        "note": "GB/T 7714-2015 顺序编码制（平台确定性渲染器）；平台引用对象（内容控件标签绑定 reference_id），非 Word 原生引文域",
    }


def compress_number_ranges(numbers: list[int]) -> str:
    """升序去重编号 → GB/T 7714 连号压缩串：仅 ≥3 连续整数压为起止范围（1-3），2 连号保持 1,2。"""
    uniq = sorted({int(n) for n in numbers})
    if not uniq:
        return ""
    parts: list[str] = []
    run_start = prev = uniq[0]
    for n in uniq[1:] + [None]:
        if n is not None and n == prev + 1:
            prev = n
            continue
        length = prev - run_start + 1
        if length >= 3:
            parts.append(f"{run_start}-{prev}")
        else:
            parts.extend(str(k) for k in range(run_start, prev + 1))
        if n is not None:
            run_start = prev = n
    return ",".join(parts)


def parse_citation_numbers(bracket_text: str) -> list[int]:
    """解析单个引用括号内文（"1, 3-5" / "1-3" / "2"）→ 展开编号列表。

    合法性约束（防误展开）：每个编号 1..999；范围端点倒序或跨度 >100 整个 token 放弃；
    含非数字 token 的括号整体放弃（那是带文字的标签，不是编号引用）。"""
    tokens = [t.strip() for t in re.split(r"[,，]", bracket_text or "") if t.strip()]
    out: list[int] = []
    for t in tokens:
        if _NUM_TOKEN_RE.match(t):
            out.append(int(t))
            continue
        m = _RANGE_TOKEN_RE.match(t)
        if not m:
            return []  # 非常规 token（年份/文字）：整括号不是编号引用
        start, end = int(m.group(1)), int(m.group(2))
        if end < start or end - start > 100:
            continue
        out.extend(range(start, end + 1))
    # 惯例上正文引用编号为 1..999；越界（如 [2020]）不视作引用标记
    return [n for n in out if 1 <= n <= 999]
