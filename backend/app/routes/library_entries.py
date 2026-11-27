# -*- coding: utf-8 -*-
"""智能文献管理条目与外部核验/补全子路由。"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app import auth, config
from app.domain import citation_verify, library, library_ops, library_pdf, library_sources
from app.domain.library import (
    KEY_RE,
    RID_RE,
    BibParseError,
    BibParseResult,
    LibraryEntry,
    format_bibtex,
    load_index,
    new_reference_id,
    normalize_arxiv,
    normalize_doi,
    suggested_key,
)
from app.errors import error_detail, kind_error
from app.routes import read_bounded

from .library_shared import (
    _current_index,
    _library_mode,
    _persist_entry,
    _project,
    _require_paperish,
    _zotero_http_error,
)

router = APIRouter(prefix="/api/projects/{pid}", tags=["library"])


class LookupIn(BaseModel):
    doi: str | None = None
    arxiv: str | None = None
    query: str | None = None
    reference_id: str | None = None


class ConfirmIn(BaseModel):
    fields: list[str] = Field(default_factory=list)


class EntryEditIn(BaseModel):
    fields: dict[str, str]
    base_sha: str | None = None


class DeleteIn(BaseModel):
    base_sha: str | None = None
    files_base: dict[str, str] = Field(default_factory=dict)


class MergeIn(BaseModel):
    survivor_rid: str
    loser_rid: str
    field_choices: dict[str, str] = Field(default_factory=dict)
    new_key: str | None = None
    bib_base: dict[str, str] = Field(default_factory=dict)
    tex_updates: list[dict] = Field(default_factory=list)


class RenameIn(BaseModel):
    updates: list[dict]


class VerifyIn(BaseModel):
    reference_ids: list[str] | None = Field(default=None, max_length=100)


@router.post("/library/lookup")
async def lookup(pid: str, body: LookupIn, request: Request):
    """DOI / arXiv / 标题关键词查询（只查不写）。返回候选 + 与已有条目的字段差异（有 rid 时）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    existing = None
    if body.reference_id:
        index = await _current_index(project)
        existing = next((e for e in index.entries if e.reference_id == body.reference_id), None)
        if existing is None:
            raise kind_error("not_found", "条目不存在", detail=body.reference_id)
    try:
        if body.doi:
            cand = await library_sources.lookup_doi(body.doi)
            cands = [cand]
        elif body.arxiv:
            cands = [await library_sources.lookup_arxiv(body.arxiv)]
        elif body.query:
            cands = await library_sources.search(body.query, limit=5)
        else:
            raise kind_error("validation", "请提供 doi / arxiv / query 之一")
    except library_sources.SourceError as e:
        raise _zotero_http_error(e, None)
    return {
        "candidates": [
            {"candidate": c, "diff": library_ops.entry_diff(existing, c["fields"]) if existing else None}
            for c in cands
        ],
        "existing_reference_id": body.reference_id,
    }


@router.post("/library/entries/{rid}/confirm")
async def confirm_entry(pid: str, rid: str, body: ConfirmIn, request: Request, user: auth.CurrentUser = None):
    """人工确认：字段 provenance.confirmed=True；整条确认 ⇒ verified（用户对匹配结果负责）。"""
    if not RID_RE.match(rid):
        raise kind_error("validation", "reference_id 不合法", detail=rid)
    project, _store = _project(request, pid)
    mode = _library_mode(project)
    index = await _current_index(project)
    ent = next((e for e in index.entries if e.reference_id == rid), None)
    if ent is None:
        raise kind_error("not_found", "条目不存在", detail=rid)
    now = time.time()
    if body.fields:
        for f in body.fields:
            if f in ent.field_provenance:
                ent.field_provenance[f].confirmed = True
                ent.field_provenance[f].at = now
            else:
                ent.field_provenance[f] = library.FieldProvenance(source="user", confirmed=True, at=now)
        ent.updated_at = now
    else:
        for pv in ent.field_provenance.values():
            pv.confirmed = True
            pv.at = now
        ent.verified = "verified"
        ent.updated_at = now
    return await _persist_entry(project, index, ent, mode)


