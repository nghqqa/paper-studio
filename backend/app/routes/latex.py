# -*- coding: utf-8 -*-
"""LaTeX 工程核心路由：文件树读写 / Issues / 编译与产物，并聚合导出与同步子路由。

权限：全局 project_access + ROUTE_ROLE（latex/build=viewer；文件写走默认 PUT→editor）。
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app import auth
from app.domain import latex_build, latex_files, latex_history, latex_issues
from app.domain.projects import ProjectError

from .latex_exports import _ARTIFACT_MEDIA, _NO_STORE, LATEX_TEMPLATES, _out  # noqa: F401

router = APIRouter(prefix="/api/projects/{pid}", tags=["latex"])


class FileIn(BaseModel):
    content: str
    base: str | None = None


class BuildIn(BaseModel):
    engine: str | None = None


class CreateFileIn(BaseModel):
    content: str = ""


class RenameFileIn(BaseModel):
    new_path: str = Field(min_length=1, max_length=400)


class IssueIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    file: str | None = Field(default=None, max_length=400)
    line: int | None = Field(default=None, ge=1)


class IssueResolveIn(BaseModel):
    resolved: bool = True


_RAW_MEDIA = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
}
_RAW_MAX_BYTES = 25 * 1024 * 1024


@router.get("/latex/files")
async def list_files(pid: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    latex_build._require_latex_project(store, pid)
    return {"files": latex_build.list_source_files(project)}


@router.get("/latex/files/{rel:path}")
async def read_file(pid: str, rel: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    content = await asyncio.to_thread(latex_build.read_source_file, project, rel)
    return {"path": rel, "content": content, "sha": hashlib.sha256(content.encode()).hexdigest()}


@router.get("/latex/raw/{rel:path}")
async def raw_source_file(pid: str, rel: str, request: Request):
    """只读预览工程内二进制源文件（图片/PDF）。"""
    store = request.app.state.store
    project = store.get(pid)
    ext = os.path.splitext(rel)[1].lower()
    if ext not in _RAW_MEDIA:
        raise ProjectError("该类型不支持预览（仅图片与 PDF）", 415)
    p = latex_build.resolve_source_path(project, rel)
    if not os.path.isfile(p):
        raise ProjectError("文件不存在", 404)
    if os.path.getsize(p) > _RAW_MAX_BYTES:
        raise ProjectError("文件超过 25MB，不支持预览", 413)
    data = await asyncio.to_thread(Path(p).read_bytes)
    headers = {**_NO_STORE}
    if ext == ".svg":
        headers["Content-Security-Policy"] = "sandbox"
    if request.query_params.get("dl"):
        headers["Content-Disposition"] = f"attachment; filename*=utf-8''{quote(os.path.basename(rel))}"
    return Response(data, media_type=_RAW_MEDIA[ext], headers=headers)


@router.post("/latex/upload")
async def upload_source_file(
    pid: str,
    request: Request,
    file: UploadFile = File(...),  # noqa: B008
    rel: str = Form(...),  # noqa: B008
    overwrite: bool = Form(False),  # noqa: B008
    user: auth.CurrentUser = None,
):
    store = request.app.state.store
    project = store.get(pid)
    data = await file.read()
    saved = await asyncio.to_thread(latex_files.upload_file, project, rel, data, overwrite)
    await asyncio.to_thread(
        latex_history.commit, project.dir, f"upload {saved}", user.email if user is not None else None, True
    )
    return {"ok": True, "path": saved}


@router.post("/latex/upload-zip")
async def upload_zip_merge(
    pid: str,
    request: Request,
    file: UploadFile = File(...),  # noqa: B008
    user: auth.CurrentUser = None,
):
    store = request.app.state.store
    project = store.get(pid)
    payload = await file.read()
    result = await asyncio.to_thread(latex_files.merge_zip, project, payload)
    if result["added"]:
        await asyncio.to_thread(
            latex_history.commit,
            project.dir,
            f"zip-merge +{len(result['added'])}",
            user.email if user is not None else None,
            True,
        )
    return result


@router.get("/latex/export-zip")
async def export_zip(pid: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    data = await asyncio.to_thread(latex_files.export_zip_bytes, project)
    filename = f"{project.title or pid}.zip"
    return Response(
        data,
        media_type="application/zip",
        headers={**_NO_STORE, "Content-Disposition": f"attachment; filename*=utf-8''{quote(filename)}"},
    )


@router.get("/latex/issues")
async def issues_list(pid: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    return {"issues": await asyncio.to_thread(latex_issues.list_issues, project)}


@router.post("/latex/issues")
async def issues_add(pid: str, request: Request, body: IssueIn):
    store = request.app.state.store
    project = store.get(pid)
    return await asyncio.to_thread(latex_issues.add_issue, project, body.message, body.file, body.line)


@router.patch("/latex/issues/{issue_id}")
async def issues_resolve(pid: str, issue_id: str, request: Request, body: IssueResolveIn):
    store = request.app.state.store
    project = store.get(pid)
    return await asyncio.to_thread(latex_issues.set_resolved, project, issue_id, body.resolved)


@router.delete("/latex/issues/{issue_id}")
async def issues_delete(pid: str, issue_id: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    await asyncio.to_thread(latex_issues.delete_issue, project, issue_id)
    return {"ok": True}


@router.put("/latex/files/{rel:path}")
async def save_file(pid: str, rel: str, body: FileIn, request: Request, user: auth.CurrentUser):
    store = request.app.state.store
    project = store.get(pid)
    cur = await asyncio.to_thread(latex_build.read_source_file, project, rel)
    cur_sha = hashlib.sha256(cur.encode()).hexdigest()
    if body.base is not None and body.base != cur_sha:
        raise HTTPException(
            status_code=409,
            detail={"kind": "stale", "message": "文件已被另一会话修改，请刷新后再保存", "sha": cur_sha},
        )
    await asyncio.to_thread(latex_build.save_source_file, project, rel, body.content)
    await asyncio.to_thread(
        latex_history.commit, project.dir, f"save {rel}", user.email if user is not None else None
    )
    return {"ok": True, "path": rel, "sha": hashlib.sha256(body.content.encode()).hexdigest()}


# 注意：rename/delete 必须先于 create（{rel:path} 贪婪匹配会把 ".../rename" 吞进 create）
@router.post("/latex/files/{rel:path}/rename")
async def rename_file_route(
    pid: str,
    rel: str,
    request: Request,
    body: RenameFileIn,
    user: auth.CurrentUser = None,
):
    store = request.app.state.store
    project = store.get(pid)
    new_rel = await asyncio.to_thread(latex_files.rename_file, project, rel, body.new_path)
    cfg = project.settings.get("latex") or {}
    if cfg.get("main") == rel:
        await asyncio.to_thread(store.update_settings, pid, {"latex": {"main": new_rel}})
    await asyncio.to_thread(
        latex_history.commit,
        project.dir,
        f"rename {rel} -> {new_rel}",
        user.email if user is not None else None,
        True,
    )
    return {"ok": True, "path": new_rel, "main_updated": cfg.get("main") == rel}


@router.delete("/latex/files/{rel:path}")
async def delete_file_route(pid: str, rel: str, request: Request, user: auth.CurrentUser = None):
    store = request.app.state.store
    project = store.get(pid)
    cfg = project.settings.get("latex") or {}
    main_now = (cfg.get("main") or "").replace("\\", "/")
    if main_now == rel.replace("\\", "/"):
        raise HTTPException(
            409,
            {"kind": "content", "message": "该文件是编译主文件——请先在「编译设置」中更换主文件，再删除"},
        )
    await asyncio.to_thread(latex_files.delete_file, project, rel)
    await asyncio.to_thread(
        latex_history.commit, project.dir, f"delete {rel}", user.email if user is not None else None, True
    )
    return {"ok": True}


@router.post("/latex/files/{rel:path}")
async def create_file(
    pid: str,
    rel: str,
    request: Request,
    body: CreateFileIn = None,
    user: auth.CurrentUser = None,
):
    """新建文本文件（可编辑扩展名白名单；409=已存在）。"""
    store = request.app.state.store
    project = store.get(pid)
    saved = await asyncio.to_thread(
        latex_files.create_text_file, project, rel, body.content if body else ""
    )
    await asyncio.to_thread(
        latex_history.commit, project.dir, f"create {saved}", user.email if user is not None else None, True
    )
    return {"ok": True, "path": saved}


@router.post("/latex/builds/cancel")
async def cancel_build(pid: str, request: Request, user: auth.CurrentUser):
    store = request.app.state.store
    store.get(pid)
    try:
        return await asyncio.to_thread(latex_build.cancel_build, store, pid)
    except ProjectError as e:
        kind = "job_busy" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})


@router.post("/latex/build")
async def build(pid: str, body: BuildIn, request: Request, user: auth.CurrentUser):
    store = request.app.state.store
    store.get(pid)
    try:
        return await asyncio.to_thread(latex_build.run_build, store, pid, body.engine)
    except ProjectError as e:
        kind = "job_busy" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})


@router.get("/latex/builds")
async def list_builds(pid: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    builds = latex_build.list_builds(project)
    cur = latex_build.digest_source(project)
    for b in builds:
        b["stale"] = b.get("digest") != cur
    latest_ok = next((b for b in builds if b.get("status") == "ok"), None)
    return {"builds": builds, "latest_ok_build_id": latest_ok.get("build_id") if latest_ok else None}


@router.get("/latex/builds/{build_id}/artifacts/pdf")
async def artifact_inline_pdf(pid: str, build_id: str, request: Request):
    data, _media, _filename = await _artifact_file(request, pid, build_id, "out.pdf")
    headers = {**_NO_STORE, "X-Content-Type-Options": "nosniff"}
    return Response(data, media_type="text/plain; charset=utf-8", headers=headers)


@router.get("/latex/builds/{build_id}/artifacts/{name}")
async def artifact(pid: str, build_id: str, name: str, request: Request):
    data, media, filename = await _artifact_file(request, pid, build_id, name)
    headers = {**_NO_STORE, "Content-Disposition": f"attachment; filename*=utf-8''{quote(filename)}"}
    return Response(data, media_type=media, headers=headers)


async def _artifact_file(request: Request, pid: str, build_id: str, name: str):
    store = request.app.state.store
    project = store.get(pid)
    if name not in latex_build.ARTIFACT_NAMES:
        raise ProjectError("非法产物名", 400)
    manifest = latex_build.load_manifest(project, build_id)
    stem = os.path.splitext(manifest.get("main") or "main.tex")[0]
    physical = {"out.pdf": f"{stem}.pdf", "build.log": "build.log", "manifest.json": "manifest.json"}[name]
    p = os.path.join(latex_build.builds_dir(project), build_id, physical)
    if not os.path.isfile(p):
        raise ProjectError("产物不存在（构建失败或已被清理）", 404)
    filename = f"{project.title or pid}-{build_id}.pdf" if name == "out.pdf" else None
    media = _ARTIFACT_MEDIA[name]
    if name != "out.pdf":
        data = await asyncio.to_thread(Path(p).read_bytes)
        return data, media, filename or name
    data = None
    for _ in range(5):
        try:
            data = await asyncio.to_thread(lambda: Path(p).read_bytes())
            break
        except PermissionError:
            await asyncio.sleep(0.3)
    if data is None:
        raise ProjectError("PDF 正在被写入，请稍后重试", 503)
    return data, media, filename
