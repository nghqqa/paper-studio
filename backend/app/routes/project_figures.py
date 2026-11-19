# -*- coding: utf-8 -*-
"""科研图表（论文线 v0.3）：数据图（chart）与方法图（diagram）的存储与插图贯通。

每个项目的 `figures/` 目录下保存渲染产物和 `index.json` 元数据。
- chart（数据图，v0.3 原有能力）：`<fid>.png` 由后端 matplotlib 渲染，行字段保持 v0.3
  原样（不加 kind 等新键——历史行缺 kind 读端一律视为 chart，兼容旧数据与既有测试）。
- diagram（方法图，B1 新增）：编辑真源 = `<fid>.excalidraw` 场景 JSON（内嵌图片资源），
  展示/插图产物 = `<fid>.png`（前端编辑器高清导出后随保存上传）。每次 PUT version+1，
  `expected_version` 不符 409（乐观并发）。fid 沿用同一正则，Word 插件
  `paper-figure:<fid>:<sha16>` 原位替换链路对两种 kind 一致生效（sha256 为读取时现算）。
删除移除 PNG/场景文件和索引记录。项目删除时 figures/ 随项目目录一起删除。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import re
import time
from typing import Annotated, Literal, Union

from fastapi import APIRouter, HTTPException, Path, Query, Request, Response
from PIL import Image
from pydantic import BaseModel, Field

from app import atomic, auth, config
from app.auth import CurrentUser
from app.domain import cases, latex_files, latex_history, word_documents
from app.routes.charts import ChartIn, render_png

# 独立前缀：/api/projects/{pid}/figures 已被旧版论文插图路由（routes/figures.py）占用，
# 先注册先匹配会把本路由整个遮蔽（图表页拿到旧数据 shape → id/created_at 全丢）。
router = APIRouter(prefix="/api/project-figures/{pid}", tags=["figures"])
# main 的全局 project_access 根据 pid 校验：读 viewer，写 editor。
FigureId = Annotated[str, Path(pattern=r"^fig-[0-9]+-[0-9a-f]{6}$")]
MAX_WORD_IMAGE_BYTES = 5 * 1024 * 1024
MAX_WORD_IMAGE_PIXELS = 16_000_000
# 方法图场景真源上限：scene JSON（含内嵌资源 dataURL）与元素数量。
MAX_SCENE_BYTES = 10 * 1024 * 1024
MAX_SCENE_ELEMENTS = 5000


def _fig_dir(pid: str) -> str:
    return os.path.join(config.PROJECTS_DIR, pid, "figures")


def _fig_meta(pid: str) -> str:
    return os.path.join(_fig_dir(pid), "index.json")


def _load_meta(pid: str) -> list[dict]:
    p = _fig_meta(pid)
    if not os.path.isfile(p):
        return []
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _save_meta(pid: str, rows: list[dict]) -> None:
    atomic.write_json(_fig_meta(pid), rows)


def _require_project(request: Request, pid: str) -> str:
    # 统一校验项目标识和工程存在性，不能直接把路由参数拼入文件路径。
    project = request.app.state.store.get(pid)
    # 归档项目不可操作图表
    if project.settings.get("archived") or cases.load_case(project.dir).archived:
        raise HTTPException(403, "项目已归档，图表不可读写")
    return project.dir


class FigureCreate(ChartIn):
    name: str = Field(min_length=1, max_length=120)


class DiagramCreate(BaseModel):
    """方法图首存：场景 JSON 文本 + 高清导出 PNG（前端编辑器产出）。"""
    kind: Literal["diagram"]
    name: str = Field(min_length=1, max_length=120)
    scene: str
    png_data_url: str


class DiagramUpdate(BaseModel):
    """方法图原地更新：expected_version 不符 409，成功后 version+1。"""
    name: str | None = Field(default=None, min_length=1, max_length=120)
    scene: str
    png_data_url: str
    expected_version: int = Field(ge=1)


class PublishLatexIn(BaseModel):
    """发布到 LaTeX 工程的目标文件名（不含目录/扩展名）；留空由服务端从图名清洗。"""
    stem: str = Field(default="", max_length=120)
    overwrite: bool = False


def _render_png(body: FigureCreate) -> bytes:
    return render_png(body)


def _validate_scene(scene: str) -> None:
    """场景真源只做轻量结构校验（格式/体量/元素数），不做深度语义解析，不执行任何内容。"""
    if len(scene.encode("utf-8")) > MAX_SCENE_BYTES:
        raise HTTPException(413, "场景文件超过 10MB 上限")
    try:
        data = json.loads(scene)
    except ValueError as e:
        raise HTTPException(422, "场景文件不是合法 JSON") from e
    if not isinstance(data, dict) or data.get("type") != "excalidraw":
        raise HTTPException(422, "场景文件不是 .excalidraw 格式")
    elements = data.get("elements")
    if not isinstance(elements, list):
        raise HTTPException(422, "场景文件缺少 elements 数组")
    if len(elements) > MAX_SCENE_ELEMENTS:
        raise HTTPException(422, "场景元素数量超限（>5000）")


def _decode_diagram_png(png_data_url: str) -> tuple[bytes, int, int]:
    """编辑器导出的 dataURL → PNG 字节；上限与 word-image 同规格（5MB / 1600 万像素）。"""
    prefix = "data:image/png;base64,"
    if not png_data_url.startswith(prefix):
        raise HTTPException(422, "图片必须是 PNG data URL")
    b64 = png_data_url[len(prefix):]
    if len(b64) > (MAX_WORD_IMAGE_BYTES * 4 + 3) // 3 + 4096:
        raise HTTPException(413, "图片超过 5MB，请在编辑器中降低导出清晰度后重试")
    try:
        png = base64.b64decode(b64, validate=True)
    except ValueError as e:
        raise HTTPException(422, "图片 base64 解码失败") from e
    if len(png) > MAX_WORD_IMAGE_BYTES:
        raise HTTPException(413, "图片超过 5MB，请在编辑器中降低导出清晰度后重试")
    try:
        with Image.open(io.BytesIO(png)) as image:
            if image.format != "PNG":
                raise HTTPException(422, "图片不是有效的 PNG")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > MAX_WORD_IMAGE_PIXELS:
                raise HTTPException(413, "图片像素过大，请缩小图片后重试")
            image.load()
    except Image.DecompressionBombError:
        raise HTTPException(413, "图片像素过大，请缩小图片后重试") from None
    except (OSError, ValueError):
        raise HTTPException(422, "图片损坏，请在编辑器中重新导出") from None
    return png, width, height


def _diagram_row(fid: str, name: str, png_len: int, width: int, height: int,
                 version: int, created_at: float | None = None) -> dict:
    now = time.time()
    return {"id": fid, "kind": "diagram", "name": name, "version": version,
            "created_at": created_at if created_at is not None else now,
            "updated_at": now, "bytes": png_len, "width_px": width, "height_px": height}


def _load_scene_bytes(pid: str, fid: str) -> str:
    path = os.path.join(_fig_dir(pid), fid + ".excalidraw")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        raise HTTPException(404, "场景文件不存在") from None


def _restore_file(path: str, old: bytes | None) -> None:
    """回滚单文件：旧字节存在则复原，否则删除新写入文件。"""
    if old is None:
        if os.path.exists(path):
            os.remove(path)
    else:
        atomic.write_bytes(path, old)


_TEX_SPECIALS = {"\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$",
                 "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}",
                 "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}


def _tex_escape(text: str) -> str:
    return "".join(_TEX_SPECIALS.get(ch, ch) for ch in text)


def _latex_stem(name: str, fid: str) -> str:
    """图名 → LaTeX 工程文件名：仅保留安全字符；纯中文等清洗为空时回退 fid。"""
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-_")
    return (stem[:80] or fid)


def _read_locked_png(pid: str, fid: str) -> tuple[dict, bytes]:
    """项目锁内读图表行与 PNG 字节（发布/快照共用）。"""
    row = next((r for r in _load_meta(pid) if r.get("id") == fid), None)
    if row is None:
        raise HTTPException(404, "图表不存在")
    try:
        with open(os.path.join(_fig_dir(pid), fid + ".png"), "rb") as f:
            png = f.read()
    except FileNotFoundError:
        raise HTTPException(404, "图表图片不存在") from None
    return row, png


@router.post("")
async def create_figure(pid: str, body: Union[FigureCreate, DiagramCreate],
                        request: Request, user: CurrentUser) -> dict:
    project_dir = _require_project(request, pid)
    fid = f"fig-{int(time.time())}-{os.urandom(3).hex()}"
    if isinstance(body, DiagramCreate):
        # 校验全部在锁外完成：锁内只做纯同步的磁盘发布。
        _validate_scene(body.scene)
        png, width, height = _decode_diagram_png(body.png_data_url)
        row = _diagram_row(fid, body.name, len(png), width, height, version=1)
        with atomic.studio_lock(project_dir, "project-figures"):
            rows = _load_meta(pid)
            scene_path = os.path.join(_fig_dir(pid), fid + ".excalidraw")
            png_path = os.path.join(_fig_dir(pid), fid + ".png")
            atomic.write_text(scene_path, body.scene)
            atomic.write_bytes(png_path, png)
            try:
                _save_meta(pid, [*rows, row])
            except Exception:
                _restore_file(scene_path, None)
                os.remove(png_path)
                raise
        return {"figure": row}
    # 数据图（chart）分支：行为与行字段保持 v0.3 原样。
    png = _render_png(body)
    row = {
        "id": fid, "name": body.name, "type": body.type,
        "title": body.title, "x_label": body.x_label, "y_label": body.y_label,
        "categories": body.categories,
        "series": [s.model_dump() for s in body.series],
        "created_at": time.time(), "bytes": len(png),
    }
    # PNG 与索引按同一项目串行发布，避免并发创建相互覆盖索引。
    with atomic.studio_lock(project_dir, "project-figures"):
        rows = _load_meta(pid)
        png_path = os.path.join(_fig_dir(pid), fid + ".png")
        atomic.write_bytes(png_path, png)
        try:
            _save_meta(pid, [*rows, row])
        except Exception:
            os.remove(png_path)
            raise
    return {"figure": row}


@router.get("")
async def list_figures(pid: str, request: Request, user: CurrentUser) -> dict:
    _require_project(request, pid)
    rows = _load_meta(pid)
    return {"figures": rows}


@router.get("/{fid}/png")
async def figure_png(pid: str, fid: FigureId, request: Request, user: CurrentUser):
    # ETag=sha16 + no-cache：原地更新（PUT）后浏览器不得再吃缓存旧图（已知缺陷修复）。
    _require_project(request, pid)
    png = os.path.join(_fig_dir(pid), fid + ".png")
    if not os.path.isfile(png):
        raise HTTPException(404, "图表不存在")
    with open(png, "rb") as f:
        data = f.read()
    etag = '"' + hashlib.sha256(data).hexdigest()[:16] + '"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    return Response(content=data, media_type="image/png",
                    headers={"ETag": etag, "Cache-Control": "no-cache"})


@router.delete("/{fid}")
async def delete_figure(pid: str, fid: FigureId, request: Request, user: CurrentUser) -> dict:
    project_dir = _require_project(request, pid)
    with atomic.studio_lock(project_dir, "project-figures"):
        rows = [r for r in _load_meta(pid) if r["id"] != fid]
        _save_meta(pid, rows)
        for suffix in (".png", ".excalidraw"):
            path = os.path.join(_fig_dir(pid), fid + suffix)
            if os.path.isfile(path):
                os.remove(path)
    return {"ok": True}


@router.put("/{fid}")
async def update_diagram(pid: str, fid: FigureId, body: DiagramUpdate,
                         request: Request, user: CurrentUser) -> dict:
    """方法图原地更新：场景与 PNG 双文件原子替换 + version 乐观并发守卫。"""
    project_dir = _require_project(request, pid)
    # 校验全部在锁外完成（纯 CPU）；锁内只做版本判定与受保护的落盘。
    _validate_scene(body.scene)
    png, width, height = _decode_diagram_png(body.png_data_url)
    scene_path = os.path.join(_fig_dir(pid), fid + ".excalidraw")
    png_path = os.path.join(_fig_dir(pid), fid + ".png")
    with atomic.studio_lock(project_dir, "project-figures"):
        rows = _load_meta(pid)
        index = next((i for i, r in enumerate(rows) if r.get("id") == fid), None)
        if index is None:
            raise HTTPException(404, "图表不存在")
        row = rows[index]
        if row.get("kind") != "diagram":
            raise HTTPException(422, "数据图不支持画布更新")
        version = int(row.get("version") or 0)
        if version != body.expected_version:
            raise HTTPException(409, {"kind": "version_conflict",
                                      "message": "该方法图已被他人更新，请重新打开编辑器后再保存",
                                      "current_version": version})
        # 先备份旧字节：任一步失败即整组回滚，绝不留下场景/PNG/索引不一致的中间态。
        old_scene_bytes: bytes | None = None
        if os.path.isfile(scene_path):
            with open(scene_path, "rb") as f:
                old_scene_bytes = f.read()
        old_png_bytes: bytes | None = None
        if os.path.isfile(png_path):
            with open(png_path, "rb") as f:
                old_png_bytes = f.read()
        updated = _diagram_row(fid, body.name or row["name"], len(png), width, height,
                               version=version + 1,
                               created_at=row.get("created_at"))
        try:
            atomic.write_text(scene_path, body.scene)
            atomic.write_bytes(png_path, png)
            _save_meta(pid, rows[:index] + [updated] + rows[index + 1:])
        except Exception:
            _restore_file(scene_path, old_scene_bytes)
            _restore_file(png_path, old_png_bytes)
            raise
    return {"figure": updated}


@router.get("/{fid}/scene")
async def figure_scene(pid: str, fid: FigureId, request: Request, response: Response,
                       user: CurrentUser) -> dict:
    """方法图场景真源（编辑器重开恢复用）；chart 无场景文件。"""
    _require_project(request, pid)
    row = next((r for r in _load_meta(pid) if r.get("id") == fid), None)
    if row is None:
        raise HTTPException(404, "图表不存在")
    if row.get("kind") != "diagram":
        raise HTTPException(404, "数据图没有场景文件")
    scene = _load_scene_bytes(pid, fid)
    response.headers["Cache-Control"] = "no-store"
    return {"id": fid, "name": row["name"], "version": int(row.get("version") or 0),
            "updated_at": row.get("updated_at"), "scene": scene}


@router.post("/{fid}/publish-latex")
async def publish_figure_to_latex(pid: str, fid: FigureId, body: PublishLatexIn,
                                  request: Request, user: CurrentUser) -> dict:
    """发布图表 PNG 到 LaTeX 工程 figures/<stem>.png（默认拒绝覆盖），返回可粘贴的 figure 片段。

    先存资源、后由作者自行粘贴源码片段：发布失败时工程内不留任何文件，天然不产生断链。"""
    project_dir = _require_project(request, pid)
    project = request.app.state.store.get(pid)
    if project.settings.get("source_format") != "latex":
        raise HTTPException(400, "只有 LaTeX 项目可以发布图表")
    with atomic.studio_lock(project_dir, "project-figures"):
        row, png = _read_locked_png(pid, fid)
    stem = _latex_stem(body.stem.strip() or row["name"], fid)
    rel = f"figures/{stem}.png"
    # LaTeX 工程 source root = 工程目录本体，图表库的 figures/ 天然在源码树内；
    # stem 回退为 fid 时目标即库文件本身，资源已在位，无需拷贝。
    library_png = os.path.join(_fig_dir(pid), fid + ".png")
    saved = rel
    if os.path.realpath(os.path.join(project.dir, rel)) != os.path.realpath(library_png):
        saved = await asyncio.to_thread(latex_files.upload_file, project, rel, png, body.overwrite)
        await asyncio.to_thread(latex_history.commit, project.dir,
                                f"publish figure {fid} -> {saved}",
                                user.email if user is not None else None, True)
    snippet = ("\\begin{figure}[htbp]\n  \\centering\n"
               f"  \\includegraphics[width=0.8\\linewidth]{{{os.path.splitext(saved)[0]}}}\n"
               f"  \\caption{{{_tex_escape(row['name'])}}}\n"
               f"  \\label{{fig:{stem}}}\n\\end{{figure}}")
    return {"ok": True, "path": saved, "stem": stem, "snippet": snippet}


@router.get("/{fid}/word-image")
async def word_image(pid: str, fid: FigureId, request: Request, response: Response, user: CurrentUser,
                     doc_key: Annotated[str, Query(min_length=8, max_length=80)]) -> dict:
    """当前 Word 插件取得本项目 PNG 快照；会话键只做绑定，不能代替编辑权限。"""
    await auth.check_access(request, user, pid, "editor")
    project_dir = _require_project(request, pid)
    project = request.app.state.store.get(pid)
    if project.settings.get("source_format") != "docx":
        raise HTTPException(400, "只有原生 Word 项目可以插入图表")
    if cases.get_state(cases.user_key(user), pid) != "active":
        raise HTTPException(403, "请先将项目移出归档或回收站，再插入图表")
    session = word_documents.session(project_dir, rotate_if_closed=False)
    if session.get("closed") or session.get("key") != doc_key:
        raise HTTPException(409, {"kind": "stale", "message": "Word 会话已结束或更新，请重新打开文档"})

    # 与创建/删除使用同一项目锁。只读取服务端已登记 PNG，不接受任意 URL 或客户端图片数据。
    with atomic.studio_lock(project_dir, "project-figures"):
        figure = next((row for row in _load_meta(pid) if row.get("id") == fid), None)
        if figure is None:
            raise HTTPException(404, "图表不存在")
        try:
            with open(os.path.join(_fig_dir(pid), fid + ".png"), "rb") as f:
                png = f.read(MAX_WORD_IMAGE_BYTES + 1)
        except FileNotFoundError:
            raise HTTPException(404, "图表图片不存在") from None
    if len(png) > MAX_WORD_IMAGE_BYTES:
        raise HTTPException(413, "图表图片超过 5 MB，请缩小图片后重试")
    try:
        with Image.open(io.BytesIO(png)) as image:
            if image.format != "PNG":
                raise HTTPException(422, "图表图片不是有效的 PNG")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > MAX_WORD_IMAGE_PIXELS:
                raise HTTPException(413, "图表图片像素过大，请缩小图片后重试")
            image.load()
    except Image.DecompressionBombError:
        raise HTTPException(413, "图表图片像素过大，请缩小图片后重试") from None
    except (OSError, ValueError):
        raise HTTPException(422, "图表图片损坏，请重新生成图表") from None
    response.headers["Cache-Control"] = "no-store"
    return {"id": fid, "name": figure["name"],
            "data_url": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
            "width_px": width, "height_px": height, "sha256": hashlib.sha256(png).hexdigest(),
            "bytes": len(png)}
