# -*- coding: utf-8 -*-
"""参考文献真实性核验（Citation Fact-Check / 防 AI 幻觉）。

复用 library_sources.py 白名单外部源（Crossref / OpenAlex / arXiv），逐条比对项目文献库与权威元数据：
- verified   : 权威源命中且核心字段（标题/年份/第一作者）一致；
- mismatch   : 权威源命中但存在年份、第一作者或标题偏差（列出具体 diffs）；
- retracted  : 权威源存在明确撤稿记录；
- unverified : 权威源未检出匹配记录（提示人工核查拼写错误或 AI 编造）；
- error      : 外部源关闭、超时或网络异常（如实报告，绝不误判为假文献）。

红线：只读外部查询 + 仅写 `.studio/citation-verify.json` 缓存，绝不自动改写作者 `.bib` 或正文。
"""
from __future__ import annotations

import os
import re
import time
from typing import Any

from app import atomic, config
from app.domain import library_sources
from app.domain.library import LibraryEntry

CACHE_FILE = os.path.join(".studio", "citation-verify.json")
MAX_BATCH = 25

_ASCII_WORD_RE = re.compile(r"[a-z0-9]{2,}")
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]+")


def _norm_tokens(text: str) -> set[str]:
    lower = (text or "").lower()
    tokens: set[str] = set(_ASCII_WORD_RE.findall(lower))
    for run in _CJK_RUN_RE.findall(lower):
        if len(run) == 1:
            tokens.add(run)
        else:
            for i in range(len(run) - 1):
                tokens.add(run[i : i + 2])
    return tokens


def _title_similarity(local_title: str, remote_title: str) -> float:
    a = _norm_tokens(local_title)
    b = _norm_tokens(remote_title)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _first_surname(authors: list[str]) -> str:
    if not authors:
        return ""
    raw = (authors[0] or "").strip()
    if not raw:
        return ""
    compact = re.sub(r"[\s,，·.]+", "", raw)
    if compact and re.fullmatch(r"[\u4e00-\u9fff]+", compact):
        return compact
    if "," in raw:
        surname = raw.split(",", 1)[0].strip()
    else:
        parts = raw.split()
        surname = parts[-1] if parts else raw
    return re.sub(r"[^a-z\u4e00-\u9fff]+", "", surname.lower())


def _extract_arxiv_id(entry: LibraryEntry) -> str:
    direct = (getattr(entry, "arxiv_id", None) or getattr(entry, "arxiv", None) or "").strip()
    if direct:
        return direct
    extra = getattr(entry, "fields", None) or getattr(entry, "extra_fields", None) or {}
    if isinstance(extra, dict):
        eprint = str(extra.get("eprint") or "").strip()
        if eprint and re.match(r"^(?:[a-z\-]+(?:\.[A-Z]{2})?/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?$", eprint, re.IGNORECASE):
            return eprint
    doi = (entry.doi or "").strip()
    m = re.search(
        r"10\.48550/arxiv\.([a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?)",
        doi,
        re.IGNORECASE,
    )
    if m:
        return m.group(1)
    url = (getattr(entry, "url", None) or "").strip()
    m2 = re.search(
        r"arxiv\.org/(?:abs|pdf)/([a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?)",
        url,
        re.IGNORECASE,
    )
    if m2:
        return m2.group(1)
    return ""


