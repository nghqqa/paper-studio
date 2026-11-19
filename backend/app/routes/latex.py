# -*- coding: utf-8 -*-
"""LaTeX 工程最小闭环路由（w21 批 A）：内置示例创建 / 文件清单 / 文本文件读写 / 手动编译与产物。

边界（显式拒绝，不静默转换）：
- 只支持已存在文件的文本编辑（白名单扩展名）；不建文件、不删文件、不改名、不收上传；
- 路径穿越/绝对路径/符号链接越界一律 400（latex_build.resolve_source_path）；
- LaTeX 工程不进 Markdown 解析、专利 lint、三书装配（content.md 读写与 /ast /lint /preflight 已有守卫）。
权限：全局 project_access + ROUTE_ROLE（latex/build=viewer；文件写走默认 PUT→editor）。
"""

import asyncio
import hashlib
import os
import shutil
import threading
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app import auth, config
from app.domain import docx_export, events, latex_build, latex_files, latex_git, latex_history, latex_issues, latex_word, paper_templates
from app.domain.org import require_org_ai
from app.domain import user_ai
from app.domain.projects import ProjectError

router = APIRouter(prefix="/api/projects/{pid}", tags=["latex"])
# 内置示例创建挂在无 {pid} 前缀的 router（POST /api/projects/latex-demo）
demo_router = APIRouter(tags=["latex"])

_NO_STORE = {"Cache-Control": "no-store"}
_ARTIFACT_MEDIA = {
    "out.pdf": "application/pdf",
    "build.log": "text/plain; charset=utf-8",
    "manifest.json": "application/json",
    "paper.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "report.json": "application/json",
}


class FileIn(BaseModel):
    content: str
    base: str | None = None  # 乐观并发：客户端持有的上次内容 sha256，不符 → 409


class BuildIn(BaseModel):
    engine: str | None = None


def _out(project) -> dict:
    return {
        "id": project.id,
        "title": project.title,
        "settings": project.settings,
        "source_format": project.settings.get("source_format"),
        "latex": project.settings.get("latex") or {},
    }


# --- 内置示例创建（POST /api/projects/latex-demo；单段 POST /api/projects/{seg} 不存在，无路由歧义） ---

# Built-in snapshot kept for existing tools; runtime reads the persistent catalogue.
LATEX_TEMPLATES: dict[str, dict] = paper_templates.builtin_latex()


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
    # 主文件/引擎随模板覆写（存储方法默认 IEEE 设置；jcip/blank 是 ctex+xelatex）
    await asyncio.to_thread(store.update_settings, pid, {
        "latex": {"main": tpl["main"], "engine": tpl["engine"]},
        "submission": {"venue": tpl.get("venue", ""), "field": "", "rank": ""},
    })
    # 创建者 owner 授权——与 main.create_project 同语义；漏掉会让创建者自己看不到项目（AUTH=on 实测缺陷）
    await auth.grant_owner(project.id, user)
    events.emit("case.created", pid=project.id, actor=events.actor_of(user), data={"title": project.title})
    return _out(await asyncio.to_thread(store.get, project.id))


# --- 文件清单与读写 ---


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


# 源文件二进制预览（图片/PDF 白名单；CoCraft 式文件树点击预览）
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


@router.get("/latex/raw/{rel:path}")
async def raw_source_file(pid: str, rel: str, request: Request):
    """只读预览工程内二进制源文件（图片/PDF）。与文本读同一套路径安全校验。
    CSP sandbox 只加给 svg（唯一能内嵌脚本的类型，防直接以 URL 打开时执行）；
    **不能加给 pdf**——Chrome 内建 PDF 查看器在 sandbox 沙箱文档中拒绝加载，
    iframe 会显示「拒绝连接」（生产实测）；PDF 内嵌 JS 无页面源访问，风险可接受。
    ?dl=1 → attachment 下载语义。"""
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


