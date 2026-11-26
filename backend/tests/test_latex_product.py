# -*- coding: utf-8 -*-
"""w21 批A：原生 LaTeX 最小产品闭环。

覆盖：示例创建与配置持久化、存量项目不受影响、文件路径边界、构建成功/失败/产物版本对应、
LaTeX 不进 Markdown/专利/协同路径。编译类用例需宿主 latexmk（无则跳过，与 soffice skip 同惯例）。
"""

import os
import shutil
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED = os.path.join(ROOT, "backend", "app", "latex_seed", "ieee_bare_conf")
HAS_LATEXMK = shutil.which("latexmk") is not None


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    monkeypatch.setenv("PATENT_STATIC_DIR", str(tmp_path / "no-static"))
    import importlib

    from app import config, main
    from app.domain import latex_build as latex_build_mod
    from app.domain import projects as projects_mod
    from app.routes import latex as latex_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(latex_build_mod)
    importlib.reload(latex_routes)
    importlib.reload(main)
    return TestClient(main.app), projects


# ---------------- 契约：创建 / 持久化 / 存量不变 ----------------


def test_create_demo_and_config_persists(client):
    c, projects = client
    r = c.post("/api/projects/latex-demo")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source_format"] == "latex"
    assert body["latex"] == {"main": "bare_conf.tex", "engine": "pdflatex"}
    assert (projects / body["id"] / "bare_conf.tex").is_file()
    assert (projects / body["id"] / "IEEEtran.cls").is_file()
    # 保存重载一致：GET project 与 settings 双通道
    got = c.get(f"/api/projects/{body['id']}").json()
    assert got["settings"]["source_format"] == "latex"
    assert got["settings"]["latex"]["main"] == "bare_conf.tex"
    # v0.1.5：不传 title 时用模板默认名（IEEEtran 模板）
    assert got["title"] == "IEEE 会议（IEEEtran）"
    # 文件清单：源文件在列，内部区不在
    files = c.get(f"/api/projects/{body['id']}/latex/files").json()["files"]
    paths = {f["path"] for f in files}
    assert {"bare_conf.tex", "IEEEtran.cls", "fig1.png"} <= paths
    assert not any(p.startswith(".studio") or p == "studio.json" for p in paths)
    assert next(f for f in files if f["path"] == "fig1.png")["editable"] is False
    assert next(f for f in files if f["path"] == "bare_conf.tex")["editable"] is True


def test_default_project_is_markdown_and_latex_endpoints_reject(client):
    c, _ = client
    c.post("/api/projects", json={"id": "pat-1", "title": "专利案"})
    got = c.get("/api/projects/pat-1").json()
    assert "source_format" not in got["settings"]  # 缺省不注入键（与 A1 不变量一致）
    assert c.get("/api/projects/pat-1/latex/files").status_code == 400
    assert c.post("/api/projects/pat-1/latex/build", json={}).status_code == 400


def test_unknown_source_format_and_engine_rejected(client):
    c, _ = client
    c.post("/api/projects", json={"id": "set-1", "title": "x"})
    r = c.put("/api/projects/set-1/settings", json={"source_format": "latex2"})
    assert r.status_code == 422 and "未知源格式" in r.text
    r = c.put(
        "/api/projects/set-1/settings",
        json={"source_format": "latex", "latex": {"main": "a.tex", "engine": "tectonic"}},
    )
    assert r.status_code == 422 and "未知 LaTeX 引擎" in r.text
    r = c.put(
        "/api/projects/set-1/settings",
        json={"source_format": "latex", "latex": {"main": "../x.tex", "engine": "pdflatex"}},
    )
    assert r.status_code == 422 and "main" in r.text


# ---------------- 文件读写与路径边界 ----------------


