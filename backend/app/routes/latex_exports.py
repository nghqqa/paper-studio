# -*- coding: utf-8 -*-
"""LaTeX 示例项目创建与 Word/DOCX 导出子路由。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from app import auth, config
from app.domain import docx_export, events, latex_word, paper_templates
from app.domain import projects as projects_domain

router = APIRouter(prefix="/api/projects/{pid}", tags=["latex"])
demo_router = APIRouter(tags=["latex"])

_NO_STORE = {"Cache-Control": "no-store"}
_ARTIFACT_MEDIA = {
    "out.pdf": "application/pdf",
    "build.log": "text/plain; charset=utf-8",
    "manifest.json": "application/json",
    "paper.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "report.json": "application/json",
}

LATEX_TEMPLATES: dict[str, dict] = paper_templates.builtin_latex()


def _out(project) -> dict:
    return {
        "id": project.id,
        "title": project.title,
        "settings": project.settings,
        "source_format": project.settings.get("source_format"),
        "latex": project.settings.get("latex") or {},
    }


@demo_router.post("/api/projects/latex-demo")
async def create_latex_demo(request: Request, body: dict | None = None, user: auth.CurrentUser = None):
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    store = request.app.state.store
    template = str((body or {}).get("template") or "ieee").strip()
    tpl = await asyncio.to_thread(paper_templates.get, "latex", template)
    pid = str((body or {}).get("id") or "").strip() or store.unique_pid(f"latex-{template}")
    title = str((body or {}).get("title") or "").strip()[:60] or tpl["name"]
    project = await asyncio.to_thread(store.create_latex_demo, pid, seed_dir=tpl["seed"], title=title)
    await asyncio.to_thread(
        store.update_settings,
        pid,
        {
            "latex": {"main": tpl["main"], "engine": tpl["engine"]},
            "submission": {"venue": tpl.get("venue", ""), "field": "", "rank": ""},
        },
    )
    await auth.grant_owner(project.id, user)
    events.emit("case.created", pid=project.id, actor=events.actor_of(user), data={"title": project.title})
    return _out(await asyncio.to_thread(store.get, project.id))


@demo_router.post("/api/projects/jcip-demo")
async def create_jcip_demo(request: Request, body: dict | None = None, user: auth.CurrentUser = None):
    """中文论文示例（实验）：jcip profile 形态的合成示例（正文/公式/图表/refs.bib）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    store = request.app.state.store
    pid = str((body or {}).get("id") or "").strip() or store.unique_pid("jcip-demo")
    project = await asyncio.to_thread(
        store.create_latex_demo, pid, seed_dir=config.JCIP_SEED_DIR, title="中文论文示例（实验）"
    )
    await asyncio.to_thread(store.update_settings, pid, {"latex": {"main": "main.tex", "engine": "xelatex"}})
    await auth.grant_owner(project.id, user)
    events.emit("case.created", pid=project.id, actor=events.actor_of(user), data={"title": project.title})
    return _out(project)


@demo_router.post("/api/projects/showcase-demo")
async def create_showcase_demo(request: Request, body: dict | None = None, user: auth.CurrentUser = None):
    """一键创建全功能演示论文（含 LaTeX + 真实 DOI 文献 + AI 提案台账 + Rebuttal 审稿回复）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    from app.domain import showcase

    store = request.app.state.store
    req_pid = str((body or {}).get("id") or "").strip() or None
    project = await asyncio.to_thread(showcase.create_showcase_project, store, req_pid)
    await auth.grant_owner(project.id, user)
    events.emit("case.created", pid=project.id, actor=events.actor_of(user), data={"title": project.title})
    return _out(project)


@router.post("/latex/export-docx")
async def export_docx(pid: str, request: Request, user: auth.CurrentUser = None):
    if not config.DOCX_EXPORT_ON:
        raise HTTPException(404, {"kind": "not_found", "message": "DOCX 导出未开启（PATENT_STUDIO_DOCX_EXPORT=on）"})
    store = request.app.state.store
    store.get(pid)
    try:
        manifest = await asyncio.to_thread(docx_export.export_docx, store, pid)
    except projects_domain.ProjectError as e:
        kind = "job_busy" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})
    return manifest


class WordExportBody(BaseModel):
    profile: str = "academic"
    eq_layout: str = "tab"


@router.post("/latex/export-word")
async def export_word(
    pid: str,
    request: Request,
    body: WordExportBody | None = None,
    user: auth.CurrentUser = None,
):
    store = request.app.state.store
    store.get(pid)
    prof = body.profile if body else "academic"
    eq_layout = body.eq_layout if body else "tab"
    try:
        return await asyncio.to_thread(latex_word.export_word, store, pid, prof, eq_layout)
    except projects_domain.ProjectError as e:
        kind = "job_busy" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})


@router.get("/latex/word-exports")
async def list_word_exports(pid: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    return {"exports": await asyncio.to_thread(latex_word.list_exports, project)}


@router.get("/latex/word-exports/{eid}/artifacts/{name}")
async def word_export_artifact(pid: str, eid: str, name: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    try:
        p = await asyncio.to_thread(latex_word.artifact_file, project, eid, name)
    except projects_domain.ProjectError as e:
        raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    data = await asyncio.to_thread(Path(p).read_bytes)
    filename = f"{project.title or pid}-{eid}-{name}"
    headers = {**_NO_STORE, "Content-Disposition": f"attachment; filename*=utf-8''{quote(filename)}"}
    return Response(data, media_type=_ARTIFACT_MEDIA[name], headers=headers)


@router.get("/latex/docx-exports")
async def list_docx_exports(pid: str, request: Request):
    if not config.DOCX_EXPORT_ON:
        raise HTTPException(404, {"kind": "not_found", "message": "DOCX 导出未开启"})
    store = request.app.state.store
    project = store.get(pid)
    return {"exports": await asyncio.to_thread(docx_export.list_exports, project)}


@router.get("/latex/docx-exports/{eid}/artifacts/{name}")
async def docx_export_artifact(pid: str, eid: str, name: str, request: Request):
    if not config.DOCX_EXPORT_ON:
        raise HTTPException(404, {"kind": "not_found", "message": "DOCX 导出未开启"})
    store = request.app.state.store
    project = store.get(pid)
    try:
        p = await asyncio.to_thread(docx_export.artifact_file, project, eid, name)
    except projects_domain.ProjectError as e:
        raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    data = await asyncio.to_thread(Path(p).read_bytes)
    filename = f"{project.title or pid}-{eid}-{name}"
    headers = {**_NO_STORE, "Content-Disposition": f"attachment; filename*=utf-8''{quote(filename)}"}
    return Response(data, media_type=_ARTIFACT_MEDIA[name], headers=headers)