# --- 工程文件面板：新建 / 上传 / ZIP 合并 / 整包下载 / Issues（CoCraft 式文件面板） ---


class CreateFileIn(BaseModel):
    content: str = ""


class IssueIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    file: str | None = Field(default=None, max_length=400)
    line: int | None = Field(default=None, ge=1)


class IssueResolveIn(BaseModel):
    resolved: bool = True


@router.post("/latex/upload")
async def upload_source_file(pid: str, request: Request, file: UploadFile = File(...),  # noqa: B008
                             rel: str = Form(...), overwrite: bool = Form(False),  # noqa: B008
                             user: auth.CurrentUser = None):
    """上传单个文件到工程（文本族可编辑类型解码保存；图片/PDF 族按字节保存；默认拒绝覆盖）。"""
    store = request.app.state.store
    project = store.get(pid)
    data = await file.read()
    saved = await asyncio.to_thread(latex_files.upload_file, project, rel, data, overwrite)
    # 结构性操作总是提交版本历史（防丢稿；git 缺失静默跳过）
    await asyncio.to_thread(latex_history.commit, project.dir, f"upload {saved}",
                            user.email if user is not None else None, True)
    return {"ok": True, "path": saved}


@router.post("/latex/upload-zip")
async def upload_zip_merge(pid: str, request: Request, file: UploadFile = File(...),  # noqa: B008
                           user: auth.CurrentUser = None):
    """上传 ZIP 合并入工程：与导入同规拒绝（穿越/符号链接/嵌套归档/超限）；
    已存在文件与平台内部目录一律跳过并报告，绝不静默覆盖。"""
    store = request.app.state.store
    project = store.get(pid)
    payload = await file.read()
    result = await asyncio.to_thread(latex_files.merge_zip, project, payload)
    if result["added"]:
        await asyncio.to_thread(latex_history.commit, project.dir,
                                f"zip-merge +{len(result['added'])}",
                                user.email if user is not None else None, True)
    return result


@router.get("/latex/export-zip")
async def export_zip(pid: str, request: Request):
    """整包下载（全部源文件 + 二进制资源）。"""
    store = request.app.state.store
    project = store.get(pid)
    data = await asyncio.to_thread(latex_files.export_zip_bytes, project)
    filename = f"{project.title or pid}.zip"
    return Response(data, media_type="application/zip", headers={
        **_NO_STORE,
        "Content-Disposition": f"attachment; filename*=utf-8''{quote(filename)}",
    })


@router.get("/latex/issues")
async def issues_list(pid: str, request: Request):
    store = request.app.state.store
    project = store.get(pid)
    return {"issues": await asyncio.to_thread(latex_issues.list_issues, project)}


@router.post("/latex/issues")
async def issues_add(pid: str, request: Request, body: IssueIn):
    store = request.app.state.store
    project = store.get(pid)
    row = await asyncio.to_thread(latex_issues.add_issue, project, body.message, body.file, body.line)
    return row


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
    # 版本历史（防丢稿）：保存按 COALESCE_S 时间合并提交；git 缺失静默跳过
    await asyncio.to_thread(latex_history.commit, project.dir, f"save {rel}",
                            user.email if user is not None else None)
    # 本轮审计口径：构建 manifest 记录每次编译的输入 sha256（git 化源码历史已落地 latex_history）
    return {"ok": True, "path": rel, "sha": hashlib.sha256(body.content.encode()).hexdigest()}


# --- 手动编译与产物 ---