def test_file_read_save_and_path_boundaries(client):
    c, projects = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    read = c.get(f"/api/projects/{demo}/latex/files/bare_conf.tex").json()
    assert "\\documentclass" in read["content"] and read["sha"]
    # 保存 + 乐观并发
    new_content = read["content"] + "\n% w21 test edit\n"
    ok = c.put(
        f"/api/projects/{demo}/latex/files/bare_conf.tex",
        json={"content": new_content, "base": read["sha"]},
    )
    assert ok.status_code == 200
    stale = c.put(
        f"/api/projects/{demo}/latex/files/bare_conf.tex",
        json={"content": "x", "base": read["sha"]},
    )
    assert stale.status_code == 409 and stale.json()["detail"]["kind"] == "stale"
    # 路径边界
    assert c.get(f"/api/projects/{demo}/latex/files/../studio.json").status_code in (400, 404)
    assert c.get(f"/api/projects/{demo}/latex/files/%2e%2e%2fx").status_code in (400, 404)
    assert c.get(f"/api/projects/{demo}/latex/files/.studio/builds/x").status_code == 400
    # v0.1 边界调整：figs/attachments/docs 等资源目录不再整体过滤——不存在即 404（不再 400 拒绝）
    assert c.get(f"/api/projects/{demo}/latex/files/attachments/x.tex").status_code == 404
    assert c.get(f"/api/projects/{demo}/latex/files/studio.json").status_code == 400
    assert c.get(f"/api/projects/{demo}/latex/files/不存在.tex").status_code == 404
    # 不支持新建：目标不存在 → 404
    r = c.put(f"/api/projects/{demo}/latex/files/new.tex", json={"content": "x"})
    assert r.status_code == 404
    # 非白名单扩展 → 415（SOURCES.md 可读不开放：.md 不在文本编辑白名单）
    assert c.get(f"/api/projects/{demo}/latex/files/SOURCES.md").status_code == 415
    assert c.get(f"/api/projects/{demo}/latex/files/fig1.png").status_code == 415


# ---------------- 构建：成功 / 失败 / 产物版本对应（需宿主 latexmk） ----------------


@pytest.mark.skipif(not HAS_LATEXMK, reason="需要宿主 latexmk（本机已验证 MiKTeX 26.5）")
def test_build_ok_fail_fix_and_stale(client):
    c, _ = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    # 1) 成功
    out = c.post(f"/api/projects/{demo}/latex/build", json={}).json()
    assert out["status"] == "ok" and out["pdf_url"], out
    pdf = c.get(out["pdf_url"])
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    # 2) 失败 → 诊断带文件行号，无 PDF
    read = c.get(f"/api/projects/{demo}/latex/files/bare_conf.tex").json()
    broken = read["content"].replace("\\section{Conclusion}", "\\sectio{Conclusion}")
    c.put(f"/api/projects/{demo}/latex/files/bare_conf.tex", json={"content": broken, "base": read["sha"]})
    out2 = c.post(f"/api/projects/{demo}/latex/build", json={}).json()
    assert out2["status"] == "error" and out2["pdf_url"] is None
    assert any(
        d["file"].endswith("bare_conf.tex") and d["line"] and "Undefined control sequence" in d["message"]
        for d in out2["diagnostics"]
    ), out2["diagnostics"]
    # 3) 修复 → 再成功；构建历史 3 条，latest_ok 指向第三次
    c.put(f"/api/projects/{demo}/latex/files/bare_conf.tex", json={"content": read["content"], "base": None})
    out3 = c.post(f"/api/projects/{demo}/latex/build", json={}).json()
    assert out3["status"] == "ok"
    builds = c.get(f"/api/projects/{demo}/latex/builds").json()
    assert [b["status"] for b in builds["builds"]] == ["ok", "error", "ok"]
    assert builds["latest_ok_build_id"] == out3["build_id"]
    # 4) stale：改源不重编 → latest 标记 stale；旧成功构建同样 stale（输入指纹已变）
    read2 = c.get(f"/api/projects/{demo}/latex/files/bare_conf.tex").json()
    touched = dict(read2)
    touched["content"] += "% touch\n"
    c.put(f"/api/projects/{demo}/latex/files/bare_conf.tex", json={"content": touched["content"], "base": read2["sha"]})
    builds2 = c.get(f"/api/projects/{demo}/latex/builds").json()
    assert all(b["stale"] for b in builds2["builds"])
    # 旧成功构建产物仍可取（前端标注「旧构建」）
    old_pdf = c.get(f"/api/projects/{demo}/latex/builds/{out['build_id']}/artifacts/out.pdf")
    assert old_pdf.status_code == 200 and old_pdf.content[:4] == b"%PDF"
    # 内嵌预览端点：200、无 content-disposition、Content-Type 为 text/plain
    # （IDM 等下载器按 attachment 头 / application/pdf 类型嗅探接管，掐断页面 fetch，用户实测）
    inline = c.get(f"/api/projects/{demo}/latex/builds/{out['build_id']}/artifacts/pdf")
    assert inline.status_code == 200 and inline.content[:4] == b"%PDF"
    assert "content-disposition" not in {k.lower() for k in inline.headers.keys()}
    assert inline.headers["content-type"].startswith("text/plain")


