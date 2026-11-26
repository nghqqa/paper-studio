# -*- coding: utf-8 -*-
"""论文项目（project）存储：PROJECTS_DIR/<id>/{studio.json, .studio/, ...}。"""

import json
import os
import re
import shutil
from dataclasses import dataclass, field

from app import atomic, config
from app.domain import history
from app.errors import ProjectError  # noqa: F401 - re-export

SETTINGS_FILE = "studio.json"
STUDIO_DIR = ".studio"
FIG_EXTS = (".emf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".svg")
DOCX_FIG_EXTS = (".emf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff")
ID_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}$")
_BAD_ID_CHARS = re.compile(r"[^A-Za-z0-9_\-\u4e00-\u9fff]+")

SOURCE_FORMATS = ("markdown", "latex", "docx")
LATEX_TEXT_EXTS = (".tex", ".bib", ".cls", ".bst", ".sty", ".ltx", ".txt")
LATEX_SOURCE_EXCLUDE_DIRS = (".studio", "__pycache__")
LATEX_INTERNAL_FILES = ("studio.json", "content.md", "case.json")

ATTACHMENTS_DIR = "attachments"
ATTACHMENT_EXTS = (".pdf", ".docx", ".doc", ".md", ".txt", ".png", ".jpg", ".zip")
ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024


def normalize_document_type(value):
    if value is None or str(value).strip() == "":
        return "paper"
    v = str(value).strip()
    if v not in ("paper", "patent"):
        raise ValueError(f"未知文档类型：{value}（允许：paper）")
    return v


def normalize_source_format(value):
    if value is None or str(value).strip() == "" or str(value).strip() == "markdown":
        return "markdown"
    v = str(value).strip()
    if v not in SOURCE_FORMATS:
        raise ValueError(f"未知源格式：{value}（允许：{'、'.join(SOURCE_FORMATS)}）")
    return v


def _is_latex_dir(d) -> bool:
    p = os.path.join(d, SETTINGS_FILE)
    if not os.path.isfile(p):
        return False
    try:
        with open(p, encoding="utf-8") as f:
            return (json.load(f) or {}).get("source_format") == "latex"
    except (OSError, ValueError):
        return False


def _is_word_dir(d) -> bool:
    try:
        with open(os.path.join(d, SETTINGS_FILE), encoding="utf-8") as f:
            return json.load(f).get("source_format") == "docx"
    except (OSError, ValueError, AttributeError):
        return False


def id_slug(stem: str, limit: int, fallback: str) -> str:
    return _BAD_ID_CHARS.sub("-", stem).strip("-")[:limit] or fallback


@dataclass
class Project:
    id: str
    dir: str
    title: str
    settings: dict = field(default_factory=dict)

    @property
    def content_path(self):
        return os.path.join(self.dir, "content.md")

    @property
    def figs_dir(self):
        return os.path.join(self.dir, "figs")

    @property
    def figsrc_dir(self):
        return os.path.join(self.dir, "figs-src")

    @property
    def studio_dir(self):
        return os.path.join(self.dir, STUDIO_DIR)

    @property
    def attachments_dir(self):
        return os.path.join(self.dir, ATTACHMENTS_DIR)


def _read_md_title(content: str) -> str:
    for ln in content.splitlines():
        if ln.startswith("# ") and not ln.startswith("## "):
            return ln[2:].strip()
    return ""


def default_settings(_figs=None):
    return {"document_type": "paper", "style": {}}


def _deep_merge(base, patch):
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _normalize_latex_cfg(raw):
    if not isinstance(raw, dict):
        raise ValueError("settings.latex 应为对象")
    out = {}
    main = str(raw.get("main") or "").strip()
    if not main or "\\" in main or main.startswith("/") or ".." in main.split("/"):
        raise ValueError("settings.latex.main 应为工程内相对路径（不得含 .. 或绝对路径）")
    out["main"] = main
    engine = str(raw.get("engine") or "pdflatex").strip()
    if engine not in config.LATEX_ENGINES:
        raise ValueError(f"未知 LaTeX 引擎：{engine}（允许：{'、'.join(config.LATEX_ENGINES)}）")
    out["engine"] = engine
    if raw.get("title") is not None:
        t = str(raw["title"]).strip()
        if not t:
            raise ValueError("settings.latex.title 不得为空字符串")
        out["title"] = t
    return out


def normalize_settings(raw, _figs=None):
    s = dict(default_settings())
    if isinstance(raw, dict):
        if raw.get("document_type") is not None:
            s["document_type"] = normalize_document_type(raw["document_type"])
        if raw.get("source_format") is not None:
            s["source_format"] = normalize_source_format(raw["source_format"])
        if raw.get("latex") is not None:
            s["latex"] = _normalize_latex_cfg(raw["latex"])
        if isinstance(raw.get("submission"), dict):
            s["submission"] = {k: str(v or "")[:200] for k, v in raw["submission"].items() if v}
        if isinstance(raw.get("blind_terms"), list):
            terms = [str(t).strip()[:80] for t in raw["blind_terms"] if str(t).strip()]
            if len(terms) > 50:
                raise ValueError("settings.blind_terms 最多 50 个词条")
            s["blind_terms"] = terms
        if isinstance(raw.get("title"), str) and raw["title"].strip():
            s["title"] = raw["title"].strip()
        if isinstance(raw.get("style"), dict):
            s["style"] = dict(raw["style"])
        if "ai_enabled" in raw:
            s["ai_enabled"] = bool(raw["ai_enabled"])
        if isinstance(raw.get("preflight"), dict):
            disabled = raw["preflight"].get("disabled")
            if disabled is not None and not (isinstance(disabled, list) and all(isinstance(x, str) for x in disabled)):
                raise ValueError("settings.preflight.disabled 应为字符串数组")
            s["preflight"] = raw["preflight"]
        if isinstance(raw.get("ai_daily_tokens"), int) and not isinstance(raw["ai_daily_tokens"], bool):
            s["ai_daily_tokens"] = max(0, raw["ai_daily_tokens"])
    return s


