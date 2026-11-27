# -*- coding: utf-8 -*-
"""项目术语表与符号表（Glossary & Notation）：<project>/.studio/glossary.json。

用于多章长论文与多人协作中的术语、符号与缩略语统一：
- 确定性 CRUD + LaTeX 源码候选提取（不自动覆写已确认条目）；
- 与 latex_preflight 联动检查已启用条目（enforce=True）的弃用别名；
- 与 paper_proposals 联动注入上下文约定（仅用户显式勾选时携带）。
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Literal

from app import atomic
from app.errors import kind_error

FILE = os.path.join(".studio", "glossary.json")
Category = Literal["term", "notation", "acronym"]
_CATEGORIES = ("term", "notation", "acronym")

_NEWACRONYM_RE = re.compile(r"\\newacronym\s*\{[^}]*\}\s*\{([A-Za-z0-9_-]{2,20})\}\s*\{([^}]{2,160})\}")
_ACRO_RE = re.compile(r"\\acro\s*\{([A-Za-z0-9_-]{2,20})\}\s*(?:\[[^\]]*\]\s*)?\{([^}]{2,160})\}")
_PAREN_ACRO_RE = re.compile(r"([A-Za-z][A-Za-z0-9 \-]{3,80}|[\u4e00-\u9fff]{2,24})\s*\(([A-Z]{2,8})\)")
_CMD_HEAD_RE = re.compile(r"\\(?:newcommand|renewcommand)\s*\*?\s*\{\s*(\\[A-Za-z@]+)\s*\}(?:\[\d+\])*\s*")


def _term_key(term: str, cat: str) -> str:
    return term if (cat == "notation" or term.startswith("\\")) else term.lower()


def _extract_braced(text: str, start: int, max_len: int = 160) -> str | None:
    n = len(text)
    i = start
    while i < n and text[i].isspace():
        i += 1
    if i >= n or text[i] != "{":
        return None
    depth = 0
    buf: list[str] = []
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            if depth >= 1:
                buf.append(text[i : i + 2])
            i += 2
            continue
        if ch == "{":
            depth += 1
            if depth > 1:
                buf.append(ch)
        elif ch == "}":
            depth -= 1
            if depth == 0:
                val = "".join(buf).strip()
                return val[:max_len] if val else None
            buf.append(ch)
        elif depth >= 1:
            buf.append(ch)
        if len(buf) > max_len * 2:
            break
        i += 1
    return None


def _path(project_dir: str) -> str:
    return os.path.join(project_dir, FILE)


def _read_raw(project_dir: str) -> list[dict]:
    p = _path(project_dir)
    if not os.path.isfile(p):
        return []
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    entries = data.get("entries") if isinstance(data, dict) else data
    return [dict(x) for x in entries if isinstance(x, dict)] if isinstance(entries, list) else []


def _write_raw(project_dir: str, entries: list[dict]) -> None:
    p = _path(project_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    atomic.write_json(p, {"schema_version": 1, "entries": entries})


def _norm_aliases(raw) -> list[str]:
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        val = str(item or "").strip()[:120]
        if not val or val.lower() in seen:
            continue
        seen.add(val.lower())
        out.append(val)
        if len(out) >= 20:
            break
    return out


def list_entries(project_dir: str) -> list[dict]:
    with atomic.studio_lock(project_dir, "glossary"):
        return _read_raw(project_dir)


def upsert_entry(project_dir: str, payload: dict) -> tuple[dict, list[dict]]:
    term = str(payload.get("term") or "").strip()[:120]
    if not term:
        raise kind_error("validation", "术语或符号名称不能为空", detail="term")
    cat = str(payload.get("category") or "term").strip()
    if cat not in _CATEGORIES:
        raise kind_error("validation", f"类别必须是 {'/'.join(_CATEGORIES)} 之一", detail=cat)
    aliases = _norm_aliases(payload.get("aliases"))
    symbol = str(payload.get("symbol") or "").strip()[:120]
    definition = str(payload.get("definition") or "").strip()[:1000]
    enforce = bool(payload.get("enforce", True))
    gid = str(payload.get("id") or "").strip()

    with atomic.studio_lock(project_dir, "glossary"):
        entries = _read_raw(project_dir)
        hit = None
        if gid:
            hit = next((e for e in entries if e.get("id") == gid), None)
        t_key = _term_key(term, cat)
        if hit is None:
            hit = next(
                (
                    e
                    for e in entries
                    if e.get("category") == cat and _term_key(str(e.get("term") or ""), cat) == t_key
                ),
                None,
            )
        now = time.time()
        filtered_aliases = [a for a in aliases if _term_key(a, cat) != t_key]
        if hit is not None:
            hit.update(
                term=term,
                category=cat,
                aliases=filtered_aliases,
                symbol=symbol,
                definition=definition,
                enforce=enforce,
                updated_at=now,
            )
            saved = dict(hit)
        else:
            saved = {
                "id": gid or f"gl_{uuid.uuid4().hex[:10]}",
                "term": term,
                "category": cat,
                "aliases": filtered_aliases,
                "symbol": symbol,
                "definition": definition,
                "enforce": enforce,
                "updated_at": now,
            }
            entries.append(saved)
        _write_raw(project_dir, entries)
        return saved, entries


def update_entry(project_dir: str, gid: str, patch: dict) -> tuple[dict, list[dict]]:
    with atomic.studio_lock(project_dir, "glossary"):
        entries = _read_raw(project_dir)
        hit = next((e for e in entries if e.get("id") == gid), None)
        if hit is None:
            raise kind_error("not_found", "术语条目不存在", detail=gid)
        if "term" in patch and patch["term"] is not None:
            t = str(patch["term"]).strip()[:120]
            if not t:
                raise kind_error("validation", "术语名称不能为空", detail="term")
            hit["term"] = t
        if "category" in patch and patch["category"] is not None:
            c = str(patch["category"]).strip()
            if c not in _CATEGORIES:
                raise kind_error("validation", f"类别必须是 {'/'.join(_CATEGORIES)} 之一", detail=c)
            hit["category"] = c
        t_cur = str(hit.get("term") or "")
        cat_cur = str(hit.get("category") or "term")
        t_cur_key = _term_key(t_cur, cat_cur)
        src_aliases = _norm_aliases(patch["aliases"]) if ("aliases" in patch and patch["aliases"] is not None) else list(hit.get("aliases") or [])
        hit["aliases"] = [a for a in src_aliases if _term_key(a, cat_cur) != t_cur_key]
        if "symbol" in patch and patch["symbol"] is not None:
            hit["symbol"] = str(patch["symbol"]).strip()[:120]
        if "definition" in patch and patch["definition"] is not None:
            hit["definition"] = str(patch["definition"]).strip()[:1000]
        if "enforce" in patch and patch["enforce"] is not None:
            hit["enforce"] = bool(patch["enforce"])
        hit["updated_at"] = time.time()
        _write_raw(project_dir, entries)
        return dict(hit), entries


def delete_entry(project_dir: str, gid: str) -> tuple[bool, list[dict]]:
    with atomic.studio_lock(project_dir, "glossary"):
        entries = _read_raw(project_dir)
        kept = [e for e in entries if e.get("id") != gid]
        removed = len(kept) != len(entries)
        if removed:
            _write_raw(project_dir, kept)
        return removed, kept


def extract_from_project(project, *, commit: bool = False) -> dict:
    """从 LaTeX 源码扫描缩略语、括号定义与自定义数学宏，产出候选条目。"""
    from app.domain import latex_build, latex_submission

    existing = list_entries(project.dir)
    existing_keys = {_term_key(str(e.get("term") or ""), str(e.get("category") or "term")) for e in existing}

    candidates: list[dict] = []
    seen: set[tuple[str, str]] = set()
    if project.settings.get("source_format") == "latex":
        for item in latex_build.list_source_files(project):
            rel = item["path"]
            if not item.get("editable") or not rel.lower().endswith(".tex"):
                continue
            try:
                raw = latex_build.read_source_file(project, rel)
            except Exception:  # noqa: BLE001
                continue
            clean = latex_submission.strip_tex_comments(raw)
            for pat in (_NEWACRONYM_RE, _ACRO_RE):
                for m in pat.finditer(clean):
                    term, defn = m.group(1).strip(), m.group(2).strip()
                    k = ("acronym", _term_key(term, "acronym"))
                    if k not in seen:
                        seen.add(k)
                        candidates.append({
                            "term": term,
                            "category": "acronym",
                            "symbol": term,
                            "definition": defn,
                            "aliases": [],
                            "source_file": rel,
                            "exists": _term_key(term, "acronym") in existing_keys,
                        })
            for m in _PAREN_ACRO_RE.finditer(clean):
                defn, term = m.group(1).strip(), m.group(2).strip()
                k = ("acronym", _term_key(term, "acronym"))
                if k not in seen and len(defn) >= 3:
                    seen.add(k)
                    candidates.append({
                        "term": term,
                        "category": "acronym",
                        "symbol": term,
                        "definition": defn,
                        "aliases": [],
                        "source_file": rel,
                        "exists": _term_key(term, "acronym") in existing_keys,
                    })
            for m in _CMD_HEAD_RE.finditer(clean):
                cmd = m.group(1).strip()
                body = _extract_braced(clean, m.end())
                if not body:
                    continue
                k = ("notation", _term_key(cmd, "notation"))
                if k not in seen:
                    seen.add(k)
                    candidates.append({
                        "term": cmd,
                        "category": "notation",
                        "symbol": cmd,
                        "definition": body,
                        "aliases": [],
                        "source_file": rel,
                        "exists": _term_key(cmd, "notation") in existing_keys,
                    })

    added = 0
    if commit:
        with atomic.studio_lock(project.dir, "glossary"):
            cur = _read_raw(project.dir)
            cur_keys = {_term_key(str(e.get("term") or ""), str(e.get("category") or "term")) for e in cur}
            now = time.time()
            for cand in candidates:
                ck = _term_key(cand["term"], cand["category"])
                if ck in cur_keys:
                    cand["exists"] = True
                    continue
                cur.append({
                    "id": f"gl_{uuid.uuid4().hex[:10]}",
                    "term": cand["term"][:120],
                    "category": cand["category"],
                    "aliases": [],
                    "symbol": str(cand.get("symbol") or "")[:120],
                    "definition": str(cand.get("definition") or "")[:1000],
                    "enforce": True,
                    "updated_at": now,
                })
                cur_keys.add(ck)
                cand["exists"] = True
                added += 1
            if added:
                _write_raw(project.dir, cur)
            entries_out = cur
    else:
        entries_out = list_entries(project.dir)

    return {"candidates": candidates, "added": added, "entries": entries_out}


def format_prompt_block(project_dir: str, max_chars: int = 2400) -> str:
    entries = list_entries(project_dir)
    if not entries:
        return ""
    lines = ["【项目术语与符号约定（请严格遵循，避免使用弃用别名）】"]
    total = len(lines[0])
    for e in entries:
        parts = [f"- {e['term']}"]
        if e.get("symbol"):
            parts.append(f"[符号: {e['symbol']}]")
        if e.get("definition"):
            parts.append(f"：{e['definition'][:120]}")
        if e.get("aliases"):
            parts.append(f"（禁止/弃用别名：{', '.join(e['aliases'][:5])}）")
        line = " ".join(parts)
        if total + len(line) + 1 > max_chars:
            break
        lines.append(line)
        total += len(line) + 1
    return "\n".join(lines) if len(lines) > 1 else ""