@pytest.mark.skipif(not HAS_LATEXMK, reason="需要宿主 latexmk")
def test_build_concurrency_409(client, monkeypatch):
    """同项目并发构建：第二个请求 409 job_busy（不排队不污染）。"""
    import threading

    c, _ = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    from app.domain import latex_build

    started = threading.Event()
    release = threading.Event()
    store = c.app.state.store

    def fake_run(*args, **kwargs):
        # 真实 run_build 的锁语义照常执行，只把 latexmk 子进程替换为阻塞桩
        # （v0.1 边界改造后编译子进程经 task_runner.run_task，桩打在这里）
        started.set()
        release.wait(30)
        return 0

    monkeypatch.setattr(latex_build.task_runner, "run_task", fake_run)

    thread_err: list[BaseException] = []

    def worker():
        try:
            latex_build.run_build(store, demo)
        except BaseException as e:  # noqa: BLE001 - 线程内异常带到断言
            thread_err.append(e)

    t = threading.Thread(target=worker)
    t.start()
    assert started.wait(10), f"worker 未进入编译：{thread_err}"
    # 第二个并发请求（同项目）→ 真实锁语义 → 409 job_busy
    from app.domain.projects import ProjectError

    with pytest.raises(ProjectError) as ei:
        latex_build.run_build(store, demo)
    assert ei.value.status == 409
    release.set()
    t.join(60)
    assert not t.is_alive() and not thread_err


def test_artifact_pdf_survives_transient_file_lock(client, monkeypatch):
    """Windows：MiKTeX 刚写完 PDF 的短暂文件锁 → 端点内重试后成功（而不是 500）。"""
    import os
    from pathlib import Path

    c, _ = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    out = c.post(f"/api/projects/{demo}/latex/build", json={}).json()
    assert out["status"] == "ok"
    from app import config

    pdf_path = os.path.join(config.PROJECTS_DIR, demo, ".studio", "latex-builds", out["build_id"], "bare_conf.pdf")
    assert os.path.isfile(pdf_path)

    calls = {"n": 0}
    real_read = Path.read_bytes

    def flaky_read_bytes(self):
        if calls["n"] < 2 and os.path.samefile(self, pdf_path):
            calls["n"] += 1
            raise PermissionError(13, "Being used by another process")
        return real_read(self)

    monkeypatch.setattr(Path, "read_bytes", flaky_read_bytes)
    r = c.get(f"/api/projects/{demo}/latex/builds/{out['build_id']}/artifacts/out.pdf")
    monkeypatch.setattr(Path, "read_bytes", real_read)
    assert r.status_code == 200 and r.content[:4] == b"%PDF", r.status_code
    assert calls["n"] >= 2  # 确实经过重试


def test_build_unknown_engine_422(client):
    c, _ = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    r = c.post(f"/api/projects/{demo}/latex/build", json={"engine": "tectonic"})
    assert r.status_code == 422 and "未知 LaTeX 引擎" in r.text


# ---------------- 隔离：LaTeX 不进 Markdown/专利/协同路径 ----------------


