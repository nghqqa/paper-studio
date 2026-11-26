# -*- coding: utf-8 -*-
"""智能文献管理 Zotero 子路由（集合列举 / 预览 / 一键刷新 / 导入回显）。"""

from __future__ import annotations

import asyncio
import json
import os

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app import auth
from app.domain import library, library_ops, library_sources
from app.domain import zotero_sources as zotero
from app.domain.library import bib_files, format_bibtex, load_index
from app.errors import kind_error

from .library_shared import (
    _ZOTERO_IMPORTS_FILE,
    MAX_ENTRIES_PER_COMMIT,
    CommitSource,
    _current_index,
    _library_mode,
    _project,
    _record_zotero_import,
    _require_paperish,
    _zotero_http_error,
    _zotero_key,
)

router = APIRouter(prefix="/api/projects/{pid}", tags=["library"])


class ZoteroGroupIn(BaseModel):
    group_id: str = Field(default="", max_length=300)  # 纯数字 ID 或 zotero.org/groups/<id> 链接（user 库可空）
    library_type: str = Field(default="group", max_length=10)
    zotero_user_id: str | None = Field(default=None, max_length=40)


class ZoteroPreviewIn(ZoteroGroupIn):
    collection_key: str | None = Field(default=None, max_length=16)
    library_type: str = Field(default="group", max_length=10)
    zotero_user_id: str | None = Field(default=None, max_length=40)


class ZoteroRefreshIn(BaseModel):
    """刷新锚点：与 zotero-imports.json 记录同构（group_name 仅供展示）。"""

    library_type: str = Field(default="group", max_length=10)
    group_id: int | None = None
    collection_key: str | None = Field(default=None, max_length=16)
    group_name: str = Field(default="", max_length=300)
    zotero_user_id: str | None = Field(default=None, max_length=40)


class ZoteroRefreshCommitIn(ZoteroRefreshIn):
    target_bib: str | None = None
    base_sha: str | None = None  # bib 模式必填（乐观锁；apply_refresh_to_bib 单次校验）
    additions: list[dict] = Field(default_factory=list, max_length=MAX_ENTRIES_PER_COMMIT)
    updates: list[dict] = Field(default_factory=list, max_length=MAX_ENTRIES_PER_COMMIT)
    removals: list[str] = Field(default_factory=list, max_length=MAX_ENTRIES_PER_COMMIT)
    remove_from_citation_order: bool = False


@router.post("/library/zotero/collections")
async def zotero_collections(pid: str, body: ZoteroGroupIn, request: Request, user: auth.CurrentUser = None):
    """群组/个人库的集合列表（解析预览不落盘）。v2：library_type=user 走个人库（需已存 Key）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    library_type = body.library_type if body.library_type in ("group", "user") else "group"
    key = _zotero_key(user, library_type)
    try:
        if library_type == "user":
            uid = zotero.parse_user_id(body.zotero_user_id or "")
            if not key:
                raise kind_error("validation", "个人库需要先配置 Zotero API Key（文献面板「私有库授权」）")
            meta, collections = await asyncio.gather(
                zotero.user_meta(uid, key), zotero.user_collections(uid, key)
            )
        else:
            gid = zotero.parse_group_id(body.group_id)
            meta, collections = await asyncio.gather(
                zotero.group_meta(gid, api_key=key), zotero.list_collections(gid, api_key=key)
            )
    except zotero.ZoteroError as e:
        raise _zotero_http_error(e, user)
    return {"group": meta, "collections": collections}


@router.post("/library/zotero/preview")
async def zotero_preview(pid: str, body: ZoteroPreviewIn, request: Request, user: auth.CurrentUser = None):
    """拉取群组/集合/个人库 BibTeX 并走与 /library/import 相同的解析+查重，返回同构 entries（不落盘）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    if body.library_type not in ("group", "user"):
        raise kind_error("validation", "library_type 须为 group 或 user", detail=body.library_type)
    key = _zotero_key(user, body.library_type)
    if body.library_type == "user":
        body.zotero_user_id = zotero.parse_user_id(body.zotero_user_id or "")
    try:
        if body.library_type == "user":
            uid = body.zotero_user_id
            if not key:
                raise kind_error("validation", "个人库需要先配置 Zotero API Key（文献面板「私有库授权」）")
            meta = await zotero.user_meta(uid, key)
            fetched = await zotero.fetch_user_bibtex(uid, body.collection_key, api_key=key)
        else:
            gid = zotero.parse_group_id(body.group_id)
            meta = await zotero.group_meta(gid, api_key=key)
            fetched = await zotero.fetch_bibtex(gid, body.collection_key, api_key=key)
    except zotero.ZoteroError as e:
        raise _zotero_http_error(e, user)
    text = fetched["bibtex"]
    source_meta = {
        "provider": "zotero",
        "library_type": body.library_type,
        "group_id": gid if body.library_type == "group" else None,
        "collection_key": body.collection_key,
        "zotero_user_id": body.zotero_user_id if body.library_type == "user" else None,
    }
    if not text.strip():
        return {
            "entries": [],
            "errors": [],
            "total_blocks": 0,
            "group": meta,
            "source": {**source_meta, "truncated": False},
            "notice": "该库/集合没有可导入的顶层条目",
        }
    index = await _current_index(project)
    parsed = await asyncio.to_thread(library.parse_bibtex_text, text)
    out_entries, errors, total_blocks = library_ops.annotate_import_preview(parsed, index)
    return {
        "entries": out_entries,
        "errors": errors,
        "total_blocks": total_blocks,
        "group": meta,
        "source": {**source_meta, "truncated": bool(fetched["truncated"])},
    }


