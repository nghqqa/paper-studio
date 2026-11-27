# -*- coding: utf-8 -*-
"""项目便携整档（Portable Archive ZIP）导出与导入。

设计要点：
- 导出与导入严格采用白名单隔离 `.studio/` 目录：仅允许 glossary / comments / latex-issues / rebuttal / library / figures / paper-proposals；
- 显式排除 .git、__pycache__、*.lock、.studio/history、.studio/git-remote.json、.studio/public_access.jsonl、.studio/word、构建/差异缓存等运行态或凭据文件；
- 导入严格校验路径穿越、大小写重名、符号链接、单文件/总解压真实字节数上限（防伪造头部的 Zip-Bomb），并以原子 mkdir 抢占唯一项目目录防 TOCTOU。
"""
from __future__ import annotations

import io
import json
import os
import posixpath
import secrets
import shutil
import time
import zipfile
import zlib
from urllib.parse import quote

from app import atomic, config
from app.domain.projects import ProjectError, id_slug, normalize_settings

ARCHIVE_SCHEMA = "paper-studio/archive@1"
MANIFEST_NAME = "manifest.json"
_MANIFEST_MAX_BYTES = 65536
_FORBIDDEN_SEGMENTS = frozenset({".git", "__pycache__"})
_ALLOWED_STUDIO_FILES = frozenset({
    ".studio/glossary.json",
    ".studio/comments.json",
    ".studio/latex-issues.json",
})
_ALLOWED_STUDIO_PREFIXES = (
    ".studio/rebuttal/",
    ".studio/library/",
    ".studio/figures/",
    ".studio/paper-proposals/",
)


def _allowed_rel(rel_posix: str) -> bool:
    if not rel_posix or rel_posix.endswith(".lock"):
        return False
    parts = rel_posix.split("/")
    if any(seg in _FORBIDDEN_SEGMENTS for seg in parts):
        return False
    if rel_posix == ".studio" or rel_posix.startswith(".studio/"):
        return rel_posix in _ALLOWED_STUDIO_FILES or rel_posix.startswith(_ALLOWED_STUDIO_PREFIXES)
    return True


def export_project_archive(project) -> tuple[bytes, str]:
    root = os.path.realpath(project.dir)
    buf = io.BytesIO()
    files_written: list[str] = []
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for base, dirs, files in os.walk(root, followlinks=False):
            rel_base = os.path.relpath(base, root).replace(os.sep, "/")
            if rel_base == ".":
                rel_base = ""
            kept_dirs = []
            for d in sorted(dirs):
                full_dir = os.path.join(base, d)
                if os.path.islink(full_dir):
                    continue
                sub = f"{rel_base}/{d}" if rel_base else d
                if sub in _FORBIDDEN_SEGMENTS or any(seg in _FORBIDDEN_SEGMENTS for seg in sub.split("/")):
                    continue
                if sub == ".studio" or any(p.startswith(sub + "/") for p in (*_ALLOWED_STUDIO_FILES, *_ALLOWED_STUDIO_PREFIXES)) or _allowed_rel(sub + "/"):
                    kept_dirs.append(d)
            dirs[:] = kept_dirs
            for fn in sorted(files):
                rel = f"{rel_base}/{fn}" if rel_base else fn
                if rel == MANIFEST_NAME or not _allowed_rel(rel):
                    continue
                full = os.path.join(base, fn)
                if os.path.islink(full) or not os.path.isfile(full):
                    continue
                real_full = os.path.realpath(full)
                if not real_full.startswith(root + os.sep):
                    continue
                zf.write(real_full, rel)
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
    if not name or name.startswith(("/", "\\")) or any(ord(ch) < 32 for ch in name):
        raise ProjectError(f"归档中包含非法或越界路径：{name}", 422)
    raw_posix = name.replace("\\", "/")
    parts = raw_posix.split("/")
    if any(seg in ("", ".", "..") for seg in parts) or ":" in parts[0]:
        raise ProjectError(f"归档中包含非法或越界路径：{name}", 422)
    norm = posixpath.normpath(raw_posix)
    if norm in (".", "..") or norm.startswith(("/", "../")) or "/../" in norm:
        raise ProjectError(f"归档中包含非法或越界路径：{name}", 422)
    if norm != MANIFEST_NAME and not _allowed_rel(norm):
        raise ProjectError(f"归档中包含受限或不允许导入的路径：{name}", 422)
    return norm


def _rebind_proposals_file(dst_root: str, old_pid: str, new_pid: str) -> None:
    pp_dir = os.path.join(dst_root, ".studio", "paper-proposals")
    if not os.path.isdir(pp_dir):
        return
    dst_file = os.path.join(pp_dir, f"{new_pid}.jsonl")
    if os.path.isfile(dst_file):
        return
    candidates = [f for f in os.listdir(pp_dir) if f.endswith(".jsonl") and os.path.isfile(os.path.join(pp_dir, f))]
    src_name = f"{old_pid}.jsonl" if old_pid and f"{old_pid}.jsonl" in candidates else (candidates[0] if len(candidates) == 1 else "")
    if src_name:
        os.replace(os.path.join(pp_dir, src_name), dst_file)


