# -*- coding: utf-8 -*-
"""审稿回复信（P1-1 rebuttal）：<project>/.studio/rebuttal/state.json。

学术论文大修 / 小修（Major/Minor Revision）的逐条 checklist：
parse_review_comments 确定性拆条（多审稿人分组 + 启发式 category，不需 AI）→
逐条跟踪 status / location / response / edits_summary →
generate_draft 以 AI 起草「建议回复」写入 ai_draft（绝不覆盖用户 response，绝不改稿件文件）→
export_letter 按 docx / md / tex 导出 Response Letter。

全部读写走 atomic.studio_lock(project_dir, "rebuttal")；AI 调用在锁外进行（等待上游不持
项目写锁），回写前复核条目仍存在（防并发 replace 删条后写坏状态）。
拆条只认文字层 PDF（pypdf，无 OCR——扫描件如实报 NoTextLayer，不做假识别）。
"""

import io
import json
import os
import re
from datetime import UTC, datetime
from typing import TypedDict

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app import atomic
from app.ai import client as ai_client

FILE = os.path.join(".studio", "rebuttal", "state.json")
ROUNDS_DIR = os.path.join(".studio", "rebuttal", "rounds")

CATEGORIES = ("major", "minor", "editorial", "general")
STATUSES = ("todo", "drafted", "addressed")
_MODES = ("replace", "append")
FORMATS = ("docx", "md", "tex")
MAX_ITEMS = 500
MIN_TEXT_CHARS = 50
LOCATION_KEYS = ("file", "line", "section", "label")
# B3 锚点白名单：平台批注 id（reviews/comments.json，uuid12）/ Word 版本 vid / git 快照 sha
_COMMENT_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_VID_RE = re.compile(r"^v\d{6}-[0-9a-f]{12}$")
_SNAP_SHA_RE = re.compile(r"^[0-9a-f]{12,64}$")
_SNAP_TYPES = ("word-version", "latex-history")
_CLIP = {
    "reviewer": 80,
    "text": 20000,
    "response": 20000,
    "edits_summary": 4000,
    "file": 500,
    "section": 200,
    "label": 200,
    "context": 6000,
}
_CATEGORY_ZH = {"major": "重大", "minor": "次要", "editorial": "编辑性", "general": "一般"}
_DRAFT_SCHEMA = {"required": ["response", "edits_summary"]}


class RebuttalError(Exception):
    """rebuttal 业务错误（HTTP 语义 status + errors.ErrorKind kind）。"""

    def __init__(self, message, status=422, kind="validation"):
        super().__init__(message)
        self.status = status
        self.kind = kind


class NoTextLayer(Exception):
    """PDF 无文字层（扫描件）或有效字数太少——如实报错，不做假 OCR。"""


class RebuttalItem(TypedDict):
    id: str
    reviewer: str
    category: str
    text: str
    status: str
    location: dict | None
    response: str
    edits_summary: str
    ai_draft: dict | None
    updated_at: str | None
    round: int
    # B3 工程锚点（可选）：平台批注线程 id + 已保存版本快照
    comment_ids: list[str]
    snapshot: dict | None


# ---------------- 确定性拆条（不需 AI）----------------

_MD_PREFIX = re.compile(r"^\s*#{1,6}\s*")
_CN_DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}

# 审稿人分组标题（对去装饰后的行匹配）：Reviewer #1 / Reviewer 1 / Reviewer A / R1: /
# 审稿人1 / 审稿人一 / AE / Editor（容忍「Reviewer 1 – Dr. Smith」式尾注，尾注进正文）
_REVIEWER_RES: tuple[tuple[re.Pattern, str], ...] = (
    (re.compile(r"^reviewer\s*[#＃]?\s*(\d{1,2}|[A-Za-z])(?![A-Za-z0-9])", re.IGNORECASE), "en"),
    (re.compile(r"^r(\d{1,2})\s*[:：]", re.IGNORECASE), "r"),
    (re.compile(r"^审稿人\s*(\d{1,2}|[一二三四五六七八九十]{1,3})"), "cn"),
    (re.compile(r"^(AE|Editor)(?:\s*[:：]\s*(.*))?$", re.IGNORECASE), "ed"),
)

# 条目标题四档，按优先级每节取一档（与 oa/parse 同思路，避免正文列举误切）：
# A 显式关键词：Major Comment 1 / Minor Comment 2 / Comment 3 / Point 1 / Q1: / Question 2
# B 行首编号「1. 」（只认从 1 起递增的一串）；C「(1)/（1）」；D「一、/（一）」
_TIER_KEYWORD: tuple[re.Pattern, ...] = (
    re.compile(
        r"^(major|minor)\s+(?:comments?|points?|questions?|concerns?|remarks?)\s*[#＃]?(\d{1,2})\b",
        re.IGNORECASE,
    ),
    re.compile(r"^(?:comments?|points?|questions?|concerns?|remarks?)\s*[#＃]?(\d{1,2})\b", re.IGNORECASE),
    re.compile(r"^q(?:uestion)?\s*[#＃]?(\d{1,2})\b", re.IGNORECASE),
)
_TIER_NUM = re.compile(r"^(\d{1,2})\s*[.、．]\s+\S")
_TIER_PAREN = re.compile(r"^[（(](\d{1,2})[)）]\s*\S")
_TIER_CN = re.compile(r"^[（(]?([一二三四五六七八九十]{1,3})[）)、.．]\s*\S")

