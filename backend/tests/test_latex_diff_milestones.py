# -*- coding: utf-8 -*-
"""回归测试：LaTeX 命名里程碑（milestones）与 latexdiff 期刊返修高亮 PDF 管线。"""
from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PAPER_STUDIO_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("PAPER_STUDIO_AUTH", "off")

    saved = {k: m for k, m in sys.modules.items() if k == "app" or k.startswith("app.")}
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]

    try:
        import app.main as main_mod

        importlib.reload(main_mod)
        c = TestClient(main_mod.app)
        yield c, projects
    finally:
        for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
            del sys.modules[k]
        sys.modules.update(saved)


def _seed_latex_project(projects_dir, pid: str = "diff-paper"):
    pdir = projects_dir / pid
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "studio.json").write_text(
        json.dumps(
            {
                "document_type": "paper",
                "source_format": "latex",
                "title": "返修对比论文",
                "latex": {"main": "main.tex", "engine": "xelatex"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (pdir / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nFirst submission text.\n\\end{document}\n",
        encoding="utf-8",
    )
    return pdir


def test_milestones_lifecycle_and_log_attachment(client):
    c, projects = client
    _seed_latex_project(projects)

    # 工作区有初始文件时，标记里程碑会自动创建首次快照并打标
    r1 = c.post("/api/projects/diff-paper/latex/history/milestones", json={"name": "初稿投稿"})
    assert r1.status_code == 201, r1.text
    m1 = r1.json()
    assert m1["name"] == "初稿投稿"
    assert len(m1["sha"]) == 40

    # 重名冲突 409
    r_dup = c.post("/api/projects/diff-paper/latex/history/milestones", json={"name": "初稿投稿"})
    assert r_dup.status_code == 409

    # 历史列表展示 milestones 标签
    hist = c.get("/api/projects/diff-paper/latex/history").json()
    assert len(hist) == 1
    assert hist[0]["milestones"] == ["初稿投稿"]

    # 工作区干净时仍可针对指定 sha 或 HEAD 标记第二个里程碑，且可删除
    r2 = c.post("/api/projects/diff-paper/latex/history/milestones", json={"name": "v1.0", "sha": m1["sha"]})
    assert r2.status_code == 201
    hist2 = c.get("/api/projects/diff-paper/latex/history").json()
    assert set(hist2[0]["milestones"]) == {"初稿投稿", "v1.0"}

    assert c.delete("/api/projects/diff-paper/latex/history/milestones/v1.0").status_code == 200
    assert c.delete("/api/projects/diff-paper/latex/history/milestones/v1.0").status_code == 404


def test_latexdiff_missing_503_and_mocked_pdf_pipeline(client, monkeypatch):
    c, projects = client
    pdir = _seed_latex_project(projects)

    # 1. 创建初始里程碑，随后修改工作区
    m1 = c.post("/api/projects/diff-paper/latex/history/milestones", json={"name": "R0 初稿"}).json()
    (pdir / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nRevised manuscript text.\n\\end{document}\n",
        encoding="utf-8",
    )

    from app.domain import latex_diff, task_runner

    # 2. latexdiff 缺失时 GET available=False 且 POST 返回 503 友好提示
    monkeypatch.setattr(latex_diff, "_latexdiff_bin", lambda: None)
    r_list0 = c.get("/api/projects/diff-paper/latex/diffs")
    assert r_list0.status_code == 200
    assert r_list0.json() == {"available": False, "items": []}

    r_missing = c.post("/api/projects/diff-paper/latex/diffs", json={"base_sha": m1["sha"]})
    assert r_missing.status_code == 503
    assert "latexdiff" in r_missing.json()["detail"]

    # 3. 相同版本禁止对比（422）
    monkeypatch.setattr(latex_diff, "_latexdiff_bin", lambda: "latexdiff")
    r_same = c.post("/api/projects/diff-paper/latex/diffs", json={"base_sha": m1["sha"], "target_sha": m1["sha"]})
    assert r_same.status_code == 422

    # 4. Mock latexdiff subprocess.run + latexmk run_task 验证完整产物链
    real_run = subprocess.run

    def fake_run(cmd, *args, cwd=None, stdout=None, stderr=None, **kwargs):
        if cmd and cmd[0] == "latexdiff":
            assert "--flatten" in cmd
            old_txt = os.path.join(cwd, cmd[-2])
            new_txt = os.path.join(cwd, cmd[-1])
            assert os.path.isfile(old_txt) and os.path.isfile(new_txt)
            stdout.write(b"\\documentclass{article}\\begin{document}DIFF_MARKUP\\end{document}\n")
            return subprocess.CompletedProcess(cmd, 0)
        return real_run(cmd, *args, cwd=cwd, stdout=stdout, stderr=stderr, **kwargs)

    def fake_task(cmd, cwd, timeout_s, log_file=None, env=None, on_proc=None):
        with open(os.path.join(cwd, "main.pdf"), "wb") as f:
            f.write(b"%PDF-1.4\n%MockDiffPdf\n")
        if log_file:
            with open(log_file, "w", encoding="utf-8") as lf:
                lf.write("latexmk mock ok\n")
        return 0

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(task_runner, "run_task", fake_task)

    r_gen = c.post("/api/projects/diff-paper/latex/diffs", json={"base_sha": m1["sha"]})
    assert r_gen.status_code == 200, r_gen.text
    manifest = r_gen.json()
    assert manifest["status"] == "ok"
    assert "R0 初稿" in manifest["base_label"]
    assert manifest["target_label"] == "当前工作区"
    assert manifest["pdf_url"].endswith(f"/diffs/{manifest['diff_id']}/pdf")

    # 列表返回刚生成的 diff
    r_list1 = c.get("/api/projects/diff-paper/latex/diffs").json()
    assert r_list1["available"] is True
    assert len(r_list1["items"]) == 1

    # 下载 PDF 返回 %PDF 字节
    r_pdf = c.get(manifest["pdf_url"] + "?download=1")
    assert r_pdf.status_code == 200
    assert r_pdf.headers["content-type"].startswith("application/pdf")
    assert r_pdf.content.startswith(b"%PDF-1.4")
