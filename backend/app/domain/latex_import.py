# -*- coding: utf-8 -*-
"""受限 LaTeX ZIP 工程导入（v0.1 论文试用发行版）。

两段式：POST /latex/import/upload（校验+暂存）→ POST /latex/import/create（建项）。
边界（全部显式拒绝，不静默删减）：
- 上传大小 / 解压总量 / 文件数 / 单文件大小上限（config 可配）；
- 拒绝：路径穿越(..)、绝对路径、反斜杠、符号链接、嵌套归档(.zip/.tar/.gz 等)、
  超限压缩包、重名(大小写不敏感平台)、内部目录(.studio/reviews/figs-src/attachments/docs)与
  平台元数据文件(studio.json/content.md/case.json/project.json)；
- 自动跳过并声明：__MACOSX/、.DS_Store；
- 主文件候选 = 含 \\documentclass 的 .tex（不含被拒/跳过项）；多个候选由用户选择，不猜；
- 创建时平台自行生成 studio.json（不信任上传配置），owner 授权，历史提交；
- 异常不留半成品项目：先在暂存目录完成全部校验，创建为最后的原子步骤（先写临时项目目录
  再 rename），失败即清理。
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import uuid
import zipfile

from app import config
from app.domain.projects import ProjectError

# 暂存目录与账号库同级（projects 目录之外，避免被工程列表扫描到）
STAGING_DIR = os.path.join(os.path.dirname(config.PROJECTS_DIR), ".import-staging")
STAGE_TTL_S = config.IMPORT_STAGE_TTL_S

# 上传内容不得触碰的平台内部路径（相对工程根，'/' 分隔）
FORBIDDEN_DIRS = (".studio", "reviews", "figs-src", "attachments", "docs", "__pycache__")
FORBIDDEN_FILES = ("studio.json", "content.md", "case.json", "project.json", ".env")
JUNK_DIRS = ("__MACOSX",)
JUNK_FILES = (".DS_Store",)
ARCHIVE_EXTS = (".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".bz2", ".xz")

_lock = threading.Lock()


def _candidate_sort_key(path: str) -> tuple:
    """主文件候选展示排序：template > sample > 其他；文档目录垫底；层级浅优先；其余按名稳定。"""
    low = path.lower()
    in_doc_dir = 1 if ("/doc/" in low or low.startswith("doc/")) else 0
    kind = 0 if "template" in os.path.basename(low) else (1 if "sample" in os.path.basename(low) else 2)
    return (in_doc_dir, kind, path.count("/"), low)


class ImportRejected(ProjectError):
    """导入被拒绝：带明确原因清单（不静默删减）。"""


def _prune_stale() -> None:
    """清理超过 TTL 的暂存目录（每次上传时调用；只动 .staging 下自己的目录）。"""
    if not os.path.isdir(STAGING_DIR):
        return
    now = time.time()
    for name in os.listdir(STAGING_DIR):
        p = os.path.join(STAGING_DIR, name)
        try:
            if now - os.path.getmtime(p) > STAGE_TTL_S:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            continue


def stage_zip(filename: str, payload: bytes) -> dict:
    """校验并暂存上传的 ZIP。返回 {token, files, main_candidates, excluded, skipped}。"""
    if not filename.lower().endswith(".zip"):
        raise ImportRejected("仅支持 .zip 压缩包", 415)
    max_upload = config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024
    if len(payload) > max_upload:
        raise ImportRejected(
            f"压缩包 {len(payload) / 1048576:.1f}MB 超过上限 {config.IMPORT_MAX_UPLOAD_MB}MB", 413)

    _prune_stale()
    excluded: list[dict] = []
    skipped: list[str] = []
    files: list[dict] = []
    seen: dict[str, str] = {}
    total = 0
    main_candidates: list[str] = []

    with tempfile.TemporaryDirectory(prefix="import-check-") as check_dir:
        try:
            zf = zipfile.ZipFile(__import__("io").BytesIO(payload))
        except zipfile.BadZipFile as e:
            raise ImportRejected(f"损坏的 ZIP 压缩包：{e}", 422) from e
        infos = zf.infolist()
        if len(infos) > config.IMPORT_MAX_FILES:
            raise ImportRejected(
                f"压缩包含 {len(infos)} 个条目，超过上限 {config.IMPORT_MAX_FILES}", 413)

        for info in infos:
            name = info.filename
            # 目录条目跳过
            if name.endswith("/"):
                continue
            # macOS 垃圾：跳过并声明
            parts = name.split("/")
            if parts[0] in JUNK_DIRS or os.path.basename(name) in JUNK_FILES:
                skipped.append(name)
                continue
            # 符号链接（create_system=Unix 且 mode 含 S_IFLNK）
            if (info.create_system == 3 and (info.external_attr >> 16) & 0o170000 == 0o120000):
                raise ImportRejected(f"拒绝符号链接条目：{name}", 422)
            # 绝对路径 / 穿越反斜杠
            if name.startswith("/") or name.startswith("\\") or ":" in name.split("/")[0]:
                raise ImportRejected(f"拒绝绝对路径条目：{name}", 422)
            norm = name.replace("\\", "/")
            if ".." in norm.split("/"):
                raise ImportRejected(f"拒绝路径穿越条目：{name}", 422)
            # 嵌套归档
            if norm.lower().endswith(ARCHIVE_EXTS):
                raise ImportRejected(f"拒绝嵌套归档条目：{norm}（请解压后重新打包）", 422)
            # 平台内部目录 / 元数据
            low_parts = [p.lower() for p in norm.split("/")]
            base_low = low_parts[-1]
            if any(d in FORBIDDEN_DIRS for d in low_parts[:-1]) or base_low in FORBIDDEN_FILES:
                raise ImportRejected(
                    f"拒绝覆盖平台内部路径：{norm}（.studio/reviews/figs-src/attachments/docs 与平台元数据文件不可导入）", 422)
            # 单文件大小
            size = info.file_size
            if size > config.IMPORT_MAX_FILE_MB * 1024 * 1024:
                raise ImportRejected(
                    f"条目 {norm} {size / 1048576:.1f}MB 超过单文件上限 {config.IMPORT_MAX_FILE_MB}MB", 413)
            total += size
            if total > config.IMPORT_MAX_TOTAL_MB * 1024 * 1024:
                raise ImportRejected(
                    f"解压总量超过上限 {config.IMPORT_MAX_TOTAL_MB}MB", 413)
            # 重名（大小写不敏感，Windows/Linux 互操作）
            key = norm.lower()
            if key in seen:
                raise ImportRejected(f"重名路径（大小写不敏感）：{norm} 与 {seen[key]}", 422)
            seen[key] = norm

            data = zf.read(info)
            rel = norm.replace("/", os.sep)
            dst = os.path.join(check_dir, rel)
            os.makedirs(os.path.dirname(dst) or check_dir, exist_ok=True)
            with open(dst, "wb") as f:
                f.write(data)

            editable = norm.lower().endswith((".tex", ".bib", ".cls", ".sty", ".bst", ".txt"))
            files.append({"path": norm, "size": size, "editable": editable})
            if editable and norm.lower().endswith(".tex"):
                head = data[:8192].decode("utf-8", "replace")
                if "\\documentclass" in head:
                    main_candidates.append(norm)

        if not files:
            raise ImportRejected("压缩包内没有可用文件", 422)
        tex_any = [f["path"] for f in files if f["path"].lower().endswith(".tex")]
        if not main_candidates and tex_any:
            # 有 .tex 但都不含 documentclass：候选仍给出（用户可选），但警告
            main_candidates = tex_any
            excluded.append({"path": "*", "reason": "未找到含 \\documentclass 的主文件——请自行确认主文件"})
        if not main_candidates:
            raise ImportRejected("压缩包内没有 .tex 文件，无法作为 LaTeX 工程导入", 422)
        # 候选排序（不猜主文件，只排展示顺序）：template 优先于 sample；文档目录（doc/）垫底；
        # 层级浅的优先——官方模板包（如 els-cas-templates）的真正主文件通常是 *-template.tex
        main_candidates.sort(key=_candidate_sort_key)

        # 校验全部通过 → 落暂存目录（正式创建从暂存复制）
        token = uuid.uuid4().hex
        stage = os.path.join(STAGING_DIR, token)
        if os.path.exists(stage):
            shutil.rmtree(stage)
        os.makedirs(STAGING_DIR, exist_ok=True)
        shutil.move(check_dir, stage)
        meta = {
            "token": token,
            "filename": filename,
            "staged_at": time.time(),
            "files": files,
            "main_candidates": main_candidates,
            "excluded": excluded,
            "skipped": skipped,
            "sha256": __import__("hashlib").sha256(payload).hexdigest(),
        }
        with open(os.path.join(stage, ".import-meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return meta


def load_stage(token: str) -> tuple[str, dict]:
    """读取暂存目录与元数据；token 非法/过期 → 404 语义异常。"""
    if not token or any(c in token for c in "/\\.") or len(token) > 64:
        raise ProjectError("无效的导入令牌", 404)
    stage = os.path.join(STAGING_DIR, token)
    meta_path = os.path.join(stage, ".import-meta.json")
    if not os.path.isdir(stage) or not os.path.isfile(meta_path):
        raise ProjectError("导入令牌不存在或已过期（TTL 1 小时），请重新上传", 404)
    with open(meta_path, encoding="utf-8") as f:
        return stage, json.load(f)


def drop_stage(stage: str) -> None:
    shutil.rmtree(stage, ignore_errors=True)


def materialize(stage: str, dst: str) -> None:
    """把暂存内容复制为正式工程目录（不覆盖已存在目标）。"""
    if os.path.exists(dst):
        raise ProjectError(f"已存在：{dst}", 409)
    shutil.copytree(stage, dst, ignore=_ignore_meta)


def _ignore_meta(_src, names):
    return [n for n in names if n == ".import-meta.json"]