@router.patch("/library/entries/{rid}")
async def edit_entry(pid: str, rid: str, body: EntryEditIn, request: Request, user: auth.CurrentUser = None):
    if not RID_RE.match(rid):
        raise kind_error("validation", "reference_id 不合法", detail=rid)
    project, _store = _project(request, pid)
    mode = _library_mode(project)
    index = await _current_index(project)
    ent = next((e for e in index.entries if e.reference_id == rid), None)
    if ent is None:
        raise kind_error("not_found", "条目不存在", detail=rid)
    for f, v in body.fields.items():
        library._set_field(ent, f, str(v), source="user")
        ent.suggested.pop(f, None)
    ent.updated_at = time.time()
    return await _persist_entry(project, index, ent, mode, base_sha=body.base_sha)


@router.delete("/library/entries/{rid}")
async def delete_entry(pid: str, rid: str, body: DeleteIn, request: Request, user: auth.CurrentUser = None):
    if not RID_RE.match(rid):
        raise kind_error("validation", "reference_id 不合法", detail=rid)
    project, _store = _project(request, pid)
    mode = _library_mode(project)
    if mode == "bib":
        index = await _current_index(project)
        ent = next((e for e in index.entries if e.reference_id == rid), None)
        if ent is None:
            raise kind_error("not_found", "条目不存在", detail=rid)
        shas = []
        for rel in ent.bib_files or []:
            base = body.files_base.get(rel, body.base_sha)
            sha = await asyncio.to_thread(library.remove_entry_from_bib, project, rel, ent.raw_bibtex, base)
            shas.append({"file": rel, "sha": sha})
        await asyncio.to_thread(library.rebuild_from_bib, project)
        await asyncio.to_thread(library_pdf.delete_pdf, project.dir, rid)
        return {"ok": True, "files": shas}
    index = await asyncio.to_thread(load_index, project.dir)
    before = len(index.entries)
    index.entries = [e for e in index.entries if e.reference_id != rid]
    if len(index.entries) == before:
        raise kind_error("not_found", "条目不存在", detail=rid)
    await asyncio.to_thread(library.save_index, project.dir, index)
    await asyncio.to_thread(library_pdf.delete_pdf, project.dir, rid)
    return {"ok": True, "files": []}


@router.post("/library/merge")
async def merge(pid: str, body: MergeIn, request: Request, user: auth.CurrentUser = None):
    project, _store = _project(request, pid)
    mode = _library_mode(project)
    index = await _current_index(project)
    survivor = next((e for e in index.entries if e.reference_id == body.survivor_rid), None)
    loser = next((e for e in index.entries if e.reference_id == body.loser_rid), None)
    if survivor is None or loser is None:
        raise kind_error("not_found", "待合并条目不存在")
    final_key = body.new_key or survivor.citation_key
    if not KEY_RE.match(final_key):
        raise kind_error("validation", f"citation key 不合法：{final_key}", detail=final_key)
    renames: dict[str, str] = {}
    if loser.citation_key != final_key:
        renames[loser.citation_key] = final_key
    if survivor.citation_key != final_key:
        renames[survivor.citation_key] = final_key
    merged = library.merge_entries(survivor, loser, body.field_choices, body.new_key)

    bib_results = []
    if mode == "bib":
        from app.domain.latex_build import read_source_file

        for rel in dict.fromkeys((survivor.bib_files or []) + (loser.bib_files or [])):
            cur = await asyncio.to_thread(read_source_file, project, rel)
            library._check_base(cur, body.bib_base.get(rel), rel)
            new_content = cur
            for src_ent, is_survivor in ((survivor, True), (loser, False)):
                if rel not in (src_ent.bib_files or []):
                    continue
                for blk, _ln, _t in library.split_bib_blocks(new_content):
                    if re.search(r"@\w+\s*\{\s*" + re.escape(src_ent.citation_key) + r"\s*,", blk):
                        new_content = new_content.replace(blk, format_bibtex(merged) if is_survivor else "", 1)
                        break
            new_content = re.sub(r"\n{3,}", "\n\n", new_content)
            sha = await asyncio.to_thread(library._write_bib, project, rel, new_content)
            bib_results.append({"file": rel, "sha": sha})
        index, _ = await asyncio.to_thread(library.rebuild_from_bib, project)
        _merged = next((e for e in index.entries if e.reference_id == merged.reference_id), None)
        if _merged is not None:
            _merged.verified = merged.verified
            _merged.field_provenance = merged.field_provenance
            _merged.suggested = merged.suggested
            _merged.suggested_model = merged.suggested_model
            _cur = await asyncio.to_thread(load_index, project.dir)
            _cur.entries = [
                _merged if e.reference_id == _merged.reference_id else e for e in _cur.entries
            ]
            await asyncio.to_thread(library.save_index, project.dir, _cur)
    else:
        index.entries = [
            merged if e.reference_id == merged.reference_id else e
            for e in index.entries
            if e.reference_id != body.loser_rid
        ]
        await asyncio.to_thread(library.save_index, project.dir, index)

    tex_results = []
    if renames and body.tex_updates:
        tex_results = await asyncio.to_thread(
            library.apply_cite_renames,
            project,
            [{"path": u.get("path"), "base": u.get("base"), "renames": renames} for u in body.tex_updates],
        )
    await asyncio.to_thread(library_pdf.delete_pdf, project.dir, body.loser_rid)
    return {
        "merged_reference_id": merged.reference_id,
        "renames": renames,
        "bib_files": bib_results,
        "tex_updates": tex_results,
    }