_EDITORIAL_KEYS = (
    "typo",
    "typographical",
    "spelling",
    "grammar",
    "formatting",
    "editorial",
    "proofread",
    "错别字",
    "笔误",
    "标点",
    "排版",
    "文字错误",
    "语病",
    "错字",
)


def _clean(line: str) -> str:
    """去掉行首 markdown 标题井号与加粗星号，供标题匹配。"""
    return _MD_PREFIX.sub("", line.replace("**", "")).strip()


def _cn_to_int(s: str) -> int:
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if s.startswith("十") and len(s) == 2:
        return 10 + _CN_DIGITS.get(s[1], 0)
    if s.endswith("十") and len(s) == 2:
        return _CN_DIGITS.get(s[0], 0) * 10
    if len(s) == 3 and s[1] == "十":
        return _CN_DIGITS.get(s[0], 0) * 10 + _CN_DIGITS.get(s[2], 0)
    return _CN_DIGITS.get(s, 0)


def _reviewer_match(line: str) -> tuple[str, str] | None:
    """→ (规范审稿人名, 行内尾注正文)。非分组标题返回 None。"""
    ln = _clean(line)
    if not ln:
        return None
    for pat, style in _REVIEWER_RES:
        m = pat.match(ln)
        if not m:
            continue
        if style == "ed":
            rest = (m.group(2) or "").strip()
            name = "AE" if m.group(1).upper() == "AE" else "Editor"
        else:
            rest = ln[m.end() :].strip().lstrip("：:－—-–#").strip()
            if style == "en":
                token = m.group(1)
                name = f"Reviewer {token.upper()}" if token.isalpha() else f"Reviewer {int(token)}"
            elif style == "r":
                name = f"Reviewer {int(m.group(1))}"
            else:
                name = f"审稿人{_cn_to_int(m.group(1))}"
        return name, rest
    return None


def _category_of(heading: str, body: str, reviewer: str) -> str:
    """启发式：标题 major/minor 直取；typo/格式等信号 editorial；其余（含 Editor/AE）general。"""
    h = heading.lower()
    if "major" in h:
        return "major"
    if "minor" in h:
        return "minor"
    probe = h + " " + body[:200].lower()
    if any(k in probe for k in _EDITORIAL_KEYS):
        return "editorial"
    if reviewer in ("AE", "Editor"):
        return "general"
    return "general"


def _sequential_hits(lines: list[str], pattern: re.Pattern) -> list[int]:
    """序号标题只认从 1 起递增的那一串（断号即停），避免正文列举被当条目（oa/parse 同律）。"""
    out: list[int] = []
    for i, ln in enumerate(lines):
        m = pattern.match(ln)
        if m and _cn_to_int(m.group(1)) == len(out) + 1:
            out.append(i)
    return out


def _item_starts_in(cleaned: list[str]) -> list[int]:
    """在一节（或全文）内按 A→B→C→D 优先级选一档条目起点。"""
    for pat in _TIER_KEYWORD:
        hits = [i for i, ln in enumerate(cleaned) if pat.match(ln)]
        if hits:
            return hits
    for pat in (_TIER_NUM, _TIER_PAREN, _TIER_CN):
        hits = _sequential_hits(cleaned, pat)
        if hits:
            return hits
    return []