@router.post("/library/zotero/refresh-preview")
async def zotero_refresh_preview(
    pid: str,
    body: ZoteroRefreshIn,
    request: Request,
    user: auth.CurrentUser = None,
):
    """一键刷新预览：绕缓存按锚点重拉 BibTeX，与当前库按 DOI→arXiv→指纹→key 分类 added/updated/removed/unchanged；不落盘。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    mode = _library_mode(project)
    if body.library_type not in ("group", "user"):
        raise kind_error("validation", "library_type 须为 group 或 user", detail=body.library_type)
    key = _zotero_key(user, body.library_type)
    if body.library_type == "user":
        body.zotero_user_id = zotero.parse_user_id(body.zotero_user_id or "")
    try:
        library_sources._cache_clear("zotero:")
        if body.library_type == "user":
            uid = body.zotero_user_id
            if not key:
                raise kind_error("validation", "个人库刷新需要先配置 Zotero API Key（文献面板「私有库授权」）")
            fetched = await zotero.fetch_user_bibtex(uid, body.collection_key, api_key=key)
        else:
            if not body.group_id:
                raise kind_error("validation", "缺少 group_id 刷新锚点")
            fetched = await zotero.fetch_bibtex(int(body.group_id), body.collection_key, api_key=key)
    except zotero.ZoteroError as e:
        raise _zotero_http_error(e, user)
    source = library_ops.refresh_source_dict(body)
    parsed = await asyncio.to_thread(library.parse_bibtex_text, fetched["bibtex"])
    index = await _current_index(project)
    summary = library_ops.build_zotero_refresh_preview_items(
        parsed,
        index,
        library_type=body.library_type,
        group_id=body.group_id,
        zotero_user_id=body.zotero_user_id,
        collection_key=body.collection_key,
        mode=mode,
    )
    return {
        "source": source,
        "mode": mode,
        "truncated": bool(fetched["truncated"]),
        **summary,
    }


async def _zotero_refresh_commit_bib(project, body: ZoteroRefreshCommitIn, source: dict) -> dict:
    """bib 模式刷新提交：不支持 removals；库内单次 base 校验后全量合成一次落盘。"""
    if body.removals:
        raise kind_error("validation", "bib 模式以 .bib 为事实源，不支持自动删除远端已移除条目（请手动编辑 .bib）")
    if not body.target_bib or body.target_bib not in bib_files(project):
        raise kind_error("validation", "请选择工程内已存在的 .bib 文件", detail=str(body.target_bib))
    if not body.base_sha:
        raise kind_error("validation", "bib 模式刷新需要 base_sha 乐观锁（先读取目标 .bib 再提交）")
    index = await _current_index(project)
    add_ents = []
    for raw in body.additions:
        ent = library_ops.validate_refresh_entry(raw, source)
        ent.reference_id = library.new_reference_id()
        ent.origin = "import"
        ent.bib_files = [body.target_bib]
        add_ents.append(ent)
    replacements: list = []
    for upd in body.updates:
        rid = str(upd.get("reference_id", ""))
        local = next((e for e in index.entries if e.reference_id == rid), None)
        if local is None or not local.raw_bibtex:
            raise kind_error("stale", "待更新条目在当前 .bib 索引中不存在，请重建文献索引后重试", detail=rid)
        remote = library_ops.validate_refresh_entry(dict(upd.get("entry") or {}), local.source or source)
        remote.citation_key = local.citation_key
        remote.raw_bibtex = format_bibtex(remote)
        replacements.append((local.raw_bibtex, remote.raw_bibtex))
    await asyncio.to_thread(
        library.apply_refresh_to_bib,
        project,
        body.target_bib,
        body.base_sha,
        replacements,
        add_ents,
    )
    await asyncio.to_thread(library.rebuild_from_bib, project)
    await asyncio.to_thread(
        _record_zotero_import,
        project.dir,
        CommitSource(**source),
        len(body.additions),
        body.target_bib,
        True,
    )
    return {"ok": True, "applied": {"added": len(add_ents), "updated": len(replacements), "removed": 0}}


@router.post("/library/zotero/refresh-commit")
async def zotero_refresh_commit(
    pid: str,
    body: ZoteroRefreshCommitIn,
    request: Request,
    user: auth.CurrentUser = None,
):
    """刷新提交（作者勾选后）：updates 保持原 reference_id/citation_key；citation_order 保护。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    mode = _library_mode(project)
    source = library_ops.refresh_source_dict(body)
    if mode == "bib":
        return await _zotero_refresh_commit_bib(project, body, source)
    index = await asyncio.to_thread(load_index, project.dir)
    by_rid = {e.reference_id: e for e in index.entries}
    for rid in body.removals:
        if rid not in by_rid:
            raise kind_error("not_found", f"待删除条目不存在：{rid}", detail=rid)
    order_hit = [rid for rid in body.removals if rid in index.citation_order]
    if order_hit and not body.remove_from_citation_order:
        raise kind_error(
            "validation",
            "以下条目在引用顺序表中，直接删除会断号：" + "、".join(order_hit) + "；请勾选「同时从引用顺序表移除」后重试",
        )
    add_ents = []
    for raw in body.additions:
        ent = library_ops.validate_refresh_entry(raw, source)
        ent.reference_id = library.new_reference_id()
        ent.origin = "import"
        add_ents.append(ent)
    upd_map: dict = {}
    for upd in body.updates:
        rid = str(upd.get("reference_id", ""))
        local = by_rid.get(rid)
        if local is None:
            raise kind_error("not_found", f"待更新条目不存在：{rid}", detail=rid)
        remote = library_ops.validate_refresh_entry(dict(upd.get("entry") or {}), local.source or source)
        remote.reference_id = local.reference_id
        remote.citation_key = local.citation_key
        remote.created_at = local.created_at
        remote.origin = local.origin
        remote.bib_files = local.bib_files
        upd_map[rid] = remote
    remove_set = set(body.removals)
    final = []
    for e in index.entries:
        if e.reference_id in remove_set:
            continue
        final.append(upd_map.get(e.reference_id, e))
    final.extend(add_ents)
    index.entries = final
    if body.remove_from_citation_order:
        index.citation_order = [r for r in index.citation_order if r not in remove_set]
    await asyncio.to_thread(library.save_index, project.dir, index)
    await asyncio.to_thread(
        _record_zotero_import,
        project.dir,
        CommitSource(**source),
        len(body.additions),
        None,
        True,
    )
    return {
        "ok": True,
        "applied": {"added": len(add_ents), "updated": len(upd_map), "removed": len(remove_set)},
        "total": len(index.entries),
    }


@router.get("/library/zotero/imports")
async def zotero_imports_list(pid: str, request: Request):
    """导入记录回显（B2 修补）：重开工程后恢复最近一次可刷新来源（不带 Key 本体）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    path = os.path.join(project.dir, _ZOTERO_IMPORTS_FILE)
    rows: list = []
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                rows = json.load(f)
        except (OSError, ValueError):
            rows = []
    if not isinstance(rows, list):
        rows = []
    latest = next(
        (
            r
            for r in reversed(rows)
            if isinstance(r, dict) and r.get("provider") == "zotero" and (r.get("group_id") or r.get("zotero_user_id"))
        ),
        None,
    )
    return {"imports": rows[-10:], "latest_refreshable": latest}
