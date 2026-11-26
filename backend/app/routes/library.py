# -*- coding: utf-8 -*-
"""智能文献管理主路由：索引 / 导入 / 引用图 / 导出 / 参考文献渲染，并聚合 Zotero 与条目子路由。

权限：全局 project_access + ROUTE_ROLE——读与外部查询 viewer；写（提交/编辑/删除/合并/建 bib 文件）editor。
"""

from __future__ import annotations

import asyncio
import json
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app import atomic, auth, config
from app.domain import gbt7714, library, library_ops
from app.domain.library import (
    KEY_RE,
    LibraryEntry,
    bib_files,
    create_bib_file,
    detect_cite_style,
    diagnostics,
    entries_to_bibtex,
    entry_to_csl_json,
    format_bibtex,
    load_index,
)
from app.errors import error_detail, kind_error

from .library_shared import (
    MAX_ENTRIES_PER_COMMIT,
    MAX_IMPORT_TEXT,
    CommitSource,
    _current_index,
    _library_mode,
    _project,
    _record_zotero_import,
    _require_paperish,
)

router = APIRouter(prefix="/api/projects/{pid}", tags=["library"])


@router.get("/library")
async def get_library(pid: str, request: Request):
    project, _store = _project(request, pid)
    _require_paperish(project)
    mode = _library_mode(project)
    if mode == "bib":
        digest = await asyncio.to_thread(library.sources_digest, project)
        cached = await asyncio.to_thread(library.load_rebuild_cache, project.dir, digest)
        if cached is not None:
            index = await asyncio.to_thread(load_index, project.dir)
            diag = dict(cached["diagnostics"])
            diag["parse_errors"] = cached["parse_errors"]
        else:
            index, errors = await asyncio.to_thread(library.rebuild_from_bib, project)
            diag = diagnostics(index, project)
            parse_errors = [e.model_dump() for e in errors]
            diag["parse_errors"] = parse_errors
            await asyncio.to_thread(
                library.save_rebuild_cache, project.dir, digest, diag, parse_errors
            )
    else:
        index = await asyncio.to_thread(load_index, project.dir)
        diag = diagnostics(index, project)
        diag["parse_errors"] = []
    return {
        "mode": mode,
        "schema_version": index.schema_version,
        "entries": [e.model_dump(mode="json") for e in index.entries],
        "diagnostics": diag,
        "bib_files": bib_files(project) if mode == "bib" else [],
        "cite_style": detect_cite_style(project) if mode == "bib" else None,
        "source_labels": library.SOURCE_LABELS,
    }


@router.post("/library/reindex")
async def reindex(pid: str, request: Request):
    project, _store = _project(request, pid)
    if _library_mode(project) != "bib":
        raise kind_error("validation", "仅 LaTeX 工程需要重建（.bib 是事实源）")
    index, errors = await asyncio.to_thread(library.rebuild_from_bib, project)
    return {"entries": len(index.entries), "errors": [e.model_dump() for e in errors]}


class ImportIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_IMPORT_TEXT)