@router.post("/library/apply-renames")
async def apply_renames(pid: str, body: RenameIn, request: Request, user: auth.CurrentUser = None):
    project, _store = _project(request, pid)
    if _library_mode(project) != "bib":
        raise kind_error("validation", "仅 LaTeX 工程有正文引用改名")
    results = await asyncio.to_thread(library.apply_cite_renames, project, body.updates)
    return {"results": results}


@router.post("/library/entries/{rid}/ai-suggest")
async def ai_suggest(pid: str, rid: str, request: Request, user: auth.CurrentUser = None):
    """AI 建议补全缺失字段：只存 suggested 层（未验证），不进 fields、不写 bib。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    from app.ai.client import AiError
    from app.domain import user_ai
    from app.domain.org import require_org_ai

    await require_org_ai()
    client, _provider = user_ai.resolve_ai_client(user)
    project, _store = _project(request, pid)
    mode = _library_mode(project)
    index = await _current_index(project)
    ent = next((e for e in index.entries if e.reference_id == rid), None)
    if ent is None:
        raise kind_error("not_found", "条目不存在", detail=rid)
    missing = [
        f
        for f, v in (
            ("title", ent.title),
            ("year", ent.year),
            ("venue", ent.venue),
            ("pages", ent.pages),
            ("volume", ent.volume),
            ("doi", ent.doi),
        )
        if not v
    ]
    if not missing:
        return {"suggested": {}, "model": None, "note": "无缺失字段"}
    sys_prompt = (
        "你是文献元数据助手。根据给定 BibTeX 条目的已知字段，补全缺失字段。"
        "只允许基于条目内线索（标题/作者/DOI 等）推断；不确定的值留空；禁止编造 DOI 与页码。"
        '输出严格 JSON 对象，只含缺失字段键（如 {"pages": "123-130", "volume": "30"}）。'
    )
    known = {
        k: v
        for k, v in (
            ("title", ent.title),
            ("authors", "; ".join(ent.authors)),
            ("year", ent.year),
            ("venue", ent.venue),
            ("entry_type", ent.entry_type),
            ("doi", ent.doi),
        )
        if v
    }
    try:
        result = await client.chat(
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": json.dumps(known, ensure_ascii=False)},
            ],
            "interactive",
            max_tokens=500,
            temperature=0.1,
        )
    except AiError as e:
        raise HTTPException(e.status or 502, error_detail("ai", str(e)))
    try:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", result.text.strip(), flags=re.MULTILINE)
        parsed = json.loads(cleaned.strip() or "{}")
        if not isinstance(parsed, dict):
            raise ValueError("not a dict")
    except Exception:  # noqa: BLE001 — 模型输出不合法：如实返回空建议
        parsed = {}
    allowed = {"title", "year", "venue", "pages", "volume", "number", "doi", "publisher", "url"}
    suggested = {
        str(k)[:40]: str(v)[:500]
        for k, v in parsed.items()
        if k in allowed and v and not library._field_value(ent, str(k))
    }
    ent.suggested = suggested
    ent.suggested_model = result.model
    await _persist_entry(project, index, ent, mode)
    return {
        "suggested": suggested,
        "model": result.model,
        "note": "AI 建议未验证；采纳前请先经外部来源查询比对确认",
    }


@router.get("/library/verify")
async def get_citation_verify(pid: str, request: Request):
    """读取最近一次文献真实性核验缓存（只读）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    return await asyncio.to_thread(citation_verify.load_cached, project.dir)


