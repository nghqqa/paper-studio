# -*- coding: utf-8 -*-
"""工程文件面板三操作（v0.4.2）：新建文本文件 / 上传单文件 / 上传 ZIP 合并入包 / 整包下载。

安全口径：
- 全部经 latex_build.resolve_source_path（穿越/绝对路径/内部目录/符号链接越界一律 400）；
- 扩展名白名单 = 文本可编辑族（LATEX_TEXT_EXTS）+ 预览资源族（图片/PDF/EPS）；
- 上传单文件默认拒绝覆盖已有文件（overwrite 显式开启才覆盖），≤25MB；
- ZIP 合并与导入同规拒绝（穿越/绝对路径/符号链接/加密条目/嵌套归档/超限/平台保留名），
  已存在文件与平台内部目录一律「跳过并报告」，绝不静默覆盖。
"""
from __future__ import annotations

import io
import os
import zipfile

from app import config
from app.domain import latex_build
from app.domain.latex_import import (
    ARCHIVE_EXTS,
    JUNK_DIRS,
    JUNK_FILES,
)
from app.domain.projects import LATEX_TEXT_EXTS, ProjectError

BINARY_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".pdf", ".eps", ".tif", ".tiff")
UPLOAD_MAX_BYTES = 25 * 1024 * 1024
ZIP_MERGE_MAX_TOTAL = config.IMPORT_MAX_TOTAL_MB * 1024 * 1024


def ext_allowed(name: str) -> bool:
    low = name.lower()
    return low.endswith(LATEX_TEXT_EXTS + BINARY_EXTS)


def create_text_file(project, rel: str, content: str = "") -> str:
    p = latex_build.resolve_source_path(project, rel)
    if os.path.exists(p):
        raise ProjectError(f"已存在同名文件：{rel}", 409)
    ext = os.path.splitext(p)[1].lower()
    if ext not in LATEX_TEXT_EXTS:
        raise ProjectError(f"新建仅支持文本类型（{', '.join(LATEX_TEXT_EXTS)}）", 415)
    os.makedirs(os.path.dirname(p) or p, exist_ok=True)
    tmp = p + ".newtmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    os.replace(tmp, p)
    return rel


def upload_file(project, rel: str, data: bytes, overwrite: bool = False) -> str:
    p = latex_build.resolve_source_path(project, rel)
    if os.path.exists(p) and not overwrite:
        raise ProjectError(f"已存在同名文件：{rel}（重传同名请先在编辑器中修改，或更换文件名）", 409)
    if len(data) > UPLOAD_MAX_BYTES:
        raise ProjectError("单个文件超过 25MB 上限", 413)
    low = rel.lower()
    if low.endswith(BINARY_EXTS):
        os.makedirs(os.path.dirname(p) or p, exist_ok=True)
        tmp = p + ".newtmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
        return rel
    if not low.endswith(LATEX_TEXT_EXTS):
        raise ProjectError(f"不支持的文件类型：{rel}", 415)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ProjectError("文本文件必须是 UTF-8 编码", 422) from e
    os.makedirs(os.path.dirname(p) or p, exist_ok=True)
    tmp = p + ".newtmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, p)
    return rel