def test_latex_excluded_from_markdown_and_patent_paths(client):
    c, _ = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    # 专利 Markdown / AST / lint / preflight 路径已彻底下线（404）
    assert c.get(f"/api/projects/{demo}/content").status_code == 404
    assert c.post(f"/api/projects/{demo}/build", json={"pdf": False}).status_code == 404
    for path, body in (("ast", None), ("lint", {}), ("preflight", {})):
        res = (
            c.post(f"/api/projects/{demo}/{path}", json=body)
            if body is not None
            else c.get(f"/api/projects/{demo}/{path}")
        )
        assert res.status_code == 404, (path, res.status_code, res.text)


def projects_dir_of(client):
    # client fixture 的项目目录来自 tmp_path；通过环境已被 reload 的 config 读回
    from app import config

    return config.PROJECTS_DIR


def test_list_ids_includes_latex_project(client):
    c, projects = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    ids = c.get("/api/projects").json()
    assert any(p["id"] == demo for p in ids)
    assert (projects / demo / "content.md").exists() is False  # 无 content.md 仍可被发现


# ---------------- v0.2 编译安全负向探针（合成内容；latexmk -norc / shell-escape / 环境白名单） ----------------

def test_build_env_never_carries_app_secrets(tmp_path, monkeypatch):
    from app.domain.latex_build import _build_env
    monkeypatch.setenv("PATENT_STUDIO_SECRET", "top-secret-value")
    monkeypatch.setenv("PATENT_STUDIO_DATABASE_URL", "sqlite:///some.db")
    monkeypatch.setenv("OTHER_PROJECT_HINT", "x")
    env = _build_env(str(tmp_path))
    for k in env:
        assert "SECRET" not in k and "DATABASE" not in k and "TOKEN" not in k
    assert env["HOME"] == str(tmp_path), "HOME 必须指向构建目录（用户级 rc/缓存不外读）"
    assert set(env) <= {"PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL",
                        "HOME", "USERPROFILE", "TEXMFVAR", "TEXMFHOME", "SOURCE_DATE_EPOCH", "TEXINPUTS"}


