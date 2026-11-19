# -*- coding: utf-8 -*-
"""智能文献管理领域层（v0.4）。

模型边界（防双写失控）：
- LaTeX 工程（mode="bib"）：.bib 文件是唯一事实源；本模块的 index（`.studio/library/index.json`）
  是**可重建视图**——字段、原始 BibTeX、所在文件都来自解析 .bib；provenance / 查询记录 / 撤稿状态 /
  确认状态等**库外元数据**也存 index，重建时按 (bib 文件, citation key) → 条目内容哈希 逐级对账保留。
  对 bib 的任何写操作（追加/改写/删除条目）都以 base-sha 乐观锁校验后走原子写，与 /latex/files 同语义。
- Word / 其他模式（mode="index"）：无 .bib，index 文件即事实源；导出 BibTeX/CSL-JSON 由字段生成。

解析：bibtexparser 1.4 按块解析（整文件解析会静默丢弃坏条目）；先自切条目块（括号配平），
逐块解析，@string 块解析后前置给后续条目块（宏跨条目可见）；坏块逐条报错并保留原文。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

from app import atomic
from app.errors import kind_error

DIR = os.path.join(".studio", "library")
INDEX_FILE = "index.json"
INDEX_SCHEMA_VERSION = 1

# 引用键合法字符（BibTeX key 惯例；逗号/花括号/空白明确非法）
KEY_RE = re.compile(r"^[A-Za-z0-9_:.+/#-]{1,120}$")
RID_RE = re.compile(r"^ref_[0-9a-f]{12}$")
BIB_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.bib$")

FieldSource = Literal["user", "bib", "crossref", "openalex", "arxiv", "ai_suggested"]
VerifiedState = Literal["unverified", "verified", "conflict"]
RetractionStatus = Literal["retracted", "corrected", "unknown"]

# 字段级事实源说明（前端展示用）
SOURCE_LABELS = {
    "user": "用户提供",
    "bib": "BibTeX 文件",
    "crossref": "Crossref",
    "openalex": "OpenAlex",
    "arxiv": "arXiv",
    "ai_suggested": "AI 建议（未验证）",
}


class FieldProvenance(BaseModel):
    source: str
    confirmed: bool = False
    at: float = Field(default_factory=time.time)


class SourceQuery(BaseModel):
    source: str
    query: str
    at: float
    matched: bool
    note: str | None = None


class RetractionInfo(BaseModel):
    status: RetractionStatus = "unknown"
    source: str | None = None
    checked_at: float | None = None
    note: str | None = None


class LibraryEntry(BaseModel):
    reference_id: str
    citation_key: str
    entry_type: str = "article"
    title: str = ""
    authors: list[str] = Field(default_factory=list)
    year: str | None = None
    venue: str | None = None  # journal / booktitle
    volume: str | None = None
    number: str | None = None
    pages: str | None = None
    publisher: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    url: str | None = None
    abstract: str | None = None
    keywords: str | None = None
    # 全部原始字段（含未知字段；值为插值后的字符串）。键 = bibtex 字段名（小写）。
    fields: dict[str, str] = Field(default_factory=dict)
    raw_bibtex: str = ""
    field_provenance: dict[str, FieldProvenance] = Field(default_factory=dict)
    queries: list[SourceQuery] = Field(default_factory=list)
    retraction: RetractionInfo | None = None
    verified: VerifiedState = "unverified"
    bib_files: list[str] = Field(default_factory=list)
    # AI 建议层：补全字段建议（未验证），采纳需用户确认后经 _set_field 进 fields
    suggested: dict[str, str] = Field(default_factory=dict)
    suggested_model: str | None = None
    # index 模式（Word）下条目的创建方式；bib 模式恒为 "import"/"lookup"
    origin: str = "import"
    # 导入溯源（B2 Zotero 刷新）：{provider:"zotero", group_id, collection_key}；
    # 仅 index 模式可靠保留（bib 模式 rebuild 后丢失 ⇒ removed 检测不可用）。
    source: dict | None = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


class LibraryIndex(BaseModel):
    schema_version: int = INDEX_SCHEMA_VERSION
    mode: Literal["bib", "index"] = "index"
    entries: list[LibraryEntry] = Field(default_factory=list)
    # Word 静态引用的全局编号顺序（first-citation order）：引用标签 [n] 的 n = 本表位置。
    # bib 模式不用（LaTeX 编号由 BibTeX 编译时生成）。
    citation_order: list[str] = Field(default_factory=list)
    updated_at: float = Field(default_factory=time.time)


class BibParseError(BaseModel):
    line: int
    raw: str
    error: str


class BibParseResult(BaseModel):
    entries: list[LibraryEntry] = Field(default_factory=list)
    errors: list[BibParseError] = Field(default_factory=list)


# ---------------------------------------------------------------- 存储 ----


def index_path(project_dir: str) -> str:
    return os.path.join(project_dir, DIR, INDEX_FILE)


def load_index(project_dir: str) -> LibraryIndex:
    p = index_path(project_dir)
    if not os.path.isfile(p):
        return LibraryIndex()
    try:
        with open(p, encoding="utf-8") as f:
            return LibraryIndex.model_validate(json.load(f))
    except Exception:
        # 坏索引不挡编辑：按空索引继续（重建/提交会覆盖修复），原始 bib 不受影响
        return LibraryIndex()


def save_index(project_dir: str, index: LibraryIndex) -> None:
    index.updated_at = time.time()
    with atomic.studio_lock(project_dir, "library"):
        atomic.write_json(index_path(project_dir), index.model_dump(mode="json"))


def new_reference_id() -> str:
    return "ref_" + uuid.uuid4().hex[:12]


# ---------------------------------------------------------------- BibTeX 解析 ----

_AT_ENTRY_RE = re.compile(r"^\s*@\s*([A-Za-z]+)\s*[(({]", re.MULTILINE)
_NON_ENTRY_TYPES = {"comment", "string", "preamble"}
# 供显示的规范字段序；其余未知字段按字母序跟在后面
_CANONICAL_ORDER = (
    "author", "title", "journal", "booktitle", "year", "volume", "number", "pages",
    "publisher", "address", "edition", "editor", "doi", "url", "abstract", "keywords", "note",
)
# 模型顶层属性与 fields 双写的字段集合
_TOP_LEVEL_FIELDS = {
    "title", "year", "venue", "volume", "number", "pages",
    "publisher", "url", "abstract", "keywords",
}


def split_bib_blocks(text: str) -> list[tuple[str, int, str]]:
    """把 .bib 文本切成块：返回 [(块原文, 起始行号, 类型小写)]。类型含 comment/string/preamble/article…。

    切块只做定位（@类型 定位 + 花括号配平），字段解析全部交给 bibtexparser；
    EOF 仍不配平的块原样返回（由调用方按损坏条目报告）。"""
    blocks: list[tuple[str, int, str]] = []
    lines = text.split("\n")
    i = 0
    n = len(lines)
    while i < n:
        m = _AT_ENTRY_RE.match(lines[i])
        if not m:
            i += 1
            continue
        start_line = i
        # 花括号配平：从条目第一个界定符起计数；同时兼容 ( ) 界定（罕见但合法）
        open_ch = "{" if "{" in lines[i][m.start():] else "(" if "(" in lines[i][m.start():] else "{"
        close_ch = "}" if open_ch == "{" else ")"
        depth = 0
        seen_open = False
        j = i
        buf: list[str] = []
        while j < n:
            line = lines[j]
            seg = line[m.start():] if j == start_line else line
            for ch in seg:
                if ch == open_ch:
                    depth += 1
                    seen_open = True
                elif ch == close_ch:
                    depth -= 1
            buf.append(line)
            j += 1
            if seen_open and depth <= 0:
                break
        blocks.append(("\n".join(buf), start_line + 1, m.group(1).lower()))
        i = j
    return blocks


_BLOCK_HEADER_RE = re.compile(r"^@[A-Za-z]+\s*[{(]\s*[^,\s{}()]+\s*,", re.DOTALL)


def _block_to_entry(block: str, line_no: int, btype: str) -> tuple[LibraryEntry | None, BibParseError | None]:
    import bibtexparser
    from bibtexparser.bparser import BibTexParser

    if btype in _NON_ENTRY_TYPES:
        return None, None
    # 块头校验：@type{key, 形态不成立 ⇒ 结构损坏（bibtexparser 会"尽力救回"跨条目碎片，
    # 静默吞掉损坏事实——这里显式报告，不静默）。EOF 不配平的块同样报。
    if not _BLOCK_HEADER_RE.match(block):
        return None, BibParseError(
            line=line_no, raw=block[:400],
            error="条目结构损坏（@类型{key, 头部不完整或花括号不配平，可能吞并了后续内容）；请修复 .bib 原文后重建")
    try:
        db = bibtexparser.loads(
            block,
            parser=BibTexParser(common_strings=True, ignore_nonstandard_types=False, interpolate_strings=True),
        )
    except Exception as e:  # noqa: BLE001 — 逐块容错
        return None, BibParseError(line=line_no, raw=block[:400], error=f"BibTeX 解析失败：{e}")
    if not db.entries:
        return None, BibParseError(line=line_no, raw=block[:400], error="无法解析的条目（语法损坏或结构不完整）")
    raw = db.entries[0]
    fields = {k.lower(): str(v) for k, v in raw.items() if k not in ("ID", "ENTRYTYPE") and v is not None}
    key = str(raw.get("ID", "")).strip()
    if not key:
        return None, BibParseError(line=line_no, raw=block[:400], error="条目缺少 citation key")
    entry = LibraryEntry(
        reference_id=new_reference_id(),
        citation_key=key,
        entry_type=str(raw.get("ENTRYTYPE", "article")).lower(),
        title=fields.get("title", "").strip("{} "),
        authors=split_authors(fields.get("author", "")),
        year=_clean_year(fields.get("year")),
        venue=fields.get("journal") or fields.get("booktitle") or None,
        volume=fields.get("volume"),
        number=fields.get("number"),
        pages=fields.get("pages"),
        publisher=fields.get("publisher"),
        doi=normalize_doi(fields.get("doi")),
        arxiv_id=normalize_arxiv(fields.get("eprint") or fields.get("arxiv") or fields.get("arxivid")),
        url=fields.get("url"),
        abstract=fields.get("abstract"),
        keywords=fields.get("keywords"),
        fields=fields,
        raw_bibtex=block.strip("\n"),
        field_provenance={"bib": FieldProvenance(source="bib")},
    )
    return entry, None


def parse_bibtex_text(text: str, *, offset_line: int = 0) -> BibParseResult:
    """整段 BibTeX 文本 → 逐块解析结果（坏块逐条报错，不吞整库）。@string 块前置共享给后续条目。"""
    out = BibParseResult()
    string_blocks: list[str] = []
    for block, line_no, btype in split_bib_blocks(text):
        if btype == "string":
            string_blocks.append(block)
            continue
        if btype in ("comment", "preamble"):
            continue
        # 宏块前置：条目内 `conf # {NIPS}` 一类引用可解析
        payload = ("\n".join(string_blocks) + "\n" + block) if string_blocks else block
        entry, err = _block_to_entry(payload, line_no + offset_line, btype)
        if err is not None:
            out.errors.append(err)
        elif entry is not None:
            out.entries.append(entry)
    return out


def parse_bibtex_text(text: str, *, offset_line: int = 0) -> BibParseResult:
    """整段 BibTeX 文本 → 逐块解析结果（坏块逐条报错，不吞整库）。@string 块前置共享给后续条目。"""
    out = BibParseResult()
    string_blocks: list[str] = []
    for block, line_no, btype in split_bib_blocks(text):
        if btype == "string":
            string_blocks.append(block)
            continue
        if btype in ("comment", "preamble"):
            continue
        # 宏块前置：条目内 `conf # {NIPS}` 一类引用可解析
        payload = ("\n".join(string_blocks) + "\n" + block) if string_blocks else block
        entry, err = _block_to_entry(payload, line_no + offset_line, btype)
        if err is not None:
            out.errors.append(err)
        elif entry is not None:
            out.entries.append(entry)
    return out


# ---------------------------------------------------------- GB/T 7714 文本导入 ----
# Google Scholar「引用 → GB/T 7714」等来源的纯文本引文，每非空行一条。启发式解析；
# 解析预览逐条报错 + 用户确认后才写盘的既有流程兜底误判。

_GBT_TYPE_MAP = {"J": "article", "C": "inproceedings", "M": "book", "D": "phdthesis", "R": "techreport"}
_GBT_LINE_RE = re.compile(
    r"^(?P<authors>.+?)\.\s*(?P<title>.+?)\[(?P<marker>[A-Z]{1,2})\](?P<rest>.*)$")
_GBT_YEAR_RE = re.compile(r"(?<!\d)(19\d{2}|20\d{2})(?!\d)")
_GBT_PAGES_RE = re.compile(r"(\d+)\s*[-–—]\s*(\d+)\s*。?\s*$")


def looks_like_bibtex(text: str) -> bool:
    return re.search(r"@\w+\s*[{(]", text) is not None


def parse_citation_text(text: str, *, offset_line: int = 0) -> BibParseResult:
    """粘贴导入的自动分流：含 @条目 的文本走 BibTeX 解析器，否则按 GB/T 7714 文本逐行解析。"""
    if looks_like_bibtex(text):
        return parse_bibtex_text(text, offset_line=offset_line)
    return parse_gbt7714_text(text, offset_line=offset_line)


def _gbt_authors(raw: str) -> list[str]:
    text = raw.strip().rstrip(".")
    for tail in ("et al", "等"):  # rstrip(".") 后 Scholar 的 "et al." 只剩 "et al"
        if text.endswith(tail):
            text = text[: -len(tail)].rstrip(" ,.，")
            break
    return [p.strip() for p in re.split(r"[,，]", text) if p.strip()]


def _gbt_entry_from_line(line: str, line_no: int) -> tuple[LibraryEntry | None, BibParseError | None]:
    m = _GBT_LINE_RE.match(line.strip())
    if not m:
        return None, BibParseError(
            line=line_no, raw=line[:400],
            error="无法识别的 GB/T 7714 条目（应为「作者. 标题[J]. 期刊, 年, 卷(期): 页码.」形态，未找到 [J]/[C]/[M] 等类型标记）")
    authors_raw, title, marker, rest = m.group("authors"), m.group("title"), m.group("marker"), m.group("rest")
    authors = _gbt_authors(authors_raw)
    if not authors or not title.strip():
        return None, BibParseError(line=line_no, raw=line[:400], error="GB/T 7714 条目缺少作者或标题")
    entry_type = _GBT_TYPE_MAP.get(marker, "misc")
    # 年/页码在清洗掉首尾句点后的 body 上提取：$ 锚定会被尾部 ASCII 句点挡住
    body = rest.strip().lstrip(".").strip().rstrip(".").strip()
    year_m = _GBT_YEAR_RE.search(body)
    year = year_m.group(1) if year_m else None
    pages = None
    pages_m = _GBT_PAGES_RE.search(body)
    if pages_m:
        pages = f"{pages_m.group(1)}-{pages_m.group(2)}"
    venue = volume = number = publisher = None
    if marker == "C" and body.startswith("//"):
        # [C]//会议名. 2026, 2026: 24062-24086.（Scholar 常见双年份，首个为出版年）
        venue = body[2:].split(".")[0].strip() or None
    elif marker == "J":
        # [J]. 期刊, 年, 卷(期): 页码.
        segs = [s.strip() for s in body.split(",")]
        if segs and segs[0]:
            venue = segs[0] or None
        vol = re.search(r"(\d+)\((\d+)\)", body)
        if vol:
            volume, number = vol.group(1), vol.group(2)
    elif marker == "M":
        # [M]. 出版地: 出版社, 年.
        head = body.split(",")[0].strip()
        addr_pub = head.split(":", 1)
        publisher = (addr_pub[1].strip() if len(addr_pub) == 2 else head) or None
    fields = {"author": " and ".join(authors), "title": title.strip()}
    if venue:
        fields["journal" if entry_type == "article" else "booktitle"] = venue
    if year:
        fields["year"] = year
    if volume:
        fields["volume"] = volume
    if number:
        fields["number"] = number
    if pages:
        fields["pages"] = pages
    if publisher:
        fields["publisher"] = publisher
    first = authors[0].split()[0] if authors[0].split() else authors[0]
    surname = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", first).lower() or "ref"
    entry = LibraryEntry(
        reference_id=new_reference_id(),
        citation_key=surname + (year or ""),
        entry_type=entry_type,
        title=title.strip(),
        authors=authors,
        year=year,
        venue=venue,
        volume=volume,
        number=number,
        pages=pages,
        publisher=publisher,
        fields=fields,
        raw_bibtex=line.strip(),
        field_provenance={"gbt7714": FieldProvenance(source="gbt7714")},
    )
    return entry, None


def parse_gbt7714_text(text: str, *, offset_line: int = 0) -> BibParseResult:
    """GB/T 7714 纯文本引文（Google Scholar 引用导出等）→ 每非空行一条。"""
    out = BibParseResult()
    for i, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        entry, err = _gbt_entry_from_line(line, i + offset_line)
        if err is not None:
            out.errors.append(err)
        elif entry is not None:
            out.entries.append(entry)
    return out


def split_authors(author_field: str) -> list[str]:
    """BibTeX author 字段 → 作者名列表（` and ` 分隔；花括号内 and 不分隔）。"""
    if not author_field:
        return []
    tokens: list[str] = []
    cur: list[str] = []
    depth = 0
    i = 0
    while i < len(author_field):
        ch = author_field[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        if depth == 0 and author_field[i:i + 5].lower() == " and ":
            tokens.append("".join(cur).strip())
            cur = []
            i += 5
            continue
        cur.append(ch)
        i += 1
    tokens.append("".join(cur).strip())
    out = []
    for t in tokens:
        t = t.strip().strip(",").strip()
        if t:
            out.append(t)
    return out


def _clean_year(v: str | None) -> str | None:
    if not v:
        return None
    m = re.search(r"(19|20)\d{2}", v)
    return m.group(0) if m else v.strip()


def normalize_doi(v: str | None) -> str | None:
    if not v:
        return None
    s = v.strip().lower()
    for pre in ("https://doi.org/", "http://doi.org/", "doi.org/", "doi:", "info:doi/"):
        if s.startswith(pre):
            s = s[len(pre):]
    s = s.strip()
    return s or None


def normalize_arxiv(v: str | None) -> str | None:
    if not v:
        return None
    s = v.strip()
    m = re.search(r"arxiv\.org/(?:abs|pdf)/([^\s?#]+)", s, re.IGNORECASE)
    if m:
        s = m.group(1)
    s = re.sub(r"(?i)^arxiv[:\s]*", "", s).strip()
    s = re.sub(r"v\d+$", "", s)
    return s or None


def title_norm(title: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", (title or "").lower())


def entry_fingerprint(e: LibraryEntry) -> tuple[str, str, str]:
    """疑似重复指纹：规范化标题 + 年份 + 第一作者姓氏。"""
    surname = ""
    if e.authors:
        first = e.authors[0]
        surname = (first.split(",")[0] if "," in first else first.split()[-1] if first.split() else "").lower()
    return (title_norm(e.title), e.year or "", surname)


def doi_of(e: LibraryEntry) -> str | None:
    return normalize_doi(e.doi or e.fields.get("doi"))


def arxiv_of(e: LibraryEntry) -> str | None:
    return normalize_arxiv(e.arxiv_id or e.fields.get("eprint") or e.fields.get("arxivid"))


# ---------------------------------------------------------------- 重建（bib 模式） ----


def bib_files(project) -> list[str]:
    """工程内全部 .bib（相对路径升序）。"""
    from app.domain.latex_build import list_source_files

    return [f["path"] for f in list_source_files(project) if f["path"].lower().endswith(".bib")]


def rebuild_from_bib(
    project, rid_hints: dict[tuple[str, str], str] | None = None
) -> tuple[LibraryIndex, list[BibParseError]]:
    """解析全部 .bib → 重建索引视图；旧索引的库外元数据按 (file, key) → 内容哈希 对账保留。
    rid_hints：调用方预分配的 (file, key)→rid（commit 场景），优先级高于旧索引对账——
    消灭「分配后回查」的时序竞态。"""
    from app.domain.latex_build import read_source_file

    old = load_index(project.dir)
    old_by_sig: dict[tuple[str, str], LibraryEntry] = {}
    old_by_content: dict[str, LibraryEntry] = {}
    for e in old.entries:
        for bf in e.bib_files or [""]:
            old_by_sig[(bf, e.citation_key)] = e
        old_by_content[hashlib.sha1(e.raw_bibtex.encode()).hexdigest()] = e

    entries: list[LibraryEntry] = []
    errors: list[BibParseError] = []
    for rel in bib_files(project):
        try:
            text = read_source_file(project, rel)
        except Exception as e:  # noqa: BLE001 — 单文件损坏逐项报告
            errors.append(BibParseError(line=0, raw=rel, error=f"读取失败：{e}"))
            continue
        parsed = parse_bibtex_text(text)
        errors.extend(BibParseError(line=e_.line, raw=f"{rel}: {e_.raw[:200]}", error=e_.error) for e_ in parsed.errors)
        for ent in parsed.entries:
            ent.bib_files = [rel]
            # 对账：同文件同 key → 复用 rid 与库外元数据；key 变了按内容哈希兜底
            hinted = (rid_hints or {}).get((rel, ent.citation_key))
            prev = None
            if hinted:
                prev = next((o for o in old.entries if o.reference_id == hinted), None)
                if prev is None:
                    # hints 命中但旧索引无此条目：纯新条目——沿用预分配 rid 即可
                    ent.reference_id = hinted
                    ent.bib_files = [rel]
                    entries.append(ent)
                    continue
            if prev is None:
                prev = old_by_sig.get((rel, ent.citation_key))
            if prev is None:
                prev = old_by_content.get(hashlib.sha1(ent.raw_bibtex.encode()).hexdigest())
            if prev is not None:
                ent.reference_id = prev.reference_id
                ent.field_provenance = prev.field_provenance
                ent.queries = prev.queries
                ent.retraction = prev.retraction
                ent.verified = prev.verified
                ent.suggested = prev.suggested
                ent.suggested_model = prev.suggested_model
                ent.created_at = prev.created_at
                ent.updated_at = time.time()
            entries.append(ent)

    # bib 中已消失的条目：bib 模式下视图跟随 bib（元数据随条目一起消失——重建语义）
    idx = LibraryIndex(mode="bib", entries=entries)
    save_index(project.dir, idx)
    return idx, errors


# ---------------------------------------------------------------- 条目写回 .bib ----


def _check_base(cur: str, base: str | None, rel: str) -> None:
    if base is not None:
        cur_sha = hashlib.sha256(cur.encode()).hexdigest()
        if cur_sha != base:
            raise kind_error("stale", f"{rel} 已被其他会话修改，请刷新文献面板后重试", detail=rel)


def _write_bib(project, rel: str, content: str) -> str:
    from app.domain.latex_build import resolve_source_path, save_source_file
    from app.domain import latex_history

    resolve_source_path(project, rel)  # 路径安全校验（穿越/内部目录）
    if not os.path.isfile(os.path.join(project.dir, *rel.split("/"))):
        raise kind_error("not_found", f"目标 .bib 文件不存在：{rel}", detail=rel)
    save_source_file(project, rel, content if content.endswith("\n") else content + "\n")
    # 结构性写回总是提交版本历史（文献插入不受 90s 保存合并窗口影响；git 缺失静默跳过）
    latex_history.commit(project.dir, f"library {rel}", force=True)
    return hashlib.sha256(content.encode()).hexdigest()


def format_bibtex(e: LibraryEntry) -> str:
    """由字段生成规范 BibTeX（未知字段保留在末尾）。"""
    lines = [f"@{e.entry_type}{{{e.citation_key},"]
    seen = set()
    ordered = [f for f in _CANONICAL_ORDER if f in e.fields] + [
        f for f in sorted(e.fields) if f not in _CANONICAL_ORDER and f not in ("id", "entrytype")
    ]
    for fname in ordered:
        if fname in seen:
            continue
        seen.add(fname)
        val = e.fields[fname]
        if val is None or str(val) == "":
            continue
        lines.append(f"  {fname} = {{{val}}},")
    if not e.fields:
        # 手工新建且尚无字段：给最小可用形态
        if e.title:
            lines.append(f"  title = {{{e.title}}},")
        if e.authors:
            lines.append(f"  author = {{{' and '.join(e.authors)}}},")
        if e.year:
            lines.append(f"  year = {{{e.year}}},")
    if lines[-1].endswith(","):
        lines[-1] = lines[-1][:-1]
    lines.append("}")
    return "\n".join(lines)


def append_entries_to_bib(project, rel: str, entries: list[LibraryEntry], base: str | None) -> str:
    """确认后的条目追加到目标 .bib（base-sha 乐观锁）。返回新 sha。"""
    from app.domain.latex_build import read_source_file

    cur = read_source_file(project, rel)
    _check_base(cur, base, rel)
    add = []
    for e in entries:
        add.append(format_bibtex(e))
    new = cur.rstrip("\n") + "\n\n" + "\n\n".join(add) + "\n" if cur.strip() else "\n\n".join(add) + "\n"
    return _write_bib(project, rel, new)


def replace_entry_in_bib(project, rel: str, old_raw: str, new_raw: str, base: str | None) -> str:
    from app.domain.latex_build import read_source_file

    cur = read_source_file(project, rel)
    _check_base(cur, base, rel)
    if old_raw not in cur:
        raise kind_error("stale", "原始 BibTeX 片段在文件中已不存在（可能被直接编辑过），请刷新后重试", detail=rel)
    new = cur.replace(old_raw, new_raw, 1)
    return _write_bib(project, rel, new)


def apply_refresh_to_bib(project, rel: str, base: str | None,
                         replacements: list[tuple[str, str]],
                         additions: list[LibraryEntry]) -> str:
    """Zotero 刷新提交的 bib 批量合成写（B2）：同一锁内校验一次 base-sha，
    内存合成全部更新+新增后**单次落盘**——绝不循环逐条 replace 撞同一 base 触发 409。
    replacements = [(old_raw, new_raw)]；old_raw 缺失即整体拒绝（stale），无半写状态。"""
    from app.domain.latex_build import read_source_file

    with atomic.studio_lock(project.dir, "library"):
        cur = read_source_file(project, rel)
        _check_base(cur, base, rel)
        new = cur
        for old_raw, new_raw in replacements:
            if old_raw not in new:
                raise kind_error("stale", "原始 BibTeX 片段在文件中已不存在（可能被直接编辑过），请刷新后重试", detail=rel)
            new = new.replace(old_raw, new_raw, 1)
        if additions:
            add = "\n\n".join(format_bibtex(e) for e in additions)
            new = new.rstrip("\n") + "\n\n" + add + "\n" if new.strip() else add + "\n"
        new = re.sub(r"\n{3,}", "\n\n", new)
        return _write_bib(project, rel, new)


def remove_entry_from_bib(project, rel: str, old_raw: str, base: str | None) -> str:
    from app.domain.latex_build import read_source_file

    cur = read_source_file(project, rel)
    _check_base(cur, base, rel)
    if old_raw not in cur:
        raise kind_error("stale", "原始 BibTeX 片段在文件中已不存在，请刷新后重试", detail=rel)
    new = cur.replace(old_raw, "", 1)
    new = re.sub(r"\n{3,}", "\n\n", new)
    return _write_bib(project, rel, new)


def create_bib_file(project, name: str) -> str:
    """新建空 .bib（文献管理专用的窄口子；/latex/files 主路径仍不建文件）。"""
    from app.domain.latex_build import resolve_source_path

    if not BIB_NAME_RE.match(name):
        raise kind_error("validation", "文件名不合法（仅允许字母数字._-，以 .bib 结尾）", detail=name)
    p = resolve_source_path(project, name)
    if os.path.isfile(p):
        raise kind_error("conflict", f"文件已存在：{name}", detail=name)
    atomic.write_text(p, "% " + name + " — 由文献面板创建\n")
    return hashlib.sha256(atomic_read(p).encode()).hexdigest()


def atomic_read(p: str) -> str:
    with open(p, encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------- 正文引用扫描 ----

CITE_CMD_RE = re.compile(
    r"\\(?:[a-zA-Z]*[cC]ite[a-zA-Z]{0,6}|autocite|Autocite|footcite|Footcite|parencite|Parencite"
    r"|textcite|Textcite|smartcite|Smartcite|citeauthor|citeyear|citealp|citealt|Citep|Citet)"
    r"\*?(?:\[[^\]]*\]){0,2}\s*\{([^{}]*)\}"
)


def scan_tex_citations(project) -> dict[str, Any]:
    """全部 .tex 的引用键使用图：{usage: {key: [{file, count}]}, cited_files: {file: [keys]}}。"""
    from app.domain.latex_build import list_source_files, read_source_file

    per_file: dict[str, list[str]] = {}
    for f in list_source_files(project):
        if not f["path"].lower().endswith(".tex"):
            continue
        try:
            text = read_source_file(project, f["path"])
        except Exception:  # noqa: BLE001 — 读不了的文件跳过
            continue
        keys: list[str] = []
        for m in CITE_CMD_RE.finditer(text):
            for k in m.group(1).split(","):
                k = k.strip()
                if k:
                    keys.append(k)
        per_file[f["path"]] = keys
    usage: dict[str, list[dict]] = {}
    for fname, keys in per_file.items():
        counter: dict[str, int] = {}
        for k in keys:
            counter[k] = counter.get(k, 0) + 1
        for k, c in counter.items():
            usage.setdefault(k, []).append({"file": fname, "count": c})
    return {"usage": usage, "cited_files": {f: sorted(set(ks)) for f, ks in per_file.items()}}


def detect_cite_style(project) -> dict[str, str]:
    """按工程实际宏包判断插入命令：natbib→citep（textcite→citet）；biblatex→autocite（textcite）；否则 cite。
    只读检测——绝不改宏包/引文风格。"""
    from app.domain.latex_build import list_source_files, read_source_file

    style = "plain"
    textcommand = "cite"
    source = "default"
    try:
        files = [f["path"] for f in list_source_files(project) if f["path"].lower().endswith(".tex")]
        # 先看主文件，再看其他
        main = (project.settings or {}).get("latex", {}).get("main")
        ordered = ([main] if main in files else []) + [f for f in files if f != main]
        for rel in ordered:
            try:
                text = read_source_file(project, rel)
            except Exception:  # noqa: BLE001
                continue
            if re.search(r"\\usepackage(?:\[[^\]]*\])?\{biblatex\}", text):
                style = "biblatex"
                textcommand = "textcite" if re.search(r"\\textcite", text) else "autocite"
                source = rel
                break
            if re.search(r"\\usepackage(?:\[[^\]]*\])?\{natbib\}", text):
                style = "natbib"
                textcommand = "citet" if re.search(r"\\citet", text) else "citep"
                source = rel
                break
    except Exception:  # noqa: BLE001 — 检测失败回落默认
        pass
    return {"style": style, "command": textcommand, "detected_from": source}


# ---------------------------------------------------------------- 重建缓存（性能基线 2026-10-24）----
# 基线：200 条文献 GET /library ~1.9s 且二次不衰减——每次全量重解析 .bib + 重算诊断。
# 缓存键 = 源内容摘要（.bib 全文哈希 + .tex 引用键使用图哈希）：普通正文编辑不失效，
# \cite 变化或 .bib 变化才重建；provenance 类只写 index.json 的操作由快路径现读天然可见。

_REBUILD_CACHE_FILE = os.path.join(DIR, "rebuild-cache.json")


def index_exists(project_dir: str) -> bool:
    return os.path.isfile(index_path(project_dir))


def sources_digest(project) -> str:
    """文献源摘要：对齐诊断的输入粒度（.bib 全文 + .tex 引用使用图），不含正文散文。"""
    from app.domain.latex_build import read_source_file

    h = hashlib.sha256()
    h.update(f"v{INDEX_SCHEMA_VERSION};".encode())
    for rel in bib_files(project):
        try:
            text = read_source_file(project, rel)
        except Exception:  # noqa: BLE001 — 读不了的文件按内容变化点处理
            h.update(f"{rel}:READ-FAIL;".encode())
            continue
        h.update(f"{rel}:{hashlib.sha256(text.encode()).hexdigest()};".encode())
    usage = scan_tex_citations(project)
    h.update(hashlib.sha256(
        json.dumps(usage, sort_keys=True, ensure_ascii=False).encode()).hexdigest().encode())
    return h.hexdigest()


def load_rebuild_cache(project_dir: str, digest: str) -> dict | None:
    """digest+schema 均匹配且索引文件存在 → {diagnostics, parse_errors}；否则 None（走重建）。"""
    p = os.path.join(project_dir, _REBUILD_CACHE_FILE)
    if not os.path.isfile(p) or not index_exists(project_dir):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if data.get("digest") != digest or data.get("schema") != INDEX_SCHEMA_VERSION:
        return None
    if not isinstance(data.get("diagnostics"), dict) or not isinstance(data.get("parse_errors"), list):
        return None
    return data


def save_rebuild_cache(project_dir: str, digest: str, diagnostics: dict, parse_errors: list[dict]) -> None:
    os.makedirs(os.path.join(project_dir, DIR), exist_ok=True)
    atomic.write_json(os.path.join(project_dir, _REBUILD_CACHE_FILE), {
        "digest": digest,
        "schema": INDEX_SCHEMA_VERSION,
        "diagnostics": diagnostics,
        "parse_errors": parse_errors,
        "saved_at": time.time(),
    })


# ---------------------------------------------------------------- 诊断 ----


def diagnostics(index: LibraryIndex, project) -> dict[str, Any]:
    """可解释诊断：重复 key / 疑似重复 / 缺字段 / 正文引用缺条目。不做"未验证=不存在"的推断。"""
    entries = index.entries
    by_key: dict[str, list[LibraryEntry]] = {}
    for e in entries:
        by_key.setdefault(e.citation_key, []).append(e)
    dup_keys = [
        {
            "key": k,
            "reference_ids": [e.reference_id for e in v],
            "bib_files": sorted({bf for e in v for bf in e.bib_files}),
        }
        for k, v in by_key.items()
        if len(v) > 1
    ]
    seen_fp: dict[tuple, list[str]] = {}
    fuzzy = []
    for e in entries:
        fp = entry_fingerprint(e)
        if not fp[0]:
            continue
        if fp in seen_fp:
            fuzzy.append({"reference_ids": [seen_fp[fp][0], e.reference_id], "title": e.title[:80]})
        else:
            seen_fp[fp] = [e.reference_id]
    missing_fields = [
        {
            "reference_id": e.reference_id,
            "citation_key": e.citation_key,
            "missing": [f for f, v in (("title", e.title), ("year", e.year), ("author", ";".join(e.authors))) if not v],
        }
        for e in entries
    ]
    missing_fields = [m for m in missing_fields if m["missing"]]

    cited = scan_tex_citations(project) if index.mode == "bib" else {"usage": {}, "cited_files": {}}
    known_keys = set(by_key)
    undefined = sorted(set(cited["usage"]) - known_keys)
    uncited = sorted(known_keys - set(cited["usage"]))
    return {
        "duplicate_keys": dup_keys,
        "fuzzy_duplicates": fuzzy,
        "missing_fields": missing_fields,
        "undefined_in_tex": undefined,
        "uncited_entries": uncited,
    }


# ---------------------------------------------------------------- 导出 ----

_CSL_TYPE_MAP = {
    "article": "article-journal",
    "inproceedings": "paper-conference",
    "conference": "paper-conference",
    "book": "book",
    "incollection": "chapter",
    "phdthesis": "thesis",
    "mastersthesis": "thesis",
    "techreport": "report",
    "misc": "document",
    "unpublished": "manuscript",
    "inbook": "chapter",
    "proceedings": "book",
}


def parse_name(name: str) -> dict:
    """BibTeX 姓名或普通姓名 → CSL-JSON 姓名对象。"""
    name = name.strip()
    if name.startswith("{") and name.endswith("}"):
        return {"literal": name.strip("{}")}
    if "," in name:
        family, _, given = name.partition(",")
        return {"family": family.strip(), "given": given.strip()}
    parts = name.split()
    if len(parts) == 1:
        return {"literal": name}
    return {"family": parts[-1], "given": " ".join(parts[:-1])}


def entry_to_csl_json(e: LibraryEntry) -> dict[str, Any]:
    t = e.entry_type.lower()
    csl_type = _CSL_TYPE_MAP.get(t, "document")
    out: dict[str, Any] = {"id": e.reference_id, "type": csl_type, "title": e.title}
    if e.authors:
        out["author"] = [parse_name(a) for a in e.authors]
    if e.year:
        out["issued"] = {"date-parts": [[int(e.year) if e.year.isdigit() else e.year]]}
    if csl_type == "article-journal" and e.venue:
        out["container-title"] = e.venue
    elif csl_type == "paper-conference" and e.venue:
        out["container-title"] = e.venue
    elif csl_type == "chapter" and e.venue:
        out["container-title"] = e.venue
    if e.volume:
        out["volume"] = e.volume
    if e.number:
        out["issue"] = e.number
    if e.pages:
        out["page"] = e.pages.replace("--", "-").replace("–", "-")
    if e.publisher:
        out["publisher"] = e.publisher
    if doi_of(e):
        out["DOI"] = doi_of(e)
    if e.url:
        out["URL"] = e.url
    if e.keywords:
        out["keywords"] = e.keywords
    out["citation-key"] = e.citation_key
    if e.entry_type == "phdthesis":
        out["genre"] = "PhD thesis"
    if e.fields.get("school"):
        out["publisher"] = e.fields.get("school")
    return out


def entries_to_bibtex(entries: list[LibraryEntry]) -> str:
    return "\n\n".join(e.raw_bibtex or format_bibtex(e) for e in entries) + ("\n" if entries else "")


# ---------------------------------------------------------------- 合并 / 改 key ----


def merge_entries(
    survivor: LibraryEntry,
    loser: LibraryEntry,
    field_choices: dict[str, str],
    new_key: str | None,
) -> LibraryEntry:
    """按用户逐字段选择合并（choices: 字段名 → "survivor"|"loser"）；不自动改 key（new_key 为 None 则保留）。"""
    merged = survivor.model_copy(deep=True)
    for fname, pick in (field_choices or {}).items():
        src = survivor if pick == "survivor" else loser
        val = _field_value(src, fname)
        _set_field(merged, fname, val, source=src.field_provenance.get(fname, FieldProvenance(source="user")).source)
    if new_key and new_key != merged.citation_key:
        if not KEY_RE.match(new_key):
            raise kind_error("validation", f"citation key 不合法：{new_key}", detail=new_key)
        merged.citation_key = new_key
    # 校验状态取两者"最强"：conflict > verified > unverified（合并不降低已知事实）
    rank = {"unverified": 0, "verified": 1, "conflict": 2}
    merged.verified = survivor.verified if rank[survivor.verified] >= rank[loser.verified] else loser.verified
    merged.updated_at = time.time()
    merged.raw_bibtex = format_bibtex(merged)
    return merged


def _field_value(e: LibraryEntry, fname: str) -> str:
    mapped = {
        "title": e.title, "year": e.year, "venue": e.venue, "volume": e.volume,
        "number": e.number, "pages": e.pages, "publisher": e.publisher,
        "doi": e.doi or "", "arxiv_id": e.arxiv_id or "", "url": e.url or "",
        "author": " and ".join(e.authors), "abstract": e.abstract or "", "keywords": e.keywords or "",
    }
    return str(mapped.get(fname, e.fields.get(fname, "")))


def _set_field(e: LibraryEntry, fname: str, val: str, source: str) -> None:
    """写单个字段：模型属性与 fields 字典同步（fields 是 format_bibtex 的唯一来源）。"""
    if fname == "author":
        e.authors = split_authors(val)
        e.fields["author"] = val
    elif fname == "venue":
        if e.entry_type in ("inproceedings", "conference", "proceedings"):
            e.fields.pop("journal", None)
            e.fields["booktitle"] = val
        else:
            e.fields.pop("booktitle", None)
            e.fields["journal"] = val
        e.venue = val or None
    elif fname == "arxiv_id":
        e.arxiv_id = val or None
        e.fields["eprint"] = val
    elif fname == "doi":
        e.doi = normalize_doi(val)
        e.fields["doi"] = val
    elif fname in _TOP_LEVEL_FIELDS:
        setattr(e, fname, val or None)
        e.fields[fname] = val
    else:
        e.fields[fname] = val
    e.field_provenance[fname] = FieldProvenance(source=source)
    e.updated_at = time.time()


def apply_cite_renames(project, updates: list[dict]) -> list[dict]:
    """两阶段：先全量校验（路径/base/内容一致性），全部通过才落盘——
    多文件改名的原子性：任一文件校验失败 ⇒ 整批 409、零写入（避免一半成功一半失败的混合态）。"""
    from app.domain.latex_build import list_source_files, read_source_file

    tex_set = {f["path"] for f in list_source_files(project) if f["path"].lower().endswith(".tex")}
    staged: list[tuple[str, str, dict[str, str], dict[str, int]]] = []
    for upd in updates:
        rel = str(upd.get("path", ""))
        renames = {k: v for k, v in (upd.get("renames") or {}).items() if k != v}
        if rel not in tex_set:
            raise kind_error("stale", f"不是工程内 .tex 文件：{rel}", detail=rel)
        cur = read_source_file(project, rel)
        _check_base(cur, upd.get("base"), rel)
        new_text, counts = _rename_keys_in_text(cur, renames)
        if counts:
            staged.append((rel, new_text, renames, counts))
    results = []
    for rel, new_text, _renames, counts in staged:
        sha = _write_bib(project, rel, new_text)  # .tex 在白名单内，同一原子写路径
        results.append({"path": rel, "ok": True, "replaced": sum(counts.values()), "sha": sha})
    # 未涉及/零替换的文件也如实回报（ok=True replaced=0）
    done = {r["path"] for r in results}
    for upd in updates:
        if str(upd.get("path", "")) not in done:
            results.append({"path": str(upd.get("path", "")), "ok": True, "replaced": 0})
    return results


def _apply_cite_renames_legacy_unused(project, updates: list[dict]) -> list[dict]:
    r"""正文 \cite 键改名（合并/去重后）：updates = [{path, base, renames: {old: new}}]。
    每文件先 base-sha 校验；只在引用命令花括号内做全词替换；返回每文件结果。"""
    from app.domain.latex_build import list_source_files, read_source_file

    tex_set = {f["path"] for f in list_source_files(project) if f["path"].lower().endswith(".tex")}
    results = []
    for upd in updates:
        rel = str(upd.get("path", ""))
        renames: dict[str, str] = {k: v for k, v in (upd.get("renames") or {}).items() if k != v}
        if rel not in tex_set:
            results.append({"path": rel, "ok": False, "error": "不是工程内 .tex 文件"})
            continue
        try:
            cur = read_source_file(project, rel)
        except Exception as e:  # noqa: BLE001
            results.append({"path": rel, "ok": False, "error": str(e)})
            continue
        _check_base(cur, upd.get("base"), rel)
        new_text, counts = _rename_keys_in_text(cur, renames)
        if not counts:
            results.append({"path": rel, "ok": True, "replaced": 0})
            continue
        sha = _write_bib(project, rel, new_text)  # 同一原子写路径（.tex 在白名单内）
        results.append({"path": rel, "ok": True, "replaced": sum(counts.values()), "sha": sha})
    return results


def _rename_keys_in_text(text: str, renames: dict[str, str]) -> tuple[str, dict[str, int]]:
    counts: dict[str, int] = {k: 0 for k in renames}

    def _sub_keys(match: re.Match) -> str:
        keys = match.group(1)
        prefix = match.group(0)[: match.start(1) - match.start(0)]  # 命令 + 可选参 + 开括号
        parts = keys.split(",")
        out_parts = []
        for k in parts:
            kk = k.strip()
            if kk in renames:
                counts[kk] += 1
                out_parts.append(renames[kk])
            else:
                out_parts.append(k)
        return prefix + ",".join(out_parts) + "}"

    new_text = CITE_CMD_RE.sub(_sub_keys, text)
    return new_text, {k: c for k, c in counts.items() if c}


# ---------------------------------------------------------------- 构建日志对账 ----


def undefined_citations_from_log(log_text: str) -> list[str]:
    """编译日志中的未定义引用：BibTeX `Warning--I didn't find a database entry` + LaTeX `Citation undefined`。"""
    keys: set[str] = set()
    for m in re.finditer(r"Warning--I didn't find a database entry for \"([^\"]+)\"", log_text):
        keys.add(m.group(1).strip().strip("\"'"))
    for m in re.finditer(r"Warning--I didn't find a database entry for ([^\s(]+)", log_text):
        keys.add(m.group(1).strip().strip("\"'"))
    for m in re.finditer(r"Citation `([^']+)' on page \d+ undefined", log_text):
        keys.add(m.group(1).strip())
    return sorted(k for k in keys if k)


# ---------------------------------------------------------------- 外部候选 → 条目 ----


def candidate_to_entry(cand: dict[str, Any]) -> LibraryEntry:
    """外部来源候选（library_sources 返回）→ 未落盘条目（字段 provenance 标来源，verified 按比对结果由路由定）。"""
    src = cand.get("source", "crossref")
    fields = cand.get("fields", {})
    prov = {k: FieldProvenance(source=src) for k in fields}
    e = LibraryEntry(
        reference_id=new_reference_id(),
        citation_key=cand.get("suggested_key") or "unnamed",
        entry_type=fields.get("entry_type", "article"),
        title=fields.get("title", ""),
        authors=fields.get("authors", []) or [],
        year=fields.get("year"),
        venue=fields.get("venue"),
        volume=fields.get("volume"),
        number=fields.get("number"),
        pages=fields.get("pages"),
        publisher=fields.get("publisher"),
        doi=normalize_doi(fields.get("doi")),
        arxiv_id=normalize_arxiv(fields.get("arxiv_id")),
        url=fields.get("url"),
        abstract=fields.get("abstract"),
        fields={k: v for k, v in _entry_fields_from_candidate(fields).items() if v not in (None, "")},
        raw_bibtex="",
        field_provenance=prov,
        verified="unverified",
    )
    e.queries = [SourceQuery(
        source=src, query=cand.get("query", ""), at=time.time(), matched=bool(cand.get("matched", True)))]
    if cand.get("retraction"):
        e.retraction = RetractionInfo(**cand["retraction"])
    return e


def _entry_fields_from_candidate(f: dict[str, Any]) -> dict[str, str]:
    out = {
        "title": f.get("title", ""), "year": f.get("year") or "",
        "journal" if (f.get("entry_type") or "article") in ("article",) else "booktitle": f.get("venue") or "",
        "volume": f.get("volume") or "", "number": f.get("number") or "", "pages": f.get("pages") or "",
        "publisher": f.get("publisher") or "", "doi": f.get("doi") or "", "eprint": f.get("arxiv_id") or "",
        "url": f.get("url") or "", "abstract": f.get("abstract") or "",
    }
    if f.get("authors"):
        out["author"] = " and ".join(f["authors"])
    return {k: str(v) for k, v in out.items() if v}


def suggested_key(entry: LibraryEntry) -> str:
    """建议 citation key：第一作者姓氏小写 + 年份 + 标题首词。冲突由调用方处理。"""
    surname = "anon"
    if entry.authors:
        first = entry.authors[0]
        base = first.split(",")[0]
        surname = re.sub(r"[^A-Za-z\u4e00-\u9fff]", "", base.split()[-1] if " " in base else base).lower() or "anon"
    year = entry.year or "nd"
    first_word = (entry.title or "").split()[:1]
    word = re.sub(r"[^A-Za-z\u4e00-\u9fff]", "", first_word[0] if first_word else "").lower() or "item"
    return f"{surname}{year}{word}"