@router.post("/latex/builds/cancel")
async def cancel_build(pid: str, request: Request, user: auth.CurrentUser):
    """中止进行中的编译：进程组被终止，构建请求以 status=canceled 落 manifest 返回。"""
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
    """内嵌预览专用端点。两个防下载器接管设计（IDM 用户实测会按 MIME 类型嗅探接管 PDF 响应，
    掐断页面 fetch →「PDF 加载失败」）：
    - 无 Content-Disposition（attachment 头是下载器最强信号）；
    - Content-Type 伪装为 text/plain——下载器不接管文本；pdf.js 用 fetch 读字节后自行解析，
      不依赖该头。下载语义（真实 PDF 类型 + attachment）仍走 /artifacts/out.pdf。"""
    data, _media, _filename = await _artifact_file(request, pid, build_id, "out.pdf")
    headers = {**_NO_STORE, "X-Content-Type-Options": "nosniff"}
    return Response(data, media_type="text/plain; charset=utf-8", headers=headers)


@router.get("/latex/builds/{build_id}/artifacts/{name}")
async def artifact(pid: str, build_id: str, name: str, request: Request):
    data, media, filename = await _artifact_file(request, pid, build_id, name)
    headers = {**_NO_STORE, "Content-Disposition": f"attachment; filename*=utf-8''{quote(filename)}"}
    return Response(data, media_type=media, headers=headers)


async def _artifact_file(request: Request, pid: str, build_id: str, name: str):
    """返回 (bytes, media_type, download_filename)。PDF 读取带短重试：
    MiKTeX/杀毒在构建刚结束时可能短暂锁住新写的文件（Windows 实测偶发 PermissionError，
    数百毫秒后自愈）——FileResponse 惰性打开没法重试，这里读进内存再返回。"""
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


# --- DOCX 实验性导出（jcip profile；PATENT_STUDIO_DOCX_EXPORT=on 才暴露） ---
# 边界见 domain/docx_export.py 模块注释：编号校验 fatal 一律 blocked 无产物；
# 产物恒标记实验性；仅 jcip profile，不泛化；不替换 PDF 管线。


@router.post("/latex/export-docx")
async def export_docx(pid: str, request: Request, user: auth.CurrentUser = None):
    if not config.DOCX_EXPORT_ON:
        raise HTTPException(404, {"kind": "not_found", "message": "DOCX 导出未开启（PATENT_STUDIO_DOCX_EXPORT=on）"})
    store = request.app.state.store
    store.get(pid)
    try:
        manifest = await asyncio.to_thread(docx_export.export_docx, store, pid)
    except ProjectError as e:
        kind = "job_busy" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})
    return manifest


# --- 通用 Word 导出（v0.6.7，导师阅读版；与 jcip 实验导出独立，见 domain/latex_word.py） ---


@router.post("/latex/export-word")
async def export_word(pid: str, request: Request, user: auth.CurrentUser = None):
    store = request.app.state.store
    store.get(pid)
    try:
        return await asyncio.to_thread(latex_word.export_word, store, pid)
    except ProjectError as e:
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
    except ProjectError as e:
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
    from app.domain import docx_export as _de
    return {"exports": await asyncio.to_thread(_de.list_exports, project)}


@router.get("/latex/docx-exports/{eid}/artifacts/{name}")
async def docx_export_artifact(pid: str, eid: str, name: str, request: Request):
    if not config.DOCX_EXPORT_ON:
        raise HTTPException(404, {"kind": "not_found", "message": "DOCX 导出未开启"})
    store = request.app.state.store
    project = store.get(pid)
    from app.domain import docx_export as _de
    try:
        p = await asyncio.to_thread(_de.artifact_file, project, eid, name)
    except ProjectError as e:
        raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    data = await asyncio.to_thread(Path(p).read_bytes)
    filename = f"{project.title or pid}-{eid}-{name}"
    headers = {**_NO_STORE, "Content-Disposition": f"attachment; filename*=utf-8''{quote(filename)}"}
    return Response(data, media_type=_ARTIFACT_MEDIA[name], headers=headers)


