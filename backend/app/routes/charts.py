# -*- coding: utf-8 -*-
"""科研图表 v1：把结构化数据渲染为 PNG（matplotlib Agg），返回 data URL 供 ONLYOFFICE 插件插入文档。

无项目状态、无盘写入：纯函数式渲染 + 登录门槛。中文字体优先取容器内挂载/自带字体。
"""
from __future__ import annotations

import base64
import hashlib
import io
import math
import os
import threading
from pathlib import Path
from typing import Annotated, Literal

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile  # noqa: E402
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator  # noqa: E402

from app import auth, config  # noqa: E402
from app.ai import client as ai_client  # noqa: E402
from app.auth import CurrentUser  # noqa: E402
from app.domain import user_ai  # noqa: E402
from app.domain.org import require_org_ai  # noqa: E402
from app.errors import error_detail  # noqa: E402

router = APIRouter(prefix="/api/charts", tags=["charts"])

CHART_TYPES = ("line", "bar", "scatter", "pie", "heatmap", "boxplot", "radar", "violin", "forest", "grouped_bar")
_VISION_MAX_BYTES = 8 * 1024 * 1024
_VISION_MIMES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
MAX_CATEGORIES = 50
MAX_SERIES = 6
MAX_POINTS = 200
PALETTES: dict[str, tuple[str, ...]] = {
    "academic": ("#1f4e79", "#c0392b", "#1e8449", "#d68910", "#6c3483", "#566573"),
    "colorblind": ("#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9"),
    "grayscale": ("#111111", "#4d4d4d", "#7f7f7f", "#a6a6a6", "#595959", "#969696"),
}
PaletteName = Literal["default", "academic", "colorblind", "grayscale"]
_GRAY_LINESTYLES = ("-", "--", "-.", ":")
_GRAY_MARKERS = ("o", "s", "^", "D", "v", "P")

_FONT_LOCK = threading.Lock()
_FONT_CHECKED = False
_FONT_FAMILY: str | None = None
_RENDER_LOCK = threading.Lock()


def _detect_image_mime(raw: bytes) -> str | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def _ensure_cjk_font_family() -> str | None:
    global _FONT_CHECKED, _FONT_FAMILY
    with _FONT_LOCK:
        if _FONT_CHECKED:
            return _FONT_FAMILY
        _FONT_CHECKED = True
        font_path = _cjk_font()
        if font_path:
            from matplotlib import font_manager

            font_manager.fontManager.addfont(font_path)
            _FONT_FAMILY = font_manager.FontProperties(fname=font_path).get_name()
        return _FONT_FAMILY


