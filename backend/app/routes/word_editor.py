"""Native Word user APIs (ACL) and DS-only signed document/callback endpoints."""

import asyncio
import json
import os
import re
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app import atomic, auth, config
from app.domain import events
from app.domain import word_documents as word
from app.domain.projects import ProjectError

router = APIRouter(tags=["word"])


class CreateIn(BaseModel):
    title: str = Field(default="未命名论文", max_length=200)
    template: str = "blank"
    venue: str = Field(default="", max_length=200)
    field: str = Field(default="", max_length=200)
    rank: str = Field(default="", max_length=200)


def _project(request: Request, pid: str):
    p = request.app.state.store.get(pid)
    if p.settings.get("source_format") != "docx":
        raise ProjectError("该项目不是原生 Word 工程", 400)
    return p


def _out(p):
    return {"id": p.id, "title": p.title, "source_format": "docx", "settings": p.settings}


async def _created(p, user):
    await auth.grant_owner(p.id, user)
    events.emit("case.created", pid=p.id, actor=events.actor_of(user), data={"title": p.title})
    return _out(p)


async def _permissions(pid):
    if not config.AUTH_ON:
        return {"allow_download": True, "allow_copy": True, "allow_comment": True}
    from app.auth import access

    return await access.get_settings(pid)


async def _download_allowed(pid):
    if not (await _permissions(pid)).get("allow_download", True):
        raise ProjectError("此文档已关闭下载权限", 403)


@router.post("/api/projects/word/create", dependencies=[Depends(auth.require_login)])
async def create(request: Request, body: CreateIn, user: auth.CurrentUser):
    word.require_ready()
    title = body.title.strip() or "未命名论文"
    submission = {k: getattr(body, k) for k in ("venue", "field", "rank")}
    data = await asyncio.to_thread(word.make_document, title, body.template)
    p = await asyncio.to_thread(word.create, request.app.state.store, title, data, submission,
                                "create:" + body.template)
    return await _created(p, user)


@router.post("/api/projects/word/import", dependencies=[Depends(auth.require_login)])
async def import_document(request: Request, user: auth.CurrentUser,
                          file: Annotated[UploadFile | None, File()] = None,
                          title: Annotated[str, Form()] = ""):
    word.require_ready()
    if file is None or not (file.filename or "").lower().endswith(".docx"):
        raise ProjectError("请上传 .docx 格式的 Word 文档", 422)
    data = bytearray()
    try:
        while chunk := await file.read(1024 * 1024):
            data.extend(chunk)
            if len(data) > config.WORD_MAX_BYTES:
                raise ProjectError("Word 文件超过 50 MB", 413)
    finally:
        await file.close()
    title = title.strip()[:200] or os.path.basename(file.filename or "论文.docx")[:-5][:200]
    p = await asyncio.to_thread(word.create, request.app.state.store, title, bytes(data))
    return await _created(p, user)


@router.get("/api/projects/{pid}/word/editor-config")
async def editor_config(pid: str, request: Request, user: auth.CurrentUser):
    p = _project(request, pid)
    role = await auth.my_role(pid, user)
    permissions = await _permissions(pid)
    name = str(getattr(user, "display_name", "") or getattr(user, "email", "本地作者"))
    identity = {"id": str(getattr(user, "id", "local-author")), "name": name}
    return await asyncio.to_thread(word.editor_config, p, role, identity, config.PUBLIC_ORIGIN, permissions)


@router.get("/api/projects/{pid}/word/state")
async def state(pid: str, request: Request):
    return await asyncio.to_thread(word.state, _project(request, pid).dir)


@router.post("/api/projects/{pid}/word/save")
async def save(pid: str, request: Request):
    word.require_ready()
    return await asyncio.to_thread(word.request_save, _project(request, pid).dir)


@router.post("/api/projects/{pid}/word/upload-version",
             dependencies=[Depends(auth.require_role("editor"))])
