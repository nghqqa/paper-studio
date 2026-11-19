# -*- coding: utf-8 -*-
"""LaTeX→Word 通用导出（v0.6.7）：桩 pandoc 产最小真 docx，验证快照/manifest/降级语义/产物端点。"""
import io
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
    from app.domain import latex_word as latex_word_mod
    from app.domain import docx_export as docx_export_mod
    from app.domain import projects as projects_mod
    from app.routes import latex as latex_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(build)
    importlib.reload(latex_build_mod)
    importlib.reload(latex_files_mod)
    importlib.reload(latex_issues_mod)
    importlib.reload(docx_export_mod)
    importlib.reload(latex_word_mod)
    importlib.reload(xml_export)
    importlib.reload(latex_routes)
    importlib.reload(main)
    return TestClient(main.app), projects, latex_word_mod, config


MINIMAL_DOCX = {
    "word/document.xml": (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>Hello Word</w:t></w:r></w:p></w:body></w:document>"
    ),
    "[Content_Types].xml": (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="xml" ContentType="application/xml"/></Types>'
    ),
}


def _fake_pandoc_ok(runner_field="run_task"):
    """桩 run_task：在 cwd 的上级写出最小 docx（local runtime 里 --output=../paper.docx）。"""

    def fake_run_task(cmd, cwd, timeout_s, log_file=None, env=None, on_proc=None):
        out = cmd[cmd.index("--output") + 1]
        target = out if out.startswith("/") else __import__("os").path.normpath(__import__("os").path.join(cwd, out))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for n, data in MINIMAL_DOCX.items():
                z.writestr(n, data)
        with open(target, "wb") as f:
            f.write(buf.getvalue())
        return 0

    return fake_run_task


def test_export_word_pass_and_download(client, monkeypatch):
    c, projects, lw, config = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    # 种子正文有 \cite：补一个 .bib（通用导出有 bib 才走 citeproc，无则如实降级）
    c.post(f"/api/projects/{pid}/latex/upload",
           data={"rel": "refs.bib"}, files={"file": ("refs.bib", "@misc{x, title={t}}", "text/x-bibtex")})
    monkeypatch.setattr(lw.task_runner, "run_task", _fake_pandoc_ok())
    monkeypatch.setattr(lw.shutil, "which", lambda name: "/usr/bin/pandoc")
    r = c.post(f"/api/projects/{pid}/latex/export-word")
    assert r.status_code == 200, r.text
    m = r.json()
    assert m["status"] == "pass", m["degrades"]
    assert m["artifacts"]["paper.docx"] == "paper.docx"
    # 产物可下载且为 zip（docx 容器）
    r = c.get(f"/api/projects/{pid}/latex/word-exports/{m['export_id']}/artifacts/paper.docx")
    assert r.status_code == 200
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == list(MINIMAL_DOCX)
    # 清单可列，stale=False（源码未动）
    r = c.get(f"/api/projects/{pid}/latex/word-exports")
    assert r.status_code == 200 and r.json()["exports"][0]["stale"] is False


def test_export_word_no_bib_degrades(client, monkeypatch):
    """种子带 \\cite 但工程无 .bib ⇒ degraded（如实提示，不静默）。"""
    c, projects, lw, config = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    monkeypatch.setattr(lw.task_runner, "run_task", _fake_pandoc_ok())
    monkeypatch.setattr(lw.shutil, "which", lambda name: "/usr/bin/pandoc")
    m = c.post(f"/api/projects/{pid}/latex/export-word").json()
    assert m["status"] == "degraded"
    assert any("无 .bib" in d for d in m["degrades"])


def test_export_word_degrades_on_latex_residue(client, monkeypatch):
    c, projects, lw, config = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    monkeypatch.setattr(lw.task_runner, "run_task", _fake_pandoc_ok())
    monkeypatch.setattr(lw.shutil, "which", lambda name: "/usr/bin/pandoc")
    # document.xml 带 LaTeX 残留词元（_analyze_docx 词表）⇒ degraded（产物仍可下载）
    bad = dict(MINIMAL_DOCX)
    bad["word/document.xml"] = bad["word/document.xml"].replace(
        "Hello Word", "Hello \\begin{center}Word")
    import io as _io

    def fake(cmd, cwd, timeout_s, log_file=None, env=None, on_proc=None):
        import os

        out = cmd[cmd.index("--output") + 1]
        target = out if out.startswith("/") else os.path.normpath(os.path.join(cwd, out))
        buf = _io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for n, data in bad.items():
                z.writestr(n, data)
        with open(target, "wb") as f:
            f.write(buf.getvalue())
        return 0

    monkeypatch.setattr(lw.task_runner, "run_task", fake)
    m = c.post(f"/api/projects/{pid}/latex/export-word").json()
    assert m["status"] == "degraded"
    assert any("LaTeX 残留" in d for d in m["degrades"])


def test_export_word_blocked_on_pandoc_failure(client, monkeypatch):
    c, projects, lw, config = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    monkeypatch.setattr(lw.task_runner, "run_task", lambda *a, **k: 1)  # pandoc 退出码 1
    monkeypatch.setattr(lw.shutil, "which", lambda name: "/usr/bin/pandoc")
    m = c.post(f"/api/projects/{pid}/latex/export-word").json()
    assert m["status"] == "blocked"
    assert "paper.docx" not in m["artifacts"]  # blocked 不得留下可下载产物（manifest 留作诊断）
    # 产物端点 404
    r = c.get(f"/api/projects/{pid}/latex/word-exports/{m['export_id']}/artifacts/paper.docx")
    assert r.status_code == 404


def test_export_word_pandoc_missing_503(client, monkeypatch):
    c, projects, lw, config = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    monkeypatch.setattr(lw.shutil, "which", lambda name: None)
    r = c.post(f"/api/projects/{pid}/latex/export-word")
    assert r.status_code == 503


def test_export_word_unknown_engine_source_guard(client):
    c, projects, lw, config = client
    c.post("/api/projects", json={"id": "pat-w1", "title": "专利案"})
    assert c.post("/api/projects/pat-w1/latex/export-word").status_code == 400
