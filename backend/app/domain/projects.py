# -*- coding: utf-8 -*-
"""案子（project）存储：PROJECTS_DIR/<id>/{content.md, docs/, figs/, attachments/, studio.json, .studio/}

W4-C（docs/plan/15-w4c-figures-files-design.md §2）：附图顺序 / 宽度 / 摘要图的真源是 docs/figures.md
（patent_studio.kernel.figures_md），studio.json 只存 style / sub_except / abstract_limit / ai_enabled。
运行期 settings dict 仍带 spec_figures / abstract_figure（由 figures.md 派生的只读视图，本波次内 lint / ast /
cnipa_xml / 设置页继续读它）；save_settings 收到这两个键时写回 figures.md。
"""

import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field

from PIL import Image, ImageDraw

from app import atomic, collab, config
from app.domain import history, review_meta
from patent_studio.kernel import docset, figures_md
from patent_studio.kernel.builder import DEFAULT_SUB_EXCEPT
from patent_studio.kernel.paper import normalize_document_type
from patent_studio.kernel.style import merge_style, style_diff, validate_headings

SETTINGS_FILE = "studio.json"
STUDIO_DIR = ".studio"
FIG_EXTS = (".emf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".svg")
DOCX_FIG_EXTS = (".emf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff")
ID_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}$")
_BAD_ID_CHARS = re.compile(r"[^A-Za-z0-9_\-\u4e00-\u9fff]+")
FIGURE_KEYS = ("abstract_figure", "spec_figures")

SOURCE_FORMATS = ("markdown", "latex", "structured", "docx")
LATEX_TEXT_EXTS = (".tex", ".bib", ".cls", ".bst", ".sty", ".ltx", ".txt")
# v0.1 论文试用：figs/ 等资源目录不得整体过滤（导入工程用 figs/ 存图）——只排除平台运行目录
LATEX_SOURCE_EXCLUDE_DIRS = (".studio", "__pycache__")
LATEX_INTERNAL_FILES = ("studio.json", "content.md", "case.json")
# 结构化中文论文（实验）：事实源 JSON 文件名
STRUCT_CONTENT_FILE = "content.json"


def normalize_source_format(value):
    """缺省/None → markdown；未知值明确报错（w21 批 A：document_type 表用途，source_format 表源格式）。"""
    if value is None or str(value).strip() == "" or str(value).strip() == "markdown":
        return "markdown"
    v = str(value).strip()
    if v not in SOURCE_FORMATS:
        raise ValueError(f"未知源格式：{value}（允许：{'、'.join(SOURCE_FORMATS)}）")
    return v


def _is_latex_dir(d) -> bool:
    """目录是否为 LaTeX 工程：studio.json 显式 source_format=latex（content.md 可不存在）。"""
    p = os.path.join(d, SETTINGS_FILE)
    if not os.path.isfile(p):
        return False
    try:
        with open(p, encoding="utf-8") as f:
            return (json.load(f) or {}).get("source_format") == "latex"
    except (OSError, ValueError):
        return False


def _is_struct_dir(d) -> bool:
    """目录是否为结构化中文论文工程（实验）：studio.json 显式 source_format=structured
    且存在 content.json（schema_version 化 JSON 事实源）。"""
    p = os.path.join(d, SETTINGS_FILE)
    if not os.path.isfile(p):
        return False
    try:
        with open(p, encoding="utf-8") as f:
            return (json.load(f) or {}).get("source_format") == "structured"
    except (OSError, ValueError):
        return False


def _is_word_dir(d) -> bool:
    try:
        with open(os.path.join(d, SETTINGS_FILE), encoding="utf-8") as f:
            return json.load(f).get("source_format") == "docx"
    except (OSError, ValueError, AttributeError):
        return False


def id_slug(stem: str, limit: int, fallback: str) -> str:
    """文件名主干 → 合法案 id 前缀。字符集 ⊆ ID_RE 允许集，故非空结果恒匹配 ID_RE。"""
    return _BAD_ID_CHARS.sub("-", stem).strip("-")[:limit] or fallback


# attachments/（12 §4.4）：任意材料，白名单 + 单文件 50 MB；C2 的 app/domain/attachments.py 读这三个常量
ATTACHMENTS_DIR = "attachments"
ATTACHMENT_EXTS = (".pdf", ".docx", ".doc", ".md", ".txt", ".png", ".jpg", ".zip")
ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024

