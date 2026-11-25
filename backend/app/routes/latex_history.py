# -*- coding: utf-8 -*-
"""LaTeX 工程版本历史路由：GET list / GET diff / POST restore（域见 app.domain.latex_history）。

与专利线 /api/projects/{pid}/history 同构，但作用于 LaTeX 源文件整树。
权限：GET 默认 viewer 可读；restore 走 POST 默认 editor。
"""

import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.auth import CurrentUser
from app.domain import history, latex_build, latex_diff, latex_history
from app.errors import error_detail

router = APIRouter(prefix="/api/projects/{pid}/latex/history", tags=["latex"])
diff_router = APIRouter(prefix="/api/projects/{pid}/latex/diffs", tags=["latex"])
UNIT = "C3-latex-history"


class MilestoneIn(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    sha: str | None = None


class DiffPdfIn(BaseModel):
    base_sha: str = Field(min_length=4, max_length=64)
    target_sha: str = history.WORK
    engine: str | None = None


def _raise(exc: history.HistoryError):
    kind = "unavailable" if isinstance(exc, history.GitUnavailable) else "history"
    raise HTTPException(exc.status, error_detail(kind, str(exc), detail=UNIT))


@router.get("")
async def list_versions(pid: str, request: Request):
    store = request.app.state.store
    project = latex_build._require_latex_project(store, pid)
    return await asyncio.to_thread(latex_history.log, project.dir)


@router.get("/diff")
async def diff_versions(pid: str, request: Request, a: str, b: str = history.WORK):
    store = request.app.state.store
    project = latex_build._require_latex_project(store, pid)
    try:
        text = await asyncio.to_thread(latex_history.diff, project.dir, a, b)
    except history.HistoryError as e:
        _raise(e)
    return {"a": a, "b": b, "diff": text}


@router.post("/{sha}/restore")
async def restore_version(pid: str, sha: str, request: Request, user: CurrentUser):
    store = request.app.state.store
    project = latex_build._require_latex_project(store, pid)
    email = user.email if user is not None else None
    try:
        result = await asyncio.to_thread(latex_history.restore, project.dir, sha, email)
    except history.HistoryError as e:
        _raise(e)
    return {"ok": True, **result}


@router.post("/milestones", status_code=201)
async def create_milestone(pid: str, body: MilestoneIn, request: Request, user: CurrentUser):
    store = request.app.state.store
    project = latex_build._require_latex_project(store, pid)
    email = user.email if user is not None else None
    try:
        item = await asyncio.to_thread(latex_history.create_milestone, project.dir, body.name, body.sha, email)
    except history.HistoryError as e:
        _raise(e)
    return item


@router.delete("/milestones/{name}")
async def delete_milestone(pid: str, name: str, request: Request):
    store = request.app.state.store
    project = latex_build._require_latex_project(store, pid)
    removed = await asyncio.to_thread(latex_history.delete_milestone, project.dir, name)
    if not removed:
        raise HTTPException(404, error_detail("not_found", f"里程碑「{name}」不存在"))
    return {"ok": True}


@diff_router.get("")
async def list_diffs(pid: str, request: Request):
    store = request.app.state.store
    project = latex_build._require_latex_project(store, pid)
    items = await asyncio.to_thread(latex_diff.list_diffs, project)
    return {"available": latex_diff.available(), "items": items}


@diff_router.post("")
async def create_diff_pdf(pid: str, body: DiffPdfIn, request: Request):
    store = request.app.state.store
    return await asyncio.to_thread(
        latex_diff.generate_diff_pdf, store, pid, body.base_sha, body.target_sha, body.engine
    )


@diff_router.get("/{diff_id}/pdf")
async def get_diff_pdf(pid: str, diff_id: str, request: Request, download: bool = False):
    store = request.app.state.store
    project = latex_build._require_latex_project(store, pid)
    pdf_path = latex_diff.diff_pdf_path(project, diff_id)
    disp = "attachment" if download else "inline"
    return FileResponse(
        pdf_path,
        media_type="application/pdf",
        headers={"Content-Disposition": f'{disp}; filename="revision-diff-{diff_id}.pdf"'},
    )
