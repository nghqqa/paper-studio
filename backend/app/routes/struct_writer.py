# -*- coding: utf-8 -*-
"""结构化中文论文（实验，默认关闭）路由：创建 / 内容读写（乐观并发） / 版本 / 资源 / 导出。

开关：config.STRUCT_WRITER_ON（PATENT_STUDIO_STRUCT_WRITER=on）；关闭时全部端点 404，
前端入口亦由 /api/meta 的 struct_writer 隐藏——前后端双侧限制，不依赖单一侧。
权限：全局 project_access + 默认档（GET=viewer / 写=editor）；导出创建=editor；
      reviewer/viewer 服务端只读（不依赖前端禁用）。
事实源：项目目录 content.json（schema_version 化 JSON，对象稳定 ID，引用存目标 ID）；
版本快照：.studio/structured/versions/；导出产物：artifacts/（manifest 记录内容 sha/资源摘要/profile，
内容变化后旧导出标记 stale）。PDF：经 STRUCT_PDF_SVC_URL 指定的转换服务从**本次 DOCX**转出；
未配置时 501（DOCX 仍可下载）。
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time
import urllib.error
import urllib.request

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from app import auth, config
from app.domain import events
from app.domain import structured, structured_export
from app.errors import error_detail
from app.domain.projects import ProjectError

router = APIRouter(prefix="/api/projects/{pid}/struct", tags=["struct"])
create_router = APIRouter(tags=["struct"])

RES_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif"}
RES_MAX_BYTES = 10 * 1024 * 1024
ARTIFACT_MEDIA = {"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  "pdf": "application/pdf", "json": "application/json"}


def _on(request: Request | None = None, pid: str | None = None) -> None:
    if config.STRUCT_WRITER_ON:
        return
    # Retain existing drafts behind the project ACL while authors save/migrate.
    # The flag still gates creation of any new structured project.
    if request is not None and pid is not None:
        project = request.app.state.store.get(pid)
        if project.settings.get("source_format") == "structured":
            return
    raise HTTPException(404, error_detail("not_found", "新建结构化写作已停用，请使用 Word 论文"))


def _store(request: Request):
    return request.app.state.store


def _project(request: Request, pid: str):
    project = _store(request).get(pid)
    if project.settings.get("source_format") != "structured":
        raise HTTPException(400, error_detail("validation", "该工程不是结构化论文工程"))
    return project


def _pdir(request: Request, pid: str):
    try:
        return _store(request).get(pid).dir
    except ProjectError as e:
        code = e.args[1] if len(e.args) > 1 else 404
        raise HTTPException(code, error_detail("not_found", str(e)))


def _current(request: Request, pid: str) -> tuple[dict, str]:
    d = _pdir(request, pid)
    cpath = structured.content_path(d)
    if not os.path.exists(cpath):
        raise HTTPException(404, error_detail("not_found", "content 不存在"))
    content = structured.load_content(d)
    return content, structured.content_sha(content)


def _conflict(cur_sha: str):
    return JSONResponse(status_code=409, content={
        "detail": error_detail("conflict", "内容已被他人保存（base_sha 不匹配），请刷新后基于最新版本修改",
                               detail=cur_sha)})


class StructCreateIn(BaseModel):
    title: str = "结构化中文论文（实验）"
    # 投稿目标元数据（统一新建对话框收集；随 studio.json 持久化，仅作记录/筛选，不影响导出）
    venue: str = ""
    field: str = ""
    rank: str = ""


class StructContentIn(BaseModel):
    content: dict
    base_sha: str | None = None


class PdfIn(BaseModel):
    docx: str


@create_router.post("/api/projects/struct/create")
async def create_structured(request: Request, body: StructCreateIn | None = None,
                            user: auth.CurrentUser = None):
    _on()
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    store = _store(request)
    title = (body.title if body and body.title else "结构化中文论文（实验）").strip()[:60]
    pid = store.unique_pid("struct-paper")
    submission = {k: getattr(body, k, "") for k in ("venue", "field", "rank")} if body else {}
    project = store.create_structured(pid, title, submission=submission)
    # 初始内容即版本 v001（与后续保存同一快照机制）
    structured.save_content(project.dir, structured.load_content(project.dir), "create")
    await auth.grant_owner(project.id, user)
    events.emit("case.created", pid=project.id, actor=events.actor_of(user),
                data={"title": project.title})
    from app.routes.latex import _out
    return _out(project)


@router.get("/content")
async def get_content(pid: str, request: Request):
    _on(request, pid)
    content, sha = _current(request, pid)
    d = _pdir(request, pid)
    return {"content": content, "sha": sha, "versions": structured.load_versions(d)}


@router.put("/content")
async def put_content(pid: str, request: Request, body: StructContentIn, user: auth.CurrentUser = None):
    _on(request, pid)
    d = _pdir(request, pid)
    cpath = structured.content_path(d)
    cur_sha = structured.content_sha(structured.load_content(d)) if os.path.exists(cpath) else ""
    if body.base_sha is not None and body.base_sha != cur_sha:
        return _conflict(cur_sha)
    gate = structured.validate(body.content)
    v = structured.save_content(d, body.content, source=f"web:{getattr(user, 'id', 'anon')}")
    return {"saved": True, "version": v,
            "sha": structured.content_sha(body.content), "gate": gate}


@router.get("/versions")
async def get_versions(pid: str, request: Request):
    _on(request, pid)
    return {"versions": structured.load_versions(_pdir(request, pid))}


@router.get("/versions/{sha}")
async def get_version_snapshot(pid: str, sha: str, request: Request):
    _on(request, pid)
    if not re.fullmatch(r"[0-9a-f]{16}", sha or ""):
        raise HTTPException(400, error_detail("validation", "非法版本 sha"))
    snap = structured.load_version_snapshot(_pdir(request, pid), sha)
    if snap is None:
        raise HTTPException(404, error_detail("not_found", "版本快照不存在"))
    return snap


RES_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif"}


@router.post("/resources")
async def upload_resource(pid: str, request: Request, file: UploadFile | None = None):
    _on(request, pid)
    if file is None:
        raise HTTPException(400, error_detail("validation", "缺少文件"))
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in RES_MEDIA:
        raise HTTPException(400, error_detail("validation", "仅支持 png/jpg/jpeg/gif"))
    data = await file.read()
    if len(data) > RES_MAX_BYTES:
        raise HTTPException(413, error_detail("file", "图片超过 10MB 限制"))
    rid = "res-" + secrets.token_hex(4)
    rdir = os.path.join(_pdir(request, pid), "resources")
    os.makedirs(rdir, exist_ok=True)
    tmp = os.path.join(rdir, rid + ext + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, os.path.join(rdir, rid + ext))
    return {"rid": rid, "ext": ext, "bytes": len(data)}


@router.get("/resources/{rid}")
async def serve_resource(pid: str, rid: str, request: Request):
    _on(request, pid)
    if not re.fullmatch(r"res-[0-9a-f]{8}", rid):
        raise HTTPException(400, error_detail("validation", "非法资源 id"))
    rdir = os.path.join(_pdir(request, pid), "resources")
    for ext, media in RES_MEDIA.items():
        p = os.path.join(rdir, rid + ext)
        if os.path.exists(p):
            return FileResponse(p, media_type=media)
    raise HTTPException(404, error_detail("not_found", "资源不存在"))


@router.post("/export/docx")
async def export_docx(pid: str, request: Request, user: auth.CurrentUser = None):
    _on(request, pid)
    d = _pdir(request, pid)
    content, sha = _current(request, pid)
    versions = structured.load_versions(d)
    vid = versions[-1]["vid"] if versions else "v001-draft"
    mode = "table" if request.query_params.get("mode") == "table" else "tab"
    try:
        r = structured_export.export_docx(d, content, sha, vid, mode=mode)
    except structured_export.StructExportBlocked as e:
        return JSONResponse(status_code=422, content={
            "detail": error_detail("validation", "导出阻断（不产文件）：\n- " + "\n- ".join(e.errors))})
    out = os.path.join(d, "artifacts")
    os.makedirs(out, exist_ok=True)
    fname = f"paper-{sha[:12]}-{mode}.docx"
    dst = os.path.join(out, fname)
    shutil.copyfile(r["docx"], dst)
    manifest = dict(r["manifest"])
    manifest.update({"pid": pid, "artifact": fname, "at": int(time.time()), "stale": False,
                     "engine": "pandoc+numbering/layout.lua（编号为静态文本，非 Word 域）"})
    with open(dst + ".manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    return {"docxUrl": f"/api/projects/{pid}/struct/artifacts/{fname}", "manifest": manifest}


@router.get("/artifacts")
async def list_artifacts(pid: str, request: Request):
    _on(request, pid)
    d = _pdir(request, pid)
    adir = os.path.join(d, "artifacts")
    out = []
    cur_sha = ""
    cpath = structured.content_path(d)
    if os.path.exists(cpath):
        cur_sha = structured.content_sha(structured.load_content(d))
    if os.path.isdir(adir):
        for fn in sorted(os.listdir(adir)):
            if not fn.endswith(".manifest.json"):
                continue
            with open(os.path.join(adir, fn), encoding="utf-8") as f:
                m = json.load(f)
            m["stale"] = m.get("content_sha256") != cur_sha
            m["manifest_file"] = fn
            out.append(m)
    return {"artifacts": out, "current_sha": cur_sha}


@router.get("/artifacts/{name}")
async def artifact_file(pid: str, name: str, request: Request):
    _on(request, pid)
    if not re.fullmatch(r"[\w.-]+", name):
        raise HTTPException(400, error_detail("validation", "非法文件名"))
    p = os.path.join(_pdir(request, pid), "artifacts", name)
    if not os.path.exists(p):
        raise HTTPException(404, error_detail("not_found", "产物不存在"))
    media = ARTIFACT_MEDIA.get(name.rsplit(".", 1)[-1], "application/octet-stream")
    return FileResponse(p, media_type=media, filename=name)


def _sidecar_pdf_bytes(docx_path: str, filename: str) -> bytes:
    """把指定 DOCX 交给 PDF sidecar 转换，返回 PDF 字节。

    预览与导出 PDF 共用同一条转换路径（同一 sidecar、同一参数）——预览与导出的
    一致性由此构造性保证。sidecar 未配置/不可达时抛带可读信息的 HTTPException。"""
    svc = config.STRUCT_PDF_SVC_URL
    if not svc:
        raise HTTPException(501, error_detail(
            "not_implemented",
            "PDF 转换引擎未配置（DOCX 已可下载，可在本地用 Word/WPS 另存为 PDF）"))
    boundary = "----structpdf" + secrets.token_hex(4)
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{filename}\"\r\n"
            "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n")
    payload = head.encode() + open(docx_path, "rb").read() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        svc.rstrip("/") + "/convert", data=payload,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.read()
    except HTTPException:
        raise
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("detail", {}).get("message", "")
        except Exception:
            pass
        raise HTTPException(502, error_detail(
            "pdf", f"PDF 转换服务返回错误（HTTP {e.code}）{(': ' + detail) if detail else ''}"))
    except Exception as e:  # URLError / 连接拒绝 / 超时
        raise HTTPException(502, error_detail(
            "pdf", f"PDF 转换服务不可用：{e}（DOCX 已可下载，可在本地用 Word/WPS 另存为 PDF）"))


@router.post("/export/pdf")
async def export_pdf(pid: str, request: Request, body: PdfIn):
    _on(request, pid)
    if not re.fullmatch(r"[\w.-]+\.docx", body.docx):
        raise HTTPException(400, error_detail("validation", "非法 docx 名"))
    src = os.path.join(_pdir(request, pid), "artifacts", body.docx)
    if not os.path.exists(src):
        raise HTTPException(404, error_detail("not_found", "DOCX 不存在"))
    pdf_bytes = _sidecar_pdf_bytes(src, body.docx)
    pdf_name = body.docx[:-5] + ".pdf"
    out = os.path.join(_pdir(request, pid), "artifacts", pdf_name)
    tmp = out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(pdf_bytes)
    os.replace(tmp, out)
    return {"pdfUrl": f"/api/projects/{pid}/struct/artifacts/{pdf_name}",
            "bytes": len(pdf_bytes), "engine": "libreoffice-svc"}


# ---------------------------------------------------------------- 投稿版预览（与导出同一转换链）
# 缓存：{项目目录}/.studio/structured/previews/{content_sha}.pdf——键含 pid（项目目录隔离）
# 与内容 sha（同项目内容未变直接复用）；跨项目天然不复用。预览文件不进 artifacts/（不可下载产物）。
PREVIEW_DIR = os.path.join(".studio", "structured", "previews")
PREVIEW_KEEP = 3  # 每案保留最近 N 个 sha 的预览
_preview_running: dict[str, str] = {}  # pid -> 正在生成的 sha（同案单任务）
_preview_lock = threading.Lock()


def _preview_dir(project_dir: str) -> str:
    return os.path.join(project_dir, PREVIEW_DIR)


def _prune_previews(pdir: str, keep_sha: str) -> None:
    pdir_pv = _preview_dir(pdir)
    if not os.path.isdir(pdir_pv):
        return
    files = sorted(
        ((os.path.getmtime(os.path.join(pdir_pv, f)), f) for f in os.listdir(pdir_pv)
         if re.fullmatch(r"[0-9a-f]{64}\.pdf", f)),
        reverse=True)
    for _, fn in files[PREVIEW_KEEP:]:
        if fn != keep_sha + ".pdf":
            try:
                os.remove(os.path.join(pdir_pv, fn))
            except OSError:
                pass


@router.post("/preview")
async def preview(pid: str, request: Request, user: auth.CurrentUser = None):
    """投稿版预览：对**服务器已保存**的内容快照走与导出完全相同的链路
    （structured_export.export_docx → 同一 sidecar 转 PDF），产物按 content sha 缓存。

    权限与导出相同（editor；viewer/reviewer 不可生成）。同案同时只允许一个生成任务
    （409 回带运行中 sha）；任务完成前内容已变化则丢弃结果（不落盘、不返回旧结果）。
    失败不产生任何可下载产物（工作目录即毁）。"""
    _on(request, pid)
    d = _pdir(request, pid)
    content, sha = _current(request, pid)
    versions = structured.load_versions(d)
    vid = versions[-1]["vid"] if versions else "v001-draft"

    pv_dir = _preview_dir(d)
    os.makedirs(pv_dir, exist_ok=True)
    cached = os.path.join(pv_dir, sha + ".pdf")
    if os.path.exists(cached):
        return {"status": "cached", "sha": sha, "vid": vid, "mode": "tab",
                "pdfUrl": f"/api/projects/{pid}/struct/preview/pdf/{sha}.pdf",
                "bytes": os.path.getsize(cached), "duration_ms": 0}

    with _preview_lock:
        running = _preview_running.get(pid)
        if running is not None:
            return JSONResponse(status_code=409, content={
                "detail": error_detail("busy", "该项目已有预览生成中，请稍后再试", detail=running)})
        _preview_running[pid] = sha
    t0 = time.monotonic()
    try:
        try:
            r = structured_export.export_docx(d, content, sha, vid, mode="tab")
        except structured_export.StructExportBlocked as e:
            raise HTTPException(422, error_detail(
                "validation", "预览被门禁阻断（当前草稿含不支持内容）：" + "; ".join(e.errors)))
        pdf_bytes = _sidecar_pdf_bytes(r["docx"], f"paper-{sha[:12]}-tab.docx")
        # 生成期间内容已变化 ⇒ 丢弃（不落盘、不返回），避免旧结果冒充新版本
        cur = structured.content_sha(structured.load_content(d))
        if cur != sha:
            return JSONResponse(status_code=409, content={
                "detail": error_detail("stale", "预览生成期间内容已变化，本次结果已丢弃，请重试", detail=cur)})
        tmp = cached + ".tmp"
        with open(tmp, "wb") as f:
            f.write(pdf_bytes)
        os.replace(tmp, cached)
        _prune_previews(d, sha)
        return {"status": "ok", "sha": sha, "vid": vid, "mode": "tab",
                "pdfUrl": f"/api/projects/{pid}/struct/preview/pdf/{sha}.pdf",
                "bytes": len(pdf_bytes), "duration_ms": int((time.monotonic() - t0) * 1000)}
    finally:
        with _preview_lock:
            _preview_running.pop(pid, None)


@router.get("/preview/pdf/{name}")
async def preview_pdf(pid: str, name: str, request: Request, user: auth.CurrentUser = None):
    """预览 PDF 读取：与导出同门槛（viewer/reviewer 不可下载新导出，预览同口径）。

    路由级 editor 门槛：project_access 对 GET 默认只要求 viewer，此处显式收紧。"""
    _on(request, pid)
    await auth.require_role("editor")(request, user)
    if not re.fullmatch(r"[0-9a-f]{64}\.pdf", name or ""):
        raise HTTPException(400, error_detail("validation", "非法预览文件名"))
    p = os.path.join(_preview_dir(_pdir(request, pid)), name)
    if not os.path.exists(p):
        raise HTTPException(404, error_detail("not_found", "预览不存在（内容可能已变化，请刷新预览）"))
    return FileResponse(p, media_type="application/pdf", filename=f"preview-{name}")