def parse_review_comments(text: str) -> tuple[list[dict], list[str]]:
    """确定性拆条：→ (条目 [{reviewer, category, text}], warnings)。

    无任何审稿人分组与条目编号 ⇒ 整篇 1 条（reviewer=Reviewer 1）+ warning；
    首位审稿人之前的导语保留为 Editor 一般条目 + warning；
    审稿人段内无条目编号 ⇒ 整段 1 条 + warning。不丢弃任何内容。"""
    lines = [ln.rstrip() for ln in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    if not "\n".join(lines).strip():
        return [], ["文本为空"]

    warnings: list[str] = []
    cleaned = [_clean(ln) for ln in lines]
    rev_starts = [i for i, ln in enumerate(cleaned) if _reviewer_match(ln)]

    def _chunks(seg: list[str], seg_clean: list[str]) -> list[str]:
        starts = _item_starts_in(seg_clean)
        if starts:
            return ["\n".join(seg[a:b]).strip() for a, b in zip(starts, starts[1:] + [len(seg)])]
        whole = "\n".join(seg).strip()
        return [whole] if whole else []

    items: list[dict] = []
    if not rev_starts:
        chunks = _chunks(lines, cleaned)
        if len(chunks) <= 1 and not _item_starts_in(cleaned):
            warnings.append("未识别到审稿人分组或条目编号（Reviewer #/Comment N/1. 等），整篇作为一条导入")
        for chunk in chunks:
            head = chunk.split("\n", 1)[0]
            items.append({"reviewer": "Reviewer 1", "category": _category_of(head, chunk, "Reviewer 1"), "text": chunk})
        return items, warnings

    # 首位审稿人之前的导语：保留为 Editor 一般条目（不丢内容）
    preamble = "\n".join(lines[: rev_starts[0]]).strip()
    if preamble:
        items.append({"reviewer": "Editor", "category": "general", "text": preamble})
        warnings.append("首位审稿人之前的导语已保留为「Editor」一般条目")

    bounds = rev_starts + [len(lines)]
    for a, b in zip(rev_starts, bounds[1:]):
        name, rest = _reviewer_match(lines[a])
        seg = ([rest] if rest else []) + lines[a + 1 : b]
        seg_clean = [_clean(ln) for ln in seg]
        chunks = _chunks(seg, seg_clean)
        if not chunks:
            continue
        if len(chunks) == 1 and not _item_starts_in(seg_clean):
            warnings.append(f"「{name}」段内未识别到条目编号（Comment N/1. 等），整段作为一条")
        for chunk in chunks:
            head = chunk.split("\n", 1)[0]
            items.append({"reviewer": name, "category": _category_of(head, chunk, name), "text": chunk})
    return items, warnings


def pdf_text(data: bytes) -> str:
    """抽取全部页面文字层（pypdf）；无文字层 / 有效字数太少 ⇒ NoTextLayer（不 OCR）。"""
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [(p.extract_text() or "").strip() for p in reader.pages]
    except PdfReadError as e:
        raise NoTextLayer(f"PDF 无法读取：{e}") from e
    text = "\n\n".join(p for p in pages if p)
    if len(re.sub(r"\s", "", text)) < MIN_TEXT_CHARS:
        raise NoTextLayer("未检测到 PDF 文字层（扫描件暂不支持）")
    return text


# ---------------- 状态持久化 ----------------


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, key) -> str:
    return str(v or "")[: _CLIP[key]]


def _norm_location(loc) -> dict | None:
    if loc is None or loc == {}:
        return None
    if not isinstance(loc, dict):
        raise RebuttalError("location 必须是对象（file/line/section/label）")
    unknown = set(loc) - set(LOCATION_KEYS)
    if unknown:
        raise RebuttalError(f"location 不支持字段：{'/'.join(sorted(map(str, unknown)))}")
    line = loc.get("line")
    if line is not None:
        try:
            line = int(line)
        except (TypeError, ValueError):
            raise RebuttalError("location.line 需为正整数") from None
        if not 0 < line <= 10**6:
            raise RebuttalError("location.line 需为正整数")
    out = {
        "file": _clip(loc.get("file"), "file").strip() or None,
        "line": line,
        "section": _clip(loc.get("section"), "section").strip() or None,
        "label": _clip(loc.get("label"), "label").strip() or None,
    }
    return out if any(v is not None for v in out.values()) else None


