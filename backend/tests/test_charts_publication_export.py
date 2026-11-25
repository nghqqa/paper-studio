# -*- coding: utf-8 -*-
"""回归测试：科研图表出版级高 DPI PNG、矢量 PDF/SVG 导出与学术配色。"""
from __future__ import annotations

import importlib
import json
import sys

import pytest
from fastapi.testclient import TestClient

from app.routes.charts import ChartIn, _png_ihdr_size, render_chart


def test_render_chart_dpi_scaling_palettes_and_vector_formats():
    base_kwargs = dict(
        type="line",
        title="Model Accuracy",
        x_label="Epoch",
        y_label="Score (%)",
        categories=["1", "2", "3"],
        series=[
            {"name": "Baseline", "values": [80.0, 82.0, 84.0]},
            {"name": "Ours", "values": [85.0, 89.0, 92.0]},
        ],
    )
    png140 = render_chart(ChartIn(**base_kwargs, palette="academic", dpi=140), fmt="png")
    png300 = render_chart(ChartIn(**base_kwargs, palette="colorblind", dpi=300), fmt="png")
    w140, h140 = _png_ihdr_size(png140)
    w300, h300 = _png_ihdr_size(png300)
    assert w300 > w140 * 2 and h300 > h140 * 2

    pdf_bytes = render_chart(ChartIn(**base_kwargs, palette="grayscale"), fmt="pdf", dpi=300)
    assert pdf_bytes.startswith(b"%PDF-")

    svg_bytes = render_chart(ChartIn(**base_kwargs, palette="academic"), fmt="svg")
    assert b"<svg" in svg_bytes


@pytest.fixture()
def fig_client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    pdir = projects / "paper1"
    pdir.mkdir()
    (pdir / "studio.json").write_text(
        json.dumps({"document_type": "paper", "source_format": "latex", "title": "图表论文"}, ensure_ascii=False),
        encoding="utf-8",
    )
    monkeypatch.setenv("PAPER_STUDIO_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("PAPER_STUDIO_AUTH", "off")

    saved = {k: m for k, m in sys.modules.items() if k == "app" or k.startswith("app.")}
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    try:
        import app.main as main_mod

        importlib.reload(main_mod)
        yield TestClient(main_mod.app)
    finally:
        for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
            del sys.modules[k]
        sys.modules.update(saved)


def test_project_figure_export_endpoints(fig_client: TestClient):
    r_create = fig_client.post(
        "/api/project-figures/paper1",
        json={
            "name": "消融对比",
            "type": "bar",
            "title": "Ablation",
            "x_label": "Setting",
            "y_label": "F1",
            "categories": ["A", "B"],
            "series": [{"name": "Ours", "values": [88.5, 91.2]}],
            "palette": "colorblind",
        },
    )
    assert r_create.status_code == 200, r_create.text
    fid = r_create.json()["figure"]["id"]
    assert r_create.json()["figure"]["palette"] == "colorblind"

    r_pdf = fig_client.get(f"/api/project-figures/paper1/{fid}/export?format=pdf&dpi=300")
    assert r_pdf.status_code == 200
    assert r_pdf.headers["content-type"].startswith("application/pdf")
    assert r_pdf.content.startswith(b"%PDF-")

    r_svg = fig_client.get(f"/api/project-figures/paper1/{fid}/export?format=svg")
    assert r_svg.status_code == 200
    assert "image/svg+xml" in r_svg.headers["content-type"]
    assert b"<svg" in r_svg.content

    r_png600 = fig_client.get(f"/api/project-figures/paper1/{fid}/export?format=png&dpi=600")
    assert r_png600.status_code == 200
    w, _ = _png_ihdr_size(r_png600.content)
    assert w >= 4000
