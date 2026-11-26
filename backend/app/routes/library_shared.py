# -*- coding: utf-8 -*-
"""文献管理路由公共辅助函数与共享请求模型。"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from app import atomic, config
from app.domain import library, zotero_credentials
from app.domain.library import LibraryEntry, format_bibtex, load_index
from app.errors import error_detail, kind_error

MAX_IMPORT_TEXT = 2 * 1024 * 1024
MAX_ENTRIES_PER_COMMIT = 200
_ZOTERO_IMPORTS_FILE = os.path.join(".studio", "library", "zotero-imports.json")


class CommitSource(BaseModel):
    """导入来源元数据（provider 记录；Zotero v2 刷新的锚点）。

    v2 追加 library_type（group|user）与 zotero_user_id（个人库）；旧记录缺省容忍。"""

    provider: str = Field(default="zotero", max_length=40)
    group_id: int | None = None
    collection_key: str | None = Field(default=None, max_length=16)
    group_name: str = Field(default="", max_length=300)
    library_type: str = Field(default="group", max_length=10)
    zotero_user_id: str | None = Field(default=None, max_length=40)


def _project(request: Request, pid: str):
    store = request.app.state.store
    return store.get(pid), store


def _require_paperish(project) -> None:
    fmt = (project.settings or {}).get("source_format")
    if fmt not in ("latex", "docx", "markdown"):
        raise kind_error("validation", "项目类型不支持文献管理", detail=str(fmt))


def _library_mode(project) -> str:
    return "bib" if (project.settings or {}).get("source_format") == "latex" else "index"


async def _current_index(project) -> library.LibraryIndex:
    """按模式取最新索引（bib 模式 = 重建视图；index 模式 = 读文件）。"""
    if _library_mode(project) == "bib":
        return (await asyncio.to_thread(library.rebuild_from_bib, project))[0]
    return load_index(project.dir)


async def _persist_entry(
    project, index: library.LibraryIndex, ent: LibraryEntry, mode: str, base_sha: str | None = None
) -> dict:
    """把（已修改的）条目写回事实源并返回 {entry, bib_sha}。"""
    if mode == "bib":
        rel = (ent.bib_files or [""])[0]
        if not rel:
            raise kind_error("not_found", "条目未关联 .bib 文件（请先重建索引）")
        new_raw = format_bibtex(ent)
        from app.domain.latex_build import read_source_file

        cur = await asyncio.to_thread(read_source_file, project, rel)
        library._check_base(cur, base_sha, rel)
        target = None
        for blk, _line, _t in library.split_bib_blocks(cur):
            if re.search(r"@\w+\s*\{\s*" + re.escape(ent.citation_key) + r"\s*,", blk):
                target = blk
                break
        if target is None:
            raise kind_error("stale", "在 .bib 中未找到该条目（可能已被直接编辑），请刷新后重试")
        new_content = cur.replace(target, new_raw, 1)
        sha = await asyncio.to_thread(library._write_bib, project, rel, new_content)
        index2, _ = await asyncio.to_thread(library.rebuild_from_bib, project)
        out = next((e for e in index2.entries if e.reference_id == ent.reference_id), None)
        if out is not None:
            # rebuild 的对账从「写盘前的旧索引」取库外元数据，会把本次内存中的
            # 确认/建议状态覆盖回去；以本次操作后的状态为准回写（字段本体在 bib，元数据在 index）。
            out.verified = ent.verified
            out.field_provenance = ent.field_provenance
            out.queries = ent.queries
            out.retraction = ent.retraction
            out.suggested = ent.suggested
            out.suggested_model = ent.suggested_model
            cur_index = await asyncio.to_thread(load_index, project.dir)
            cur_index.entries = [
                out if e.reference_id == out.reference_id else e for e in cur_index.entries
            ]
            await asyncio.to_thread(library.save_index, project.dir, cur_index)
        return {"entry": out.model_dump(mode="json") if out else None, "bib_sha": sha}
    library.save_index(project.dir, index)
    return {"entry": ent.model_dump(mode="json"), "bib_sha": None}


def _record_zotero_import(
    project_dir: str,
    src: CommitSource,
    count: int,
    target_bib: str | None,
    refresh: bool = False,
) -> None:
    """追加导入记录（provider 元数据；v2 按 group/collection 重新拉取刷新的锚点）。"""
    path = os.path.join(project_dir, _ZOTERO_IMPORTS_FILE)
    rows: list[dict] = []
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                rows = json.load(f)
        except (OSError, ValueError):
            rows = []
    rows.append({
        "at": time.time(),
        "provider": src.provider,
        "group_id": src.group_id,
        "collection_key": src.collection_key,
        "group_name": src.group_name,
        "count": count,
        "target_bib": target_bib,
        "library_type": getattr(src, "library_type", None) or "group",
        "zotero_user_id": getattr(src, "zotero_user_id", None),
        "refresh": bool(refresh),
    })
    os.makedirs(os.path.dirname(path), exist_ok=True)
    atomic.write_json(path, rows[-50:])


def _zotero_http_error(e, user) -> HTTPException:
    """ZoteroError/SourceError → HTTP：错误文本先经凭据 redact 兜底擦除（key 只应在 header，防回显泄漏）。"""
    redacted = zotero_credentials.redact(e.message, getattr(user, "id", None))
    return HTTPException(e.status, error_detail(e.kind, redacted))


def _zotero_key(user, library_type: str) -> str | None:
    """已存 Zotero API Key（无登录态/未配置 → None）。个人库必须有登录态与 Key。"""
    from app import auth

    if config.AUTH_ON and user is None:
        if library_type == "user":
            raise auth.login_required()
        return None
    data = zotero_credentials.load_credentials(getattr(user, "id", None))
    return str(data.get("api_key")) if data else None