@router.post("/library/verify")
async def run_citation_verify(pid: str, request: Request, body: VerifyIn | None = None):
    """批量通过 Crossref / OpenAlex / arXiv 核验项目文献真实性（单次最多 25 条，只读不改正文）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    index = await _current_index(project)
    rids = body.reference_ids if body and body.reference_ids else None
    return await citation_verify.verify_entries(project.dir, index.entries, rids=rids)


_MAX_PDF_EXTRACT_FILES = 10
_MAX_PDF_EXTRACT_BYTES = 32 * 1024 * 1024


def _entry_from_fields(fields: dict, fallback_doi: str | None = None, fallback_arxiv: str | None = None) -> LibraryEntry:
    authors = [str(a).strip() for a in (fields.get("authors") or []) if str(a).strip()]
    doi = normalize_doi(fields.get("doi") or fallback_doi)
    arxiv_id = normalize_arxiv(fields.get("arxiv_id") or fallback_arxiv)
    ent = LibraryEntry(
        reference_id=new_reference_id(),
        citation_key="tmpkey",
        entry_type=str(fields.get("entry_type") or "article"),
        title=str(fields.get("title") or "").strip(),
        authors=authors,
        year=str(fields["year"]) if fields.get("year") else None,
        venue=str(fields["venue"]) if fields.get("venue") else None,
        volume=str(fields["volume"]) if fields.get("volume") else None,
        number=str(fields["number"]) if fields.get("number") else None,
        pages=str(fields["pages"]) if fields.get("pages") else None,
        publisher=str(fields["publisher"]) if fields.get("publisher") else None,
        doi=doi,
        arxiv_id=arxiv_id,
        url=str(fields["url"]) if fields.get("url") else None,
        abstract=str(fields["abstract"]) if fields.get("abstract") else None,
    )
    key = suggested_key(ent)
    if not KEY_RE.match(key):
        key = re.sub(r"[^A-Za-z0-9_:-]+", "", key) or "refpdf"
    ent.citation_key = key
    ent.raw_bibtex = format_bibtex(ent)
    return ent


@router.post("/library/extract-pdf")
async def extract_pdf_references(
    pid: str,
    request: Request,
    files: Annotated[list[UploadFile], File(...)],
):
    """上传论文 PDF 提取 DOI/arXiv/标题并联网补全标准题录，返回导入预览清单（不落盘）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    if not files:
        raise kind_error("validation", "请至少上传一个 PDF 文件")
    if len(files) > _MAX_PDF_EXTRACT_FILES:
        raise kind_error("validation", f"单次最多解析 {_MAX_PDF_EXTRACT_FILES} 个 PDF 文件")

    index = await _current_index(project)
    parsed_entries: list[LibraryEntry] = []
    parse_errors: list[BibParseError] = []
    file_reports: list[dict] = []

    for idx, f in enumerate(files, 1):
        fname = f.filename or f"paper-{idx}.pdf"
        raw = await read_bounded(f, "PDF", _MAX_PDF_EXTRACT_BYTES)
        try:
            info = await asyncio.to_thread(library_pdf.extract_identifiers_from_pdf, raw, fname)
        except ValueError as e:
            parse_errors.append(BibParseError(line=idx, raw=fname, error=str(e)))
            file_reports.append({"filename": fname, "status": "failed", "error": str(e)})
            continue

        cand: dict | None = None
        lookup_err: str | None = None
        if info.get("doi"):
            try:
                cand = await library_sources.lookup_doi(info["doi"])
            except library_sources.SourceError as e:
                lookup_err = e.message
                try:
                    cand = await library_sources.lookup_doi_openalex(info["doi"])
                except library_sources.SourceError:
                    pass
        if cand is None and info.get("arxiv_id"):
            try:
                cand = await library_sources.lookup_arxiv(info["arxiv_id"])
            except library_sources.SourceError as e:
                lookup_err = lookup_err or e.message
        if cand is None and info.get("title"):
            try:
                hits = await library_sources.search(info["title"], limit=1)
                if hits:
                    cand = hits[0]
            except library_sources.SourceError as e:
                lookup_err = lookup_err or e.message

        if cand is not None and (cand.get("fields") or {}).get("title"):
            ent = _entry_from_fields(cand["fields"], info.get("doi"), info.get("arxiv_id"))
            parsed_entries.append(ent)
            file_reports.append({
                "filename": fname,
                "status": "matched",
                "source": cand.get("source"),
                "doi": info.get("doi"),
                "arxiv_id": info.get("arxiv_id"),
                "title": ent.title,
            })
        elif info.get("title") or info.get("doi") or info.get("arxiv_id"):
            ent = _entry_from_fields(
                {"title": info.get("title") or fname.rsplit(".", 1)[0]},
                info.get("doi"),
                info.get("arxiv_id"),
            )
            parsed_entries.append(ent)
            file_reports.append({
                "filename": fname,
                "status": "partial",
                "doi": info.get("doi"),
                "arxiv_id": info.get("arxiv_id"),
                "title": ent.title,
                "warning": lookup_err or "仅本地提取到基础标识符/标题，建议入库前补充核对",
            })
        else:
            msg = lookup_err or "未从该 PDF 文字层识别出 DOI、arXiv 号或标题（扫描版暂不支持）"
            parse_errors.append(BibParseError(line=idx, raw=fname, error=msg))
            file_reports.append({"filename": fname, "status": "failed", "error": msg})

    parsed = BibParseResult(entries=parsed_entries, errors=parse_errors)
    out_entries, errors, total_blocks = library_ops.annotate_import_preview(parsed, index)
    return {
        "entries": out_entries,
        "errors": errors,
        "total_blocks": total_blocks,
        "files": file_reports,
    }