async def _find_authoritative(entry: LibraryEntry) -> tuple[dict[str, Any] | None, str | None]:
    """按优先级查询权威源（正式 DOI → arXiv → 标题检索）。返回 (candidate, error_message)。"""
    doi = (entry.doi or "").strip()
    arxiv_id = _extract_arxiv_id(entry)
    title = (entry.title or "").strip()
    is_arxiv_doi = bool(doi and re.match(r"^10\.48550/arxiv\.", doi, re.IGNORECASE))
    last_err: str | None = None

    async def _try_arxiv() -> tuple[dict[str, Any] | None, str | None]:
        if not arxiv_id:
            return None, None
        try:
            cand = await library_sources.lookup_arxiv(arxiv_id)
            if cand and (cand.get("fields") or {}).get("title"):
                return cand, None
            return None, None
        except library_sources.SourceError as exc:
            return None, (exc.message if exc.status not in (404, 422) else None)

    async def _try_doi() -> tuple[dict[str, Any] | None, str | None]:
        if not doi:
            return None, None
        try:
            cand = await library_sources.lookup_doi(doi)
            if cand and (cand.get("fields") or {}).get("title"):
                return cand, None
            return None, None
        except library_sources.SourceError as exc:
            if exc.status == 404:
                try:
                    cand = await library_sources.lookup_doi_openalex(doi)
                    if cand and (cand.get("fields") or {}).get("title"):
                        return cand, None
                except library_sources.SourceError as exc2:
                    if exc2.status not in (404, 422):
                        return None, exc2.message
            elif exc.status != 422:
                return None, exc.message
            return None, None

    if doi and not is_arxiv_doi:
        cand, err = await _try_doi()
        if cand is not None:
            return cand, None
        if err:
            last_err = err
        cand, err = await _try_arxiv()
        if cand is not None:
            return cand, None
        if err:
            last_err = err
    else:
        cand, err = await _try_arxiv()
        if cand is not None:
            return cand, None
        if err:
            last_err = err
        cand, err = await _try_doi()
        if cand is not None:
            return cand, None
        if err:
            last_err = err

    # 3. 标题关键词检索（OpenAlex，按最高标题相似度挑候选；中文标题允许 ≥4 字）
    min_title_len = 4 if _CJK_RUN_RE.search(title) else 6
    if title and len(title) >= min_title_len:
        try:
            cands = await library_sources.search_openalex(title, limit=5)
            best = None
            best_sim = 0.0
            for c in cands:
                rtitle = ((c.get("fields") or {}).get("title") or "").strip()
                sim = _title_similarity(title, rtitle)
                if sim > best_sim:
                    best_sim = sim
                    best = c
            if best is not None and best_sim >= 0.55:
                return best, None
        except library_sources.SourceError as exc:
            if exc.status not in (404, 422):
                last_err = exc.message

    return None, last_err


def _compare_entry(entry: LibraryEntry, cand: dict[str, Any]) -> dict[str, Any]:
    fields = cand.get("fields") or {}
    retraction = cand.get("retraction") or {}
    r_title = str(fields.get("title") or "").strip()
    r_year = str(fields.get("year") or "").strip()
    r_authors = list(fields.get("authors") or [])
    r_doi = str(fields.get("doi") or "").strip()
    r_venue = str(fields.get("venue") or "").strip()
    r_url = str(fields.get("url") or "").strip()
    source = str(cand.get("source") or "unknown")

    sim = _title_similarity(entry.title or "", r_title)
    diffs: list[dict[str, str]] = []

    if entry.title and r_title and sim < 0.72:
        diffs.append({"field": "title", "local": entry.title, "remote": r_title})

    l_year = str(entry.year or "").strip()
    if l_year and r_year and l_year != r_year:
        diffs.append({"field": "year", "local": l_year, "remote": r_year})

    l_first = _first_surname(entry.authors)
    r_first = _first_surname(r_authors)
    if l_first and r_first and l_first != r_first:
        diffs.append({
            "field": "first_author",
            "local": entry.authors[0] if entry.authors else "",
            "remote": r_authors[0] if r_authors else "",
        })

    if retraction.get("status") == "retracted":
        status = "retracted"
        reason = "权威源记录显示该文献已被撤稿，请核实后移除或说明"
    elif diffs:
        status = "mismatch"
        diff_names = "、".join(d["field"] for d in diffs)
        reason = f"已命中权威源（{source}），但以下字段存在偏差：{diff_names}"
    else:
        status = "verified"
        reason = f"已通过权威源（{source}）核验，标题/年份/第一作者一致"

    remote_fields: dict[str, Any] = {}
    if r_title:
        remote_fields["title"] = r_title
    if r_year:
        remote_fields["year"] = r_year
    if r_authors:
        clean_authors = [str(a).strip() for a in r_authors if str(a).strip()]
        if clean_authors:
            remote_fields["authors"] = clean_authors
    if r_venue:
        remote_fields["venue"] = r_venue
    if r_doi:
        remote_fields["doi"] = r_doi
    if r_url:
        remote_fields["url"] = r_url

    return {
        "reference_id": entry.reference_id,
        "citation_key": entry.citation_key,
        "status": status,
        "source": source,
        "title_similarity": round(sim, 3),
        "matched_title": r_title,
        "matched_year": r_year,
        "matched_doi": r_doi,
        "remote_fields": remote_fields,
        "retraction_status": retraction.get("status") or "unknown",
        "diffs": diffs,
        "reason": reason,
        "checked_at": time.time(),
    }