# 新案自带的占位附图（图1）：排版内核要求摘要附图必须存在（abstract_figure=None → TypeError），
# 有了它新建案子首屏就能构建预览；用户放入真实附图后在排版设置里替换。
TEMPLATE_FIG = "fig1.png"

TEMPLATE_MD = """# 一种XXX方法及装置

## 摘要

本发明公开了一种XXX方法及装置，涉及……技术领域，用于解决……的问题。方法包括：……。能够提高……（≤300 字）。

## 权利要求书

1.一种XXX方法，其特征在于，包括以下步骤：
步骤一，……；
步骤二，……。

2.根据权利要求1所述的方法，其特征在于，……。

## 说明书

### 技术领域

本发明涉及……技术领域，尤其涉及一种XXX方法及装置。

### 背景技术

……

### 发明内容

……

### 附图说明

图1为本发明实施例的总体流程图。

### 具体实施方式

下面结合附图对本发明作进一步说明。如图1所示，……
"""

PAPER_TEMPLATE_MD = """# 论文标题（占位）

## 摘要

本文研究……，提出……方法，实验表明……。关键词以「关键词：」开头另起一段。

关键词：示例；论文

## 引言

研究背景与动机……

## 方法

正文一段一行。行内公式如 $x_i$；独立公式单独一行并可在尾部手写编号：

$$E = mc^2$$(1)

## 结果

![图1 示例结果图](figs/fig1.png){width=14}

| 组别 | 指标A | 指标B |
| --- | --- | --- |
| 对照 | 0.82 | 1.31 |
| 本文 | 0.91 | 1.02 |

<!-- 表格: 三线 -->

注：表中数值为占位示例。

## 讨论

……（参考文献请在下方「参考文献」章逐条列出；文内引用与文献表的对账检查属后续批次）

## 参考文献

[1] 作者. 文献标题. 期刊, 年份.
"""


