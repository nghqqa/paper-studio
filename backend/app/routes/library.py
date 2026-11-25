# -*- coding: utf-8 -*-
"""智能文献管理路由（v0.4）：导入/查询/去重/合并/导出/引用插入支撑。

权限：全局 project_access + ROUTE_ROLE——读与外部查询 viewer；写（提交/编辑/删除/合并/建 bib 文件）editor。
外部查询（lookup/search）是服务器出站、无项目写入 ⇒ viewer 可用（学生角色查文献是正常工作流）。

边界：
- LaTeX 工程：bib 是事实源；本路由只追加/改写**用户确认过的**条目，且全部走 base-sha 乐观锁 + 原子写；
  正文 cite 改名同样逐文件 base 校验——绝不后台重写未保存草稿（浏览器脏文件由前端先走自身保存链）。
- 外部源返回内容一律视为数据；候选必须经用户确认才落盘（commit 前不写任何文件）。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app import atomic, auth, config
from app.domain import (
    citation_verify,
    gbt7714,
    library,
    library_ops,
    library_sources,
    zotero_credentials,
)
from app.domain import (
    zotero_sources as zotero,
)
from app.domain.library import (
    KEY_RE,
    RID_RE,
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

router = APIRouter(prefix="/api/projects/{pid}", tags=["library"])

MAX_IMPORT_TEXT = 2 * 1024 * 1024
MAX_ENTRIES_PER_COMMIT = 200


def _project(request: Request, pid: str):
    store = request.app.state.store
    return store.get(pid), store


def _require_paperish(project) -> None:
    fmt = (project.settings or {}).get("source_format")
    if fmt not in ("latex", "docx", "structured", "markdown"):
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


# ---------------------------------------------------------------- 索引 / 重建 ----


@router.get("/library")
async def get_library(pid: str, request: Request):
    project, _store = _project(request, pid)
    _require_paperish(project)
    mode = _library_mode(project)
    if mode == "bib":
        # 源内容摘要缓存（性能基线 2026-10-24）：.bib/.cite 使用图未变 → 直接读已建索引与缓存诊断，
        # 跳过全量重解析；provenance 类只写 index.json 的操作由快路径现读天然可见。
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
                library.save_rebuild_cache, project.dir, digest, diag, parse_errors)
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


# ---------------------------------------------------------------- 导入 ----


class ImportIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_IMPORT_TEXT)


@router.post("/library/import")
async def import_bibtex(pid: str, body: ImportIn, request: Request):
    """解析预览（不落盘）：逐条报错 + 逐条查重（key 冲突 / DOI / arXiv / 疑似重复）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    index = await _current_index(project)
    # 粘贴导入自动分流：@条目 → BibTeX 解析器；纯文本 → GB/T 7714 逐行解析
    parsed = await asyncio.to_thread(library.parse_citation_text, body.text)
    out_entries, errors, total_blocks = library_ops.annotate_import_preview(parsed, index)
    return {"entries": out_entries, "errors": errors, "total_blocks": total_blocks}


class CommitSource(BaseModel):
    """导入来源元数据（provider 记录；Zotero v2 刷新的锚点）。

    v2 追加 library_type（group|user）与 zotero_user_id（个人库）；旧记录缺省容忍。"""
    provider: str = Field(default="zotero", max_length=40)
    group_id: int | None = None
    collection_key: str | None = Field(default=None, max_length=16)
    group_name: str = Field(default="", max_length=300)
    library_type: str = Field(default="group", max_length=10)
    zotero_user_id: str | None = Field(default=None, max_length=40)


class CommitIn(BaseModel):
    entries: list[dict] = Field(min_length=1, max_length=MAX_ENTRIES_PER_COMMIT)
    target_bib: str | None = None
    base_sha: str | None = None  # 目标 .bib 的乐观锁（bib 模式必填）
    source: CommitSource | None = None


_ZOTERO_IMPORTS_FILE = os.path.join(".studio", "library", "zotero-imports.json")