def import_project_archive(store, raw_bytes: bytes, *, preferred_id: str | None = None) -> tuple[object, int]:
    max_upload = config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024
    max_total = config.IMPORT_MAX_TOTAL_MB * 1024 * 1024
    max_file = max(config.IMPORT_MAX_FILE_MB, 50) * 1024 * 1024
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
        declared_total = 0
        staged: list[tuple[zipfile.ZipInfo, str]] = []
        seen_lower: set[str] = set()
        for info in infos:
            if info.flag_bits & 1:
                raise ProjectError("不支持导入加密 ZIP 归档", 422)
            mode = (info.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise ProjectError("归档禁止包含符号链接", 422)
            rel = _safe_rel(info.filename)
            low = rel.lower()
            if low in seen_lower:
                raise ProjectError(f"归档中存在重名路径：{rel}", 422)
            seen_lower.add(low)
            declared_total += max(0, info.file_size)
            if info.file_size > max_file or declared_total > max_total:
                raise ProjectError(f"归档解压大小超过上限（{config.IMPORT_MAX_TOTAL_MB} MB）", 422)
            if rel == MANIFEST_NAME:
                try:
                    with zf.open(info, "r") as mf:
                        raw_manifest = mf.read(_MANIFEST_MAX_BYTES + 1)
                    if len(raw_manifest) > _MANIFEST_MAX_BYTES:
                        raise ProjectError("manifest.json 体积超过上限", 422)
                    manifest_data = json.loads(raw_manifest.decode("utf-8"))
                except ProjectError:
                    raise
                except (UnicodeDecodeError, ValueError, RuntimeError, zlib.error, zipfile.BadZipFile, OSError) as exc:
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
        new_pid = ""
        dst_root = ""
        for attempt in range(20):
            cand_base = base_id if attempt == 0 else f"{base_id[:39]}-{secrets.token_hex(4)}"
            cand_pid = store.unique_pid(cand_base)
            cand_dir = os.path.realpath(os.path.join(store.root, cand_pid))
            try:
                os.makedirs(cand_dir, exist_ok=False)
                new_pid = cand_pid
                dst_root = cand_dir
                break
            except FileExistsError:
                continue
        if not dst_root:
            raise ProjectError("无法为导入项目分配唯一目录，请稍后重试", 409)

        restored = 0
        actual_total = 0
        try:
            for info, rel in staged:
                target = os.path.realpath(os.path.join(dst_root, *rel.split("/")))
                if target != dst_root and not target.startswith(dst_root + os.sep):
                    raise ProjectError(f"非法解压目标：{rel}", 422)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                file_written = 0
                try:
                    with zf.open(info, "r") as src, open(target, "wb") as dst:
                        while True:
                            chunk = src.read(65536)
                            if not chunk:
                                break
                            file_written += len(chunk)
                            actual_total += len(chunk)
                            if file_written > max_file:
                                raise ProjectError(f"归档中单个文件过大：{rel}", 422)
                            if actual_total > max_total:
                                raise ProjectError(f"归档解压总大小超过上限（{config.IMPORT_MAX_TOTAL_MB} MB）", 422)
                            dst.write(chunk)
                except ProjectError:
                    raise
                except (RuntimeError, zlib.error, zipfile.BadZipFile, OSError) as exc:
                    raise ProjectError(f"解压归档文件失败（{rel}）：{exc}", 422) from exc
                restored += 1

            settings_path = os.path.join(dst_root, "studio.json")
            if os.path.isfile(settings_path):
                try:
                    with open(settings_path, encoding="utf-8") as f:
                        raw_settings = json.load(f)
                except (OSError, UnicodeDecodeError, ValueError) as exc:
                    raise ProjectError(f"studio.json 格式无效：{exc}", 422) from exc
                if not isinstance(raw_settings, dict):
                    raise ProjectError("studio.json 必须是 JSON 对象", 422)
            else:
                raw_settings = {
                    "document_type": "paper",
                    "source_format": manifest_data.get("source_format") or "markdown",
                    "title": manifest_data.get("title") or new_pid,
                }
            try:
                norm = normalize_settings(raw_settings)
            except ValueError as exc:
                raise ProjectError(f"项目配置无效：{exc}", 422) from exc
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump(norm, f, ensure_ascii=False, indent=2)

            old_pid = str(manifest_data.get("project_id") or "").strip()
            _rebind_proposals_file(dst_root, old_pid, new_pid)

            if norm.get("source_format") == "docx":
                docx_path = os.path.join(dst_root, "document.docx")
                if os.path.isfile(docx_path):
                    from app.domain import word_documents

                    with open(docx_path, "rb") as df:
                        raw_docx = df.read(config.WORD_MAX_BYTES + 1)
                    word_documents.validate_docx(raw_docx)
                    state = {
                        "version": 0,
                        "versions": [],
                        "key": secrets.token_hex(20),
                        "closed": False,
                        "saving": False,
                        "receipts": [],
                    }
                    with atomic.studio_lock(dst_root, "word"):
                        word_documents._persist(dst_root, state, raw_docx, "archive-import")
        except Exception:
            shutil.rmtree(dst_root, ignore_errors=True)
            raise

    return store.get(new_pid), restored