def merge_zip(project, payload: bytes) -> dict:
    """ZIP 合并入已有工程（不覆盖）：两阶段——先全量校验（任一硬拒绝则整体不入包），
    再统一写入；已存在文件与平台内部目录「跳过并报告」，绝不静默覆盖。
    返回 {added, skipped_existing, skipped_rejected}。"""
    added: list[str] = []
    skipped_existing: list[str] = []
    skipped_rejected: list[str] = []
    if len(payload) > config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024:
        raise ProjectError(f"压缩包超过上传上限 {config.IMPORT_MAX_UPLOAD_MB}MB", 413)
    try:
        zf = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as e:
        raise ProjectError("损坏的 ZIP 压缩包", 422) from e
    total = 0
    staged: list[tuple[str, bytes]] = []
    for info in zf.infolist():
        name = info.orig_filename
        if info.is_dir() or not name:
            continue
        parts = name.split("/")
        base = parts[-1]
        if parts[0] in JUNK_DIRS or base in JUNK_FILES:
            continue
        norm = name.replace("\\", "/")
        if (name.startswith("/") or name.startswith("\\") or ".." in norm.split("/")
                or ":" in norm.split("/")[0]):
            raise ProjectError(f"拒绝路径穿越/绝对路径条目：{norm}", 422)
        if (info.create_system == 3 and (info.external_attr >> 16) & 0o170000 == 0o120000):
            raise ProjectError(f"拒绝符号链接条目：{norm}", 422)
        if norm.lower().endswith(ARCHIVE_EXTS):
            raise ProjectError(f"拒绝嵌套归档条目：{norm}（请解压后按普通文件上传）", 422)
        low_parts = [q.lower() for q in norm.split("/")]
        if any(d in ("studio", "reviews", "figs-src", "attachments", "__pycache__", "docs") for d in low_parts[:-1]) \
                or low_parts[-1] in ("studio.json", "content.md", "case.json", "project.json", ".env"):
            skipped_rejected.append(norm)
            continue
        if not ext_allowed(norm):
            skipped_rejected.append(norm)
            continue
        total += info.file_size
        if info.file_size > UPLOAD_MAX_BYTES or total > ZIP_MERGE_MAX_TOTAL:
            raise ProjectError("解压总量超过上限", 413)
        staged.append((norm, zf.read(info)))
    # 校验全部通过 → 统一写入（resolve_source_path 在此再做一次穿越兜底）
    for norm, data in staged:
        p = latex_build.resolve_source_path(project, norm)
        if os.path.exists(p):
            skipped_existing.append(norm)
            continue
        os.makedirs(os.path.dirname(p) or p, exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
        added.append(norm)
    return {"added": added, "skipped_existing": skipped_existing, "skipped_rejected": skipped_rejected}


def export_zip_bytes(project) -> bytes:
    """整包下载：全部源文件（含二进制资源）打 zip（deflate）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for item in latex_build.list_source_files(project):
            p = os.path.join(latex_build.source_root(project), item["path"])
            z.write(p, item["path"])
    return buf.getvalue()


def rename_file(project, old_rel: str, new_rel: str) -> str:
    """重命名/移动源文件。返回新相对路径。
    约束：旧文件须存在且为可编辑文本类型；新路径不得已存在、不得改出可编辑白名单；
    若改名的是编译主文件，调用方（路由）负责同步编译设置。提案锚点含旧路径——
    改名后旧提案会标记原文已变化，属已知边界（面板会如实提示）。"""
    old_rel = (old_rel or "").strip()
    new_rel = (new_rel or "").strip().replace("\\", "/")
    if not old_rel or not new_rel:
        raise ProjectError("重命名需要原路径与新路径", 422)
    old_p = latex_build.resolve_source_path(project, old_rel)
    if not os.path.isfile(old_p):
        raise ProjectError(f"文件不存在：{old_rel}", 404)
    old_ext = os.path.splitext(old_p)[1].lower()
    if old_ext not in LATEX_TEXT_EXTS:
        raise ProjectError("仅支持重命名文本源文件（图片/PDF 暂不支持改名）", 415)
    new_p = latex_build.resolve_source_path(project, new_rel)
    if os.path.exists(new_p):
        raise ProjectError(f"目标已存在：{new_rel}", 409)
    new_ext = os.path.splitext(new_p)[1].lower()
    if new_ext not in LATEX_TEXT_EXTS:
        raise ProjectError(f"新扩展名不在可编辑白名单（{', '.join(LATEX_TEXT_EXTS)}）", 415)
    os.makedirs(os.path.dirname(new_p) or new_p, exist_ok=True)
    os.rename(old_p, new_p)
    return new_rel


def delete_file(project, rel: str) -> None:
    """删除源文件（不可恢复；主文件删除由路由层拒绝并提示先换主文件）。"""
    p = latex_build.resolve_source_path(project, rel)
    if not os.path.isfile(p):
        raise ProjectError(f"文件不存在：{rel}", 404)
    ext = os.path.splitext(p)[1].lower()
    if ext not in LATEX_TEXT_EXTS:
        raise ProjectError("仅支持删除文本源文件（图片/PDF 暂不支持删除）", 415)
    os.remove(p)