async def upload_version(pid: str, request: Request, user: auth.CurrentUser,
                         file: Annotated[UploadFile | None, File()] = None,
                         expected_sha: Annotated[str, Form()] = ""):
    """桌面 Word/WPS 精调后回传：上传 .docx 作为新版本（editor 及以上写权限）。"""
    word.require_ready()
    p = _project(request, pid)
    if file is None or not (file.filename or "").lower().endswith(".docx"):
        raise ProjectError("请上传 .docx 格式的 Word 文档", 422)
    data = bytearray()
    try:
        while chunk := await file.read(1024 * 1024):
            data.extend(chunk)
            if len(data) > config.WORD_MAX_BYTES:
                raise ProjectError("Word 文件超过 50 MB", 413)
    finally:
        await file.close()
    result = await asyncio.to_thread(word.upload_version, p.dir, bytes(data), expected_sha)
    events.emit("word.version_uploaded", pid=pid, actor=events.actor_of(user),
                data={"version": result["version"], "sha": result["sha"],
                      "unchanged": result["unchanged"], "filename": os.path.basename(file.filename or "")[:200]})
    return result


class RenumberIn(BaseModel):
    style: str = "gb-t-7714-2015"
    expected_sha: str = ""


@router.post("/api/projects/{pid}/word/renumber-citations",
             dependencies=[Depends(auth.require_role("editor"))])
async def renumber_citations(pid: str, request: Request, user: auth.CurrentUser,
                             body: RenumberIn | None = None):
    """按正文首次出现顺序确定性重排全文引用编号（P1-0-B，editor 及以上写权限）。

    服务端权威 DOCX 直接执行 OOXML 重排：静态 [n]/[1,2]/[1-3] 引用按新序改写、托管参考文献表
    按指定样式重建、文献顺序表 citation_order 同步（未引用条目保持追加）。fail-closed：托管块
    标记异常/修订边界/越界编号一律 409/422 拒绝，绝不半途改写。有变化时轮换 DS 会话键，浏览器
    随后用新 doc_key 重开加载最新文档。"""
    word.require_ready()
    p = _project(request, pid)
    body = body or RenumberIn()
    from app.domain.word_citations import STYLES as CITATION_STYLES

    if body.style not in CITATION_STYLES:
        raise ProjectError(f"暂不支持引用样式：{body.style}（当前支持：{'、'.join(CITATION_STYLES)}）", 422)
    from app.domain import library, word_citations

    transform = word_citations.build_transform(p.dir, body.style)
    result = await asyncio.to_thread(word.renumber_citations, p.dir,
                                     expected_sha=body.expected_sha, transform_fn=transform)
    with atomic.studio_lock(p.dir, "citations"):
        index = library.load_index(p.dir)
        order_synced = index.citation_order != result["order"]
        if order_synced:
            index.citation_order = list(result["order"])
            library.save_index(p.dir, index)
    result["changed"] = bool(result["changed"] or order_synced)
    events.emit("word.citations_renumbered", pid=pid, actor=events.actor_of(user),
                data={"changed": result["changed"], "mapped": len(result["mapping"]),
                      "rebuilt_block": bool(result.get("rebuilt_block")), "style": body.style})
    return result


@router.get("/api/projects/{pid}/word/download")
async def download(pid: str, request: Request):
    p = _project(request, pid)
    await _download_allowed(pid)
    return FileResponse(word.document_path(p.dir), media_type=word.DOCX_MEDIA,
                        filename=p.title + ".docx")


@router.get("/api/projects/{pid}/word/versions/{vid}/download")
async def download_version(pid: str, vid: str, request: Request):
    p = _project(request, pid)
    await _download_allowed(pid)
    path = await asyncio.to_thread(word.version_path, p.dir, vid)
    return FileResponse(path, media_type=word.DOCX_MEDIA, filename=p.title + "-" + vid + ".docx")


@router.post("/api/projects/{pid}/word/export/pdf")
async def export_pdf(pid: str, request: Request):
    p = _project(request, pid)
    await _download_allowed(pid)
    return await asyncio.to_thread(word.export_pdf, p)


@router.get("/api/projects/{pid}/word/pdf/{filename}")
async def pdf_file(pid: str, filename: str, request: Request):
    p = _project(request, pid)
    await _download_allowed(pid)
    if not re.fullmatch(r"[0-9a-f]{64}\.pdf", filename):
        raise ProjectError("PDF 文件名不合法", 400)
    path = os.path.join(p.dir, ".studio", "word", "exports", filename)
    if not os.path.isfile(path):
        raise ProjectError("PDF 尚未生成", 404)
    return FileResponse(path, media_type="application/pdf", filename=p.title + ".pdf")


