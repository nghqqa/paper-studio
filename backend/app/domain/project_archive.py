# -*- coding: utf-8 -*-
"""项目便携整档（Portable Archive ZIP）导出与导入。

设计要点：
- 导出包含：studio.json、源码/插图/Word 文档/Markdown 正文、glossary.json、rebuttal、library(+PDF)、figures、comments、paper-proposals；
- 排除编译/预览缓存（.studio/latex-builds、.studio/latex-diffs、.studio/word/exports、.studio/word/versions）及 .git；
- 导入严格校验 Zip-Slip、符号链接、文件数（IMPORT_MAX_FILES）及总大小（IMPORT_MAX_TOTAL_MB）。
"""
from __future__ import annotations

import io
import json
import os
import posixpath
import shutil
import time
import zipfile
from urllib.parse import quote

from app import config
from app.domain.projects import ProjectError, id_slug, normalize_settings

ARCHIVE_SCHEMA = "paper-studio/archive@1"
MANIFEST_NAME = "manifest.json"
_EXCLUDE_DIRS = (".git", "__pycache__", ".studio/latex-builds", ".studio/latex-diffs", ".studio/word/exports", ".studio/word/versions")


def _excluded(rel_posix: str) -> bool:
    for ex in _EXCLUDE_DIRS:
        if rel_posix == ex or rel_posix.startswith(ex + "/"):
            return True
    return rel_posix.endswith(".lock")


def export_project_archive(project) -> tuple[bytes, str]:
    root = os.path.realpath(project.dir)
    buf = io.BytesIO()
    files_written: list[str] = []
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for base, dirs, files in os.walk(root):
            rel_base = os.path.relpath(base, root).replace(os.sep, "/")
            if rel_base == ".":
                rel_base = ""
            kept_dirs = []
            for d in sorted(dirs):
                sub = f"{rel_base}/{d}" if rel_base else d
                if not _excluded(sub):
                    kept_dirs.append(d)
            dirs[:] = kept_dirs
            for fn in sorted(files):
                rel = f"{rel_base}/{fn}" if rel_base else fn
                if _excluded(rel) or rel == MANIFEST_NAME:
                    continue
                full = os.path.join(base, fn)
                if not os.path.isfile(full):
                    continue
                zf.write(full, rel)
                files_written.append(rel)

        manifest = {
            "schema": ARCHIVE_SCHEMA,
            "project_id": project.id,
            "title": project.title,
            "source_format": project.settings.get("source_format", "markdown"),
            "exported_at": int(time.time()),
            "file_count": len(files_written),
        }
        zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    slug = id_slug(project.title or project.id, 48, project.id)
    return buf.getvalue(), quote(f"{slug}-archive.zip")


def _safe_rel(name: str) -> str:
    norm = posixpath.normpath(name.replace("\\", "/")).lstrip("/")
    if (
        not norm
        or norm == "."
        or norm.startswith("../")
        or "/../" in norm
        or ":" in norm.split("/")[0]
        or _excluded(norm)
    ):
        raise ProjectError(f"归档中包含非法或越界路径：{name}", 422)
    return norm


def import_project_archive(store, raw_bytes: bytes, *, preferred_id: str | None = None) -> tuple[object, int]:
    max_upload = config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024
    max_total = config.IMPORT_MAX_TOTAL_MB * 1024 * 1024
    if len(raw_bytes) > max_upload:
        raise ProjectError(f"归档文件过大（上限 {config.IMPORT_MAX_UPLOAD_MB} MB）", 413)
    if not raw_bytes:
        raise ProjectError("上传的归档文件为空", 422)

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except (zipfile.BadZipFile, OSError) as exc:
        raise ProjectError(f"无法解析 ZIP 归档文件：{exc}", 422) from exc

    with zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > config.IMPORT_MAX_FILES:
            raise ProjectError(f"归档文件数量超限（上限 {config.IMPORT_MAX_FILES} 个）", 422)

        manifest_data: dict | None = None
        total_uncompressed = 0
        staged: list[tuple[zipfile.ZipInfo, str]] = []
        for info in infos:
            mode = (info.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise ProjectError("归档禁止包含符号链接", 422)
            rel = _safe_rel(info.filename)
            total_uncompressed += max(0, info.file_size)
            if total_uncompressed > max_total:
                raise ProjectError(f"归档解压总大小超过上限（{config.IMPORT_MAX_TOTAL_MB} MB）", 422)
            if rel == MANIFEST_NAME:
                try:
                    manifest_data = json.loads(zf.read(info).decode("utf-8"))
                except (UnicodeDecodeError, ValueError) as exc:
                    raise ProjectError("manifest.json 格式无效", 422) from exc
                continue
            staged.append((info, rel))

        if not isinstance(manifest_data, dict) or manifest_data.get("schema") != ARCHIVE_SCHEMA:
            raise ProjectError("不是有效的 Paper Studio 项目归档（缺少 manifest.json 或 schema 不匹配）", 422)

        base_id = id_slug(
            (preferred_id or str(manifest_data.get("project_id") or manifest_data.get("title") or "imported")).strip(),
            48,
            "imported",
        )
        new_pid = store.unique_pid(base_id)
        dst_root = os.path.realpath(os.path.join(store.root, new_pid))
        os.makedirs(dst_root, exist_ok=True)
        restored = 0
        try:
            for info, rel in staged:
                target = os.path.realpath(os.path.join(dst_root, *rel.split("/")))
                if target != dst_root and not target.startswith(dst_root + os.sep):
                    raise ProjectError(f"非法解压目标：{rel}", 422)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info, "r") as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst, length=65536)
                restored += 1

            settings_path = os.path.join(dst_root, "studio.json")
            if os.path.isfile(settings_path):
                with open(settings_path, encoding="utf-8") as f:
                    raw_settings = json.load(f)
            else:
                raw_settings = {
                    "document_type": "paper",
                    "source_format": manifest_data.get("source_format") or "markdown",
                    "title": manifest_data.get("title") or new_pid,
                }
            norm = normalize_settings(raw_settings)
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump(norm, f, ensure_ascii=False, indent=2)
        except Exception:
            shutil.rmtree(dst_root, ignore_errors=True)
            raise

    return store.get(new_pid), restored
