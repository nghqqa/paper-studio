# -*- coding: utf-8 -*-
"""文献管理业务逻辑助手：导入查重标注、Zotero 增量刷新比对、条目差异与 CSL 渲染。"""

from __future__ import annotations

from typing import Any

from app.domain import library
from app.domain.library import (
    KEY_RE,
    LibraryEntry,
    entry_to_csl_json,
    format_bibtex,
    suggested_key,
)
from app.errors import kind_error


def annotate_import_preview(parsed, index) -> tuple[list[dict], list[dict], int]:
    """对解析出的 BibTeX/引用条目逐条标注 key 冲突与 DOI/arXiv/模糊重复，返回 `(entries, errors, total_blocks)`."""
    existing_keys = {e.citation_key for e in index.entries}
    existing_dois = {library.doi_of(e) for e in index.entries if library.doi_of(e)}
    existing_arx = {library.arxiv_of(e) for e in index.entries if library.arxiv_of(e)}
    fp_map: dict[tuple, LibraryEntry] = {}
    for e in index.entries:
        fp_map.setdefault(library.entry_fingerprint(e), e)

    out_entries: list[dict] = []
    batch_keys: dict[str, int] = {}
    for ent in parsed.entries:
        batch_keys[ent.citation_key] = batch_keys.get(ent.citation_key, 0) + 1
        entry_dict = ent.model_dump(mode="json")
        dupes: list[dict] = []
        doi = library.doi_of(ent)
        arx = library.arxiv_of(ent)
        if doi and doi in existing_dois:
            match = next(e for e in index.entries if library.doi_of(e) == doi)
            dupes.append({"kind": "doi", "reference_id": match.reference_id, "citation_key": match.citation_key})
        if arx and arx in existing_arx:
            match = next(e for e in index.entries if library.arxiv_of(e) == arx)
            dupes.append({"kind": "arxiv", "reference_id": match.reference_id, "citation_key": match.citation_key})
        fp = library.entry_fingerprint(ent)
        if fp[0] and fp in fp_map:
            dupes.append({
                "kind": "fuzzy",
                "reference_id": fp_map[fp].reference_id,
                "citation_key": fp_map[fp].citation_key,
            })
        entry_dict["duplicates"] = dupes
        entry_dict["key_conflict"] = ent.citation_key in existing_keys or batch_keys[ent.citation_key] > 1
        entry_dict["suggested_key"] = suggested_key(ent)
        out_entries.append(entry_dict)
    errors = [e.model_dump() for e in parsed.errors]
    return out_entries, errors, len(out_entries) + len(parsed.errors)


def refresh_source_dict(body) -> dict:
    """构造 Zotero 刷新锚点记录字典。"""
    return {
        "provider": "zotero",
        "library_type": body.library_type,
        "group_id": body.group_id,
        "collection_key": body.collection_key,
        "group_name": body.group_name,
        "zotero_user_id": body.zotero_user_id,
    }


def match_remote_entry(local_entries: list[LibraryEntry], ent: LibraryEntry) -> LibraryEntry | None:
    """刷新匹配键优先级：DOI → arXiv → 指纹 → citation_key。"""
    doi = library.doi_of(ent)
    if doi:
        hit = next((e for e in local_entries if library.doi_of(e) == doi), None)
        if hit is not None:
            return hit
    arx = library.arxiv_of(ent)
    if arx:
        hit = next((e for e in local_entries if library.arxiv_of(e) == arx), None)
        if hit is not None:
            return hit
    fp = library.entry_fingerprint(ent)
    if fp[0]:
        hit = next((e for e in local_entries if library.entry_fingerprint(e) == fp), None)
        if hit is not None:
            return hit
    return next((e for e in local_entries if e.citation_key == ent.citation_key), None)


def entry_signature(e: LibraryEntry) -> tuple:
    return (
        e.title or "",
        e.year or "",
        e.venue or "",
        e.volume or "",
        e.number or "",
        e.pages or "",
        e.publisher or "",
        e.url or "",
        tuple(e.authors),
    )


def signature_dict(e: LibraryEntry) -> dict:
    out = {k: getattr(e, k) or "" for k in ("title", "year", "venue", "volume", "number", "pages", "publisher", "url")}
    out["authors"] = " and ".join(e.authors)
    out["citation_key"] = e.citation_key
    return out