def write_template_fig(path, size=(1200, 700)):
    """生成占位总体流程图：S1 → S2 → S3 三个步骤框（黑白线条，符合附图不着色的惯例）。"""
    w, h = size
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    bw, bh, gap = 260, 160, 110
    x0 = (w - (3 * bw + 2 * gap)) // 2
    y0 = (h - bh) // 2
    for i in range(3):
        x = x0 + i * (bw + gap)
        d.rectangle([x, y0, x + bw, y0 + bh], outline="black", width=4)
        d.text((x + bw // 2, y0 + bh // 2), f"S{i + 1}", fill="black", anchor="mm", font_size=56)
        if i < 2:
            ax0, ax1, ay = x + bw + 12, x + bw + gap - 12, y0 + bh // 2
            d.line([ax0, ay, ax1, ay], fill="black", width=4)
            d.polygon([(ax1, ay), (ax1 - 24, ay - 14), (ax1 - 24, ay + 14)], fill="black")
    img.save(path, "PNG")


# ProjectError 已上移至 app/errors.py（保证类身份在 importlib.reload 下稳定），
# 此处再导出维持既有 `from app.domain.projects import ProjectError` 的 29 处引用。
from app.errors import ProjectError  # noqa: E402


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
    def figures_md_path(self):
        return figures_md.path_of(self.dir)

    @property
    def attachments_dir(self):
        return os.path.join(self.dir, ATTACHMENTS_DIR)


def read_title(content):
    for ln in content.splitlines():
        if ln.startswith("# ") and not ln.startswith("## "):
            return ln[2:].strip()
    return ""


def default_settings(figs):
    """未提供 studio.json 时的推断：摘要附图=第一张图，说明书附图=全部（按图号排序）。
    注意：不注入 document_type 缺省键——运行时 settings 与磁盘 studio.json 保持键一致
    （除 figures 派生键），档案判定一律 .get("document_type") == "paper"（缺省即 patent）。"""
    docx_figs = [f for f in figs if f.lower().endswith(DOCX_FIG_EXTS)]
    return {
        "abstract_figure": [docx_figs[0], 14.5] if docx_figs else None,
        "spec_figures": [[f, 15.0] for f in docx_figs],
        "sub_except": list(DEFAULT_SUB_EXCEPT),
        "abstract_limit": 300,
        "style": {},
    }


def _deep_merge(base, patch):
    """dict+dict 递归合并，其余值覆盖（update_settings 用）。"""
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _normalize_latex_cfg(raw):
    """latex 工程配置：{main: 相对主文件, engine: pdflatex|xelatex, title?}。形状校验；
    main 的存在性在创建/构建端点按文件系统校验。"""
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


def normalize_settings(raw, figs):
    """补齐缺省字段；style 只保留相对默认值的差异；ai_daily_tokens（案级日预算，W5 §6.2）按原样透传。
    document_type（w20 批 A1）：patent（缺省）/ paper；未知值明确报错。"""
    base = default_settings(figs)
    s = dict(base)
    if isinstance(raw, dict):
        if raw.get("document_type") is not None:
            s["document_type"] = normalize_document_type(raw["document_type"])
        if raw.get("source_format") is not None:
            s["source_format"] = normalize_source_format(raw["source_format"])
        if raw.get("latex") is not None:
            s["latex"] = _normalize_latex_cfg(raw["latex"])
        if isinstance(raw.get("submission"), dict):
            # 投稿目标元数据（v0.1.5 统一新建入口收集；仅记录/筛选，不影响导出）
            s["submission"] = {k: str(v or "")[:200] for k, v in raw["submission"].items() if v}
        if isinstance(raw.get("blind_terms"), list):
            # 双盲检查屏蔽词（作者/单位名等；double-blind 规则集扫描用；仅记录不影响导出）
            terms = [str(t).strip()[:80] for t in raw["blind_terms"] if str(t).strip()]
            if len(terms) > 50:
                raise ValueError("settings.blind_terms 最多 50 个词条")
            s["blind_terms"] = terms
        if isinstance(raw.get("title"), str) and raw["title"].strip():
            # LaTeX 工程无 content.md，标题存 studio.json（markdown 项目不受影响：不携带该键）
            s["title"] = raw["title"].strip()
        for k in ("abstract_figure", "spec_figures", "sub_except", "abstract_limit"):
            if k in raw and raw[k] is not None:
                s[k] = raw[k]
        if isinstance(raw.get("style"), dict):
            validate_headings(raw["style"])
            s["style"] = style_diff(merge_style(raw["style"]))
        if "ai_enabled" in raw:
            s["ai_enabled"] = bool(raw["ai_enabled"])
        if isinstance(raw.get("preflight"), dict):
            disabled = raw["preflight"].get("disabled")
            if disabled is not None and not (isinstance(disabled, list) and all(isinstance(x, str) for x in disabled)):
                raise ValueError("settings.preflight.disabled 应为字符串数组")
            s["preflight"] = raw["preflight"]
        if isinstance(raw.get("ai_daily_tokens"), int) and not isinstance(raw["ai_daily_tokens"], bool):
            s["ai_daily_tokens"] = max(0, raw["ai_daily_tokens"])
        if "notify_webhook_url" in raw:
            u = str(raw.get("notify_webhook_url") or "").strip()
            if u and not re.match(r"^https?://", u):
                raise ValueError("settings.notify_webhook_url 应为 http(s) URL")
            s["notify_webhook_url"] = u
    try:
        if s["abstract_figure"] is not None:
            s["abstract_figure"] = [str(s["abstract_figure"][0]), float(s["abstract_figure"][1])]
        s["spec_figures"] = [[str(f), float(w)] for f, w in s["spec_figures"]]
        s["sub_except"] = [str(x) for x in s["sub_except"]]
        s["abstract_limit"] = int(s["abstract_limit"])
    except (TypeError, ValueError, KeyError, IndexError) as e:
        raise ValueError(f"settings 字段形态不合法：{e}") from e
    return s


def _fig_sort_key(name):
    m = re.search(r"(\d+)", name)
    return (int(m.group(1)) if m else 10**9, name)


class ProjectStore:
    def __init__(self, root):
        self.root = os.path.abspath(root)

    # --- 枚举与读取 ---
    def list_ids(self):
        if not os.path.isdir(self.root):
            return []
        out = []
        for name in sorted(os.listdir(self.root)):
            d = os.path.join(self.root, name)
            if not os.path.isdir(d) or os.path.islink(d):
                continue
            if (os.path.isfile(os.path.join(d, "content.md")) or _is_latex_dir(d)
                    or _is_struct_dir(d) or _is_word_dir(d)):
                out.append(name)
        return out

    def _dir(self, pid):
        if not ID_RE.match(pid) or pid in (".", ".."):
            raise ProjectError("项目标识不合法", 400)
        d = os.path.join(self.root, pid)
        if (not os.path.isfile(os.path.join(d, "content.md")) and not _is_latex_dir(d)
                and not _is_struct_dir(d) and not _is_word_dir(d)):
            raise ProjectError(f"项目不存在：{pid}", 404)
        return d

    def unique_pid(self, base: str) -> str:
        """base → 未占用案 id（被占 ⇒ base-2、-3…）。list_ids 只收有 content.md 的案，
        再叠目录存在检查，挡空目录名被复用。"""
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
        if os.path.isfile(os.path.join(d, "content.md")):
            with open(os.path.join(d, "content.md"), encoding="utf-8") as f:
                content = f.read()
            title = read_title(content)
        else:  # latex 工程：无 content.md，标题存 studio.json
            title = str(self.load_settings(pid).get("title") or pid)
        return Project(id=pid, dir=d, title=title, settings=self.load_settings(pid))

    def read_content(self, pid):
        d = self._dir(pid)
        if _is_latex_dir(d):
            raise ProjectError("LaTeX 工程不使用 content.md：请使用 /latex/files 端点", 400)
        if _is_struct_dir(d):
            raise ProjectError("结构化工程不使用 content.md：请使用 /struct/content 端点", 400)
        if _is_word_dir(d):
            raise ProjectError("Word 工程使用原生 DOCX：请使用 Word 编辑器", 400)
        with open(os.path.join(d, "content.md"), encoding="utf-8") as f:
            content = f.read()
        if not docset.has_mirror(d):
            docset.write_mirror(d, content)
        return content

    def _read_settings_file(self, d):
        p = os.path.join(d, SETTINGS_FILE)
        if not os.path.isfile(p):
            return None
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except ValueError as e:
            raise ProjectError(f"{SETTINGS_FILE} 无法读取：{e}", 422) from e

    # --- 附图真源 docs/figures.md ---
    def load_figures(self, pid_or_dir):
        """读 docs/figures.md；不存在则迁移生成（幂等：存在即只读，不动 studio.json）：
        studio.json 旧字段 spec_figures / abstract_figure → figures.md（alt 取说明书「图N为…」题注）；
        两者都没有 → 按 figs/ 推断（摘要图 = 第一张，说明书附图 = 全部）。"""
        d = pid_or_dir if os.path.isabs(pid_or_dir) else self._dir(pid_or_dir)
        doc = figures_md.read(d)
        if doc is not None:
            return doc
        raw = self._read_settings_file(d) or {}
        if raw.get("spec_figures") or raw.get("abstract_figure"):
            with open(os.path.join(d, "content.md"), encoding="utf-8") as f:
                content = f.read()
            doc = figures_md.from_legacy(raw.get("spec_figures") or [], raw.get("abstract_figure"), content)
        else:
            doc = figures_md.infer(self.list_figs(d), DOCX_FIG_EXTS)
        return figures_md.write(d, doc)

    def save_figures(self, pid, doc):
        """写 docs/figures.md 并 history commit（docs/ 已在 history.commit 的 add 路径内）。"""
        d = self._dir(pid)
        figures_md.write(d, doc)
        history.commit(d, "figures")
        return doc

    def load_settings(self, pid):
        d = self._dir(pid)
        raw = self._read_settings_file(d)
        return self._runtime_settings(d, raw, self.load_figures(d))

    def _runtime_settings(self, d, raw, doc):
        """studio.json 内容 + figures.md 派生的 spec_figures / abstract_figure（只读视图）。"""
        s = normalize_settings({**(raw or {}), **doc.legacy_view()}, self.list_figs(d))
        s["abstract_figure"] = doc.legacy_view()["abstract_figure"]
        return s

    def has_settings_file(self, pid):
        return os.path.isfile(os.path.join(self._dir(pid), SETTINGS_FILE))

    def update_settings(self, pid, partial):
        """PUT /settings 的 merge 入口：请求携带的键覆盖，未携带的键保留（dict 值深合并）。
        替换语义下部分客户端（MCP/脚本）漏发的键会被 normalize 重置回默认——merge 后
        客户端只需传改动项。studio.json 损坏时无基可并，退化为整体替换（PUT 仍是自愈路径）。"""
        d = self._dir(pid)
        try:
            raw = self._read_settings_file(d)
        except ProjectError:
            raw = None
        return self.save_settings(pid, _deep_merge(raw or {}, dict(partial or {})))

    def save_settings(self, pid, settings):
        """style / sub_except / abstract_limit / ai_enabled → studio.json；
        settings 里若带 spec_figures / abstract_figure（旧设置页 / R2 figures API / 导入器）
        → 套到 figures.md（保留已有 alt）。"""
        d = self._dir(pid)
        settings = dict(settings or {})
        if _is_word_dir(d) and settings.get("source_format", "docx") != "docx":
            raise ProjectError("原生 Word 工程的源格式不能更改，请创建独立副本进行转换", 400)
        if _is_word_dir(d):
            settings["source_format"] = "docx"
        doc = self.load_figures(d)
        if any(k in settings for k in FIGURE_KEYS):
            lv = normalize_settings(
                {**doc.legacy_view(), **{k: settings[k] for k in FIGURE_KEYS if k in settings}}, self.list_figs(d)
            )
            figures_md.apply_legacy(doc, lv["spec_figures"], lv["abstract_figure"])
            self.save_figures(pid, doc)
        s = normalize_settings(settings, self.list_figs(d))
        persisted = {k: v for k, v in s.items() if k not in FIGURE_KEYS}
        atomic.write_json(os.path.join(d, SETTINGS_FILE), persisted)
        return self._runtime_settings(d, persisted, doc)

    # --- 写内容（保存前备份）---
    def save_content(self, pid, content, backup=True):
        """写 content.md + 三书镜像 + history commit，末尾通知协同房间（R8）。
        backup=False 供协同去抖写回用（git 已是安全网）。"""
        d = self._dir(pid)
        if _is_latex_dir(d):
            raise ProjectError("LaTeX 工程不使用 content.md：请使用 /latex/files 端点", 400)
        if _is_word_dir(d) or _is_struct_dir(d):
            raise ProjectError("该工程不使用 content.md：请使用相应的文档编辑器", 400)
        path = os.path.join(d, "content.md")
        name = None
        if backup and os.path.isfile(path):
            ts = time.strftime("%Y%m%d-%H%M%S")
            name = f"content.md.bak-{ts}"
            bpath = os.path.join(d, name)
            i = 1
            while os.path.exists(bpath):
                bpath = os.path.join(d, f"{name}-{i}")
                i += 1
            shutil.copy2(path, bpath)
            name = os.path.basename(bpath)
        old = ""
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                old = f.read()
        atomic.write_text(path, content)
        review_meta.record(d, old, content)
        docset.write_mirror(d, content)
        history.commit(d, "save")
        collab.on_saved(pid, content)
        return name

    def list_backups(self, pid):
        d = self._dir(pid)
        out = []
        for name in os.listdir(d):
            if name.startswith("content.md.bak-"):
                st = os.stat(os.path.join(d, name))
                out.append({"name": name, "size": st.st_size, "mtime": st.st_mtime})
        return sorted(out, key=lambda x: x["name"], reverse=True)

    def read_backup(self, pid, name):
        d = self._dir(pid)
        if not name.startswith("content.md.bak-") or "/" in name or "\\" in name:
            raise ProjectError("非法备份名", 400)
        p = os.path.join(d, name)
        if not os.path.isfile(p):
            raise ProjectError("备份不存在", 404)
        with open(p, encoding="utf-8") as f:
            return f.read()

    # --- 新建 ---
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
        os.makedirs(os.path.join(d, "figs"))
        os.makedirs(os.path.join(d, ATTACHMENTS_DIR))
        write_template_fig(os.path.join(d, "figs", TEMPLATE_FIG))
        template = PAPER_TEMPLATE_MD if doc_type == "paper" else TEMPLATE_MD
        md = template.replace("一种XXX方法及装置", title.strip() or "一种XXX方法及装置", 1)
        md = md.replace("论文标题（占位）", title.strip() or "论文标题（占位）", 1)
        atomic.write_text(os.path.join(d, "content.md"), md)
        settings = default_settings(self.list_figs(d))
        settings["document_type"] = doc_type
        self.save_settings(pid, settings)
        return self.get(pid)

    # --- LaTeX 内置示例（w21 批 A：合法分发的 IEEEtran 官方示例 + 显式标注的验证增强） ---
    def create_structured(self, pid, title=None, submission=None):
        """创建结构化中文论文工程（实验）：事实源=content.json（schema_version 化 JSON）。

        submission = 投稿目标元数据 {venue, field, rank}（统一新建对话框收集，仅记录不影响导出）。"""
        if not ID_RE.match(pid) or pid in (".", ".."):
            raise ProjectError("id 只能包含字母、数字、下划线、连字符或中文", 400)
        d = os.path.join(self.root, pid)
        if os.path.exists(d):
            raise ProjectError(f"已存在：{pid}", 409)
        os.makedirs(os.path.join(d, "resources"))
        settings = {
            "document_type": "paper",
            "source_format": "structured",
            "title": title or "结构化中文论文（实验）",
            "style": {},
        }
        if submission:
            settings["submission"] = {k: str(v or "")[:80] for k, v in submission.items() if v}
        atomic.write_json(os.path.join(d, SETTINGS_FILE), settings)
        content = {
            "schema_version": 1,
            "title": title or "",
            "title_en": "", "authors": "", "affil": "",
            "abstract_zh": "", "abstract_en": "", "keywords": "",
            "body": [
                {"type": "h1", "text": "引言"},
                {"type": "p", "text": ""},
            ],
        }
        atomic.write_json(os.path.join(d, STRUCT_CONTENT_FILE), content)
        return Project(id=pid, dir=d, title=settings["title"], settings=settings)

    def create_latex_demo(self, pid, seed_dir=None, title=None):
        """从内置种子目录创建 LaTeX 工程（保留原生 .tex/.cls 结构，不转 Markdown）。"""
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
                if fn == "template.json":  # 平台内部元数据，不属于用户工程
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

    # --- 永久删除（W4-A 回收站 → 彻底删除；仅 owner，路由层校验；协同房间由路由先 collab.rooms.drop） ---
    def delete(self, pid):
        shutil.rmtree(self._dir(pid))

    # --- 构建配置 ---
    def build_config(self, project, out, content_md=None, settings=None):
        """docs/figures.md + studio.json（或传入的草稿 settings）→ 内核构建 CONFIG。

        patent 档案（缺省）：CONFIG 契约不变（build_patent），以便 examples/*/build_docx.py 与
        make zero-drift 的原脚本路径继续作为基准；
        paper 档案（w20 批 A1）：CONFIG = {content_md, out, figs_dir, style, sub_except}——无摘要附图
        强制要求、无 abstract_limit / spec_figures（附图由正文内嵌行声明），builder 为 paper_builder。"""
        if project.settings.get("source_format") == "docx":
            raise ProjectError("原生 Word 工程不经过 Markdown 构建，请使用 Word 保存与导出", 400)
        s = normalize_settings(settings if settings is not None else project.settings, self.list_figs(project.dir))
        if s.get("document_type") == "paper":
            cfg = {
                "content_md": content_md or project.content_path,
                "out": out,
                "figs_dir": project.figs_dir,
                "sub_except": tuple(s["sub_except"]),
            }
            if s["style"]:
                cfg["style"] = s["style"]
            return cfg
        if not s["abstract_figure"] and s["spec_figures"]:
            # 有说明书附图却未选摘要图 → 沿用产品原口径硬拦；纯方法无附图案卷允许无摘要图构建。
            raise ProjectError("未设置摘要附图（figs/ 目录为空或未在设置中选择）", 422)
        cfg = {
            "content_md": content_md or project.content_path,
            "out": out,
            "figs_dir": project.figs_dir,
            "abstract_figure": (s["abstract_figure"][0], s["abstract_figure"][1]) if s["abstract_figure"] else None,
            "spec_figures": [(f, w) for f, w in s["spec_figures"]],
            "sub_except": tuple(s["sub_except"]),
            "abstract_limit": s["abstract_limit"],
        }
        if s["style"]:
            cfg["style"] = s["style"]
        return cfg

    def fig_preview_path(self, pid, name):
        """浏览器可显示的附图路径：emf → 同名 png/svg/jpg；找不到返回 None。"""
        d = self._dir(pid)
        fd = os.path.join(d, "figs")
        if "/" in name or "\\" in name or name.startswith("."):
            raise ProjectError("非法文件名", 400)
        p = os.path.join(fd, name)
        stem, ext = os.path.splitext(name)
        if ext.lower() in (".png", ".jpg", ".jpeg", ".gif", ".svg", ".bmp") and os.path.isfile(p):
            return p
        for alt in (".png", ".svg", ".jpg", ".jpeg"):
            q = os.path.join(fd, stem + alt)
            if os.path.isfile(q):
                return q
        return p if os.path.isfile(p) else None
