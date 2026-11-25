# -*- coding: utf-8 -*-
"""科研图表 v1：把结构化数据渲染为 PNG（matplotlib Agg），返回 data URL 供 ONLYOFFICE 插件插入文档。

无项目状态、无盘写入：纯函数式渲染 + 登录门槛。中文字体优先取容器内挂载/自带字体。
"""
from __future__ import annotations

import base64
import hashlib
import io
import os
from pathlib import Path
from typing import Literal

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from fastapi import APIRouter  # noqa: E402
from pydantic import BaseModel, Field, field_validator, model_validator  # noqa: E402

from app import config  # noqa: E402
from app.auth import CurrentUser  # noqa: E402

router = APIRouter(prefix="/api/charts", tags=["charts"])

CHART_TYPES = ("line", "bar", "scatter", "pie")
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
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


class SeriesIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    values: list[float] = Field(max_length=MAX_POINTS)


class ChartIn(BaseModel):
    type: str
    title: str = Field(default="", max_length=120)
    x_label: str = Field(default="", max_length=80)
    y_label: str = Field(default="", max_length=80)
    categories: list[str] = Field(min_length=1, max_length=MAX_CATEGORIES)
    series: list[SeriesIn] = Field(min_length=1, max_length=MAX_SERIES)
    palette: PaletteName = "default"
    dpi: int = Field(default=140, ge=72, le=600)

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
    from matplotlib import font_manager

    font_path = _cjk_font()
    if font_path:
        font_manager.fontManager.addfont(font_path)
        family = font_manager.FontProperties(fname=font_path).get_name()
        plt.rcParams["font.sans-serif"] = [family, "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    plt.rcParams["pdf.fonttype"] = 42
    plt.rcParams["ps.fonttype"] = 42

    effective_dpi = dpi if dpi is not None else body.dpi
    colors = PALETTES.get(body.palette)
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=effective_dpi)
    cats = body.categories
    xs = list(range(len(cats)))
    if body.type == "pie":
        pie_colors = list(colors[: len(cats)]) if colors else None
        ax.pie(body.series[0].values, labels=cats, autopct="%1.1f%%", startangle=90, colors=pie_colors)
        ax.axis("equal")
    elif body.type == "bar":
        width = 0.8 / len(body.series)
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            ax.bar([x + i * width for x in xs], s.values, width=width, label=s.name, color=color)
        ax.set_xticks([x + 0.4 - width / 2 for x in xs] if len(body.series) > 1 else xs)
        ax.set_xticklabels(cats)
    elif body.type == "scatter":
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            marker = _GRAY_MARKERS[i % len(_GRAY_MARKERS)] if body.palette == "grayscale" else "o"
            ax.scatter(xs, s.values, label=s.name, color=color, marker=marker)
        ax.set_xticks(xs)
        ax.set_xticklabels(cats)
    else:  # line
        for i, s in enumerate(body.series):
            color = colors[i % len(colors)] if colors else None
            ls = _GRAY_LINESTYLES[i % len(_GRAY_LINESTYLES)] if body.palette == "grayscale" else "-"
            marker = _GRAY_MARKERS[i % len(_GRAY_MARKERS)] if body.palette == "grayscale" else "o"
            ax.plot(xs, s.values, marker=marker, linestyle=ls, linewidth=1.6, label=s.name, color=color)
        ax.set_xticks(xs)
        ax.set_xticklabels(cats)

    if body.type != "pie":
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
    if body.title:
        ax.set_title(body.title)
    if body.x_label:
        ax.set_xlabel(body.x_label)
    if body.y_label:
        ax.set_ylabel(body.y_label)
    if body.type != "pie" and len(body.series) > 1:
        ax.legend(fontsize=9, frameon=False)
    ax.grid(axis="y", linestyle="--", alpha=0.35)

    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format=fmt, dpi=effective_dpi)
    plt.close(fig)
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