def _cjk_font():
    """容器内可用的中文字体：挂载目录（custom）→ fandol → Noto → None（回退默认字体）。"""
    candidates = []
    custom = os.environ.get("ONLYOFFICE_FONTS_DIR", "")
    if custom and os.path.isdir(custom):
        candidates += [str(p) for p in Path(custom).iterdir() if p.suffix.lower() in (".ttf", ".ttc", ".otf")]
    candidates += [
        "/usr/share/texlive/texmf-dist/fonts/opentype/public/fandol/FandolSong-Regular.otf",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/Deng.ttf",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simsun.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


class SeriesIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    values: list[float] = Field(max_length=MAX_POINTS)
    errors: list[float] | None = Field(default=None, max_length=MAX_POINTS)


class ChartIn(BaseModel):
    type: str
    title: str = Field(default="", max_length=120)
    x_label: str = Field(default="", max_length=80)
    y_label: str = Field(default="", max_length=80)
    categories: list[str] = Field(min_length=1, max_length=MAX_CATEGORIES)
    series: list[SeriesIn] = Field(min_length=1, max_length=MAX_SERIES)
    palette: PaletteName = "default"
    dpi: int = Field(default=140, ge=72, le=600)
    show_values: bool = False

    @field_validator("type")
    @classmethod
    def _type_ok(cls, v: str) -> str:
        if v not in CHART_TYPES:
            raise ValueError(f"type 须为 {'/'.join(CHART_TYPES)}")
        return v

    @field_validator("categories")
    @classmethod
    def _cat_ok(cls, v: list[str]) -> list[str]:
        cleaned = [c.strip()[:40] for c in v]
        if any(not c for c in cleaned):
            raise ValueError("分类标签不能为空")
        return cleaned

    @field_validator("series")
    @classmethod
    def _series_ok(cls, v: list[SeriesIn], info) -> list[SeriesIn]:
        for s in v:
            if len(s.values) != len(info.data.get("categories", [])):
                raise ValueError(f"系列「{s.name}」数据点数与分类数不一致")
            if any(x != x or abs(x) > 1e12 for x in s.values):
                raise ValueError(f"系列「{s.name}」含无效数值")
            if s.errors is not None:
                if len(s.errors) != len(s.values):
                    raise ValueError(f"系列「{s.name}」误差条长度与数据点数不一致")
                if any(e != e or e < 0 or abs(e) > 1e12 for e in s.errors):
                    raise ValueError(f"系列「{s.name}」含无效误差值（须非负实数）")
        return v

    @model_validator(mode="after")
    def _pie_ok(self):
        if self.type == "pie":
            if len(self.series) != 1:
                raise ValueError("饼图只支持一个数据系列")
            values = self.series[0].values
            if any(value < 0 for value in values) or sum(values) <= 0:
                raise ValueError("饼图数据不能为负数，且总和须大于零")
        return self


def render_chart(body: ChartIn, *, fmt: Literal["png", "pdf", "svg"] = "png", dpi: int | None = None) -> bytes:
    """渲染科研数据图为 PNG（含高 DPI）或 TrueType 嵌入矢量 PDF / SVG。"""
    family = _ensure_cjk_font_family()
    effective_dpi = dpi if dpi is not None else body.dpi
    colors = PALETTES.get(body.palette)
    cats = body.categories
    xs = list(range(len(cats)))

    with _RENDER_LOCK:
        if family:
            plt.rcParams["font.sans-serif"] = [family, "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
        plt.rcParams["pdf.fonttype"] = 42
        plt.rcParams["ps.fonttype"] = 42

        if body.type == "radar":
            fig, ax = plt.subplots(figsize=(7, 5), dpi=effective_dpi, subplot_kw={"polar": True})
        else:
            fig, ax = plt.subplots(figsize=(8, 4.5), dpi=effective_dpi)
        try:
            return _draw_and_export(fig, ax, body, cats, xs, colors, fmt, effective_dpi)
        finally:
            plt.close(fig)


def _draw_and_export(fig, ax, body: ChartIn, cats, xs, colors, fmt, effective_dpi) -> bytes:
    if body.type == "pie":
        pie_colors = list(colors[: len(cats)]) if colors else None
        ax.pie(body.series[0].values, labels=cats, autopct="%1.1f%%", startangle=90, colors=pie_colors)
        ax.axis("equal")
    elif body.type == "radar":
        n = max(len(cats), 1)
        angles = [2 * math.pi * i / n for i in range(n)] + [0.0]
        ax.set_theta_offset(math.pi / 2)
        ax.set_theta_direction(-1)
        ax.set_xticks(angles[:-1])
        ax.set_xticklabels(cats)
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            ls = _GRAY_LINESTYLES[i % len(_GRAY_LINESTYLES)] if body.palette == "grayscale" else "-"
            vals = list(s.values) + [s.values[0]]
            ax.plot(angles, vals, linewidth=1.7, linestyle=ls, label=s.name, color=color, marker="o", markersize=4)
            ax.fill(angles, vals, color=color, alpha=0.14)
        if body.show_values and len(body.series) == 1:
            for ang, val in zip(angles[:-1], body.series[0].values):
                ax.annotate(f"{val:g}", (ang, val), textcoords="offset points", xytext=(0, 5), ha="center", fontsize=8)
    elif body.type == "violin":
        data = [list(s.values) if len(s.values) >= 2 else [s.values[0], s.values[0]] for s in body.series]
        vp = ax.violinplot(data, showmeans=True, showmedians=True)
        for i, pc in enumerate(vp["bodies"]):
            c = colors[i % len(colors)] if colors else "#4c72b0"
            pc.set_facecolor(c)
            pc.set_edgecolor("#222222")
            pc.set_alpha(0.72)
        for part_key in ("cmeans", "cmedians", "cbars", "cmins", "cmaxes"):
            if part_key in vp:
                vp[part_key].set_color("#111111")
                vp[part_key].set_linewidth(1.2)
        ax.set_xticks(list(range(1, len(body.series) + 1)))
        ax.set_xticklabels([s.name for s in body.series])
        if body.show_values:
            for i, vals in enumerate(data, 1):
                mean_v = sum(vals) / len(vals)
                ax.annotate(f"{mean_v:g}", (i, mean_v), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=8)
    elif body.type == "forest":
        n_s = len(body.series)
        spread = 0.55 / n_s if n_s > 1 else 0.0
        ref_x = 0.0 if any(v <= 0 for s in body.series for v in s.values) else 1.0
        ax.axvline(ref_x, linestyle="--", color="#7f7f7f", linewidth=1.0)
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            marker = _GRAY_MARKERS[i % len(_GRAY_MARKERS)] if body.palette == "grayscale" else "o"
            offset = (i - (n_s - 1) / 2) * spread if n_s > 1 else 0.0
            ys = [y + offset for y in xs]
            ax.errorbar(
                s.values,
                ys,
                xerr=s.errors,
                fmt=marker,
                capsize=3,
                elinewidth=1.2,
                markersize=5,
                label=s.name,
                color=color,
            )
            if body.show_values:
                for x_v, y_v in zip(s.values, ys):
                    ax.annotate(f"{x_v:g}", (x_v, y_v), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=8)
        ax.set_yticks(xs)
        ax.set_yticklabels(cats)
        ax.invert_yaxis()
    elif body.type == "grouped_bar":
        height = 0.8 / len(body.series)
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            bar_kw = {"xerr": s.errors, "capsize": 3, "error_kw": {"elinewidth": 1.1, "ecolor": "#333333"}} if s.errors else {}
            bars = ax.barh([y + i * height for y in xs], s.values, height=height, label=s.name, color=color, **bar_kw)
            if body.show_values:
                ax.bar_label(bars, fmt="%.3g", padding=3, fontsize=8)
        ax.set_yticks([y + 0.4 - height / 2 for y in xs] if len(body.series) > 1 else xs)
        ax.set_yticklabels(cats)
        ax.invert_yaxis()
    elif body.type == "heatmap":
        matrix = [s.values for s in body.series]
        flat = [v for row in matrix for v in row]
        vmin, vmax = min(flat), max(flat)
        span = (vmax - vmin) or 1.0
        cmap = "Greys" if body.palette == "grayscale" else ("cividis" if body.palette == "colorblind" else "YlGnBu")
        im = ax.imshow(matrix, aspect="auto", cmap=cmap)
        ax.set_xticks(xs)
        ax.set_xticklabels(cats)
        ax.set_yticks(list(range(len(body.series))))
        ax.set_yticklabels([s.name for s in body.series])
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        if body.show_values:
            for r, row in enumerate(matrix):
                for c, val in enumerate(row):
                    norm = (val - vmin) / span
                    txt_color = "#ffffff" if norm > 0.55 else "#111111"
                    ax.text(c, r, f"{val:g}", ha="center", va="center", color=txt_color, fontsize=8)
    elif body.type == "boxplot":
        data = [s.values for s in body.series]
        labels = [s.name for s in body.series]
        mpl_ver = tuple(int(p) for p in matplotlib.__version__.split(".")[:2] if p.isdigit())
        label_kw = {"tick_labels": labels} if mpl_ver >= (3, 9) else {"labels": labels}
        bp = ax.boxplot(data, patch_artist=True, **label_kw)
        for i, box in enumerate(bp["boxes"]):
            c = colors[i % len(colors)] if colors else "#4c72b0"
            box.set_facecolor(c)
            box.set_alpha(0.75)
        for med in bp["medians"]:
            med.set_color("#111111")
            med.set_linewidth(1.5)
        if body.show_values:
            for i, vals in enumerate(data, 1):
                sv = sorted(vals)
                mid = len(sv) // 2
                med_val = sv[mid] if len(sv) % 2 == 1 else (sv[mid - 1] + sv[mid]) / 2
                ax.annotate(f"{med_val:g}", (i, med_val), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=8)
    elif body.type == "bar":
        width = 0.8 / len(body.series)
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            bar_kw = {}
            if s.errors:
                bar_kw = {"yerr": s.errors, "capsize": 3, "error_kw": {"elinewidth": 1.1, "ecolor": "#333333"}}
            bars = ax.bar([x + i * width for x in xs], s.values, width=width, label=s.name, color=color, **bar_kw)
            if body.show_values:
                ax.bar_label(bars, fmt="%.3g", padding=2, fontsize=8)
        ax.set_xticks([x + 0.4 - width / 2 for x in xs] if len(body.series) > 1 else xs)
        ax.set_xticklabels(cats)
    elif body.type == "scatter":
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            marker = _GRAY_MARKERS[i % len(_GRAY_MARKERS)] if body.palette == "grayscale" else "o"
            ax.scatter(xs, s.values, label=s.name, color=color, marker=marker)
            if body.show_values:
                for x, y in zip(xs, s.values):
                    ax.annotate(f"{y:g}", (x, y), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=8)
        ax.set_xticks(xs)
        ax.set_xticklabels(cats)
    else:  # line
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            ls = _GRAY_LINESTYLES[i % len(_GRAY_LINESTYLES)] if body.palette == "grayscale" else "-"
            marker = _GRAY_MARKERS[i % len(_GRAY_MARKERS)] if body.palette == "grayscale" else "o"
            if s.errors:
                ax.errorbar(
                    xs,
                    s.values,
                    yerr=s.errors,
                    marker=marker,
                    linestyle=ls,
                    linewidth=1.6,
                    capsize=3,
                    elinewidth=1.0,
                    label=s.name,
                    color=color,
                )
            else:
                ax.plot(xs, s.values, marker=marker, linestyle=ls, linewidth=1.6, label=s.name, color=color)
            if body.show_values:
                for x, y in zip(xs, s.values):
                    ax.annotate(f"{y:g}", (x, y), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=8)
        ax.set_xticks(xs)
        ax.set_xticklabels(cats)

    if body.type not in ("pie", "heatmap", "radar"):
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
    if body.title:
        ax.set_title(body.title, pad=14 if body.type == "radar" else None)
    if body.x_label and body.type not in ("radar",):
        ax.set_xlabel(body.x_label)
    if body.y_label and body.type not in ("radar",):
        ax.set_ylabel(body.y_label)
    if body.type not in ("pie", "heatmap", "boxplot", "violin") and len(body.series) > 1:
        ax.legend(fontsize=9, frameon=False)
    if body.type not in ("pie", "heatmap", "radar"):
        axis_dir = "x" if body.type in ("forest", "grouped_bar") else "y"
        ax.grid(axis=axis_dir, linestyle="--", alpha=0.35)

    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format=fmt, dpi=effective_dpi)
    return buf.getvalue()


def render_png(body: ChartIn) -> bytes:
    return render_chart(body, fmt="png", dpi=body.dpi)


def _png_ihdr_size(png: bytes) -> tuple[int, int]:
    """PNG 尺寸直接取 IHDR（Agg 输出恒为 PNG），避免引入 PIL 依赖。"""
    if png[:8] != b"\x89PNG\r\n\x1a\n" or len(png) < 24:
        raise ValueError("渲染产物不是合法 PNG")
    return int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")


@router.post("/render")
async def render(body: ChartIn, user: CurrentUser) -> dict:
    """数据 → PNG data URL（仅登录门槛；无项目状态）。插件用 AddImage 插入或直接下载。

    width_px/height_px/sha256 一并由服务端给出：插件的运行环境常是 HTTP 内网页面
    （非安全上下文），没有 crypto.subtle，无法在前端自行计算摘要。"""
    if config.AUTH_ON and user is None:
        from app.auth import login_required

        raise login_required()
    png = render_png(body)
    width_px, height_px = _png_ihdr_size(png)
    return {
        "data_url": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "bytes": len(png),
        "width_px": width_px,
        "height_px": height_px,
        "sha256": hashlib.sha256(png).hexdigest(),
    }


@router.post("/from-image", dependencies=[Depends(auth.require_login), Depends(require_org_ai)])
async def chart_from_image(
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    hint: Annotated[str, Form()] = "",
) -> dict:
    """借助多模态 Vision 模型从科研图表/实验表格截图中还原结构化 ChartIn 数据。"""
    fname = (file.filename or "").lower()
    ext = os.path.splitext(fname)[1]
    base_ct = (file.content_type or "").split(";", 1)[0].strip().lower()
    if base_ct and base_ct not in ("application/octet-stream", "image/png", "image/jpeg", "image/jpg", "image/webp"):
        await file.close()
        raise HTTPException(422, error_detail("validation", "仅支持 PNG / JPG / WebP 图表或表格截图"))
    if ext and ext not in _VISION_MIMES:
        await file.close()
        raise HTTPException(422, error_detail("validation", "仅支持 PNG / JPG / WebP 图表或表格截图"))
    try:
        raw = await file.read(_VISION_MAX_BYTES + 1)
    finally:
        await file.close()
    if len(raw) > _VISION_MAX_BYTES:
        raise HTTPException(413, error_detail("file", "图片过大（上限 8 MB）"))
    if not raw:
        raise HTTPException(422, error_detail("validation", "上传的图片为空"))
    mime = _detect_image_mime(raw)
    if not mime:
        raise HTTPException(422, error_detail("validation", "图片文件内容无效，仅支持合法 PNG / JPG / WebP"))

    client, _provider = user_ai.resolve_ai_client(user)
    b64 = base64.b64encode(raw).decode("ascii")
    allowed = "/".join(CHART_TYPES)
    sys_msg = (
        "[paper-studio:charts] 你是科研数据提取助手。"
        "请仔细读取上传图片中的图表或数据表格，提取类别、系列名与真实数值，严格输出单个 JSON 对象，"
        '结构为 {"type": "bar", "title": "...", "x_label": "...", "y_label": "...", '
        '"categories": ["A", "B"], "series": [{"name": "Baseline", "values": [1.0, 2.0]}]}。'
        f"type 必须是 {allowed} 之一；所有系列 values 长度须等于 categories 长度；禁止编造图像中不存在的数据。"
    )
    user_text = f"补充要求：{hint.strip()[:300]}" if hint.strip() else "请识别并提取图中数据为标准 Chart JSON。"
    messages = [
        {"role": "system", "content": sys_msg},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        },
    ]
    try:
        res = await client.chat(messages, "interactive", max_tokens=2048, temperature=0.1)
    except ai_client.AiError as exc:
        raise HTTPException(exc.status or 502, error_detail(exc.kind, str(exc))) from exc

    try:
        parsed = ai_client.parse_json(res.text, {"required": ["categories", "series"]})
        if parsed.get("type") not in CHART_TYPES:
            parsed["type"] = "bar"
        for txt_k in ("title", "x_label", "y_label"):
            if parsed.get(txt_k) is None:
                parsed[txt_k] = ""
            elif not isinstance(parsed.get(txt_k), str):
                parsed[txt_k] = str(parsed[txt_k])
        if isinstance(parsed.get("categories"), list):
            parsed["categories"] = ["" if c is None else str(c) for c in parsed["categories"]]
        if isinstance(parsed.get("series"), list):
            norm_series = []
            for s in parsed["series"]:
                if isinstance(s, dict):
                    s_copy = dict(s)
                    if s_copy.get("name") is not None and not isinstance(s_copy.get("name"), str):
                        s_copy["name"] = str(s_copy["name"])
                    norm_series.append(s_copy)
                else:
                    norm_series.append(s)
            parsed["series"] = norm_series
        validated = ChartIn.model_validate(parsed)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(502, error_detail("format", f"图片识别结果未能通过数据结构校验：{exc}")) from exc

    return {"chart": validated.model_dump(mode="json"), "model": res.model}
