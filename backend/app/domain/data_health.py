# -*- coding: utf-8 -*-
"""管理后台数据存储健康检查与 SQLite/平台安全热备份导出。"""
from __future__ import annotations

import io
import json
import os
import shutil
import sqlite3
import tempfile
import time
import zipfile

from app import config

_CACHE_SUBDIRS = (
    os.path.join(".studio", "latex-builds"),
    os.path.join(".studio", "latex-diffs"),
    os.path.join(".studio", "word", "exports"),
)


def _dir_size(path: str) -> int:
    total = 0
    if not os.path.isdir(path):
        return 0
    for base, _dirs, files in os.walk(path):
        for fn in files:
            try:
                total += os.path.getsize(os.path.join(base, fn))
            except OSError:
                pass
    return total


def _sqlite_integrity(db_path: str) -> tuple[bool, str, int]:
    if not os.path.isfile(db_path):
        return True, "未使用数据库文件（AUTH=off 或尚未建库）", 0
    size = 0
    for ext in ("", "-wal", "-shm"):
        p = db_path + ext
        if os.path.isfile(p):
            try:
                size += os.path.getsize(p)
            except OSError:
                pass
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
        try:
            row = conn.execute("PRAGMA integrity_check").fetchone()
            msg = str(row[0] if row else "unknown")
            return msg.lower() == "ok", msg, size
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return False, str(exc), size


def collect_data_health(store) -> dict:
    pids = store.list_ids()
    formats = {"latex": 0, "docx": 0, "markdown": 0}
    projects_bytes = 0
    cache_bytes = 0
    corrupt_settings: list[dict] = []
    project_sizes: list[dict] = []

    for pid in pids:
        try:
            p = store.get(pid)
            fmt = str(p.settings.get("source_format") or "markdown")
            formats[fmt] = formats.get(fmt, 0) + 1
            title = p.title
            pdir = p.dir
        except Exception as exc:  # noqa: BLE001
            pdir = os.path.join(store.root, pid)
            title = pid
            corrupt_settings.append({"pid": pid, "error": str(exc)})
        total_p = _dir_size(pdir)
        c_bytes = sum(_dir_size(os.path.join(pdir, sub)) for sub in _CACHE_SUBDIRS)
        projects_bytes += total_p
        cache_bytes += c_bytes
        project_sizes.append({
            "pid": pid,
            "title": title,
            "total_bytes": total_p,
            "cache_bytes": c_bytes,
        })

    project_sizes.sort(key=lambda r: r["total_bytes"], reverse=True)
    shared_bytes = _dir_size(os.path.join(store.root, ".studio", "shared-assets"))
    db_ok, db_msg, db_bytes = _sqlite_integrity(config.DB_PATH)
    disk_root = store.root if os.path.isdir(store.root) else os.path.dirname(store.root)
    try:
        usage = shutil.disk_usage(disk_root)
        disk = {"total_bytes": usage.total, "used_bytes": usage.used, "free_bytes": usage.free}
    except OSError:
        disk = {"total_bytes": 0, "used_bytes": 0, "free_bytes": 0}

    return {
        "checked_at": int(time.time()),
        "project_count": len(pids),
        "formats": formats,
        "storage": {
            "projects_bytes": projects_bytes,
            "build_cache_bytes": cache_bytes,
            "shared_assets_bytes": shared_bytes,
            "db_bytes": db_bytes,
            "total_bytes": projects_bytes + shared_bytes + db_bytes,
        },
        "db": {"exists": os.path.isfile(config.DB_PATH), "ok": db_ok, "message": db_msg, "bytes": db_bytes},
        "disk": disk,
        "corrupt_settings": corrupt_settings,
        "top_projects": project_sizes[:10],
    }


def _hot_backup_sqlite(db_path: str) -> bytes | None:
    if not os.path.isfile(db_path):
        return None
    fd, tmp_path = tempfile.mkstemp(prefix="ps_backup_", suffix=".db")
    os.close(fd)
    try:
        src = sqlite3.connect(db_path, timeout=10.0)
        dst = sqlite3.connect(tmp_path)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def build_platform_backup_zip(store, *, include_projects: bool = False) -> bytes:
    """打包平台核心备份（SQLite 一致性热备 + org.json（脱敏 Key）+ 共享资产），绝不含 PAT 明文/哈希。"""
    buf = io.BytesIO()
    included: list[str] = []
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        db_bytes = _hot_backup_sqlite(config.DB_PATH)
        if db_bytes is not None:
            zf.writestr("studio.db", db_bytes)
            included.append("studio.db")

        studio_global = os.path.join(store.root, ".studio")
        org_path = os.path.join(studio_global, "org.json")
        if os.path.isfile(org_path):
            try:
                with open(org_path, encoding="utf-8") as f:
                    org_data = json.load(f)
                if isinstance(org_data, dict) and isinstance(org_data.get("ai_provider"), dict):
                    org_data["ai_provider"] = {**org_data["ai_provider"], "api_key": ""}
                zf.writestr(".studio/org.json", json.dumps(org_data, ensure_ascii=False, indent=2) + "\n")
                included.append(".studio/org.json")
            except (OSError, ValueError):
                pass

        for rel_file in ("tags.json",):
            p = os.path.join(studio_global, rel_file)
            if os.path.isfile(p):
                zf.write(p, f".studio/{rel_file}")
                included.append(f".studio/{rel_file}")

        shared_dir = os.path.join(studio_global, "shared-assets")
        if os.path.isdir(shared_dir):
            for base, _dirs, files in os.walk(shared_dir):
                for fn in sorted(files):
                    full = os.path.join(base, fn)
                    rel = os.path.relpath(full, store.root).replace(os.sep, "/")
                    zf.write(full, rel)
                    included.append(rel)

        if include_projects:
            from app.domain import project_archive

            budget = 200 * 1024 * 1024
            used = 0
            for pid in store.list_ids():
                try:
                    proj = store.get(pid)
                    arch_bytes, _name = project_archive.export_project_archive(proj)
                    if used + len(arch_bytes) > budget:
                        continue
                    arc_name = f"projects/{pid}.zip"
                    zf.writestr(arc_name, arch_bytes)
                    included.append(arc_name)
                    used += len(arch_bytes)
                except Exception:  # noqa: BLE001
                    continue

        manifest = {
            "schema": "paper-studio/backup@1",
            "created_at": int(time.time()),
            "product": config.PRODUCT,
            "include_projects": include_projects,
            "items": included,
        }
        zf.writestr("backup-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return buf.getvalue()