@demo_router.post("/api/projects/jcip-demo")
async def create_jcip_demo(request: Request, body: dict | None = None, user: auth.CurrentUser = None):
    """中文论文示例（实验）：jcip profile 形态的合成示例（正文/公式/图表/refs.bib），
    供 DOCX 实验性导出闭环使用。合成内容（仓库自撰，无版权负担），不使用真实录用论文。
    编译走 xelatex（ctex）。IEEEtran 示例保留；其形态不适用中文 DOCX 通道。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    store = request.app.state.store
    pid = str((body or {}).get("id") or "").strip() or store.unique_pid("jcip-demo")
    project = await asyncio.to_thread(
        store.create_latex_demo, pid, seed_dir=config.JCIP_SEED_DIR, title="中文论文示例（实验）"
    )
    # 种子主文件为 main.tex（IEEEtran 种子是 bare_conf.tex），ctex 用 xelatex
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


# --- 受限 LaTeX ZIP 工程导入（两段式：upload 校验暂存 → create 建项） ---
# 边界见 domain/latex_import.py：限额/穿越/符号链接/嵌套归档/重名/内部路径全部显式拒绝；
# 平台自行生成 studio.json（不信任上传配置）；先暂存校验，创建为最后一步，失败不留半成品。

_import_lock = threading.Lock()


# --- per-project GitHub/Gitea 推拉（v0.6.8，#5；域见 domain/latex_git.py） ---

class GitRemoteIn(BaseModel):
    url: str = Field(min_length=1, max_length=400)
    branch: str = Field(default="main", max_length=120)
    token: str = Field(default="", max_length=300)


class GitPushIn(BaseModel):
    """force=True 覆盖远端（前端须先显式确认；首推到已初始化仓库的场景）。"""
    force: bool = False


class GitPullIn(BaseModel):
    """force=True 放弃本地独立提交、硬重置到远端（前端须先显式确认；分叉时的逃生门）。"""
    force: bool = False


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
    except ProjectError as e:
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
    except ProjectError as e:
        kind = "conflict" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})


@router.post("/latex/git/pull")
async def git_pull_route(pid: str, request: Request, body: GitPullIn | None = None, user: auth.CurrentUser = None):
    store = request.app.state.store
    project = store.get(pid)
    latex_build._require_latex_project(store, pid)
    try:
        return await asyncio.to_thread(latex_git.pull, project, bool(body.force) if body else False)
    except ProjectError as e:
        kind = "conflict" if e.status == 409 else "content"
        raise HTTPException(e.status, {"kind": kind, "message": str(e)})


@demo_router.post("/api/projects/latex/import-docx/upload")
async def latex_import_docx_upload(request: Request, user: auth.CurrentUser = None):
    """Word(.docx) → LaTeX 导入第一段：pandoc 转换 + 暂存（返回 main.tex/media 清单与建议引擎）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    ctype = request.headers.get("Content-Type", "")
    if "multipart/form-data" not in ctype:
        raise HTTPException(415, {"kind": "content", "message": "请使用 multipart/form-data 上传 .docx 文件"})
    form = await request.form()
    up = form.get("file")
    if up is None or not hasattr(up, "filename") or not hasattr(up, "read"):
        raise HTTPException(422, {"kind": "content", "message": "缺少 file 字段（.docx）"})
    payload = await up.read()
    from app.domain import latex_import, latex_import_docx

    with _import_lock:
        try:
            meta = await asyncio.to_thread(latex_import_docx.stage_docx, up.filename, payload)
        except latex_import.ImportRejected as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
        except ProjectError as e:
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
    from app.domain import latex_import_docx as _dx

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
            pid = store.unique_pid("word-imported")
            final_dir = os.path.join(store.root, pid)
            await asyncio.to_thread(latex_import.materialize, stage, final_dir)
            try:
                from app import atomic

                await asyncio.to_thread(
                    atomic.write_json, os.path.join(final_dir, "studio.json"),
                    {"document_type": "paper", "source_format": "latex",
                     "latex": {"main": "main.tex", "engine": engine},
                     "title": title or "导入的 Word 论文"},
                )
                await asyncio.to_thread(store.get, pid)
            except Exception:
                shutil.rmtree(final_dir, ignore_errors=True)
                raise
            latex_import.drop_stage(stage)
        except latex_import.ProjectError as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    await auth.grant_owner(pid, user)
    events.emit("case.created", pid=pid, actor=events.actor_of(user),
                data={"title": title or "导入的 Word 论文", "source": "docx-import"})
    return _out(store.get(pid))