@router.post("/library/import")
async def import_bibtex(pid: str, body: ImportIn, request: Request):
    """解析预览（不落盘）：逐条报错 + 逐条查重（key 冲突 / DOI / arXiv / 疑似重复）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    index = await _current_index(project)
    parsed = await asyncio.to_thread(library.parse_citation_text, body.text)
    out_entries, errors, total_blocks = library_ops.annotate_import_preview(parsed, index)
    return {"entries": out_entries, "errors": errors, "total_blocks": total_blocks}


class CommitIn(BaseModel):
    entries: list[dict] = Field(min_length=1, max_length=MAX_ENTRIES_PER_COMMIT)
    target_bib: str | None = None
    base_sha: str | None = None
    source: CommitSource | None = None


@router.post("/library/commit")
async def commit_entries(pid: str, body: CommitIn, request: Request, user: auth.CurrentUser = None):
    """用户确认后才落盘：bib 模式追加到目标 .bib（base 锁）→ 重建索引；index 模式直写索引。"""
    project, _store = _project(request, pid)
    mode = _library_mode(project)
    new_rids: list[str] = []
    new_sha = None
    entries: list[LibraryEntry] = []
    for raw in body.entries:
        ent = LibraryEntry.model_validate({**raw, "reference_id": library.new_reference_id()})
        if not KEY_RE.match(ent.citation_key):
            raise kind_error("validation", f"citation key 不合法：{ent.citation_key}", detail=ent.citation_key)
        if not ent.raw_bibtex:
            ent.raw_bibtex = format_bibtex(ent)
        if body.source and body.source.provider == "zotero":
            ent.source = body.source.model_dump()
        entries.append(ent)
    if mode == "bib":
        if not body.target_bib or body.target_bib not in bib_files(project):
            raise kind_error(
                "validation", "请选择工程内已存在的 .bib 文件（可先在面板新建）", detail=str(body.target_bib)
            )
        for ent in entries:
            ent.bib_files = [body.target_bib]
        await asyncio.to_thread(
            library.append_entries_to_bib, project, body.target_bib, entries, body.base_sha
        )
        hints = {(body.target_bib, ent.citation_key): ent.reference_id for ent in entries}
        index, _errors = await asyncio.to_thread(library.rebuild_from_bib, project, hints)
        new_rids = [e.reference_id for e in entries]
    else:
        index = await asyncio.to_thread(load_index, project.dir)
        for ent in entries:
            ent.origin = "import"
            index.entries.append(ent)
        await asyncio.to_thread(library.save_index, project.dir, index)
        new_rids = [e.reference_id for e in entries]
    if body.source and body.source.provider == "zotero":
        await asyncio.to_thread(
            _record_zotero_import, project.dir, body.source, len(entries), body.target_bib
        )
    return {"reference_ids": new_rids, "bib_sha": new_sha, "total": len(index.entries)}


class BibFileIn(BaseModel):
    name: str


@router.post("/library/bib-file")
async def new_bib_file(pid: str, body: BibFileIn, request: Request, user: auth.CurrentUser = None):
    project, _store = _project(request, pid)
    if _library_mode(project) != "bib":
        raise kind_error("validation", "仅 LaTeX 工程需要 .bib 文件")
    name = body.name.strip()
    sha = await asyncio.to_thread(create_bib_file, project, name)
    return {"path": name, "sha": sha}


@router.get("/library/citations")
async def citations(pid: str, request: Request):
    project, _store = _project(request, pid)
    if _library_mode(project) != "bib":
        raise kind_error("validation", "仅 LaTeX 工程有正文引用图")
    return await asyncio.to_thread(library.scan_tex_citations, project)


@router.get("/library/export")
async def export(pid: str, request: Request, format: str = "bibtex"):
    project, _store = _project(request, pid)
    index = await _current_index(project)
    if format == "bibtex":
        data = entries_to_bibtex(index.entries)
        return Response(
            data,
            media_type="application/x-bibtex; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename*=utf-8''references.bib"},
        )
    if format == "csl-json":
        data = json.dumps([entry_to_csl_json(e) for e in index.entries], ensure_ascii=False, indent=2)
        return Response(
            data,
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename*=utf-8''references-csl.json"},
        )
    raise kind_error("validation", f"不支持的导出格式：{format}", detail=format)


class BibliographyIn(BaseModel):
    order: list[str] = Field(min_length=1, max_length=500)
    style: str = "ieee"


_render_csl = library_ops.render_csl_bibliography


@router.post("/library/bibliography")
async def bibliography(pid: str, body: BibliographyIn, request: Request):
    """按给定顺序渲染编号引用与参考文献表（Word 插件用；LaTeX 参考文献由 BibTeX 在编译时生成）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    index = await _current_index(project)
    by_rid = {e.reference_id: e for e in index.entries}
    missing = [rid for rid in body.order if rid not in by_rid]
    if missing:
        raise kind_error("not_found", f"条目不存在：{', '.join(missing[:5])}", detail=missing)
    entries_in_order = [by_rid[rid] for rid in body.order]
    if body.style == "gb-t-7714-2015":
        return await asyncio.to_thread(gbt7714.format_gbt7714_bibliography, entries_in_order)
    from app.domain.word_citations import STYLES as CITATION_STYLES

    style_file = os.path.join(config.BACKEND_DIR, "app", "csl", f"{body.style}.csl")
    if body.style not in CITATION_STYLES or not os.path.isfile(style_file):
        allowed = "、".join(CITATION_STYLES)
        raise kind_error("validation", f"暂不支持引用样式：{body.style}（当前支持：{allowed}）", detail=body.style)
    try:
        return await asyncio.to_thread(_render_csl, entries_in_order, body.style, style_file)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — CSL 渲染失败如实报错
        raise HTTPException(502, error_detail("content", f"参考文献渲染失败：{e}"))


class CitationRegisterIn(BaseModel):
    append: list[str] = Field(default_factory=list)


@router.post("/library/citations/register")
async def register_citations(pid: str, body: CitationRegisterIn, request: Request):
    """Word 静态引用的全局编号登记。"""
    import time

    project, _store = _project(request, pid)
    _require_paperish(project)
    if _library_mode(project) == "bib":
        raise kind_error("validation", "LaTeX 工程的引用编号由 BibTeX 编译时生成，无需登记")
    await _current_index(project)
    with atomic.studio_lock(project.dir, "citations"):
        index = library.load_index(project.dir)
        by_rid = {e.reference_id for e in index.entries}
        unknown = [rid for rid in body.append if rid not in by_rid]
        if unknown:
            raise kind_error("not_found", f"条目不存在：{', '.join(unknown[:5])}", detail=unknown)
        order = list(index.citation_order)
        changed = False
        for rid in body.append:
            if rid not in order:
                order.append(rid)
                changed = True
        if changed:
            index.citation_order = order
            index.updated_at = time.time()
            library.save_index(project.dir, index)
    return {"order": order, "changed": changed}
