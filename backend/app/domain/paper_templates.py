"""Platform paper templates: immutable assets + an atomic, persistent catalogue.

Deleting a template unpublishes it; project copies and archived assets stay intact.
The catalogue lives in the data volume, never in the application source tree.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path

from app import atomic, config
from app.domain.latex_import import _candidate_sort_key
from app.domain.projects import ProjectError

_FIELDS = ("id", "format", "name", "desc", "language", "kind", "venue", "year", "mode",
           "source", "verify", "main", "engine", "origin", "enabled", "created_at",
           "verify_error", "verified_at", "version", "updated_at", "thumb")
_EXTENSIONS = {".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx", ".lbx", ".def",
               ".fd", ".clo", ".cfg", ".txt", ".md", ".png", ".jpg", ".jpeg", ".pdf",
               ".eps", ".svg", ".bb", ".bbl", ".dat", ".csv", ".otf", ".ttf",
               ".dtx", ".ins", ".ist", ".ps", ".tif", ".tiff", ".gif", ".bmp", ".lua"}
# 官方模板包常带无扩展名的说明/构建文件（Elsevier CAS 的 doc/makefile、README）。
# 只放行这份已知清单；其余无扩展名文件仍拒绝（防止无类型二进制混入）。
_EXTENSIONLESS = {"makefile", "readme", "license", "copying", "notice", "manifest",
                  "changelog", "install", "todo"}
_RESERVED = {"studio.json", "content.md", "case.json", "project.json", "template.json"}
# PATCH 元信息可覆盖字段（builtin 写 catalog.json override、upload 直接改行）。
# 白名单锁死：catalog 永远覆盖不到 seed/document/id/format/origin 等只读源信息。
_DISPLAY_FIELDS = ("name", "desc", "language", "kind", "venue", "year")
_OVERRIDE_FIELDS = ("enabled", "verify", "verify_error", "verified_at") + _DISPLAY_FIELDS


def builtin_latex() -> dict[str, dict]:
    base = Path(config.BACKEND_DIR) / "app" / "latex_seed"
    roots = sorted(base.iterdir()) + [Path(config.BACKEND_DIR) / "app" / "jcip_seed"]
    out = {}
    for root in roots:
        try:
            meta = json.loads((root / "template.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if meta.get("id"):
            out[meta["id"]] = {**meta, "seed": str(root), "format": "latex", "origin": "builtin", "enabled": True}
    return out


def _builtins() -> list[dict]:
    common = {"format": "docx", "language": "中文", "kind": "期刊", "origin": "builtin",
              "enabled": True, "verify": "verified", "venue": ""}
    return [
        {**common, "id": "blank", "name": "空白 Word 文档", "desc": "原生 DOCX，支持 LaTeX 公式"},
        # id="jcip" 保留为既有规则集/API 兼容标识，底层文件为自撰 Apache-2.0 开源中文学术论文模板
        {**common, "id": "jcip", "name": "中文学术论文模板（开源通用版）", "venue": "通用中文期刊",
         "desc": "Apache-2.0 原创中文学术论文模板，含双语摘要、编号章节、三线表与参考文献占位；管理员可上传任意目标期刊 DOCX",
         "document": os.path.join(config.BACKEND_DIR, "app", "word_templates", "jcip", "template.docx")},
        *builtin_latex().values(),
    ]


def _root() -> str:
    return os.path.join(config.PROJECTS_DIR, ".studio", "paper-templates")


def _load() -> dict:
    try:
        with open(os.path.join(_root(), "catalog.json"), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise ProjectError("模板库目录无法读取，请联系管理员检查数据卷", 503) from e


def _save(rows: dict) -> None:
    atomic.write_json(os.path.join(_root(), "catalog.json"), rows)


def _key(fmt: str, tid: str) -> str:
    if fmt not in ("docx", "latex") or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", tid):
        raise ProjectError("模板不存在", 404)
    return fmt + ":" + tid


def _thumbs_dir() -> str:
    # 与 files/ 平级：模板资产目录会被 verify_compile 全量拷入构建、被新建工程继承，
    # 缩略图放里面会污染每一次编译与复制。
    return os.path.join(_root(), "thumbs")


def _thumb_path(fmt: str, tid: str) -> str:
    return os.path.join(_thumbs_dir(), f"{fmt}-{tid}.png")


def _token(row: dict) -> tuple:
    """代际令牌：replace 推进 version、PATCH main/engine 推进 updated_at。
    后台验收落盘前复核令牌，编译/转换期间被替换的过期结果直接丢弃。"""
    return (row.get("version"), row.get("updated_at"))


def _find(fmt: str, tid: str) -> dict | None:
    key = _key(fmt, tid)
    return next((t for t in all_templates() if t["format"] + ":" + t["id"] == key), None)


def all_templates() -> list[dict]:
    overrides = _load()
    rows = {t["format"] + ":" + t["id"]: t for t in _builtins()}
    for key, meta in overrides.items():
        if key in rows:
            # 内置模板只允许白名单字段被 catalog 覆盖（启用态、验收结果与展示信息）；
            # seed/document/id/format/origin 等只读源信息永不被覆盖。
            for field in _OVERRIDE_FIELDS:
                if field in meta:
                    rows[key][field] = meta[field]
        elif meta.get("origin") == "upload":
            row = dict(meta)
            folder = os.path.join(_root(), "files", row["id"])
            row["document" if row["format"] == "docx" else "seed"] = (
                os.path.join(folder, "document.docx") if row["format"] == "docx" else folder)
            rows[key] = row
    for row in rows.values():
        row["thumb"] = os.path.isfile(_thumb_path(row["format"], row["id"]))
    return list(rows.values())


def public(row: dict) -> dict:
    return {k: row[k] for k in _FIELDS if k in row}


def catalogue() -> dict:
    rows = [public(t) for t in all_templates() if t["enabled"]]
    return {"word": [t for t in rows if t["format"] == "docx"] if config.WORD_EDITOR_ON else [],
            "latex": [t for t in rows if t["format"] == "latex"]}


def get(fmt: str, tid: str) -> dict:
    row = _find(fmt, tid)
    if row is None or not row["enabled"]:
        raise ProjectError("模板不存在或已移除，请刷新模板库", 404)
    return row


def set_enabled(fmt: str, tid: str, enabled: bool) -> dict:
    key = _key(fmt, tid)
    with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
        row = next((t for t in all_templates() if t["format"] + ":" + t["id"] == key), None)
        if row is None:
            raise ProjectError("模板不存在", 404)
        data = _load()
        data[key] = {**data.get(key, {}), "enabled": enabled}
        _save(data)
        return public({**row, "enabled": enabled})


def update_meta(fmt: str, tid: str, changes: dict) -> dict:
    """PATCH 元信息部分更新（None/缺省 = 不修改）。展示字段 builtin/upload 均可改（builtin 走
    catalog override 白名单）；main/engine 仅 upload LaTeX 可改且校验资产内存在，
    变更即推进代际令牌（updated_at）并重置 verify。返回 {row, toggled, changes}。"""
    key = _key(fmt, tid)
    with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
        row = _find(fmt, tid)
        if row is None:
            raise ProjectError("模板不存在", 404)
        builtin = row["origin"] == "builtin"
        updates: dict = {}
        for field in _DISPLAY_FIELDS:
            if changes.get(field) is None:
                continue
            value = str(changes[field])
            if field == "name":
                value = value.strip()
                if not value:
                    raise ProjectError("模板名称不能为空", 422)
            if row.get(field) != value:
                updates[field] = value
        if changes.get("enabled") is not None and bool(changes["enabled"]) != row["enabled"]:
            updates["enabled"] = bool(changes["enabled"])
        structural = {f: changes[f] for f in ("main", "engine") if changes.get(f) is not None}
        if structural:
            if builtin:
                raise ProjectError("内置模板的主文件与编译引擎不可修改", 422)
            if fmt != "latex":
                raise ProjectError("Word 模板没有主文件与编译引擎设置", 422)
            if "engine" in structural and structural["engine"] != row.get("engine"):
                updates["engine"] = structural["engine"]
            if "main" in structural:
                main = structural["main"].strip()
                if not main:
                    raise ProjectError("主文件不能为空，请填写模板压缩包内的 .tex 相对路径", 422)
                _safe_path(main)
                if not main.endswith(".tex"):
                    raise ProjectError("主文件必须是模板内的 .tex 相对路径", 422)
                asset = os.path.join(_root(), "files", tid, *main.split("/"))
                if not os.path.isfile(asset):
                    raise ProjectError(f"模板资产中不存在主文件 {main}，请核对压缩包内路径", 422)
                with open(asset, encoding="utf-8", errors="replace") as f:
                    if "\\documentclass" not in f.read(8192):
                        raise ProjectError("主文件缺少 \\documentclass，请选择完整论文入口", 422)
                if main != row.get("main"):
                    updates["main"] = main
        if "main" in updates or "engine" in updates:
            # 主文件/引擎变了 ⇒ 旧验收结果失效：推进代际令牌并重置 verify（缩略图保留，版式未变）
            updates["updated_at"] = time.time()
            updates["verify"] = "unverified"
            updates["verify_error"] = None
            updates["verified_at"] = None
            updates["verify_log_tail"] = None
        if updates:
            data = _load()
            data[key] = {**(data.get(key) or {}), **updates}
            _save(data)
        toggled = "enabled" in updates
        audit_changes = {k: updates[k] for k in updates
                         if k in _DISPLAY_FIELDS or k in ("main", "engine", "enabled")}
        fresh = {**row, **updates, "thumb": os.path.isfile(_thumb_path(fmt, tid))}
        return {"row": public(fresh), "toggled": toggled, "changes": audit_changes}


def replace_assets(fmt: str, tid: str, filename: str, payload: bytes, meta: dict | None = None) -> dict:
    """替换上传模板版本（仅 origin=upload）：tid 不变、version 自增、verify 重置、
    旧缩略图删除（待新验收重生成）。锁外解包校验，锁内两段 rename 原子换目录，
    任何一步失败完整回滚旧目录与 catalog；已建工程持有独立副本，不受任何影响。"""
    meta = meta or {}
    key = _key(fmt, tid)
    if len(payload) > config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024:
        raise ProjectError("模板上传大小超过上限", 413)
    if fmt == "docx" and (meta.get("main") is not None or meta.get("engine") is not None):
        raise ProjectError("Word 模板没有主文件与编译引擎设置", 422)
    if meta.get("engine") is not None and meta["engine"] not in config.LATEX_ENGINES:
        raise ProjectError("不支持的编译引擎", 422)
    new_main, new_engine = meta.get("main"), meta.get("engine")
    with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
        row = _find(fmt, tid)
        if row is None:
            raise ProjectError("模板不存在", 404)
        if row.get("origin") != "upload":
            raise ProjectError("内置模板资产随版本只读分发，不支持替换；如需变更请下载后另存为上传模板", 422)
        cur_main, cur_engine = row.get("main", ""), row.get("engine")
    # 解包与安全校验在锁外（纯 CPU）：docx 全套 DOCX 校验 / latex 全套 ZIP 防护
    if fmt == "docx":
        if not filename.lower().endswith(".docx"):
            raise ProjectError("Word 模板请上传普通 .docx 文件", 422)
        from app.domain.word_documents import validate_docx

        validate_docx(payload)
        files = {"document.docx": payload}
        main = ""
    else:
        if not filename.lower().endswith(".zip"):
            raise ProjectError("LaTeX 模板请上传包含样式、引用库和图片的 .zip 工程", 422)
        files, main = _latex_files(payload, cur_main if new_main is None else new_main)
    engine = new_engine or cur_engine

    root = _root()
    os.makedirs(os.path.join(root, "files"), exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="replace-", dir=root) as tmp:
        for name, content in files.items():
            path = Path(tmp, *name.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        target = os.path.join(root, "files", tid)
        old = os.path.join(root, "old-" + uuid.uuid4().hex)
        with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
            # 竞态复核：解包期间模板可能被移除/并非 upload
            row = _find(fmt, tid)
            if row is None:
                raise ProjectError("模板不存在", 404)
            if row.get("origin") != "upload":
                raise ProjectError("内置模板资产随版本只读分发，不支持替换", 422)
            if not os.path.isdir(target):
                raise ProjectError("模板资产目录缺失，无法替换，请重新上传该模板", 422)
            if new_main is None and row.get("main", "") != cur_main:
                raise ProjectError("模板主文件在此期间被修改，请刷新后重试", 409)
            if new_engine is None and row.get("engine") != cur_engine:
                raise ProjectError("模板编译引擎在此期间被修改，请刷新后重试", 409)
            moved_old = moved_new = False
            try:
                shutil.move(target, old)
                moved_old = True
                shutil.move(tmp, target)
                moved_new = True
                data = _load()
                stored = data.get(key) or {}
                updates: dict = {"version": int(stored.get("version", 1)) + 1, "updated_at": time.time(),
                                 "verify": "unverified", "verify_error": None, "verified_at": None,
                                 "verify_log_tail": None}
                if main:
                    updates["main"] = main
                if engine and engine != stored.get("engine"):
                    updates["engine"] = engine
                data[key] = {**stored, **updates}
                _save(data)
            except (OSError, ProjectError) as e:
                # 完整回滚：新目录退回暂存、旧目录复位（catalog 未写成功前资产先不动语义）
                if moved_new and os.path.isdir(target):
                    shutil.move(target, tmp)
                if moved_old and not os.path.isdir(target):
                    shutil.move(old, target)
                if isinstance(e, ProjectError):
                    raise
                raise ProjectError("模板替换失败，已回滚保留原版本，请检查数据卷", 422) from e
        shutil.rmtree(old, ignore_errors=True)
        try:
            os.remove(_thumb_path(fmt, tid))
        except OSError:
            pass
        fresh = _find(fmt, tid) or row
        return public({**fresh, "thumb": os.path.isfile(_thumb_path(fmt, tid))})


# ---------- 上传/替换后的自动验收（后台线程；PAPER_TEMPLATE_AUTO_ACCEPT 开启时由路由触发） ----------

_accept_gates: dict[str, threading.Lock] = {}
_accept_gate_guard = threading.Lock()
_accept_threads: list[threading.Thread] = []
_accept_threads_guard = threading.Lock()


def _accept_gate(key: str) -> threading.Lock:
    with _accept_gate_guard:
        return _accept_gates.setdefault(key, threading.Lock())


def schedule_auto_accept(fmt: str, tid: str):
    """每模板一把串行闸：并发触发不丢弃请求——闸后排队中的任务启动时重新快照，
    永远按当时最新版本验收；编译期间被替换的过期结果由代际令牌在落盘前丢弃。"""
    t = threading.Thread(target=_auto_accept_worker, args=(fmt, tid), daemon=True,
                         name=f"tpl-accept-{fmt}-{tid}")
    with _accept_threads_guard:
        _accept_threads[:] = [x for x in _accept_threads if x.is_alive()]
        _accept_threads.append(t)
    t.start()
    return t


def wait_auto_accept(timeout_s: float = 60.0) -> bool:
    """等待所有在飞自动验收线程退出（测试确定性用）。"""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        with _accept_threads_guard:
            live = [t for t in _accept_threads if t.is_alive()]
        if not live:
            return True
        for t in live:
            t.join(timeout=0.5)
    return False


def _auto_accept_worker(fmt: str, tid: str) -> None:
    key = fmt + ":" + tid
    with _accept_gate(key):
        try:
            if fmt == "latex":
                verify_compile(fmt, tid)
            else:
                word_preview(fmt, tid)
        except ProjectError as e:
            if getattr(e, "status", None) == 409:
                return  # 代际过期：更新版本的验收已在闸后排队，无需补写过期结果
            _persist_error_note(fmt, tid, str(e))
        except Exception as e:  # 环境缺依赖等意外也要留下可读原因
            _persist_error_note(fmt, tid, f"自动验收未完成：{e}")


def _persist_error_note(fmt: str, tid: str, message: str) -> None:
    """自动验收未执行成（队列繁忙/缺编译器/转换服务不可用）时的可读原因，不动 verify 值。"""
    key = _key(fmt, tid)
    with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
        if _find(fmt, tid) is None:
            return
        data = _load()
        data[key] = {**(data.get(key) or {}), "verify_error": message}
        _save(data)


def verify_compile(fmt: str, tid: str) -> dict:
    """管理端「验证编译」：把模板资产在临时构建目录真实跑一遍 latexmk（与工程编译同一套
    守卫环境/并发槽/超时），成功 ⇒ verify='verified' 持久化到 catalog 并生成首页 PNG 缩略图；
    失败 ⇒ 保持 unverified 并记录 verify_error（诊断首条）。验证通过的口径与工作台编译一致：
    latexmk 退出码 0 **且** 产出 PDF（主文件在子目录时产物落构建根的裸 basename，两处都找）。
    Word 模板无编译语义，不适用。资产快照在 studio_lock 短持内拷出并记代际令牌；落盘前
    复核令牌，编译期间被替换/改主文件的过期结果直接丢弃（409，更新版本的验收已在排队）。"""
    if fmt != "latex":
        raise ProjectError("「已验证编译」标记只针对 LaTeX 模板；Word 模板无编译验证", 422)
    from app.domain import latex_build, task_runner

    build_dir = tempfile.mkdtemp(prefix="tpl-verify-")
    slot = task_runner.latex_slot()
    if not slot.acquire():
        raise ProjectError("LaTeX 编译队列繁忙，请稍后再试验证", 429)
    try:
        # 短持锁快照：代际令牌 + 资产拷贝。锁内纯同步；此后编译只看私有快照目录。
        with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
            row = get(fmt, tid)
            token = _token(row)
            seed = row.get("seed")
            if not seed or not os.path.isdir(seed):
                raise ProjectError("模板资产缺失，请重新上传该模板", 422)
            main = row.get("main") or "main.tex"
            engine = row["engine"] if row.get("engine") in config.LATEX_ENGINES else "pdflatex"
            for name in os.listdir(seed):
                src = os.path.join(seed, name)
                dst = os.path.join(build_dir, name)
                if os.path.isdir(src):
                    shutil.copytree(src, dst)
                else:
                    shutil.copy2(src, dst)
        if not os.path.isfile(os.path.join(build_dir, main)):
            raise ProjectError(f"模板主文件缺失：{main}", 422)
        cmd = [config.LATEX_LATEXMK, f"-{engine}", "-norc", "-synctex=1",
               "-interaction=nonstopmode", "-halt-on-error", "-file-line-error",
               "-no-shell-escape", main]
        log_path = os.path.join(build_dir, "verify-build.log")
        t0 = time.perf_counter()
        try:
            rc = task_runner.run_task(cmd, cwd=build_dir, timeout_s=config.LATEX_TIMEOUT_S,
                                      log_file=log_path, env=latex_build._build_env(build_dir))
        except subprocess.TimeoutExpired:
            log_tail = _tail(log_path)
            return _persist_accept(fmt, tid, token, ok=False, error=f"编译超时（>{config.LATEX_TIMEOUT_S}s）",
                                   duration_ms=round((time.perf_counter() - t0) * 1000), log_tail=log_tail)
        elapsed = round((time.perf_counter() - t0) * 1000)
        log_tail = _tail(log_path)
        stem = os.path.splitext(main)[0]
        pdf_candidates = (os.path.join(build_dir, f"{stem}.pdf"),
                          os.path.join(build_dir, f"{os.path.basename(stem)}.pdf"))
        pdf_ok = any(os.path.isfile(p) for p in pdf_candidates)
        error = None
        if rc != 0:
            tex_log = ""
            for cand in (os.path.join(build_dir, f"{stem}.log"),
                         os.path.join(build_dir, f"{os.path.basename(stem)}.log")):
                if os.path.isfile(cand):
                    with open(cand, encoding="utf-8", errors="replace") as f:
                        tex_log = f.read()
                    break
            diags = latex_build.parse_diagnostics(tex_log) or latex_build.parse_diagnostics(log_tail)
            error = (diags[0]["message"] if diags else None) or f"latexmk 退出码 {rc}（详见日志）"
        elif not pdf_ok:
            error = "latexmk 成功退出但未产出 PDF（模板主文件可能不是完整论文入口）"
        png = None
        if rc == 0 and pdf_ok:
            png = _pdf_first_png(next(p for p in pdf_candidates if os.path.isfile(p)))
        return _persist_accept(fmt, tid, token, ok=rc == 0 and pdf_ok, error=error,
                               duration_ms=elapsed, log_tail=log_tail, png=png)
    finally:
        slot.sem.release()
        shutil.rmtree(build_dir, ignore_errors=True)


def _tail(path: str, limit: int = 2000) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()[-limit:]
    except OSError:
        return ""


def _persist_accept(fmt: str, tid: str, token: tuple | None, *, ok: bool | None, error: str | None,
                    duration_ms: int, log_tail: str | None, png: bytes | None = None) -> dict:
    """验收结果落盘（studio_lock 内，纯同步）。ok=True ⇒ verified；False ⇒ unverified+error；
    None ⇒ 只记 error 不动 verify（Word 转换服务不可用等，不降级内置模板既有状态）。
    token 为代际令牌：与当前行不符 ⇒ 409——编译/转换期间模板已被替换，过期结果丢弃，
    更新版本的验收任务已在闸后排队。"""
    key = _key(fmt, tid)
    with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
        cur = _find(fmt, tid)
        if cur is None:
            raise ProjectError("模板不存在", 404)
        if token is not None and _token(cur) != token:
            raise ProjectError("模板在此期间已被替换或修改，本次验收结果已丢弃，请重试验收", 409)
        updates = {"verify_error": None if ok else (error or "验收失败"),
                   "verified_at": time.time() if ok else None,
                   "verify_log_tail": (log_tail or None) if ok is not True else None}
        if ok is not None:
            updates["verify"] = "verified" if ok else "unverified"
        data = _load()
        data[key] = {**data.get(key, {}), **updates}
        _save(data)
        if png:
            os.makedirs(_thumbs_dir(), exist_ok=True)
            atomic.write_bytes(_thumb_path(fmt, tid), png)
        updated = {**cur, **updates, "thumb": os.path.isfile(_thumb_path(fmt, tid))}
    return {**public(updated), "status": "ok" if ok else "error",
            "duration_ms": duration_ms, "log_tail": log_tail or ""}


def _pdf_first_png(pdf_path: str | None) -> bytes | None:
    """pdftoppm 首页栅格 PNG（镜像已内置 poppler-utils，同 convert/extract 先例）。
    只生成栅格 PNG、禁止 SVG 防 XSS；缺 pdftoppm 或渲染失败 ⇒ None（优雅降级为无缩略图）。"""
    if not pdf_path or shutil.which("pdftoppm") is None:
        return None
    try:
        with tempfile.TemporaryDirectory(prefix="tpl-thumb-") as tmp:
            prefix = os.path.join(tmp, "page")
            subprocess.run(["pdftoppm", "-f", "1", "-l", "1", "-png", "-r", "120", pdf_path, prefix],
                           check=True, capture_output=True, timeout=60)
            for name in sorted(os.listdir(tmp)):
                if name.startswith("page") and name.endswith(".png"):
                    with open(os.path.join(tmp, name), "rb") as f:
                        return f.read()
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def word_document_path(fmt: str, tid: str) -> str:
    """ONLYOFFICE /converter 回拉的模板文档路径（/api/office/template 路由用；cap 在路由校验）。"""
    row = get(fmt, tid)
    doc = row.get("document")
    if not doc or not os.path.isfile(doc):
        raise ProjectError("模板文档缺失，请重新上传或选择其他模板", 404)
    return doc


def word_preview(fmt: str, tid: str) -> dict:
    """Word 模板转换验收 + 首页缩略图（ONLYOFFICE /converter；app 容器无 LibreOffice）。
    管理端「生成预览」与后台自动验收共用：DS 把 cap 内网拉取 URL 转成 PDF，取回后
    pdftoppm 出首页 PNG。服务不可用/转换失败 ⇒ 记可读 verify_error、不动 verify 既有值、
    不阻塞模板使用（降级为无缩略图）。代际令牌与 LaTeX 验收同语义。"""
    if fmt != "docx":
        raise ProjectError("「生成预览」只针对 Word 模板；LaTeX 模板请使用「验证编译」，通过后自动生成缩略图", 422)
    from app.domain import word_documents as word

    t0 = time.perf_counter()
    # 短持锁快照：代际令牌 + 文档内容 sha（转换 key 随内容走，DS 缓存不串版本）。
    with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
        row = get(fmt, tid)
        token = _token(row)
        doc = row.get("document")
        if not doc or not os.path.isfile(doc):
            raise ProjectError("模板文档缺失，请重新上传该模板", 422)
        with open(doc, "rb") as f:
            payload = f.read()
    sha = hashlib.sha256(payload).hexdigest()

    def finish(ok: bool | None, error: str | None, png: bytes | None = None) -> dict:
        return _persist_accept(fmt, tid, token, ok=ok, error=error, png=png,
                               duration_ms=round((time.perf_counter() - t0) * 1000), log_tail=None)

    if not config.WORD_EDITOR_ON or not word.ready():
        return finish(None, "Word 转换服务不可用（未开启 ONLYOFFICE 或配置不全），未能生成预览")
    url = (config.ONLYOFFICE_PUBLIC_URL + f"/api/office/template/{fmt}/{tid}"
           + "?cap=" + word.capability(fmt + ":" + tid, "template-doc", "template"))
    try:
        result = word.server_request("/converter", {"async": False, "filetype": "docx", "outputtype": "pdf",
                                                    "key": "tpl-" + sha[:48], "url": url,
                                                    "title": row["name"] + ".docx"})
        if result.get("error") or not result.get("endConvert") or not result.get("fileUrl"):
            return finish(None, f"ONLYOFFICE PDF 转换失败（错误 {result.get('error', 'unknown')}）")
        pdf_bytes = word.fetch_document(result["fileUrl"], pdf=True)
    except ProjectError as e:
        return finish(None, str(e))
    png = None
    with tempfile.TemporaryDirectory(prefix="tpl-wpdf-") as tmp:
        pdf_path = os.path.join(tmp, "preview.pdf")
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)
        png = _pdf_first_png(pdf_path)
    if png is None:
        return finish(None, "PDF 已转换成功，但环境缺少 pdftoppm（poppler-utils），未能生成缩略图")
    return finish(True, None, png=png)


def thumbnail_png(fmt: str, tid: str) -> tuple[bytes, str]:
    """作者端缩略图读取（仅启用模板）。返回 (PNG bytes, ETag)。"""
    row = get(fmt, tid)
    path = _thumb_path(fmt, tid)
    if not row.get("thumb") or not os.path.isfile(path):
        raise ProjectError("该模板暂无预览图", 404)
    with open(path, "rb") as f:
        data = f.read()
    return data, '"' + hashlib.sha256(data).hexdigest()[:16] + '"'


def _safe_path(name: str) -> str:
    parts = name.split("/")
    if not name or "\\" in name or any(
        not p or p in (".", "..") or p.startswith(".") or p[-1:] in (".", " ")
        or any(c in p for c in ':<>"|?*') or any(ord(c) < 32 for c in p)
        or re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?", p, re.I)
        for p in parts
    ):
        raise ProjectError(f"模板内路径不合法：{name}", 422)
    if any(p.lower() in _RESERVED for p in parts):
        raise ProjectError(f"模板不能携带平台配置文件：{name}", 422)
    return name


def _latex_main_candidates(files: dict[str, bytes]) -> list[str]:
    """含 \\documentclass 的 .tex 候选，按展示排序（template 优先、doc/ 垫底、层级浅优先）。"""
    return sorted(
        (name for name, data in files.items()
         if name.lower().endswith(".tex") and "\\documentclass" in data[:8192].decode("utf-8", "replace")),
        key=_candidate_sort_key,
    )


def _latex_files(payload: bytes, main: str) -> tuple[dict[str, bytes], str]:
    """解包并校验 LaTeX 模板 ZIP，返回 (files, main)。
    main 留空 = 自动检测（递归扫描 \\documentclass，排序取最优候选）；
    main 填写但不存在 ⇒ 422 并在报错里列出检测到的候选，免猜路径。"""
    main = (main or "").strip()
    if main:
        _safe_path(main)
        if not main.endswith(".tex"):
            raise ProjectError("主文件必须是压缩包内的 .tex 相对路径", 422)
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            infos = z.infolist()
            if len(infos) > config.IMPORT_MAX_FILES:
                raise ProjectError("模板文件数量超过上限", 413)
            files, seen, total = {}, set(), 0
            for info in infos:
                name = info.orig_filename
                if name.startswith("__MACOSX/") or name.rsplit("/", 1)[-1] == ".DS_Store":
                    continue
                _safe_path(name.rstrip("/") if info.is_dir() else name)
                if info.flag_bits & 1 or (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ProjectError("模板不支持加密条目或符号链接", 422)
                if info.is_dir():
                    continue
                key = name.casefold()
                if key in seen:
                    raise ProjectError(f"模板中存在重名文件：{name}", 422)
                seen.add(key)
                suffix = Path(name).suffix.lower()
                if suffix not in _EXTENSIONS and not (suffix == "" and Path(name).name.casefold() in _EXTENSIONLESS):
                    raise ProjectError(f"模板中包含不支持的文件：{name}；请仅保留排版源文件和图片", 422)
                total += info.file_size
                limit_file = config.IMPORT_MAX_FILE_MB * 1024 * 1024
                limit_total = config.IMPORT_MAX_TOTAL_MB * 1024 * 1024
                if info.file_size > limit_file or total > limit_total:
                    raise ProjectError("模板解压大小超过上限", 413)
                files[name] = z.read(info)
            if not main:
                candidates = _latex_main_candidates(files)
                if not candidates:
                    raise ProjectError(
                        "压缩包中没有含 \\documentclass 的 .tex 主文件，无法作为 LaTeX 模板", 422)
                main = candidates[0]
            if main not in files:
                candidates = _latex_main_candidates(files)
                shown = "、".join(candidates[:6]) + ("…等" if len(candidates) > 6 else "")
                hint = f"；检测到候选：{shown}" if candidates else "；也未检测到含 \\documentclass 的 .tex"
                raise ProjectError(f"压缩包中没有主文件 {main}{hint}", 422)
            if "\\documentclass" not in files[main].decode("utf-8-sig"):
                raise ProjectError("主文件缺少 \\documentclass，请选择完整论文入口", 422)
            return files, main
    except (zipfile.BadZipFile, RuntimeError, UnicodeError, NotImplementedError) as e:
        raise ProjectError("无法读取 LaTeX ZIP，请检查压缩包及主文件 UTF-8 编码", 422) from e


def add(meta: dict, filename: str, payload: bytes) -> dict:
    fmt = meta["format"]
    if len(payload) > config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024:
        raise ProjectError("模板上传大小超过上限", 413)
    main = ""  # docx 模板无主文件概念；latex 分支由 _latex_files 赋值
    if fmt == "docx":
        from app.domain.word_documents import validate_docx

        if not filename.lower().endswith(".docx"):
            raise ProjectError("Word 模板请上传普通 .docx 文件", 422)
        validate_docx(payload)
        files = {"document.docx": payload}
    else:
        if not filename.lower().endswith(".zip"):
            raise ProjectError("LaTeX 模板请上传包含样式、引用库和图片的 .zip 工程", 422)
        if meta.get("engine") not in config.LATEX_ENGINES:
            raise ProjectError("不支持的编译引擎", 422)
        files, main = _latex_files(payload, meta.get("main", ""))
    tid = "custom-" + uuid.uuid4().hex
    row = {**meta, "main": main, "id": tid, "origin": "upload", "enabled": True,
           "created_at": time.time(), "verify": "unverified", "version": 1}
    root = _root()
    os.makedirs(os.path.join(root, "files"), exist_ok=True)
    # Extraction happens in a private directory. Only the catalogue publishes it.
    with tempfile.TemporaryDirectory(prefix="upload-", dir=root) as tmp:
        try:
            for name, content in files.items():
                path = Path(tmp, *name.split("/"))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            target = os.path.join(root, "files", tid)
            with atomic.studio_lock(config.PROJECTS_DIR, "paper-templates"):
                shutil.move(tmp, target)
                data = _load()
                data[_key(fmt, tid)] = row
                _save(data)
        except OSError as e:
            raise ProjectError("模板保存失败，请检查文件路径和数据卷权限", 422) from e
    return public(row)
