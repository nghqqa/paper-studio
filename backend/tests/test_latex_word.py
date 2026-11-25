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
    from app.domain import docx_export as docx_export_mod
    from app.domain import latex_build as latex_build_mod
    from app.domain import latex_files as latex_files_mod
    from app.domain import latex_issues as latex_issues_mod
    from app.domain import latex_word as latex_word_mod
    from app.domain import projects as projects_mod
    from app.routes import latex as latex_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(latex_build_mod)
    importlib.reload(latex_files_mod)
    importlib.reload(latex_issues_mod)
    importlib.reload(docx_export_mod)
    importlib.reload(latex_word_mod)
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
    # 清单可列，stale=False（源码未动），且包含 artifacts
    r = c.get(f"/api/projects/{pid}/latex/word-exports")
    assert r.status_code == 200
    listed = r.json()["exports"][0]
    assert listed["stale"] is False
    assert listed["artifacts"]["paper.docx"] == "paper.docx"


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


def test_export_word_profiles_and_pandoc_args(client, monkeypatch):
    """验证默认 academic 单栏与 jcip 双栏的 pandoc 参数、语言检测、参考文献标题与自动 equation 编号预处理。"""
    import os

    c, projects, lw, config = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    c.post(f"/api/projects/{pid}/latex/upload",
           data={"rel": "refs.bib"}, files={"file": ("refs.bib", "@misc{x, title={t}}", "text/x-bibtex")})
    # 写入中文 LaTeX（含无 \label 的 equation 与带 \nonumber 的 equation）
    files = c.get(f"/api/projects/{pid}/latex/files").json()["files"]
    main_rel = next(f["path"] for f in files if f["path"].endswith(".tex"))
    zh_tex = (
        "\\documentclass{article}\n\\usepackage{ctex}\n\\begin{document}\n"
        "\\begin{abstract}中文摘要内容。\\end{abstract}\n"
        "\\section{引言}\n"
        "\\begin{equation}\nx = y + 1\n\\end{equation}\n"
        "\\begin{equation}\na = b \\nonumber\n\\end{equation}\n"
        "\\cite{x}\n\\bibliography{refs}\n\\end{document}\n"
    )
    assert c.put(f"/api/projects/{pid}/latex/files/{main_rel}", json={"content": zh_tex}).status_code == 200

    captured = []

    def spy_run_task(cmd, cwd, timeout_s, log_file=None, env=None, on_proc=None):
        src_tex = open(os.path.join(cwd, main_rel), encoding="utf-8").read()
        captured.append({"cmd": list(cmd), "env": dict(env or {}), "src_tex": src_tex})
        return _fake_pandoc_ok()(cmd, cwd, timeout_s, log_file=log_file, env=env, on_proc=on_proc)

    monkeypatch.setattr(lw.task_runner, "run_task", spy_run_task)
    monkeypatch.setattr(lw.shutil, "which", lambda name: "/usr/bin/pandoc")

    # 1) 默认 academic 单栏
    m1 = c.post(f"/api/projects/{pid}/latex/export-word").json()
    assert m1["status"] == "pass", m1["degrades"]
    assert m1["profile"] == "academic"
    assert m1["lang"] == "zh"
    c1 = captured[-1]
    assert any("academic-reference.docx" in a for a in c1["cmd"])
    assert any("gb7714-2015-numeric.csl" in a for a in c1["cmd"])
    assert "reference-section-title=参考文献" in c1["cmd"]
    assert any("numbering.lua" in a for a in c1["cmd"])
    assert not any("layout.lua" in a for a in c1["cmd"])
    assert c1["env"]["PANDOC_NUMBERING_SOFT"] == "1"
    assert c1["env"]["PANDOC_DOC_LANG"] == "zh"
    assert "\\label{__auto_eq_1__}" in c1["src_tex"]
    assert "__auto_eq_2__" not in c1["src_tex"]  # 带 \nonumber 不注入

    # 2) 指定 jcip 双栏
    m2 = c.post(f"/api/projects/{pid}/latex/export-word", json={"profile": "jcip"}).json()
    assert m2["status"] == "pass", m2["degrades"]
    assert m2["profile"] == "jcip"
    c2 = captured[-1]
    assert any("jcip-reference.docx" in a for a in c2["cmd"])
    assert any("layout.lua" in a for a in c2["cmd"])

    # 3) thesis 学位论文 profile + align 多行公式拆行 + 按章编号
    m3 = c.post(f"/api/projects/{pid}/latex/export-word", json={"profile": "thesis"}).json()
    assert m3["status"] == "pass", m3["degrades"]
    assert m3["profile"] == "thesis"
    c3 = captured[-1]
    assert "--top-level-division" in c3["cmd"] and "chapter" in c3["cmd"]
    assert c3["env"]["PANDOC_CHAPTER_NUMBERING"] == "1"

    # 4) 非法 profile 返回 400
    r_bad = c.post(f"/api/projects/{pid}/latex/export-word", json={"profile": "unknown"})
    assert r_bad.status_code == 400


