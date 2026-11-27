# -*- coding: utf-8 -*-
"""跨项目共享文献库与 LaTeX 片段库路由。"""
from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app import atomic, auth, config
from app.domain import library, shared_assets
from app.domain.library import KEY_RE, LibraryEntry, bib_files, create_bib_file, format_bibtex
from app.errors import kind_error

router = APIRouter(tags=["shared-assets"])


class SharedLibraryIn(BaseModel):
    bibtex: str | None = Field(default=None, max_length=200000)
    entries: list[dict] = Field(default_factory=list, max_length=100)
    from_project_id: str | None = Field(default=None, max_length=64)
    reference_ids: list[str] = Field(default_factory=list, max_length=100)


class ImportFromSharedIn(BaseModel):
    item_ids: list[str] = Field(min_length=1, max_length=100)
    target_bib: str | None = None


class SnippetIn(BaseModel):
    id: str | None = Field(default=None, max_length=40)
    title: str = Field(min_length=1, max_length=80)
    category: str = Field(default="常用", max_length=32)
    description: str = Field(default="", max_length=240)
    code: str = Field(min_length=1, max_length=20000)


def _uid(user) -> str:
    if user is None:
        if config.AUTH_ON:
            raise auth.login_required()
        return "anon"
    return str(user.id)


@router.get("/api/shared/library", dependencies=[Depends(auth.require_login)])
async def get_shared_library(user: auth.CurrentUser = None):
    items = await asyncio.to_thread(shared_assets.list_shared_library, _uid(user))
    return {"items": items}


@router.post("/api/shared/library", dependencies=[Depends(auth.require_login)])
async def add_shared_library(body: SharedLibraryIn, request: Request, user: auth.CurrentUser = None):
    uid = _uid(user)
    collected: list[dict] = list(body.entries)
    if body.bibtex and body.bibtex.strip():
        parsed = await asyncio.to_thread(library.parse_citation_text, body.bibtex)
        for ent in parsed.entries:
            collected.append(ent.model_dump(mode="json"))
    if body.from_project_id:
        await auth.check_access(request, user, body.from_project_id, "viewer")
        proj = request.app.state.store.get(body.from_project_id)
        if proj.settings.get("source_format") == "latex":
            idx, _err = await asyncio.to_thread(library.rebuild_from_bib, proj)
        else:
            idx = await asyncio.to_thread(library.load_index, proj.dir)
        want = set(body.reference_ids)
        for ent in idx.entries:
            if not want or ent.reference_id in want:
                d = ent.model_dump(mode="json")
                d["source_project"] = proj.title or proj.id
                collected.append(d)
    added, items = await asyncio.to_thread(shared_assets.add_shared_library_items, uid, collected)
    return {"added": len(added), "items": items}


@router.delete("/api/shared/library/{item_id}", dependencies=[Depends(auth.require_login)])
async def delete_shared_library_item(item_id: str, user: auth.CurrentUser = None):
    ok, items = await asyncio.to_thread(shared_assets.delete_shared_library_item, _uid(user), item_id)
    if not ok:
        raise kind_error("not_found", "共享文献条目不存在", detail=item_id)
    return {"ok": True, "items": items}


def _build_import_entries(picked: list[dict], used_keys: set[str]) -> list[LibraryEntry]:
    new_entries: list[LibraryEntry] = []
    for raw in picked:
        ent = LibraryEntry(
            reference_id=library.new_reference_id(),
            citation_key="tmp",
            entry_type=str(raw.get("entry_type") or "article"),
            title=str(raw.get("title") or ""),
            authors=list(raw.get("authors") or []),
            year=str(raw["year"]) if raw.get("year") is not None else None,
            venue=raw.get("venue"),
            doi=raw.get("doi"),
            arxiv_id=raw.get("arxiv_id"),
            url=raw.get("url"),
            abstract=raw.get("abstract"),
            raw_bibtex=str(raw.get("raw_bibtex") or ""),
        )
        base_key = str(raw.get("citation_key") or "").strip()
        if not base_key or not KEY_RE.match(base_key):
            raw_sugg = library.suggested_key(ent)
            base_key = re.sub(r"[^A-Za-z0-9_:.+/#-]", "", raw_sugg)[:120]
            if not base_key or not KEY_RE.match(base_key):
                base_key = f"ref{re.sub(r'[^0-9]', '', ent.year or '')[:8]}_{ent.reference_id[-6:]}"
        key = base_key
        suffix = 2
        while key in used_keys:
            key = f"{base_key}_{suffix}"
            suffix += 1
        used_keys.add(key)
        ent.citation_key = key
        if not ent.raw_bibtex or key != str(raw.get("citation_key") or "").strip():
            ent.raw_bibtex = format_bibtex(ent)
        new_entries.append(ent)
    return new_entries


