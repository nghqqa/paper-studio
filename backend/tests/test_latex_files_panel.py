# -*- coding: utf-8 -*-
import pytest

"""工程文件面板三操作 + Issues（v0.4.2）：新建/上传/ZIP 合并/整包下载/issue 生命周期。

复用 test_latex_product 的 client fixture 形态（tmp_path + 模块 reload 链）。
"""
import io
import zipfile

from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    import importlib

    from app import config, main
    from app.domain import latex_build as latex_build_mod
    from app.domain import latex_files as latex_files_mod
    from app.domain import latex_issues as latex_issues_mod
    from app.domain import projects as projects_mod
    from app.routes import latex as latex_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(latex_build_mod)
    importlib.reload(latex_files_mod)
    importlib.reload(latex_issues_mod)
    importlib.reload(latex_routes)
    importlib.reload(main)
    return TestClient(main.app), projects


def _demo(c):
    return c.post("/api/projects/latex-demo").json()["id"]


def test_create_file_and_duplicate_conflict(client):
    c, projects = client
    pid = _demo(c)
    r = c.post(f"/api/projects/{pid}/latex/files/sections/method.tex", json={"content": "\\section{M}\n"})
    assert r.status_code == 200, r.text
    assert (projects / pid / "sections" / "method.tex").is_file()
    # 重复创建 409；不可编辑扩展名 415
    assert c.post(f"/api/projects/{pid}/latex/files/sections/method.tex", json={"content": "x"}).status_code == 409
    assert c.post(f"/api/projects/{pid}/latex/files/x.exe", json={"content": "x"}).status_code == 415
    # 穿越拒绝（URL 编码绕过客户端归一化；服务端守卫兜底）
    assert c.post(f"/api/projects/{pid}/latex/files/%2e%2e%2fevil.tex", json={"content": "x"}).status_code in (400, 404)


def test_upload_binary_and_text(client):
    c, projects = client
    pid = _demo(c)
    r = c.post(f"/api/projects/{pid}/latex/upload",
               data={"rel": "figs/new-fig.png"},
               files={"file": ("new-fig.png", b"\x89PNG fake", "image/png")})
    assert r.status_code == 200, r.text
    assert (projects / pid / "figs" / "new-fig.png").read_bytes().startswith(b"\x89PNG")
    # 同名拒绝覆盖
    r = c.post(f"/api/projects/{pid}/latex/upload",
               data={"rel": "figs/new-fig.png"},
               files={"file": ("new-fig.png", b"x", "image/png")})
    assert r.status_code == 409
    # 文本族按 utf-8 保存
    r = c.post(f"/api/projects/{pid}/latex/upload",
               data={"rel": "refs/extra.bib"},
               files={"file": ("extra.bib", "@article{a, title={t}}", "text/x-bibtex")})
    assert r.status_code == 200
    # 不支持的类型 415
    r = c.post(f"/api/projects/{pid}/latex/upload",
               data={"rel": "evil.exe"},
               files={"file": ("evil.exe", b"MZ", "application/x-exe")})
    assert r.status_code == 415