@demo_router.post("/api/projects/latex/import/upload")
async def latex_import_upload(request: Request, user: auth.CurrentUser = None):
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    ctype = request.headers.get("Content-Type", "")
    if "multipart/form-data" not in ctype:
        raise HTTPException(415, {"kind": "content", "message": "请使用 multipart/form-data 上传 .zip 文件"})
    form = await request.form()
    up = form.get("file")
    if up is None or not hasattr(up, "filename") or not hasattr(up, "read"):
        raise HTTPException(422, {"kind": "content", "message": "缺少 file 字段（.zip）"})
    payload = await up.read()
    from app.domain import latex_import

    with _import_lock:
        try:
            meta = await asyncio.to_thread(latex_import.stage_zip, up.filename, payload)
        except latex_import.ImportRejected as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    return {"token": meta["token"], "filename": meta["filename"], "files": meta["files"],
            "main_candidates": meta["main_candidates"], "excluded": meta["excluded"],
            "skipped": meta["skipped"], "sha256": meta["sha256"]}


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
        raise HTTPException(422, {"kind": "content", "message": f"未知 LaTeX 引擎：{engine}（允许：{'、'.join(config.LATEX_ENGINES)}）"})
    from app.domain import latex_import

    with _import_lock:
        try:
            stage, meta = latex_import.load_stage(token)
            if main not in meta["main_candidates"]:
                raise HTTPException(422, {"kind": "content", "message": f"主文件 {main} 不在候选列表中（候选：{', '.join(meta['main_candidates'][:8])}）"})
            store = request.app.state.store
            pid = store.unique_pid("imported-paper")
            final_dir = os.path.join(store.root, pid)
            # 最后一步：暂存 → 正式工程目录（平台自行写 studio.json，不信任上传配置）
            await asyncio.to_thread(latex_import.materialize, stage, final_dir)
            try:
                from app import atomic

                await asyncio.to_thread(
                    atomic.write_json, os.path.join(final_dir, "studio.json"),
                    {"document_type": "paper", "source_format": "latex",
                     "latex": {"main": main.replace(os.sep, "/"), "engine": engine},
                     "title": title or "导入的 LaTeX 工程"},
                )
                await asyncio.to_thread(store.get, pid)
            except Exception:
                shutil.rmtree(final_dir, ignore_errors=True)
                raise
            latex_import.drop_stage(stage)
        except latex_import.ProjectError as e:
            raise HTTPException(e.status, {"kind": "content", "message": str(e)})
    await auth.grant_owner(pid, user)
    events.emit("case.created", pid=pid, actor=events.actor_of(user),
                data={"title": title or "导入的 LaTeX 工程", "source": "zip-import"})
    from app.routes.latex import _out
    return _out(store.get(pid))


# --- SyncTeX 正反向跳转 ---

class SynctexViewIn(BaseModel):
    file: str = Field(min_length=1, max_length=400)
    line: int = Field(ge=1)


class SynctexEditIn(BaseModel):
    page: int = Field(ge=1)
    x: float = 0
    y: float = 0


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


# --- 文件重命名 / 删除（工程文件面板行内操作） ---
# 注意：rename/delete 必须先于 create（{rel:path} 贪婪匹配会把 ".../rename" 吞进 create）

class RenameFileIn(BaseModel):
    new_path: str = Field(min_length=1, max_length=400)