def _append_non_latex_library(project_dir: str, picked: list[dict]) -> tuple[list[str], int]:
    with atomic.studio_lock(project_dir, "library"):
        index = library.load_index(project_dir)
        used_keys = {e.citation_key for e in index.entries}
        new_entries = _build_import_entries(picked, used_keys)
        for ent in new_entries:
            ent.origin = "import"
            index.entries.append(ent)
        library.save_index(project_dir, index)
        return [e.reference_id for e in new_entries], len(index.entries)


@router.post("/api/projects/{pid}/library/import-from-shared")
async def import_from_shared(pid: str, body: ImportFromSharedIn, request: Request, user: auth.CurrentUser = None):
    uid = _uid(user)
    project = request.app.state.store.get(pid)
    fmt = project.settings.get("source_format")
    shared = await asyncio.to_thread(shared_assets.list_shared_library, uid)
    want = set(body.item_ids)
    picked = [x for x in shared if x.get("id") in want]
    if not picked:
        raise kind_error("not_found", "未找到所选共享文献条目")

    if fmt == "latex":
        existing_idx, _bib_errs = await asyncio.to_thread(library.rebuild_from_bib, project)
        used_keys = {e.citation_key for e in existing_idx.entries}
        new_entries = _build_import_entries(picked, used_keys)
        bibs = bib_files(project)
        target_bib = body.target_bib if body.target_bib in bibs else (bibs[0] if bibs else None)
        if not target_bib:
            await asyncio.to_thread(create_bib_file, project, "refs.bib")
            target_bib = "refs.bib"
        for ent in new_entries:
            ent.bib_files = [target_bib]
        await asyncio.to_thread(library.append_entries_to_bib, project, target_bib, new_entries, None)
        hints = {(target_bib, ent.citation_key): ent.reference_id for ent in new_entries}
        index, _errors = await asyncio.to_thread(library.rebuild_from_bib, project, hints)
        return {
            "imported": len(new_entries),
            "reference_ids": [e.reference_id for e in new_entries],
            "total": len(index.entries),
        }

    ref_ids, total = await asyncio.to_thread(_append_non_latex_library, project.dir, picked)
    return {
        "imported": len(ref_ids),
        "reference_ids": ref_ids,
        "total": total,
    }


@router.get("/api/shared/snippets", dependencies=[Depends(auth.require_login)])
async def get_shared_snippets(user: auth.CurrentUser = None):
    items = await asyncio.to_thread(shared_assets.list_snippets, _uid(user))
    return {"items": items}


@router.post("/api/shared/snippets", dependencies=[Depends(auth.require_login)])
async def save_shared_snippet(body: SnippetIn, user: auth.CurrentUser = None):
    saved, items = await asyncio.to_thread(shared_assets.upsert_snippet, _uid(user), body.model_dump())
    return {"item": saved, "items": items}


@router.patch("/api/shared/snippets/{sid}", dependencies=[Depends(auth.require_login)])
async def update_shared_snippet(sid: str, body: SnippetIn, user: auth.CurrentUser = None):
    saved, items = await asyncio.to_thread(shared_assets.update_snippet, _uid(user), sid, body.model_dump())
    if saved is None:
        raise kind_error("not_found", "片段不存在", detail=sid)
    return {"item": saved, "items": items}


@router.delete("/api/shared/snippets/{sid}", dependencies=[Depends(auth.require_login)])
async def remove_shared_snippet(sid: str, user: auth.CurrentUser = None):
    ok, items = await asyncio.to_thread(shared_assets.delete_snippet, _uid(user), sid)
    if not ok:
        raise kind_error("not_found", "片段不存在", detail=sid)
    return {"ok": True, "items": items}