@router.post("/library/entries/{rid}/pdf")
async def upload_entry_pdf(
    pid: str,
    rid: str,
    request: Request,
    file: Annotated[UploadFile | None, File()] = None,
):
    if not RID_RE.match(rid):
        raise kind_error("validation", "reference_id 不合法", detail=rid)
    if file is None:
        raise kind_error("validation", "请上传 PDF 文件", detail="file")
    project, _store = _project(request, pid)
    _require_paperish(project)
    index = await _current_index(project)
    if not any(e.reference_id == rid for e in index.entries):
        raise kind_error("not_found", "文献条目不存在", detail=rid)
    raw = await read_bounded(file, "PDF", library_pdf.PDF_MAX_BYTES)
    try:
        meta = await asyncio.to_thread(library_pdf.attach_pdf, project.dir, rid, raw, file.filename or f"{rid}.pdf")
    except ValueError as e:
        raise kind_error("validation", str(e), detail=rid)
    return {"pdf": meta}


@router.get("/library/entries/{rid}/pdf")
async def get_entry_pdf(pid: str, rid: str, request: Request):
    if not RID_RE.match(rid):
        raise kind_error("validation", "reference_id 不合法", detail=rid)
    project, _store = _project(request, pid)
    _require_paperish(project)
    index = await _current_index(project)
    if not any(e.reference_id == rid for e in index.entries):
        raise kind_error("not_found", "文献条目不存在", detail=rid)
    try:
        pdf_path, fname = await asyncio.to_thread(library_pdf.get_pdf_path, project.dir, rid)
    except FileNotFoundError as e:
        raise kind_error("not_found", str(e), detail=rid)
    return FileResponse(
        pdf_path,
        media_type="application/pdf",
        filename=fname,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/library/entries/{rid}/pdf/text")
async def get_entry_pdf_text(pid: str, rid: str, request: Request):
    if not RID_RE.match(rid):
        raise kind_error("validation", "reference_id 不合法", detail=rid)
    project, _store = _project(request, pid)
    _require_paperish(project)
    index = await _current_index(project)
    entry = next((e for e in index.entries if e.reference_id == rid), None)
    if entry is None:
        raise kind_error("not_found", "文献条目不存在", detail=rid)
    try:
        info = await asyncio.to_thread(library_pdf.get_pdf_text, project.dir, rid)
    except FileNotFoundError as e:
        raise kind_error("not_found", str(e), detail=rid)
    return {
        **info,
        "reference_id": entry.reference_id,
        "citation_key": entry.citation_key,
        "title": entry.title,
        "authors": entry.authors,
        "year": entry.year,
        "venue": entry.venue,
    }


@router.delete("/library/entries/{rid}/pdf")
async def delete_entry_pdf(pid: str, rid: str, request: Request):
    if not RID_RE.match(rid):
        raise kind_error("validation", "reference_id 不合法", detail=rid)
    project, _store = _project(request, pid)
    _require_paperish(project)
    removed = await asyncio.to_thread(library_pdf.delete_pdf, project.dir, rid)
    if not removed:
        raise kind_error("not_found", "该文献尚未附加 PDF 原文", detail=rid)
    return {"ok": True}