def test_preprocess_splits_align_multiline(tmp_path):
    """验证 align 多行多编号拆分（保留 cases 内部换行、支持 \\nonumber、保留 \\label 与自动补标签）。"""
    from app.domain import docx_post

    tex = (
        "\\begin{align}\n"
        "  a &= b \\label{eq:a} \\\\\n"
        "  c &= \\begin{cases} 1 \\\\ 2 \\end{cases} \\nonumber \\\\\n"
        "  d &= e\n"
        "\\end{align}\n"
    )
    f = tmp_path / "main.tex"
    f.write_text(tex, encoding="utf-8")
    n = docx_post.preprocess_tex_for_pandoc(str(tmp_path), split_multiline=True)
    out = f.read_text(encoding="utf-8")
    assert n == 1  # 仅第 3 行无 label 且无 nonumber，注入 __auto_eq_1__
    assert "\\begin{equation}\na = b \\label{eq:a}\n\\end{equation}" in out
    assert "\\begin{equation*}\nc = \\begin{cases} 1 \\\\ 2 \\end{cases}\n\\end{equation*}" in out
    assert "\\label{__auto_eq_1__}" in out
    assert "\\begin{align}" not in out


def test_docx_post_native_polish_and_eq_layout(tmp_path):
    """验证摘要汉化、题区空段清理、以及单/双栏下公式居中+编号靠右制表位计算。"""
    import lxml.etree as ET
    from app.domain import docx_post

    NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    NS_M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
    doc_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{NS_W}" xmlns:m="{NS_M}"><w:body>'
        f'<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>测试论文</w:t></w:r></w:p>'
        f'<w:p/>'
        f'<w:p><w:pPr><w:pStyle w:val="AbstractTitle"/></w:pPr><w:r><w:t>Abstract</w:t></w:r></w:p>'
        f'<w:p><m:oMathPara><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath></m:oMathPara>'
        f'<w:r><w:t>(2-1)</w:t></w:r></w:p>'
        f'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        f'<w:pgMar w:left="1587" w:right="1587" w:top="1440" w:bottom="1440"/></w:sectPr>'
        f'</w:body></w:document>'
    )
    p = tmp_path / "sample.docx"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", doc_xml)
        z.writestr("[Content_Types].xml", MINIMAL_DOCX["[Content_Types].xml"])

    n = docx_post.apply_eq_layout(str(p), mode="tab")
    assert n == 1
    docx_post.apply_meta_layout(str(p), lang="zh")
    docx_post.polish_docx_native(str(p), lang="zh")

    with zipfile.ZipFile(p) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    W = f"{{{NS_W}}}"
    M = f"{{{NS_M}}}"
    paras = root.findall(f"{W}body/{W}p")
    # 题区空白段落已被清理：剩下 Title + AbstractTitle + 公式段 = 3 段
    assert len(paras) == 3
    all_text = "".join(t.text or "" for t in root.iter(f"{W}t"))
    assert "摘要" in all_text and "Abstract" not in all_text
    # 公式段已转内联 oMath + 居中/右对齐制表位 + 清除首行缩进
    eq_p = paras[2]
    assert eq_p.find(f"{M}oMath") is not None
    assert eq_p.find(f"{M}oMathPara") is None
    tabs = eq_p.findall(f"{W}pPr/{W}tabs/{W}tab")
    assert {t.get(f"{W}val") for t in tabs} == {"center", "right"}
    ind = eq_p.find(f"{W}pPr/{W}ind")
    assert ind is not None and ind.get(f"{W}firstLine") == "0"