def _record_zotero_import(project_dir: str, src: CommitSource, count: int, target_bib: str | None,
                          refresh: bool = False) -> None:
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
        "at": time.time(), "provider": src.provider, "group_id": src.group_id,
        "collection_key": src.collection_key, "group_name": src.group_name,
        "count": count, "target_bib": target_bib,
        # v2 追加字段（旧行缺省容忍，读端 .get()）
        "library_type": getattr(src, "library_type", None) or "group",
        "zotero_user_id": getattr(src, "zotero_user_id", None),
        "refresh": bool(refresh),
    })
    os.makedirs(os.path.dirname(path), exist_ok=True)
    atomic.write_json(path, rows[-50:])


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
            # 溯源入条目（B2 一键刷新 removed 检测依据；bib 模式 rebuild 后会丢失，属已知边界）
            ent.source = body.source.model_dump()
        entries.append(ent)
    if mode == "bib":
        if not body.target_bib or body.target_bib not in bib_files(project):
            raise kind_error(
                "validation", "请选择工程内已存在的 .bib 文件（可先在面板新建）", detail=str(body.target_bib))
        for ent in entries:
            ent.bib_files = [body.target_bib]
        await asyncio.to_thread(
            library.append_entries_to_bib, project, body.target_bib, entries, body.base_sha)
        # 预分配 rid 直接喂给重建（hints 优先于旧索引对账）——跨请求稳定，无回查竞态
        hints = {(body.target_bib, ent.citation_key): ent.reference_id for ent in entries}
        index, _errors = await asyncio.to_thread(
            library.rebuild_from_bib, project, hints)
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
            _record_zotero_import, project.dir, body.source, len(entries), body.target_bib)
    return {"reference_ids": new_rids, "bib_sha": new_sha, "total": len(index.entries)}


# ---------------------------------------------------------------- 查询（外部源） ----


class LookupIn(BaseModel):
    doi: str | None = None
    arxiv: str | None = None
    query: str | None = None
    reference_id: str | None = None  # 提供时返回与现有条目的字段差异


# ---------------------------------------------------------------- Zotero 公开群组导入（v0.5） ----


class ZoteroGroupIn(BaseModel):
    group_id: str = Field(default="", max_length=300)  # 纯数字 ID 或 zotero.org/groups/<id> 链接（user 库可空）
    library_type: str = Field(default="group", max_length=10)
    zotero_user_id: str | None = Field(default=None, max_length=40)


class ZoteroPreviewIn(ZoteroGroupIn):
    collection_key: str | None = Field(default=None, max_length=16)
    # v2：library_type="user" 时走个人库（/users/{zotero_user_id}，需已存 API Key）
    library_type: str = Field(default="group", max_length=10)
    zotero_user_id: str | None = Field(default=None, max_length=40)


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
                zotero.user_meta(uid, key), zotero.user_collections(uid, key))
        else:
            gid = zotero.parse_group_id(body.group_id)
            meta, collections = await asyncio.gather(
                zotero.group_meta(gid, api_key=key), zotero.list_collections(gid, api_key=key))
    except zotero.ZoteroError as e:
        raise _zotero_http_error(e, user)
    return {"group": meta, "collections": collections}


def _zotero_http_error(e: zotero.ZoteroError, user) -> HTTPException:
    """ZoteroError → HTTP：错误文本先经凭据 redact 兜底擦除（key 只应在 header，防回显泄漏）。"""
    redacted = zotero_credentials.redact(e.message, getattr(user, "id", None))
    return HTTPException(e.status, error_detail(e.kind, redacted))


def _zotero_key(user, library_type: str) -> str | None:
    """已存 Zotero API Key（无登录态/未配置 → None）。个人库必须有登录态与 Key。"""
    if config.AUTH_ON and user is None:
        if library_type == "user":
            raise auth.login_required()
        return None
    data = zotero_credentials.load_credentials(getattr(user, "id", None))
    return str(data.get("api_key")) if data else None


@router.post("/library/zotero/preview")
async def zotero_preview(pid: str, body: ZoteroPreviewIn, request: Request, user: auth.CurrentUser = None):
    """拉取群组/集合/个人库 BibTeX 并走与 /library/import 相同的解析+查重，返回同构 entries（不落盘）。
    复用现有 import → commit 管线；provider 元数据在 commit 的 source 字段落记录（v2 刷新锚点）。
    v2：公开群组免 key 行为不变；私有群组/个人库带已存 API Key（Zotero-API-Key 头）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    if body.library_type not in ("group", "user"):
        raise kind_error("validation", "library_type 须为 group 或 user", detail=body.library_type)
    key = _zotero_key(user, body.library_type)
    if body.library_type == "user":
        # 入口清洗回写：source_meta / 锚点记录一律使用清洗后的纯数字 uid
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
    source_meta = {"provider": "zotero", "library_type": body.library_type,
                   "group_id": gid if body.library_type == "group" else None,
                   "collection_key": body.collection_key,
                   "zotero_user_id": body.zotero_user_id if body.library_type == "user" else None}
    if not text.strip():
        return {"entries": [], "errors": [], "total_blocks": 0, "group": meta,
                "source": {**source_meta, "truncated": False},
                "notice": "该库/集合没有可导入的顶层条目"}
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


# ---------------------------------------------------------------- Zotero 一键刷新（v2/B2） ----


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


@router.post("/library/zotero/refresh-preview")
async def zotero_refresh_preview(pid: str, body: ZoteroRefreshIn, request: Request,
                                 user: auth.CurrentUser = None):
    """一键刷新预览：绕缓存按锚点重拉 BibTeX，与当前库按 DOI→arXiv→指纹→key 分类
    added/updated/removed/unchanged；不落盘。removed 仅 index 模式可用（bib 模式诚实降级提示）。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    mode = _library_mode(project)
    if body.library_type not in ("group", "user"):
        raise kind_error("validation", "library_type 须为 group 或 user", detail=body.library_type)
    key = _zotero_key(user, body.library_type)
    if body.library_type == "user":
        body.zotero_user_id = zotero.parse_user_id(body.zotero_user_id or "")
    try:
        library_sources._cache_clear("zotero:")  # 刷新必须绕过 TTL 缓存
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
        remote.citation_key = local.citation_key      # key = 正文引用锚，不随远端漂移
        remote.raw_bibtex = format_bibtex(remote)
        replacements.append((local.raw_bibtex, remote.raw_bibtex))
    await asyncio.to_thread(library.apply_refresh_to_bib, project, body.target_bib,
                            body.base_sha, replacements, add_ents)
    await asyncio.to_thread(library.rebuild_from_bib, project)
    await asyncio.to_thread(_record_zotero_import, project.dir,
                            CommitSource(**source), len(body.additions), body.target_bib, True)
    return {"ok": True, "applied": {"added": len(add_ents), "updated": len(replacements),
                                    "removed": 0}}