# project_id deliberately differs from the ACL dependency's pid parameter:
# these endpoints authenticate DS with purpose-bound capabilities, never cookies.
@router.get("/api/office/document/{project_id}/{key}")
async def ds_document(project_id: str, key: str, cap: str, request: Request):
    word.check_capability(cap, project_id, key, "document")
    expected = config.ONLYOFFICE_PUBLIC_URL + request.url.path + "?" + request.url.query
    word.verify_download(request.headers.get("authorization", ""), expected)
    p = _project(request, project_id)
    path = await asyncio.to_thread(word.session_file, p.dir, key)
    return FileResponse(path, media_type=word.DOCX_MEDIA)


@router.get("/api/office/version/{project_id}/{vid}")
async def ds_version(project_id: str, vid: str, cap: str, request: Request):
    word.check_capability(cap, project_id, vid, "version")
    expected = config.ONLYOFFICE_PUBLIC_URL + request.url.path + "?" + request.url.query
    word.verify_download(request.headers.get("authorization", ""), expected)
    p = _project(request, project_id)
    path = await asyncio.to_thread(word.version_path, p.dir, vid)
    return FileResponse(path, media_type=word.DOCX_MEDIA)


@router.get("/api/office/template/{fmt}/{tid}")
async def ds_template(fmt: str, tid: str, cap: str, request: Request):
    """DS /converter 回拉论文模板 DOCX（Word 模板转换验收/缩略图链路，C1）。
    同 ds_version 双重校验：purpose-bound cap（pid=fmt:tid、key=template-doc、purpose=template）
    + DS 下载 JWT 的 payload.url 逐一比对。仅启用模板可回拉。"""
    from app.domain import paper_templates

    word.check_capability(cap, fmt + ":" + tid, "template-doc", "template")
    expected = config.ONLYOFFICE_PUBLIC_URL + request.url.path + "?" + request.url.query
    word.verify_download(request.headers.get("authorization", ""), expected)
    path = await asyncio.to_thread(paper_templates.word_document_path, fmt, tid)
    return FileResponse(path, media_type=word.DOCX_MEDIA)


@router.post("/api/office/callback/{project_id}/{key}")
async def ds_callback(project_id: str, key: str, cap: str, request: Request):
    word.check_capability(cap, project_id, key, "callback")
    try:
        body = await request.json()
    except (ValueError, UnicodeError):
        raise ProjectError("Word 回调 JSON 无效", 400) from None
    if not isinstance(body, dict):
        raise ProjectError("Word 回调 JSON 无效", 400)
    payload = word.verify_callback(body, request.headers.get("authorization", ""))
    p = _project(request, project_id)
    return await asyncio.to_thread(word.callback, p.dir, key, payload)


@router.get("/api/office-plugin/settings.json")
async def plugin_settings():
    return {"document_server_url": config.ONLYOFFICE_URL}