def test_upload_zip_merge_skips_existing_and_internal(client):
    c, projects = client
    pid = _demo(c)
    (projects / pid / "bare_conf.tex").write_text("% keep me", encoding="utf-8")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("new.tex", "\\documentclass{article}")
        z.writestr("bare_conf.tex", "% OVERWRITE!")            # 已存在 → 跳过
        z.writestr("docs/notes.md", "internal")                # 平台内部目录 → 跳过
        z.writestr("nested.tar.gz", "x")                       # 嵌套归档 → 硬拒绝
    r = c.post(f"/api/projects/{pid}/latex/upload-zip", files={"file": ("pack.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 422, r.text  # 嵌套归档硬拒绝（与导入同规）

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("new.tex", "\\documentclass{article}")
        z.writestr("bare_conf.tex", "% OVERWRITE!")
        z.writestr("docs/notes.md", "internal")
        z.writestr("weird.dat", "x")
    r = c.post(f"/api/projects/{pid}/latex/upload-zip", files={"file": ("pack.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["added"] == ["new.tex"]
    assert body["skipped_existing"] == ["bare_conf.tex"]
    assert set(body["skipped_rejected"]) == {"docs/notes.md", "weird.dat"}
    assert (projects / pid / "bare_conf.tex").read_text(encoding="utf-8") == "% keep me"


def test_export_zip_roundtrip(client):
    c, projects = client
    pid = _demo(c)
    r = c.get(f"/api/projects/{pid}/latex/export-zip")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        names = set(z.namelist())
    assert "bare_conf.tex" in names and "fig1.png" in names


def test_issue_lifecycle(client):
    c, _ = client
    pid = _demo(c)
    r = c.post(f"/api/projects/{pid}/latex/issues",
               json={"message": "方法节需要补实验对比", "file": "bare_conf.tex", "line": 530})
    assert r.status_code == 200, r.text
    issue = r.json()
    assert issue["status"] == "open"
    r = c.post(f"/api/projects/{pid}/latex/issues", json={"message": "  "})
    assert r.status_code == 422
    r = c.patch(f"/api/projects/{pid}/latex/issues/{issue['id']}", json={"resolved": True})
    assert r.status_code == 200 and r.json()["status"] == "resolved"
    items = c.get(f"/api/projects/{pid}/latex/issues").json()["issues"]
    assert len(items) == 1 and items[0]["status"] == "resolved"
    assert c.delete(f"/api/projects/{pid}/latex/issues/{issue['id']}").status_code == 200
    assert c.get(f"/api/projects/{pid}/latex/issues").json()["issues"] == []


def test_rename_and_delete_file(client):
    c, projects = client
    pid = _demo(c)
    assert c.post(f"/api/projects/{pid}/latex/files/sections/m.tex", json={"content": "x"}).status_code == 200
    r = c.post(f"/api/projects/{pid}/latex/files/sections/m.tex/rename", json={"new_path": "sections/m2.tex"})
    assert r.status_code == 200 and r.json()["path"] == "sections/m2.tex"
    assert not (projects / pid / "sections" / "m.tex").exists()
    assert (projects / pid / "sections" / "m2.tex").is_file()
    assert c.post(f"/api/projects/{pid}/latex/files/sections/m2.tex/rename", json={"new_path": "sections/m2.tex"}).status_code == 409
    assert c.delete(f"/api/projects/{pid}/latex/files/sections/m2.tex").status_code == 200
    # 主文件删除保护
    assert c.delete(f"/api/projects/{pid}/latex/files/bare_conf.tex").status_code == 409


def test_rename_main_updates_settings(client):
    c, projects = client
    pid = _demo(c)
    r = c.post(f"/api/projects/{pid}/latex/files/bare_conf.tex/rename", json={"new_path": "docs/main.tex"})
    assert r.status_code == 200, r.text
    assert r.json()["main_updated"] is True
    assert c.get(f"/api/projects/{pid}").json()["settings"]["latex"]["main"] == "docs/main.tex"


def test_ai_review_creates_issues(client, monkeypatch):
    import json as _json
    from app.domain import user_ai as ua

    c, projects = client
    (projects / ".studio").mkdir(exist_ok=True)
    (projects / ".studio" / "org.json").write_text(_json.dumps({
        "ai_provider": {"base_url": "https://fake/v1", "api_key": "sk-t", "model_interactive": "m1"}
    }), encoding="utf-8")

    class FakeResult:
        text = '[{"line": 5, "message": "引言缺文献支撑"}, {"message": "结论过于空泛"}]'
        model = "m1"

    class FakeClient:
        def __init__(self, provider, models=None):
            pass
        async def chat(self, messages, purpose, **kw):
            return FakeResult()

    monkeypatch.setattr(ua, "AiClient", FakeClient)
    monkeypatch.setattr(ua, "OpenAICompatProvider", lambda key, base_url=None: type("P", (), {"key": key, "base_url": base_url or ""})())

    c, _ = client
    pid = _demo(c)
    content = "\\documentclass{article}\n\\begin{document}x\\end{document}"
    r = c.post(f"/api/projects/{pid}/latex/ai-review", json={"file": "bare_conf.tex", "content": content})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["added"] == 2
    issues = c.get(f"/api/projects/{pid}/latex/issues").json()["issues"]
    assert len(issues) == 2 and issues[0]["message"].startswith(("引言", "结论"))