@router.post("/library/zotero/refresh-commit")
async def zotero_refresh_commit(pid: str, body: ZoteroRefreshCommitIn, request: Request,
                                user: auth.CurrentUser = None):
    """刷新提交（作者勾选后）：updates 保持原 reference_id/citation_key；citation_order 保护——
    removal 命中且未显式勾选「同时从引用顺序表移除」则整体拒绝；勾选后只摘除该 rid，
    其余顺序原样保留。index 模式单次 save_index 原子生效。"""
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
        raise kind_error("validation", "以下条目在引用顺序表中，直接删除会断号：" + "、".join(order_hit)
                         + "；请勾选「同时从引用顺序表移除」后重试")
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
        remote.reference_id = local.reference_id      # rid 稳定（citation_order/引用不受影响）
        remote.citation_key = local.citation_key      # key = 正文引用锚，不随远端漂移
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
    await asyncio.to_thread(_record_zotero_import, project.dir,
                            CommitSource(**source), len(body.additions), None, True)
    return {"ok": True, "applied": {"added": len(add_ents), "updated": len(upd_map),
                                    "removed": len(remove_set)},
            "total": len(index.entries)}


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
    latest = next((r for r in reversed(rows) if isinstance(r, dict) and r.get("provider") == "zotero"
                   and (r.get("group_id") or r.get("zotero_user_id"))), None)
    return {"imports": rows[-10:], "latest_refreshable": latest}


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


# ---------------------------------------------------------------- 条目操作 ----


class ConfirmIn(BaseModel):
    fields: list[str] = Field(default_factory=list)  # 空 = 整条确认


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


class EntryEditIn(BaseModel):
    fields: dict[str, str]
    base_sha: str | None = None  # bib 模式：条目所在 .bib 的锁


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


class DeleteIn(BaseModel):
    base_sha: str | None = None
    files_base: dict[str, str] = Field(default_factory=dict)  # 多文件时每文件锁


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
        return {"ok": True, "files": shas}
    index = await asyncio.to_thread(load_index, project.dir)
    before = len(index.entries)
    index.entries = [e for e in index.entries if e.reference_id != rid]
    if len(index.entries) == before:
        raise kind_error("not_found", "条目不存在", detail=rid)
    await asyncio.to_thread(library.save_index, project.dir, index)
    return {"ok": True, "files": []}


# ---------------------------------------------------------------- 合并 / 改名 ----


class MergeIn(BaseModel):
    survivor_rid: str
    loser_rid: str
    field_choices: dict[str, str] = Field(default_factory=dict)  # field → survivor|loser
    new_key: str | None = None
    bib_base: dict[str, str] = Field(default_factory=dict)  # 涉及 .bib 的锁
    tex_updates: list[dict] = Field(default_factory=list)  # [{path, base}] — 引用改名涉及的 .tex


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
        tex_results = await asyncio.to_thread(library.apply_cite_renames, project, [
            {"path": u.get("path"), "base": u.get("base"), "renames": renames} for u in body.tex_updates
        ])
    return {
        "merged_reference_id": merged.reference_id,
        "renames": renames,
        "bib_files": bib_results,
        "tex_updates": tex_results,
    }