def _fig_sort_key(name):
    m = re.search(r"(\d+)", name)
    return (int(m.group(1)) if m else 10**9, name)


class ProjectStore:
    def __init__(self, root):
        self.root = os.path.abspath(root)

    def _is_project_dir(self, d: str) -> bool:
        return (
            os.path.isfile(os.path.join(d, SETTINGS_FILE))
            or os.path.isfile(os.path.join(d, "content.md"))
            or _is_latex_dir(d)
            or _is_word_dir(d)
        )

    def list_ids(self):
        if not os.path.isdir(self.root):
            return []
        out = []
        for name in sorted(os.listdir(self.root)):
            if name.startswith("."):
                continue
            d = os.path.join(self.root, name)
            if not os.path.isdir(d) or os.path.islink(d):
                continue
            if self._is_project_dir(d):
                out.append(name)
        return out

    def _dir(self, pid):
        if not ID_RE.match(pid) or pid in (".", ".."):
            raise ProjectError("项目标识不合法", 400)
        d = os.path.join(self.root, pid)
        if not os.path.isdir(d) or not self._is_project_dir(d):
            raise ProjectError(f"项目不存在：{pid}", 404)
        return d

    def unique_pid(self, base: str) -> str:
        taken = set(self.list_ids())
        pid, n = base, 2
        while pid in taken or os.path.exists(os.path.join(self.root, pid)):
            pid = f"{base}-{n}"
            n += 1
        return pid

    def list_figs(self, pid_or_dir):
        d = pid_or_dir if os.path.isabs(pid_or_dir) else self._dir(pid_or_dir)
        fd = os.path.join(d, "figs")
        if not os.path.isdir(fd):
            return []
        return sorted((f for f in os.listdir(fd) if f.lower().endswith(FIG_EXTS)), key=_fig_sort_key)

    def get(self, pid):
        d = self._dir(pid)
        s = self.load_settings(pid)
        title = str(s.get("title") or "").strip()
        if not title and os.path.isfile(os.path.join(d, "content.md")):
            with open(os.path.join(d, "content.md"), encoding="utf-8") as f:
                title = _read_md_title(f.read())
        return Project(id=pid, dir=d, title=title or pid, settings=s)

    def _read_settings_file(self, d):
        p = os.path.join(d, SETTINGS_FILE)
        if not os.path.isfile(p):
            return None
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except ValueError as e:
            raise ProjectError(f"{SETTINGS_FILE} 无法读取：{e}", 422) from e

    def load_settings(self, pid):
        d = self._dir(pid)
        return normalize_settings(self._read_settings_file(d))

    def has_settings_file(self, pid):
        return os.path.isfile(os.path.join(self._dir(pid), SETTINGS_FILE))

    def update_settings(self, pid, partial):
        d = self._dir(pid)
        try:
            raw = self._read_settings_file(d)
        except ProjectError:
            raw = None
        return self.save_settings(pid, _deep_merge(raw or {}, dict(partial or {})))

    def save_settings(self, pid, settings):
        d = self._dir(pid)
        settings = dict(settings or {})
        if _is_word_dir(d) and settings.get("source_format", "docx") != "docx":
            raise ProjectError("原生 Word 工程的源格式不能更改，请创建独立副本进行转换", 400)
        if _is_word_dir(d):
            settings["source_format"] = "docx"
        s = normalize_settings(settings)
        atomic.write_json(os.path.join(d, SETTINGS_FILE), s)
        return s

    def create(self, pid, title, document_type=None):
        if not ID_RE.match(pid) or pid in (".", ".."):
            raise ProjectError("id 只能包含字母、数字、下划线、连字符或中文", 400)
        try:
            doc_type = normalize_document_type(document_type)
        except ValueError as e:
            raise ProjectError(str(e), 422) from e
        d = os.path.join(self.root, pid)
        if os.path.exists(d):
            raise ProjectError(f"已存在：{pid}", 409)
        os.makedirs(d, exist_ok=True)
        settings = {
            "document_type": doc_type,
            "title": (title or "").strip() or pid,
            "style": {},
        }
        atomic.write_json(os.path.join(d, SETTINGS_FILE), normalize_settings(settings))
        return self.get(pid)

    def create_latex_demo(self, pid, seed_dir=None, title=None):
        if not ID_RE.match(pid) or pid in (".", ".."):
            raise ProjectError("id 只能包含字母、数字、下划线、连字符或中文", 400)
        seed = seed_dir or config.LATEX_SEED_DIR
        if not os.path.isdir(seed):
            raise ProjectError(f"LaTeX 示例种子缺失：{seed}", 500)
        d = os.path.join(self.root, pid)
        if os.path.exists(d):
            raise ProjectError(f"已存在：{pid}", 409)
        os.makedirs(d)
        for root, _dirs, files in os.walk(seed):
            for fn in files:
                if fn == "template.json":
                    continue
                src = os.path.join(root, fn)
                rel = os.path.relpath(src, seed)
                dst = os.path.join(d, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
        settings = {
            "document_type": "paper",
            "source_format": "latex",
            "latex": {"main": "bare_conf.tex", "engine": "pdflatex"},
            "title": title or "LaTeX 示例（IEEEtran bare_conf）",
            "style": {},
        }
        atomic.write_json(os.path.join(d, SETTINGS_FILE), settings)
        history.commit(d, "create latex demo")
        return self.get(pid)

    def delete(self, pid):
        shutil.rmtree(self._dir(pid))
