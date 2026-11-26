# -*- coding: utf-8 -*-
"""LaTeX Git 同步、ZIP/DOCX 导入、SyncTeX 与 AI 审阅子路由。"""

from __future__ import annotations

import asyncio
import threading

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app import auth, config
from app.domain import (
    events,
    latex_build,
    latex_git,
    latex_import_service,
    latex_issues,
    user_ai,
)
from app.domain import projects as projects_domain
from app.domain.org import require_org_ai

from .latex_exports import _out

router = APIRouter(prefix="/api/projects/{pid}", tags=["latex"])
demo_router = APIRouter(tags=["latex"])

_import_lock = threading.Lock()


class GitRemoteIn(BaseModel):
    url: str = Field(min_length=1, max_length=400)
    branch: str = Field(default="main", max_length=120)
    token: str = Field(default="", max_length=300)


class GitPushIn(BaseModel):
    force: bool = False


class GitPullIn(BaseModel):
    force: bool = False


class SynctexViewIn(BaseModel):
    file: str = Field(min_length=1, max_length=400)
    line: int = Field(ge=1)


class SynctexEditIn(BaseModel):
    page: int = Field(ge=1)
    x: float = 0
    y: float = 0


class AiReviewIn(BaseModel):
    file: str = Field(min_length=1, max_length=400)
    content: str = Field(min_length=1, max_length=80000)


_parse_issue_array = latex_import_service.parse_ai_issue_array


@router.get("/latex/git")
async def git_status_route(pid: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    latex_build._require_latex_project(store, pid)
    return await asyncio.to_thread(latex_git.status, project)


@router.put("/latex/git/remote")
async def git_set_remote(pid: str, request: Request, body: GitRemoteIn, user: auth.CurrentUser):
    store = request.app.state.store
    project = store.get(pid)
    latex_build._require_latex_project(store, pid)
    try:
        row = await asyncio.to_thread(latex_git.save_remote, project, body.url, body.branch, body.token)
    except projects_domain.ProjectError as e:
        raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    return {"ok": True, "remote": latex_git.masked_out(row)}


@router.delete("/latex/git/remote")
async def git_delete_remote(pid: str, request: Request, user: auth.CurrentUser):
    store = request.app.state.store
    project = store.get(pid)
    latex_build._require_latex_project(store, pid)
    return {"ok": True, "removed": await asyncio.to_thread(latex_git.delete_remote, project)}


@router.post("/latex/git/push")
async def git_push_route(pid: str, request: Request, body: GitPushIn | None = None, user: auth.CurrentUser = None):
    store = request.app.state.store
    project = store.get(pid)
    latex_build._require_latex_project(store, pid)
    try:
        return await asyncio.to_thread(latex_git.push, project, bool(body.force) if body else False)
    except projects_domain.ProjectError as e:
        kind = "conflict" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})


@router.post("/latex/git/pull")
async def git_pull_route(pid: str, request: Request, body: GitPullIn | None = None, user: auth.CurrentUser = None):
    store = request.app.state.store
    project = store.get(pid)
    latex_build._require_latex_project(store, pid)
    try:
        return await asyncio.to_thread(latex_git.pull, project, bool(body.force) if body else False)
    except projects_domain.ProjectError as e:
        kind = "conflict" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})


@demo_router.post("/api/projects/latex/import-docx/upload")
async def latex_import_docx_upload(request: Request, user: auth.CurrentUser = None):
    """Word(.docx) → LaTeX 导入第一段：pandoc 转换 + 暂存（返回 main.tex/media 清单与建议引擎）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    filename, payload = await latex_import_service.read_multipart_upload(request, label=".docx")
    from app.domain import latex_import, latex_import_docx

    with _import_lock:
        try:
            meta = await asyncio.to_thread(latex_import_docx.stage_docx, filename, payload)
        except latex_import.ImportRejected as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
        except projects_domain.ProjectError as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    return meta


@demo_router.post("/api/projects/latex/import-docx/create")
async def latex_import_docx_create(request: Request, user: auth.CurrentUser = None):
    """Word→LaTeX 导入第二段：暂存物化为正式工程（main.tex 单主文件；引擎可改建议值）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    body = await request.json()
    token = str(body.get("token") or "")
    engine = str(body.get("engine") or "")
    title = str(body.get("title") or "").strip()
    from app.domain import latex_import

    with _import_lock:
        try:
            stage, meta = latex_import.load_stage(token)
            if meta.get("filename", "").lower().endswith(".docx") is False:
                raise HTTPException(422, {"kind": "content", "message": "令牌不是 Word 导入暂存"})
            if not engine:
                engine = str(meta.get("engine") or "pdflatex")
            if engine not in config.LATEX_ENGINES:
                raise HTTPException(422, {"kind": "content", "message": f"未知 LaTeX 引擎：{engine}"})
            store = request.app.state.store
            project = await latex_import_service.materialize_staged_project(
                store,
                stage,
                prefix="word-imported",
                main="main.tex",
                engine=engine,
                title=title or "导入的 Word 论文",
            )
        except latex_import.ProjectError as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    await auth.grant_owner(project.id, user)
    events.emit(
        "case.created",
        pid=project.id,
        actor=events.actor_of(user),
        data={"title": title or "导入的 Word 论文", "source": "docx-import"},
    )
    return _out(project)


