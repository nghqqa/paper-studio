# -*- coding: utf-8 -*-
"""LaTeX 工程版本历史路由：GET list / GET diff / POST restore（域见 app.domain.latex_history）。

与专利线 /api/projects/{pid}/history 同构，但作用于 LaTeX 源文件整树。
权限：GET 默认 viewer 可读；restore 走 POST 默认 editor。
"""

import asyncio

from fastapi import APIRouter, HTTPException, Request

from app.auth import CurrentUser
from app.domain import history, latex_build, latex_history
from app.errors import error_detail

router = APIRouter(prefix="/api/projects/{pid}/latex/history", tags=["latex"])
UNIT = "C3-latex-history"


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
