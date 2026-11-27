# -*- coding: utf-8 -*-
"""项目便携整档导出 / 导入路由。"""
from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Request, Response, UploadFile

from app import auth, config
from app.domain import cases, events, project_archive
from app.errors import kind_error

router = APIRouter(tags=["archive"])


async def _export_allowed(pid: str) -> bool:
    if not config.AUTH_ON:
        return True
    from app.auth import access

    s = await access.get_settings(pid)
    return bool(s.get("allow_download", True))


@router.get("/api/projects/{pid}/archive/export")
async def export_archive(pid: str, request: Request):
    project = request.app.state.store.get(pid)
    if not await _export_allowed(pid):
        raise kind_error("forbidden", "当前项目协作设置禁止下载源文件与整档")
    payload, encoded_name = await asyncio.to_thread(project_archive.export_project_archive, project)
    return Response(
        payload,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


@router.post("/api/projects/archive/import", dependencies=[Depends(auth.require_login)])
async def import_archive(
    request: Request,
    user: auth.CurrentUser,
    file: Annotated[UploadFile | None, File()] = None,
    preferred_id: str | None = Form(default=None),
):
    if file is None:
        raise kind_error("validation", "请上传 .zip 项目归档文件", detail="file")
    max_bytes = config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024
    raw = await file.read(max_bytes + 1)
    proj, restored = await asyncio.to_thread(
        project_archive.import_project_archive,
        request.app.state.store,
        raw,
        preferred_id=preferred_id,
    )
    await auth.grant_owner(proj.id, user)
    cases.ensure_case(proj.dir)
    if user is not None:
        cases.claim_owner(proj.dir, str(user.id))
    events.emit("case.created", pid=proj.id, actor=events.actor_of(user), data={"title": proj.title, "via": "archive_import"})
    return {
        "project": {
            "id": proj.id,
            "title": proj.title,
            "source_format": proj.settings.get("source_format", "markdown"),
        },
        "restored_files": restored,
    }