@pytest.mark.skipif(not HAS_LATEXMK, reason="需要宿主 latexmk")
def test_latexmkrc_imported_is_never_executed(client, tmp_path):
    """负向探针（威胁模型=用户上传 ZIP 携带 .latexmkrc）：-norc 必须使 rc 完全失效。
    rc 内含 Perl 语法破坏器——若被读取，latexmk 解析即报错。"""
    import io as _io
    import zipfile as _zip
    c, _ = client
    buf = _io.BytesIO()
    with _zip.ZipFile(buf, "w") as z:
        z.writestr("main.tex", "\\documentclass{article}\n\\begin{document}ok\n\\end{document}\n")
        z.writestr(".latexmkrc", "this is definitely not perl ]]{ ;;;\n1/0;\n")
    buf.seek(0)
    st, body = None, None
    r = c.post("/api/projects/latex/import/upload",
               files={"file": ("evil.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    r2 = c.post("/api/projects/latex/import/create",
                json={"token": token, "main": "main.tex", "engine": "pdflatex", "title": "rc 探针"})
    assert r2.status_code == 200, r2.text
    pid = r2.json()["id"]
    assert (tmp_path / "projects" / pid / ".latexmkrc").is_file(), "rc 文件应随 ZIP 导入（但绝不执行）"
    out = c.post(f"/api/projects/{pid}/latex/build", json={}).json()
    assert out["status"] == "ok", f"-norc 未生效（rc 被读取执行）：{str(out.get('diagnostics'))[:300]}"
    # 快照目录含占位替换标记 ⇒ 主文真实编译而非空跑
    assert (tmp_path / "projects" / pid / "main.pdf").exists() or out.get("pdf_url")


@pytest.mark.skipif(not HAS_LATEXMK, reason="需要宿主 latexmk")
def test_shell_escape_is_disabled(client):
    """负向探针：-no-shell-escape 下 \write18 是空操作，不产生标记文件。"""
    c, _ = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    read = c.get(f"/api/projects/{demo}/latex/files/bare_conf.tex").json()
    evil = read["content"].replace(
        "\section{Conclusion}",
        "\immediate\write18{echo PWNED > pwned-marker.txt}\n\section{Conclusion}")
    c.put(f"/api/projects/{demo}/latex/files/bare_conf.tex", json={"content": evil, "base": None})
    out = c.post(f"/api/projects/{demo}/latex/build", json={}).json()
    assert out["status"] == "ok"
    # 构建目录（快照）内不得出现 shell 产物
    from app.config import PROJECTS_DIR
    build_root = os.path.join(PROJECTS_DIR, demo)
    hits = []
    for root, _dirs, files in os.walk(build_root):
        hits += [os.path.join(root, f) for f in files if f == "pwned-marker.txt"]
    assert hits == [], f"shell escape 未禁用：{hits}"


# ---------------- v0.4.2：子目录主文件产物定位 + raw 预览端点 ----------------


def test_build_subdir_main_finds_relocated_pdf(client, monkeypatch):
    """主文件在子目录：TeX 家族把 PDF 写在构建根的裸 basename 下（Linux texlive 实测，
    生产 els-cas 导入实测踩坑）——run_build 须在 basename 位置找到产物并复制到规范
    stem 路径，状态 ok、产物可读，不再误报「成功退出但未产出 PDF」。"""
    import os

    c, projects = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    sub = projects / demo / "els-cas-templates"
    sub.mkdir()
    (sub / "cas-sc-template.tex").write_text(
        "\\documentclass{article}\n\\begin{document}demo\\end{document}\n", encoding="utf-8")
    r = c.put(f"/api/projects/{demo}/settings", json={"latex": {"main": "els-cas-templates/cas-sc-template.tex"}})
    assert r.status_code == 200, r.text

    from app.domain import latex_build

    def fake_run(cmd, cwd=None, **kw):
        # 模拟 texlive：产物写在 CWD（构建根）的裸 basename，不在源文件旁
        main_arg = cmd[-1]
        stem = os.path.splitext(os.path.basename(main_arg))[0]
        with open(os.path.join(cwd, f"{stem}.pdf"), "wb") as f:
            f.write(b"%PDF-1.4 fake")
        return 0

    monkeypatch.setattr(latex_build.task_runner, "run_task", fake_run)
    out = c.post(f"/api/projects/{demo}/latex/build", json={}).json()
    assert out["status"] == "ok", out
    assert out["error"] is None
    # 产物接口按规范 stem 路径读取
    r = c.get(f"/api/projects/{demo}/latex/builds/{out['build_id']}/artifacts/out.pdf")
    assert r.status_code == 200 and r.content[:4] == b"%PDF", r.status_code


def test_raw_source_preview(client):
    """raw 预览端点：图片 200、svg 才带 CSP sandbox（pdf 不能带——Chrome 内建 PDF 查看器
    在 sandbox 文档中拒绝加载，生产实测 iframe「拒绝连接」）、未知 404、非白名单 415、
    穿越 415/400、?dl=1 走附件。"""
    c, projects = client
    demo = c.post("/api/projects/latex-demo").json()["id"]
    (projects / demo / "figs").mkdir(exist_ok=True)
    (projects / demo / "figs" / "t.svg").write_text(
        "<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    r = c.get(f"/api/projects/{demo}/latex/raw/fig1.png")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/png")
    assert "content-security-policy" not in r.headers
    # 工作台 iframe 嵌入预览：raw 响应不得带 X-Frame-Options（asgi 外层中间件默认 DENY）
    assert "x-frame-options" not in r.headers
    r = c.get(f"/api/projects/{demo}/latex/raw/figs/t.svg")
    assert r.status_code == 200
    assert r.headers.get("content-security-policy") == "sandbox"
    assert c.get(f"/api/projects/{demo}/latex/raw/nope.png").status_code == 404
    assert c.get(f"/api/projects/{demo}/latex/raw/bare_conf.tex").status_code == 415
    assert c.get(f"/api/projects/{demo}/latex/raw/..%2F.studio%2Fstudio.json").status_code in (400, 404, 415)
    r = c.get(f"/api/projects/{demo}/latex/raw/fig1.png?dl=1")
    assert "attachment" in r.headers.get("content-disposition", "")
