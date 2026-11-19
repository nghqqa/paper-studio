# -*- coding: utf-8 -*-
"""Word(.docx) → LaTeX 导入（v0.6.8）：转换桩（rc/产物可控）+ 真转换集成（本机有 pandoc/docker 才跑）。"""
import os
import zipfile

import pytest

from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    monkeypatch.setenv("PATENT_STUDIO_DOCX_EXPORT_RUNTIME", "local")
    import importlib

    from app import config, main
    from app.domain import build, xml_export
    from app.domain import latex_build as latex_build_mod
    from app.domain import latex_files as latex_files_mod
    from app.domain import latex_issues as latex_issues_mod
    from app.domain import latex_import as latex_import_mod
    from app.domain import latex_import_docx as latex_import_docx_mod
    from app.domain import projects as projects_mod
    from app.routes import latex as latex_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(build)
    importlib.reload(latex_build_mod)
    importlib.reload(latex_files_mod)
    importlib.reload(latex_issues_mod)
    importlib.reload(latex_import_mod)
    importlib.reload(latex_import_docx_mod)
    importlib.reload(xml_export)
    importlib.reload(latex_routes)
    importlib.reload(main)
    return TestClient(main.app), projects, latex_import_docx_mod


def _docx(text: str) -> bytes:
    buf = __import__("io").BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
        z.writestr("word/document.xml",
                   '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   f"<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>")
    return buf.getvalue()


def test_docx_rejects_non_docx_and_oversize(client):
    c, _projects, _dx = client
    r = c.post("/api/projects/latex/import-docx/upload",
               files={"file": ("x.zip", b"PK", "application/zip")})
    assert r.status_code == 415
    r = c.post("/api/projects/latex/import-docx/upload",
               files={"file": ("big.docx", b"0" * (25 * 1024 * 1024 + 1), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
    assert r.status_code == 413


def test_docx_stage_and_create_flow(client, monkeypatch):
    c, projects, dx = client
    monkeypatch.setattr(dx.shutil, "which", lambda name: "/usr/bin/pandoc")  # 本机无 pandoc：过 which 闸
    # 转换桩：中文正文 → cjk=True；产出 main.tex + media 图片
    def fake_pandoc(stage, src_name, cjk):
        with open(os.path.join(stage, "main.tex"), "w", encoding="utf-8") as f:
            f.write("\\documentclass{ctexart}\n\\begin{document}\n你好 \\(x^2\\)\n\\end{document}\n")
        os.makedirs(os.path.join(stage, "media"), exist_ok=True)
        with open(os.path.join(stage, "media", "image1.png"), "wb") as f:
            f.write(b"\x89PNG")
        return 0, ""

    monkeypatch.setattr(dx, "_run_pandoc", fake_pandoc)
    r = c.post("/api/projects/latex/import-docx/upload",
               files={"file": ("论文.docx", _docx("你好世界"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["cjk"] is True and meta["engine"] == "xelatex"
    assert meta["main_candidates"] == ["main.tex"]
    paths = {f["path"] for f in meta["files"]}
    assert {"main.tex", "media/image1.png"} <= paths
    assert any("人工核对" in w for w in meta["warnings"])
    # 第二段：创建（引擎缺省用建议值 xelatex）
    r = c.post("/api/projects/latex/import-docx/create",
               json={"token": meta["token"], "title": "存量论文"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert r.json()["latex"] == {"main": "main.tex", "engine": "xelatex"}
    assert (projects / pid / "main.tex").is_file()
    assert (projects / pid / "media" / "image1.png").is_file()
    # 令牌已消费（复用 404）
    r = c.post("/api/projects/latex/import-docx/create", json={"token": meta["token"], "engine": "pdflatex"})
    assert r.status_code == 404


def test_docx_conversion_failure_rejected(client, monkeypatch):
    c, _projects, dx = client
    monkeypatch.setattr(dx.shutil, "which", lambda name: "/usr/bin/pandoc")
    monkeypatch.setattr(dx, "_run_pandoc", lambda stage, src, cjk: (1, "panic: bad docx"))
    r = c.post("/api/projects/latex/import-docx/upload",
               files={"file": ("bad.docx", _docx("x"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
    assert r.status_code == 422
    assert "转换失败" in r.json()["detail"]["message"]


def test_docx_create_engine_whitelist(client, monkeypatch):
    c, _projects, dx = client
    monkeypatch.setattr(dx.shutil, "which", lambda name: "/usr/bin/pandoc")
    monkeypatch.setattr(dx, "_run_pandoc", lambda stage, src, cjk: _write_empty(stage))
    r = c.post("/api/projects/latex/import-docx/upload",
               files={"file": ("a.docx", _docx("hello"), "text/plain")})
    assert r.status_code == 200
    r = c.post("/api/projects/latex/import-docx/create",
               json={"token": r.json()["token"], "engine": "lualatex"})
    assert r.status_code == 422


def _write_empty(stage):
    with open(os.path.join(stage, "main.tex"), "w", encoding="utf-8") as f:
        f.write("\\documentclass{article}\n")
    return 0, ""


@pytest.mark.skipif(not __import__("shutil").which("pandoc"),
                    reason="需要本机 pandoc（local runtime 真转换集成）")
def test_docx_real_conversion_integration(client, tmp_path):
    """真 pandoc 转换：中文 docx → ctexart main.tex（编译验证留给工作台链路）。"""
    c, _projects, dx = client
    r = c.post("/api/projects/latex/import-docx/upload",
               files={"file": ("cn.docx", _docx("这是一篇中文论文的正文。"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["cjk"] is True
    tex = open(os.path.join(_stage_dir(meta["token"]), "main.tex"), encoding="utf-8").read()
    assert "ctexart" in tex


def _stage_dir(token: str) -> str:
    from app.domain.latex_import import STAGING_DIR

    return os.path.join(STAGING_DIR, token)