@demo_router.post("/api/projects/latex/import/upload")
async def latex_import_upload(request: Request, user: auth.CurrentUser = None):
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    filename, payload = await latex_import_service.read_multipart_upload(request, label=".zip")
    from app.domain import latex_import

    with _import_lock:
        try:
            meta = await asyncio.to_thread(latex_import.stage_zip, filename, payload)
        except latex_import.ImportRejected as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    return {
        "token": meta["token"],
        "filename": meta["filename"],
        "files": meta["files"],
        "main_candidates": meta["main_candidates"],
        "excluded": meta["excluded"],
        "skipped": meta["skipped"],
        "sha256": meta["sha256"],
    }


@demo_router.post("/api/projects/latex/import/create")
async def latex_import_create(request: Request, user: auth.CurrentUser = None):
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    body = await request.json()
    token = str(body.get("token") or "")
    main = str(body.get("main") or "")
    engine = str(body.get("engine") or "pdflatex")
    title = str(body.get("title") or "").strip()
    if engine not in config.LATEX_ENGINES:
        raise HTTPException(
            422,
            {"kind": "content", "message": f"未知 LaTeX 引擎：{engine}（允许：{'、'.join(config.LATEX_ENGINES)}）"},
        )
    from app.domain import latex_import

    with _import_lock:
        try:
            stage, meta = latex_import.load_stage(token)
            if main not in meta["main_candidates"]:
                cand_str = ", ".join(meta["main_candidates"][:8])
                raise HTTPException(
                    422,
                    {"kind": "content", "message": f"主文件 {main} 不在候选列表中（候选：{cand_str}）"},
                )
            store = request.app.state.store
            project = await latex_import_service.materialize_staged_project(
                store,
                stage,
                prefix="imported-paper",
                main=main,
                engine=engine,
                title=title or "导入的 LaTeX 工程",
            )
        except latex_import.ProjectError as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    await auth.grant_owner(project.id, user)
    events.emit(
        "case.created",
        pid=project.id,
        actor=events.actor_of(user),
        data={"title": title or "导入的 LaTeX 工程", "source": "zip-import"},
    )
    return _out(project)


@router.post("/latex/builds/{build_id}/synctex/view")
async def synctex_view_route(pid: str, build_id: str, request: Request, body: SynctexViewIn):
    """正向：源码文件+行 → PDF 页与 72dpi 坐标。"""
    store = request.app.state.store
    project = store.get(pid)
    return await asyncio.to_thread(latex_build.synctex_view, project, build_id, body.file, body.line)


@router.post("/latex/builds/{build_id}/synctex/edit")
async def synctex_edit_route(pid: str, build_id: str, request: Request, body: SynctexEditIn):
    """反向：PDF 页+坐标 → 源码文件+行。"""
    store = request.app.state.store
    project = store.get(pid)
    return await asyncio.to_thread(latex_build.synctex_edit, project, build_id, body.page, body.x, body.y)


@router.post("/latex/ai-review", dependencies=[Depends(require_org_ai)])
async def ai_review_issues(pid: str, request: Request, body: AiReviewIn, user: auth.CurrentUser = None):
    """AI 审稿当前文件全文（前端已弹窗确认外发范围），问题清单逐条落为 Issue。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    store = request.app.state.store
    project = store.get(pid)
    client, _provider = user_ai.resolve_ai_client(user)
    if len(body.content) > 60000:
        raise HTTPException(413, {"kind": "content", "message": "文件超过 6 万字符，请分段审阅（先拆分章节）"})
    system = (
        "你是论文审稿助手。审阅给定的 LaTeX 源文件，指出需要修改的问题："
        "论证漏洞、表述不清、结构问题、术语不一致、格式错误（引用/公式/图表）。"
        "每条问题一句话说明位置与修改建议。只输出 JSON 数组，"
        '形如 [{"line": 行号int, "message": "问题描述与建议"}]，最多 12 条，按重要性排序；无问题输出 []。'
    )
    user_content = f"【LaTeX 源文件：{body.file}】\n{body.content}\n\n请只输出 JSON 数组。"
    try:
        result = await client.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user_content}],
            "interactive",
            max_tokens=8192,
            temperature=0.3,
        )
    except Exception as e:  # noqa: BLE001 — AiError 等统一转 502
        raise HTTPException(502, {"kind": "ai", "message": f"AI 调用失败：{e}"})
    items = _parse_issue_array(result.text)[:12]
    created = []
    for item in items:
        created.append(
            await asyncio.to_thread(
                latex_issues.add_issue, project, item["message"], body.file, item["line"]
            )
        )
    return {"added": len(created), "issues": created}