@router.post("/latex/files/{rel:path}/rename")
async def rename_file_route(pid: str, rel: str, request: Request, body: RenameFileIn,
                            user: auth.CurrentUser = None):
    store = request.app.state.store
    project = store.get(pid)
    new_rel = await asyncio.to_thread(latex_files.rename_file, project, rel, body.new_path)
    # 主文件被改名 ⇒ 编译设置自动跟随（否则下次编译 404 主文件不存在）
    cfg = project.settings.get("latex") or {}
    if cfg.get("main") == rel:
        await asyncio.to_thread(store.update_settings, pid, {"latex": {"main": new_rel}})
    await asyncio.to_thread(latex_history.commit, project.dir, f"rename {rel} -> {new_rel}",
                            user.email if user is not None else None, True)
    return {"ok": True, "path": new_rel, "main_updated": cfg.get("main") == rel}


@router.delete("/latex/files/{rel:path}")
async def delete_file_route(pid: str, rel: str, request: Request, user: auth.CurrentUser = None):
    store = request.app.state.store
    project = store.get(pid)
    cfg = project.settings.get("latex") or {}
    main_now = (cfg.get("main") or "").replace("\\", "/")
    if main_now == rel.replace("\\", "/"):
        raise HTTPException(409, {
            "kind": "content",
            "message": "该文件是编译主文件——请先在「编译设置」中更换主文件，再删除",
        })
    await asyncio.to_thread(latex_files.delete_file, project, rel)
    await asyncio.to_thread(latex_history.commit, project.dir, f"delete {rel}",
                            user.email if user is not None else None, True)
    return {"ok": True}


@router.post("/latex/files/{rel:path}")
async def create_file(pid: str, rel: str, request: Request, body: CreateFileIn = None,
                      user: auth.CurrentUser = None):
    """新建文本文件（可编辑扩展名白名单；409=已存在）。"""
    store = request.app.state.store
    project = store.get(pid)
    saved = await asyncio.to_thread(
        latex_files.create_text_file, project, rel, body.content if body else "")
    await asyncio.to_thread(latex_history.commit, project.dir, f"create {saved}",
                            user.email if user is not None else None, True)
    return {"ok": True, "path": saved}


# --- AI 审稿 → Issue 清单（外发范围：单文件全文，前端显式确认后才调用） ---


class AiReviewIn(BaseModel):
    file: str = Field(min_length=1, max_length=400)
    content: str = Field(min_length=1, max_length=80000)


def _parse_issue_array(text: str) -> list[dict]:
    """模型输出 → [{line, message}]。容错：剥代码围栏；非数组/异常项丢弃。"""
    import json
    import re as _re
    raw = (text or "").strip()
    raw = _re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=_re.MULTILINE).strip()
    try:
        obj = json.loads(raw)
    except Exception:  # noqa: BLE001
        start, end = raw.find("["), raw.rfind("]")
        if start == -1 or end <= start:
            return []
        try:
            obj = json.loads(raw[start:end + 1])
        except Exception:  # noqa: BLE001
            return []
    if not isinstance(obj, list):
        return []
    out = []
    for item in obj[:20]:
        if not isinstance(item, dict):
            continue
        msg = str(item.get("message") or "").strip()
        if not msg:
            continue
        line = item.get("line")
        out.append({"line": int(line) if isinstance(line, (int, float)) and line > 0 else None,
                    "message": msg[:500]})
    return out


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
        # deepseek-flash 等推理型模型会消耗大量 reasoning tokens——max_tokens 须留足最终答案空间
        result = await client.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user_content}],
            "interactive", max_tokens=8192, temperature=0.3)
    except Exception as e:  # noqa: BLE001 — AiError 等统一转 502
        raise HTTPException(502, {"kind": "ai", "message": f"AI 调用失败：{e}"})
    items = _parse_issue_array(result.text)[:12]
    created = []
    for item in items:
        created.append(await asyncio.to_thread(
            latex_issues.add_issue, project, item["message"], body.file, item["line"]))
    return {"added": len(created), "issues": created}