async def verify_entries(
    project_dir: str,
    entries: list[LibraryEntry],
    *,
    rids: list[str] | None = None,
) -> dict[str, Any]:
    """批量核验项目文献条目并将结果缓存到 `.studio/citation-verify.json`。"""
    target = entries
    if rids:
        rid_set = set(rids)
        target = [e for e in entries if e.reference_id in rid_set]
    truncated = len(target) > MAX_BATCH
    batch = target[:MAX_BATCH]

    results: list[dict[str, Any]] = []
    for ent in batch:
        if not config.LIBRARY_SOURCES_ON:
            results.append({
                "reference_id": ent.reference_id,
                "citation_key": ent.citation_key,
                "status": "error",
                "source": None,
                "title_similarity": 0.0,
                "matched_title": "",
                "matched_year": "",
                "matched_doi": "",
                "retraction_status": "unknown",
                "diffs": [],
                "reason": "外部文献源查询未开启（PAPER_STUDIO_LIBRARY_SOURCES=off）",
                "checked_at": time.time(),
            })
            continue

        cand, err = await _find_authoritative(ent)
        if cand is not None:
            results.append(_compare_entry(ent, cand))
        elif err:
            results.append({
                "reference_id": ent.reference_id,
                "citation_key": ent.citation_key,
                "status": "error",
                "source": None,
                "title_similarity": 0.0,
                "matched_title": "",
                "matched_year": "",
                "matched_doi": "",
                "retraction_status": "unknown",
                "diffs": [],
                "reason": f"外部源查询异常（不判定为假文献）：{err}",
                "checked_at": time.time(),
            })
        else:
            results.append({
                "reference_id": ent.reference_id,
                "citation_key": ent.citation_key,
                "status": "unverified",
                "source": None,
                "title_similarity": 0.0,
                "matched_title": "",
                "matched_year": "",
                "matched_doi": "",
                "retraction_status": "unknown",
                "diffs": [],
                "reason": "在 Crossref / OpenAlex / arXiv 中未检出匹配记录，请人工核查是否拼写有误或为 AI 虚构文献",
                "checked_at": time.time(),
            })

    cache_path = os.path.join(project_dir, CACHE_FILE)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    valid_rids = {e.reference_id for e in entries}
    with atomic.studio_lock(project_dir, "citation-verify"):
        # 与已有缓存按 reference_id 合并，保留局部抽检历史
        prev = load_cached(project_dir)
        merged_map = {it["reference_id"]: it for it in prev.get("items", []) if it.get("reference_id")}
        for it in results:
            merged_map[it["reference_id"]] = it
        # 仅保留当前文献库仍存在的条目
        all_items = [it for rid, it in merged_map.items() if rid in valid_rids]

        counts = {"verified": 0, "mismatch": 0, "retracted": 0, "unverified": 0, "error": 0}
        for it in all_items:
            st = it.get("status", "error")
            if st in counts:
                counts[st] += 1

        report = {
            "checked_at": time.time(),
            "total": len(all_items),
            "batch_size": len(batch),
            "truncated": truncated,
            "max_batch": MAX_BATCH,
            "counts": counts,
            "items": all_items,
        }
        atomic.write_json(cache_path, report)
    return report


def load_cached(project_dir: str) -> dict[str, Any]:
    cache_path = os.path.join(project_dir, CACHE_FILE)
    if not os.path.isfile(cache_path):
        return {
            "checked_at": None,
            "total": 0,
            "batch_size": 0,
            "truncated": False,
            "max_batch": MAX_BATCH,
            "counts": {"verified": 0, "mismatch": 0, "retracted": 0, "unverified": 0, "error": 0},
            "items": [],
        }
    try:
        import json

        with open(cache_path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {
        "checked_at": None,
        "total": 0,
        "batch_size": 0,
        "truncated": False,
        "max_batch": MAX_BATCH,
        "counts": {"verified": 0, "mismatch": 0, "retracted": 0, "unverified": 0, "error": 0},
        "items": [],
    }