class RenameIn(BaseModel):
    updates: list[dict]  # [{path, base, renames:{old:new}}]


@router.post("/library/apply-renames")
async def apply_renames(pid: str, body: RenameIn, request: Request, user: auth.CurrentUser = None):
    project, _store = _project(request, pid)
    if _library_mode(project) != "bib":
        raise kind_error("validation", "仅 LaTeX 工程有正文引用改名")
    results = await asyncio.to_thread(library.apply_cite_renames, project, body.updates)
    return {"results": results}


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


# ---------------------------------------------------------------- 引用图 / 导出 / 渲染 ----


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
        return Response(data, media_type="application/x-bibtex; charset=utf-8",
                        headers={"Content-Disposition": "attachment; filename*=utf-8''references.bib"})
    if format == "csl-json":
        data = json.dumps([entry_to_csl_json(e) for e in index.entries], ensure_ascii=False, indent=2)
        return Response(data, media_type="application/json; charset=utf-8",
                        headers={"Content-Disposition": "attachment; filename*=utf-8''references-csl.json"})
    raise kind_error("validation", f"不支持的导出格式：{format}", detail=format)


class BibliographyIn(BaseModel):
    order: list[str] = Field(min_length=1, max_length=500)  # 按正文首次出现顺序的 reference_id
    style: str = "ieee"


@router.post("/library/bibliography")
async def bibliography(pid: str, body: BibliographyIn, request: Request):
    """按给定顺序渲染编号引用与参考文献表（Word 插件用；LaTeX 参考文献由 BibTeX 在编译时生成）。
    样式：ieee = citeproc-py + vendored ieee.csl（行为不变）；gb-t-7714-2015 = 平台确定性国标渲染器。
    产物是平台引用对象文本，非 Word 原生域。"""
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
        return await asyncio.to_thread(_render_csl, [by_rid[rid] for rid in body.order], body.style, style_file)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — CSL 渲染失败如实报错
        raise HTTPException(502, error_detail("content", f"参考文献渲染失败：{e}"))


_render_csl = library_ops.render_csl_bibliography


class CitationRegisterIn(BaseModel):
    append: list[str] = Field(default_factory=list)


@router.post("/library/citations/register")
async def register_citations(pid: str, body: CitationRegisterIn, request: Request):
    """Word 静态引用的全局编号登记。append 中的 rid 若尚未在引用顺序表里则追加到尾部
    （编号 = 表中位置）；返回全局顺序。编号冲突（多次插入都被编成 [1]）由此表根治。"""
    project, _store = _project(request, pid)
    _require_paperish(project)
    if _library_mode(project) == "bib":
        raise kind_error("validation", "LaTeX 工程的引用编号由 BibTeX 编译时生成，无需登记")
    await _current_index(project)  # 确保索引已重建/落盘
    # 预览→登记读改写在项目锁内完成：两人并发登记时后到者必须看到先到者的顺序（防双 [1]）
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


# ---------------------------------------------------------------- AI 补全建议 ----


@router.post("/library/entries/{rid}/ai-suggest")
async def ai_suggest(pid: str, rid: str, request: Request, user: auth.CurrentUser = None):
    """AI 建议补全缺失字段：只存 suggested 层（未验证），不进 fields、不写 bib。
    采纳需用户显式 confirm；建议值绝不自动标记为已验证。"""
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
    missing = [f for f, v in (("title", ent.title), ("year", ent.year), ("venue", ent.venue),
                              ("pages", ent.pages), ("volume", ent.volume), ("doi", ent.doi)) if not v]
    if not missing:
        return {"suggested": {}, "model": None, "note": "无缺失字段"}
    sys_prompt = (
        "你是文献元数据助手。根据给定 BibTeX 条目的已知字段，补全缺失字段。"
        "只允许基于条目内线索（标题/作者/DOI 等）推断；不确定的值留空；禁止编造 DOI 与页码。"
        '输出严格 JSON 对象，只含缺失字段键（如 {"pages": "123-130", "volume": "30"}）。'
    )
    known = {k: v for k, v in (("title", ent.title), ("authors", "; ".join(ent.authors)), ("year", ent.year),
                               ("venue", ent.venue), ("entry_type", ent.entry_type), ("doi", ent.doi)) if v}
    try:
        result = await client.chat(
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": json.dumps(known, ensure_ascii=False)},
            ],
            "interactive", max_tokens=500, temperature=0.1,
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
    return {"suggested": suggested, "model": result.model, "note": "AI 建议未验证；采纳前请先经外部来源查询比对确认"}


# ---------------------------------------------------------------- 参考文献真实性核验（Citation Fact-Check） ----


class VerifyIn(BaseModel):
    reference_ids: list[str] | None = Field(default=None, max_length=100)


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