def _norm_comment_ids(raw) -> list[str]:
    """平台批注 id 白名单校验（uuid12）；非法即 422，不静默丢弃。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RebuttalError("comment_ids 必须是数组")
    out: list[str] = []
    for cid in raw:
        cid = str(cid).strip()
        if not cid:
            continue
        if not _COMMENT_ID_RE.match(cid):
            raise RebuttalError(f"批注 id 不合法（应为 12 位十六进制）：{cid[:40]}")
        if cid not in out:
            out.append(cid)
    return out


def _norm_snapshot(raw) -> dict | None:
    """版本快照锚点：word-version 需 vid（v{6 位}-{12 位 sha}）；latex-history 需 12..64 位 sha。"""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise RebuttalError("snapshot 必须是对象")
    kind = str(raw.get("type") or "").strip()
    if kind not in _SNAP_TYPES:
        raise RebuttalError(f"snapshot.type 必须是 {'/'.join(_SNAP_TYPES)} 之一")
    sha = str(raw.get("sha") or "").strip()
    if not _SNAP_SHA_RE.match(sha):
        raise RebuttalError("snapshot.sha 不合法（12..64 位十六进制）")
    vid = str(raw.get("vid") or "").strip() or None
    if kind == "word-version":
        if not vid or not _VID_RE.match(vid):
            raise RebuttalError("Word 快照需要 vid（形如 v000012-abcdef123456）")
    else:
        vid = None
    file = str(raw.get("file") or "").strip() or None
    return {"type": kind, "sha": sha, "vid": vid, "file": file}


def _norm_item(it: dict) -> dict:
    cat = str(it.get("category") or "general")
    if cat not in CATEGORIES:
        raise RebuttalError(f"意见类别必须是 {'/'.join(CATEGORIES)} 之一")
    status = str(it.get("status") or "todo")
    if status not in STATUSES:
        raise RebuttalError(f"状态必须是 {'/'.join(STATUSES)} 之一")
    draft = it.get("ai_draft")
    if draft is not None:
        if not isinstance(draft, dict):
            raise RebuttalError("ai_draft 必须是对象")
        draft = {
            "response_draft": _clip(draft.get("response_draft"), "response"),
            "edits_summary_draft": _clip(draft.get("edits_summary_draft"), "edits_summary"),
            "created_at": str(draft.get("created_at") or ""),
        }
    return {
        "id": str(it.get("id") or "").strip(),
        "reviewer": _clip(it.get("reviewer"), "reviewer").strip() or "Reviewer 1",
        "category": cat,
        "text": _clip(it.get("text"), "text"),
        "status": status,
        "location": _norm_location(it.get("location")),
        "response": _clip(it.get("response"), "response"),
        "edits_summary": _clip(it.get("edits_summary"), "edits_summary"),
        "ai_draft": draft,
        "updated_at": it.get("updated_at"),
        "round": max(int(it.get("round") or 0), 0),
        "comment_ids": _norm_comment_ids(it.get("comment_ids")),
        "snapshot": _norm_snapshot(it.get("snapshot")),
    }


def _empty() -> dict:
    return {"updated_at": None, "round": 0, "items": [], "warnings": []}


def _parse_state(data) -> dict:
    st = _empty()
    if isinstance(data, dict):
        st["updated_at"] = data.get("updated_at")
        try:
            st["round"] = max(int(data.get("round") or 0), 0)
        except (TypeError, ValueError):
            raise RebuttalError("状态文件 round 字段损坏") from None
        raw = data.get("items")
        if raw is not None and not isinstance(raw, list):
            raise RebuttalError("状态文件 items 字段损坏")
        st["items"] = [_norm_item(it) for it in (raw or [])[:MAX_ITEMS]]
        st["warnings"] = [str(w) for w in (data.get("warnings") or [])]
    return st


def _path(project_dir: str) -> str:
    return os.path.join(project_dir, FILE)


def load_state(project_dir: str) -> dict:
    """→ {updated_at, round, items[], warnings[]}；无文件返回空记录；腐坏 ⇒ 422。"""
    p = _path(project_dir)
    if not os.path.isfile(p):
        return _empty()
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise RebuttalError(f"回复信状态文件损坏：{FILE}", status=422) from e
    return _parse_state(data)


def _write(project_dir: str, st: dict) -> None:
    os.makedirs(os.path.join(project_dir, ".studio", "rebuttal"), exist_ok=True)
    atomic.write_text(_path(project_dir), json.dumps(st, ensure_ascii=False, indent=2) + "\n")


def _find(st: dict, item_id: str) -> dict:
    it = next((x for x in st["items"] if x["id"] == item_id), None)
    if it is None:
        raise RebuttalError(f"条目 {item_id} 不存在（可能已被重新导入清除）", status=404, kind="not_found")
    return it


def _next_seq(items: list[dict]) -> int:
    ns = [int(m.group(1)) for it in items if (m := re.fullmatch(r"rb-(\d+)", it.get("id") or ""))]
    return (max(ns) if ns else 0) + 1


def _archive_round(project_dir: str, n: int, st: dict) -> None:
    """当前轮条目原样归档为 rounds/round-{n}.json（锁内纯同步；n 取 max(old,1)，绝不写 round-0）。"""
    n = max(int(n or 0), 1)
    path = os.path.join(project_dir, ROUNDS_DIR, f"round-{n}.json")
    atomic.write_json(path, {
        "round": n,
        "archived_at": _now(),
        "updated_at": st.get("updated_at"),
        "items": [dict(it) for it in st.get("items") or []],
    })


def list_rounds(project_dir: str) -> dict:
    """历史轮只读清单（轮号升序；round-N 命名之外的文件忽略）。"""
    directory = os.path.join(project_dir, ROUNDS_DIR)
    out: list[dict] = []
    if os.path.isdir(directory):
        for fn in os.listdir(directory):
            m = re.fullmatch(r"round-(\d+)\.json", fn)
            if not m:
                continue
            try:
                with open(os.path.join(directory, fn), encoding="utf-8") as f:
                    data = json.load(f)
                out.append({"round": int(m.group(1)), "items": len(data.get("items") or []),
                            "archived_at": data.get("archived_at")})
            except (OSError, ValueError):
                continue  # 损坏归档不挡列表
    out.sort(key=lambda r: r["round"])
    return {"rounds": out}


def load_round(project_dir: str, n: int) -> dict:
    """单轮归档只读详情；不存在 ⇒ 404。历史轮严格只读，不提供 restore。"""
    n = max(int(n or 0), 1)
    path = os.path.join(project_dir, ROUNDS_DIR, f"round-{n}.json")
    if not os.path.isfile(path):
        raise RebuttalError(f"第 {n} 轮归档不存在", status=404, kind="not_found")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise RebuttalError(f"第 {n} 轮归档损坏", status=422, kind="corrupt") from e
    return {"round": int(n), "archived_at": data.get("archived_at"),
            "items": [_norm_item(it) for it in (data.get("items") or [])[:MAX_ITEMS]]}


def import_comments(project_dir: str, parsed: list[dict], warnings: list[str], mode: str = "replace") -> dict:
    """拆条结果落盘。replace：先归档旧轮（rounds/round-{max(old,1)}.json）再 round+1 整表替换
    （id 从 rb-1 重新编号）；append：按当前 round 追加保留旧条目，id rb-N 全局递增。
    → 同 load_state。"""
    if mode not in _MODES:
        raise RebuttalError(f"导入模式必须是 {'/'.join(_MODES)} 之一")
    if not parsed:
        raise RebuttalError("未能从文本中识别出任何审稿意见条目")
    with atomic.studio_lock(project_dir, "rebuttal"):
        st = load_state(project_dir)
        if mode == "replace":
            old_round = int(st.get("round") or 0)
            if st["items"]:
                _archive_round(project_dir, old_round, st)  # 归档失败则整体不落盘
            st["round"] = old_round + 1
            st["items"] = []
        else:
            st["round"] = max(int(st.get("round") or 0), 1)
        nxt = _next_seq(st["items"])
        fresh = [
            _norm_item(
                {
                    "id": f"rb-{nxt + k}",
                    "reviewer": p["reviewer"],
                    "category": p["category"],
                    "text": p["text"],
                    "status": "todo",
                    "round": st["round"],
                }
            )
            for k, p in enumerate(parsed)
        ]
        st["items"] = (st["items"] + fresh)[:MAX_ITEMS]
        st["warnings"] = [str(w) for w in warnings]
        st["updated_at"] = _now()
        _write(project_dir, st)
    return st


def update_item(project_dir: str, item_id: str, patch: dict) -> dict:
    """局部更新条目（patch 只含调用方给出的键；location=None 表示清除）。
    → 更新后的条目；条目不存在 ⇒ 404。"""
    with atomic.studio_lock(project_dir, "rebuttal"):
        st = load_state(project_dir)
        it = _find(st, item_id)
        if "status" in patch:
            status = str(patch.get("status") or "")
            if status not in STATUSES:
                raise RebuttalError(f"状态必须是 {'/'.join(STATUSES)} 之一")
            it["status"] = status
        if "location" in patch:
            it["location"] = _norm_location(patch.get("location"))
        if "response" in patch:
            it["response"] = _clip(patch.get("response"), "response")
        if "edits_summary" in patch:
            it["edits_summary"] = _clip(patch.get("edits_summary"), "edits_summary")
        if "comment_ids" in patch:
            it["comment_ids"] = _norm_comment_ids(patch.get("comment_ids"))
        if "snapshot" in patch:
            it["snapshot"] = _norm_snapshot(patch.get("snapshot"))
        it["updated_at"] = _now()
        st["updated_at"] = _now()
        _write(project_dir, st)
    return it


def append_single_item(
    project_dir: str,
    *,
    reviewer: str,
    category: str,
    text: str,
    location: dict | None = None,
    comment_ids: list[str] | None = None,
) -> dict:
    """将单条审稿意见/平台批注追加为当前轮 rebuttal 条目并返回新条目。"""
    clean_text = (text or "").strip()
    if not clean_text:
        raise RebuttalError("意见内容不能为空")
    safe_cids = [str(cid).strip() for cid in (comment_ids or []) if _COMMENT_ID_RE.match(str(cid).strip())]
    with atomic.studio_lock(project_dir, "rebuttal"):
        st = load_state(project_dir)
        if len(st["items"]) >= MAX_ITEMS:
            raise RebuttalError(f"当前轮审稿意见已达上限（{MAX_ITEMS} 条），请先开启新一轮", status=409, kind="conflict")
        st["round"] = max(int(st.get("round") or 0), 1)
        nxt = _next_seq(st["items"])
        item = _norm_item(
            {
                "id": f"rb-{nxt}",
                "reviewer": reviewer or "外部审阅",
                "category": category if category in CATEGORIES else "major",
                "text": clean_text,
                "status": "todo",
                "location": location,
                "round": st["round"],
                "comment_ids": safe_cids,
            }
        )
        st["items"] = [*st["items"], item]
        st["updated_at"] = _now()
        _write(project_dir, st)
    return item


# ---------------- AI 起草（建议，不覆盖用户回复）----------------

_DRAFT_RULES = (
    "你是学术论文审稿回复信（Response Letter）写作助手，为作者起草一条礼貌、专业、具体可核查的学术回复："
    "先简短致谢并复述审稿人关注点，再逐点回应（采纳合理建议并说明已做的修改；必要时礼貌澄清分歧并给出依据）。"
    "语气尊重而不卑不亢；不要夸大、不要编造未发生的修改；使用与审稿意见相同的语言（中文意见中文回复，英文意见英文回复）。"
    "输出约束（违反即无效）：只输出一个 JSON 对象："
    '{"response": "回复正文（可含换行）", "edits_summary": "对应修改摘要，无修改则为空字符串"}；'
    "不要 Markdown 围栏，不要解释。"
)


def _draft_messages(title: str, snap: dict, context: str | None) -> list[dict]:
    loc = snap.get("location") or {}
    loc_bits = "；".join(f"{k}={loc[k]}" for k in LOCATION_KEYS if loc.get(k) is not None)
    user = (
        f"稿件标题：{title or '（未命名）'}\n"
        f"审稿人：{snap['reviewer']}\n"
        f"意见类别：{_CATEGORY_ZH.get(snap['category'], snap['category'])}\n\n"
        f"审稿意见原文：\n{snap['text']}"
    )
    if loc_bits:
        user += f"\n\n作者标注的修改位置：{loc_bits}"
    if context and context.strip():
        user += f"\n\n作者补充的上下文 / 已做修改说明：\n{context.strip()[: _CLIP['context']]}"
    user += "\n\n请起草这条意见的作者回复。"
    # system 首行 [patent-studio:<kind>] 供 mock 供应商与用量记录识别场景（kind 不入 prompts.KINDS）
    return [
        {"role": "system", "content": "[patent-studio:rebuttal_draft]\n" + _DRAFT_RULES},
        {"role": "user", "content": user},
    ]


def _parse_draft_response(raw_text: str) -> tuple[str, str, list[str]]:
    warnings: list[str] = []
    try:
        data = ai_client.parse_json(raw_text, _DRAFT_SCHEMA)
        resp = str(data.get("response") or "").strip()
        summ = str(data.get("edits_summary") or "").strip()
        if not resp:
            raise ValueError("response 为空")
    except ValueError as e:
        resp = (raw_text or "").strip()
        summ = ""
        warnings.append(f"AI 输出未按约定 JSON 返回（{e}），已将原文保存为草稿建议")
    return resp, summ, warnings


def prepare_draft_context_with_round(
    store, pid: str, item_id: str, context: str | None = None
) -> tuple[str, list[dict], int]:
    project = store.get(pid)
    d = project.dir
    with atomic.studio_lock(d, "rebuttal"):
        st = load_state(d)
        it = _find(st, item_id)
        expected_round = int(st.get("round") or 0)
        snap = {
            "reviewer": it["reviewer"],
            "category": it["category"],
            "text": it["text"],
            "location": it.get("location"),
        }
    return d, _draft_messages(project.title, snap, context), expected_round


def prepare_draft_context(store, pid: str, item_id: str, context: str | None = None) -> tuple[str, list[dict]]:
    d, messages, _round = prepare_draft_context_with_round(store, pid, item_id, context)
    return d, messages


def save_draft_result(
    d: str, item_id: str, resp: str, summ: str, *, expected_round: int | None = None
) -> dict:
    clean_resp = _clip(resp, "response").strip()
    if not clean_resp:
        raise RebuttalError("AI 未返回有效的回复正文", status=502, kind="ai")
    clean_summ = _clip(summ, "edits_summary").strip()
    with atomic.studio_lock(d, "rebuttal"):
        st = load_state(d)
        if expected_round is not None and int(st.get("round") or 0) != expected_round:
            raise RebuttalError("审稿意见轮次已切换，请重新生成草稿", status=409, kind="conflict")
        it = _find(st, item_id)
        it["ai_draft"] = {"response_draft": clean_resp, "edits_summary_draft": clean_summ, "created_at": _now()}
        it["updated_at"] = _now()
        st["updated_at"] = _now()
        _write(d, st)
    return it


async def generate_draft(store, pid: str, ai, item_id: str, context: str | None = None) -> tuple[dict, list[str]]:
    """AI 起草单条回复建议 → (条目, warnings)。

    锁内读条目快照 → 锁外 await ai.chat（等待上游不持项目写锁）→ 重新加锁复核条目与轮次一致
    （并发 replace 可能已删条或切轮 ⇒ 409）→ 写 ai_draft。
    只写 ai_draft——用户手写的 response / edits_summary 一律不动，稿件文件零接触。
    AiError → RebuttalError(kind="ai_<kind>", status=e.status)，路由层统一翻译。"""
    d, messages, expected_round = prepare_draft_context_with_round(store, pid, item_id, context)
    try:
        r = await ai.chat(messages, "interactive", project_dir=d)
        resp, summ, warnings = _parse_draft_response(r.text)
    except ai_client.AiError as e:
        raise RebuttalError(str(e), status=e.status, kind=f"ai_{e.kind}") from e
    it = save_draft_result(d, item_id, resp, summ, expected_round=expected_round)
    return it, warnings


# ---------------- 导出 Response Letter ----------------


def _location_desc(it: dict) -> str:
    loc = it.get("location") or {}
    bits = []
    if loc.get("file"):
        bits.append(str(loc["file"]) + (f" 第 {loc['line']} 行" if loc.get("line") else ""))
    if loc.get("section"):
        bits.append(f"章节「{loc['section']}」")
    if loc.get("label"):
        bits.append(f"标记 {loc['label']}")
    return "；".join(bits)


def _anchor_desc(it: dict) -> str:
    """工程锚点摘要行（导出用）：关联批注数 + 版本快照标识；无锚点返回空串。"""
    bits = []
    ids = it.get("comment_ids") or []
    if ids:
        bits.append(f"关联批注 {len(ids)} 条（{', '.join('#' + c for c in ids[:3])}{'…' if len(ids) > 3 else ''}）")
    snap = it.get("snapshot")
    if snap:
        ident = snap.get("vid") or str(snap.get("sha") or "")[:12]
        bits.append(f"快照 {snap['type']} {ident}")
    return "；".join(bits)


def _group_by_reviewer(items: list[dict]) -> list[tuple[str, list[dict]]]:
    """保持出现顺序，按审稿人聚合条目（同名审稿人不相邻也归并到首次出现的组）。"""
    out: list[tuple[str, list[dict]]] = []
    idx: dict[str, int] = {}
    for it in items:
        r = it.get("reviewer") or "Reviewer 1"
        if r not in idx:
            idx[r] = len(out)
            out.append((r, []))
        out[idx[r]][1].append(it)
    return out


def _has_exportable(items: list[dict]) -> bool:
    return bool(
        items
        and any((it.get("response") or "").strip() or (it.get("edits_summary") or "").strip() for it in items)
    )


def _export_docx(project: dict, items: list[dict], round_no: int = 1) -> bytes:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt

    font_name = "宋体"

    def _font(run, size: float, bold: bool = False, italic: bool = False):
        run.font.name = font_name
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.italic = italic
        run._element.rPr.rFonts.set(qn("w:eastAsia"), font_name)

    def _para(doc, text: str, size: float = 12, bold: bool = False, italic: bool = False, align=None):
        p = doc.add_paragraph()
        if align is not None:
            p.alignment = align
        _font(p.add_run(text), size, bold, italic)
        return p

    def _cell(cell, text: str, size: float = 10.5):
        cell.text = ""
        lines = text.split("\n") if text else [""]
        _font(cell.paragraphs[0].add_run(lines[0]), size, italic=True)
        for ln in lines[1:]:
            _font(cell.add_paragraph().add_run(ln), size, italic=True)

    def _borders(table):
        tbl_pr = table._tbl.tblPr
        borders = OxmlElement("w:tblBorders")
        for edge in ("top", "left", "bottom", "right"):
            el = OxmlElement(f"w:{edge}")
            el.set(qn("w:val"), "single")
            el.set(qn("w:sz"), "4")
            el.set(qn("w:color"), "808080")
            borders.append(el)
        tbl_pr.append(borders)

    doc = Document()
    doc.styles["Normal"].font.name = font_name
    doc.styles["Normal"].element.rPr.rFonts.set(qn("w:eastAsia"), font_name)

    _para(doc, "Response to Reviewers", 22, True, align=WD_ALIGN_PARAGRAPH.CENTER)
    _para(doc, f"Round {round_no}", 13, True, align=WD_ALIGN_PARAGRAPH.CENTER)
    _para(doc, f"Manuscript: {project.get('title') or '（未命名）'}", 12)
    _para(doc, f"Date: {datetime.now(UTC).strftime('%Y-%m-%d')}", 12)
    _para(
        doc,
        "We sincerely thank the editor and all reviewers for their careful reading and constructive "
        "comments. We have addressed each point below; the reviewers' comments are quoted in italics, "
        "followed by our response.",
        12,
    )
    _para(doc, "", 12)

    for reviewer, its in _group_by_reviewer(items):
        _para(doc, reviewer, 14, True)
        for k, it in enumerate(its, 1):
            _para(doc, f"Comment {k}（{_CATEGORY_ZH.get(it['category'], it['category'])}）", 12, True)
            table = doc.add_table(rows=1, cols=1)
            _borders(table)
            _cell(table.rows[0].cells[0], it["text"])
            _para(doc, "", 8)
            _para(doc, "Response:", 12, True)
            _para(doc, (it.get("response") or "").strip() or "（尚未回复）", 12)
            if (it.get("edits_summary") or "").strip():
                _para(doc, "Changes: " + it["edits_summary"].strip(), 12)
            loc = _location_desc(it)
            if loc:
                _para(doc, f"Location: {loc}", 12)
            anc = _anchor_desc(it)
            if anc:
                _para(doc, f"Refs: {anc}", 12)
            _para(doc, "", 10)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


_TEX_ESCAPES = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}
_TEX_RE = re.compile("|".join(re.escape(k) for k in _TEX_ESCAPES))


def _tex_escape(text: str) -> str:
    # 单遍正则替换，避免 \textbackslash{} 里的 {} 被后续规则二次转义成 \{\}
    norm = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    escaped = _TEX_RE.sub(lambda m: _TEX_ESCAPES[m.group(0)], norm)
    paras = re.split(r"\n{2,}", escaped)
    return "\n\n".join(p.replace("\n", r"\\\relax ") for p in paras)


def _export_tex(project: dict, items: list[dict], round_no: int = 1) -> str:
    out = [
        "% Response Letter — 由研稿 rebuttal 工具生成；仅用 LaTeX 通用环境（quote/itemize），无需额外宏包",
        "\\section*{Response to Reviewers}",
        "",
        f"\\noindent\\textbf{{Round {round_no}}}",
        "",
        "\\noindent\\textbf{Manuscript:} " + _tex_escape(project.get("title") or "（未命名）"),
        "",
        "\\noindent\\textbf{Date:} " + datetime.now(UTC).strftime("%Y-%m-%d"),
        "",
        "\\noindent We sincerely thank the editor and all reviewers for their careful reading and "
        "constructive comments. We have addressed each point below.",
        "",
    ]
    for reviewer, its in _group_by_reviewer(items):
        out.append("\\subsection*{" + _tex_escape(reviewer) + "}")
        out.append("")
        out.append("\\begin{itemize}")
        for k, it in enumerate(its, 1):
            cat = _CATEGORY_ZH.get(it["category"], it["category"])
            out.append("  \\item \\textbf{Comment %d（%s）.}" % (k, _tex_escape(cat)))
            out.append("  \\begin{quote}\\itshape")
            out.append("    " + _tex_escape(it["text"]))
            out.append("  \\end{quote}")
            resp = _tex_escape((it.get("response") or "").strip() or "（尚未回复）")
            out.append("  \\textbf{Response:} " + resp)
            if (it.get("edits_summary") or "").strip():
                out.append("  \\textbf{Changes:} " + _tex_escape(it["edits_summary"].strip()))
            loc = _location_desc(it)
            if loc:
                out.append("  \\textit{Location: " + _tex_escape(loc) + "}")
            anc = _anchor_desc(it)
            if anc:
                out.append("  \\textit{Refs: " + _tex_escape(anc) + "}")
        out.append("\\end{itemize}")
        out.append("")
    return "\n".join(out)


def _export_md(project: dict, items: list[dict], round_no: int = 1) -> str:
    out = [
        "# Response to Reviewers",
        "",
        f"**Round {round_no}**",
        "",
        f"**Manuscript:** {project.get('title') or '（未命名）'}",
        "",
        f"**Date:** {datetime.now(UTC).strftime('%Y-%m-%d')}",
        "",
        "We sincerely thank the editor and all reviewers for their careful reading and constructive "
        "comments. We have addressed each point below.",
        "",
    ]
    for reviewer, its in _group_by_reviewer(items):
        out.append(f"## {reviewer}")
        out.append("")
        for k, it in enumerate(its, 1):
            cat = _CATEGORY_ZH.get(it["category"], it["category"])
            out.append(f"### Comment {k}（{cat}）")
            out.append("")
            out.append("> " + it["text"].replace("\n", "\n> "))
            out.append("")
            out.append("**Response:**")
            out.append("")
            out.append((it.get("response") or "").strip() or "（尚未回复）")
            out.append("")
            if (it.get("edits_summary") or "").strip():
                out.append(f"**Changes:** {it['edits_summary'].strip()}")
                out.append("")
            loc = _location_desc(it)
            if loc:
                out.append(f"*Location: {loc}*")
            anc = _anchor_desc(it)
            if anc:
                out.append(f"*Refs: {anc}*")
                out.append("")
    return "\n".join(out)


def export_letter(project: dict, state: dict, fmt: str) -> bytes:
    """导出 Response Letter 字节流。条目为空，或所有条目既无回复也无修改说明 ⇒ 409。"""
    if fmt not in FORMATS:
        raise RebuttalError(f"导出格式必须是 {'/'.join(FORMATS)} 之一")
    items = state.get("items") or []
    if not items:
        raise RebuttalError("暂无审稿意见条目，请先导入审稿意见", status=409, kind="conflict")
    if not _has_exportable(items):
        raise RebuttalError("尚无任何作者回复或修改说明可导出，请先逐条填写回复", status=409, kind="conflict")
    round_no = max(int(state.get("round") or 0), 1)
    if fmt == "docx":
        return _export_docx(project, items, round_no)
    if fmt == "tex":
        return _export_tex(project, items, round_no).encode("utf-8")
    return _export_md(project, items, round_no).encode("utf-8")