def validate_refresh_entry(raw: dict, source: dict) -> LibraryEntry:
    ent = LibraryEntry.model_validate(dict(raw))
    if not KEY_RE.match(ent.citation_key):
        raise kind_error("validation", f"citation key 不合法：{ent.citation_key}", detail=ent.citation_key)
    if not ent.raw_bibtex:
        ent.raw_bibtex = format_bibtex(ent)
    ent.source = source
    return ent


def build_zotero_refresh_preview_items(
    parsed,
    index,
    *,
    library_type: str,
    group_id: int | None,
    zotero_user_id: str | None,
    collection_key: str | None,
    mode: str,
) -> dict:
    """将远端 Zotero 条目与本地索引比对分类为 added/updated/removed/unchanged。"""
    added: list = []
    updated: list = []
    unchanged = 0
    matched: set = set()
    for ent in parsed.entries:
        local = match_remote_entry(index.entries, ent)
        if local is None:
            added.append(ent.model_dump(mode="json"))
            continue
        matched.add(local.reference_id)
        if entry_signature(local) != entry_signature(ent):
            updated.append({
                "reference_id": local.reference_id,
                "citation_key": local.citation_key,
                "old": signature_dict(local),
                "new": signature_dict(ent),
                "entry": ent.model_dump(mode="json"),
            })
        else:
            unchanged += 1

    removed: list = []
    removed_supported = mode == "index"
    for e in index.entries:
        src = e.source or {}
        if src.get("provider") != "zotero" or src.get("library_type", "group") != library_type:
            continue
        if library_type == "group" and src.get("group_id") != group_id:
            continue
        if library_type == "user" and str(src.get("zotero_user_id") or "") != str(zotero_user_id or ""):
            continue
        if collection_key and (src.get("collection_key") or None) != collection_key:
            continue
        if e.reference_id not in matched:
            removed.append({
                "reference_id": e.reference_id,
                "citation_key": e.citation_key,
                "in_citation_order": e.reference_id in index.citation_order,
            })

    notice = None
    if removed and not removed_supported:
        notice = "bib 模式以 .bib 为事实源，不支持远端移除检测的自动删除（如需删除请手动编辑 .bib）"
        removed = []

    return {
        "counts": {
            "added": len(added),
            "updated": len(updated),
            "removed": len(removed),
            "unchanged": unchanged,
        },
        "added": added,
        "updated": updated,
        "removed": removed,
        "removed_supported": removed_supported,
        "notice": notice,
    }


def entry_diff(existing: LibraryEntry, cand_fields: dict[str, Any]) -> list[dict]:
    cur_map = {
        "title": existing.title or "",
        "year": existing.year or "",
        "venue": existing.venue or "",
        "volume": existing.volume or "",
        "number": existing.number or "",
        "pages": existing.pages or "",
        "publisher": existing.publisher or "",
        "doi": library.doi_of(existing) or "",
        "arxiv_id": library.arxiv_of(existing) or "",
        "url": existing.url or "",
        "author": " and ".join(existing.authors),
    }
    diffs = []
    for f, src_val in cand_fields.items():
        if f not in cur_map or cur_map[f] in (None, ""):
            continue
        same = str(cur_map[f]).strip().lower() == str(src_val).strip().lower()
        diffs.append({"field": f, "current": cur_map[f], "source": str(src_val), "same": same})
    return diffs


def render_csl_bibliography(entries_in_order: list[LibraryEntry], style: str, style_file: str) -> dict:
    """使用 citeproc-py 按顺序渲染编号引用标签与参考文献列表。"""
    from citeproc import Citation, CitationItem, CitationStylesBibliography, CitationStylesStyle, formatter
    from citeproc.source.json import CiteProcJSON

    data = [entry_to_csl_json(e) for e in entries_in_order]
    src = CiteProcJSON(data)
    style_obj = CitationStylesStyle(style_file)
    bib = CitationStylesBibliography(style_obj, src, formatter.plain)
    for e in entries_in_order:
        bib.register(Citation([CitationItem(e.reference_id)]))
    labels = {e.reference_id: f"[{i}]" for i, e in enumerate(entries_in_order, 1)}
    items = [str(it) for it in bib.bibliography()]
    return {
        "style": style,
        "labels": labels,
        "bibliography": items,
        "note": "平台引用对象（内容控件标签绑定 reference_id），非 Word 原生引文域",
    }