@router.get("/api/office-plugin/config.json")
async def plugin_config(request: Request):
    path = os.path.join(config.BACKEND_DIR, "app", "office_plugin", "config.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise ProjectError("公式插件尚未安装", 503) from e
    # DS 10 concatenates baseUrl and variation.url, including absolute urls.
    data["variations"][0]["url"] = "index.html"
    data["baseUrl"] = config.PUBLIC_ORIGIN + "/api/office-plugin/"
    return data


@router.get("/api/office-plugin-ai/settings.json")
async def ai_plugin_settings():
    return {"document_server_url": config.ONLYOFFICE_URL}


# 选区桥调试：桥 iframe 运行态回传（init/轮询步进），仅供浏览器侧诊断桥接问题。
_BRIDGE_DEBUG: list[str] = []


@router.get("/api/office-plugin-ai/debug")
async def bridge_debug_get(user: auth.CurrentUser) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    return {"steps": list(_BRIDGE_DEBUG[-40:])}


@router.post("/api/office-plugin-ai/debug")
async def bridge_debug_post(request: Request, user: auth.CurrentUser) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    try:
        body = await request.json()
    except (ValueError, UnicodeError):
        raise ProjectError("调试回传 JSON 无效", 400) from None
    step = body.get("step") if isinstance(body, dict) else None
    if isinstance(step, str) and step:
        _BRIDGE_DEBUG.append(step[:200])
        del _BRIDGE_DEBUG[:-80]
    return {"ok": True}


@router.get("/api/office-plugin-ai/config.json")
async def ai_plugin_config(request: Request):
    path = os.path.join(config.BACKEND_DIR, "app", "office_plugin_ai", "config.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise ProjectError("AI 润色插件尚未安装", 503) from e
    data["variations"][0]["url"] = "index.html"
    data["baseUrl"] = config.PUBLIC_ORIGIN + "/api/office-plugin-ai/"
    return data


@router.get("/api/office-plugin/native/config.json")
async def numbering_plugin_config(request: Request):
    path = os.path.join(config.BACKEND_DIR, "app", "office_plugin", "native", "config.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    data["baseUrl"] = config.PUBLIC_ORIGIN + "/api/office-plugin/native/"
    return data


@router.get("/api/office-charts/settings.json")
async def charts_plugin_settings():
    return {"document_server_url": config.ONLYOFFICE_URL}


@router.get("/api/office-charts/config.json")
async def charts_plugin_config(request: Request):
    path = os.path.join(config.BACKEND_DIR, "app", "office_charts", "config.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise ProjectError("科研图表插件尚未安装", 503) from e
    data["variations"][0]["url"] = "index.html"
    data["baseUrl"] = config.PUBLIC_ORIGIN + "/api/office-charts/"
    return data


class WordVersionLabelIn(BaseModel):
    label: str = Field(default="", max_length=80)


class WordVersionRestoreIn(BaseModel):
    expected_sha: str | None = Field(default=None, max_length=128)


class WordRevisionKitIn(BaseModel):
    base_vid: str | None = Field(default=None, max_length=64)
    target_vid: str | None = Field(default=None, max_length=64)


@router.patch("/api/projects/{pid}/word/versions/{vid}", dependencies=[Depends(auth.require_role("editor"))])
async def label_word_version(pid: str, vid: str, body: WordVersionLabelIn, request: Request,
                             user: auth.CurrentUser = None):
    p = _project(request, pid)
    state = await asyncio.to_thread(word.label_version, p.dir, vid, body.label)
    events.emit("word.version_labeled", pid=pid, actor=events.actor_of(user),
                data={"vid": vid, "label": body.label.strip()[:80]})
    return state


@router.post("/api/projects/{pid}/word/versions/{vid}/restore", dependencies=[Depends(auth.require_role("editor"))])
async def restore_word_version(pid: str, vid: str, request: Request,
                               body: WordVersionRestoreIn | None = None,
                               user: auth.CurrentUser = None):
    p = _project(request, pid)
    expected_sha = body.expected_sha if body is not None else None
    state = await asyncio.to_thread(word.restore_version, p.dir, vid, expected_sha=expected_sha)
    events.emit("word.version_restored", pid=pid, actor=events.actor_of(user),
                data={"from_vid": vid, "version": state.get("version"), "sha": state.get("sha")})
    return state


@router.get("/api/projects/{pid}/word/diff")
async def diff_word_versions(pid: str, request: Request,
                             base_vid: str = Query(..., min_length=1, max_length=64),
                             target_vid: str = Query(..., min_length=1, max_length=64)):
    p = _project(request, pid)
    await _download_allowed(pid)
    return await asyncio.to_thread(word.diff_versions, p.dir, base_vid, target_vid)


@router.post("/api/projects/{pid}/word/export-revision-kit")
async def export_word_revision_kit(pid: str, request: Request,
                                   body: WordRevisionKitIn | None = None):
    await _download_allowed(pid)
    p = _project(request, pid)
    b_vid = body.base_vid if body is not None else None
    t_vid = body.target_vid if body is not None else None
    zip_bytes, filename = await asyncio.to_thread(
        word.build_word_revision_kit_zip, p, base_vid=b_vid, target_vid=t_vid
    )
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
            "Cache-Control": "no-store",
        },
    )
