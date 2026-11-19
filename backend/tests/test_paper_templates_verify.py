"""管理端「验证编译」流水线（POST /api/admin/paper-templates/{fmt}/{tid}/verify）。

复用 test_word_editor 的 matrix 共享夹具（独立数据卷 + bootstrap 管理员）。
latexmk 子进程打桩（与 test_latex_product 同惯例）：成功桩写 PDF 到构建根裸 basename
（texlive 对子目录主文件的实际落点），失败桩返回非零退出码。
"""
import io
import json
import os
import zipfile

from fastapi.testclient import TestClient
from test_word_editor import matrix  # noqa: F401 — 共享夹具

BASE = "/api/admin/paper-templates"


def admin(matrix):  # noqa: F811 — 夹具参数与模块级导入同名（pytest 注册需要该名）
    c = TestClient(matrix["app"])
    login = c.post("/api/auth/cookie/login",
                   data={"username": "bootstrap@word.example.com", "password": "Word-test-pw!"})
    assert login.status_code == 204
    return c


def tex_zip(main="main.tex"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(main, "\\documentclass{article}\n\\begin{document}verify\\end{document}\n")
    return buf.getvalue()


def upload_latex(c, name="验证模板", main="main.tex"):
    r = c.post(BASE, data={"metadata": json.dumps({
        "format": "latex", "name": name, "main": main, "engine": "pdflatex"})},
        files={"file": ("template.zip", tex_zip(main))})
    assert r.status_code == 201, r.text
    return r.json()


def stub_run(monkeypatch, rc=0, write_pdf=True):
    from app.domain import task_runner

    def fake(cmd, cwd=None, **kw):
        if write_pdf and cwd:
            main_arg = cmd[-1]
            stem = os.path.splitext(os.path.basename(main_arg))[0]
            with open(os.path.join(cwd, f"{stem}.pdf"), "wb") as f:
                f.write(b"%PDF-1.4 stub")
        return rc
    monkeypatch.setattr(task_runner, "run_task", fake)


def test_verify_requires_admin(matrix):  # noqa: F811
    assert TestClient(matrix["app"]).post(BASE + "/latex/ieee/verify").status_code == 401
    owner = matrix["users"]["owner"]
    assert owner.post(BASE + "/latex/ieee/verify").status_code == 403


def test_verify_compile_ok_flips_to_verified(matrix, monkeypatch):  # noqa: F811
    c = admin(matrix)
    row = upload_latex(c, name="验证-成功路径")
    assert row["verify"] == "unverified"
    stub_run(monkeypatch, rc=0, write_pdf=True)
    r = c.post(f"{BASE}/latex/{row['id']}/verify")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok" and body["verify"] == "verified" and body["verify_error"] is None
    # 目录持久化：重新拉取列表仍是 verified（新建入口徽章数据源）
    items = c.get(BASE).json()["items"]
    mine = next(t for t in items if t["id"] == row["id"])
    assert mine["verify"] == "verified" and not mine.get("verify_error")


def test_verify_compile_fail_keeps_unverified_with_reason(matrix, monkeypatch):  # noqa: F811
    c = admin(matrix)
    row = upload_latex(c, name="验证-失败路径", main="sub/paper.tex")
    stub_run(monkeypatch, rc=1, write_pdf=False)
    r = c.post(f"{BASE}/latex/{row['id']}/verify")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "error" and body["verify"] == "unverified"
    assert body["verify_error"]
    items = c.get(BASE).json()["items"]
    mine = next(t for t in items if t["id"] == row["id"])
    assert mine["verify"] == "unverified" and mine.get("verify_error")


def test_verify_docx_not_applicable(matrix):  # noqa: F811
    c = admin(matrix)
    r = c.post(BASE + "/docx/jcip/verify")
    assert r.status_code == 422
    detail = r.json()["detail"]
    text = detail if isinstance(detail, str) else (detail.get("message") or "")
    assert "Word" in text or "LaTeX" in text


def test_upload_latex_autodetects_main(matrix):  # noqa: F811
    """主文件留空 ⇒ 自动递归扫描 documentclass 并取最优候选（排序同导入：template 优先）。"""
    c = admin(matrix)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("els-cas-templates/doc/elsdoc-cas.tex", rb"\documentclass{article}")
        z.writestr("els-cas-templates/cas-sc-sample.tex", rb"\documentclass{article}")
        z.writestr("els-cas-templates/cas-sc-template.tex", rb"\documentclass{article}")
        z.writestr("els-cas-templates/cas-sc.cls", "cls")
    r = c.post(BASE, data={"metadata": json.dumps({
        "format": "latex", "name": "自动检测", "main": "", "engine": "pdflatex"})},
        files={"file": ("template.zip", buf.getvalue())})
    assert r.status_code == 201, r.text
    assert r.json()["main"] == "els-cas-templates/cas-sc-template.tex"


def test_upload_wrong_main_error_lists_candidates(matrix):  # noqa: F811
    """主文件填错 ⇒ 422 且报错里列出检测到的候选（免猜路径）。"""
    c = admin(matrix)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("els-cas-templates/cas-sc-template.tex", rb"\documentclass{article}")
    r = c.post(BASE, data={"metadata": json.dumps({
        "format": "latex", "name": "候选提示", "main": "cas-sc-sample.tex", "engine": "pdflatex"})},
        files={"file": ("template.zip", buf.getvalue())})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    text = detail if isinstance(detail, str) else (detail.get("message") or "")
    assert "cas-sc-sample.tex" in text and "els-cas-templates/cas-sc-template.tex" in text


def test_auto_accept_success_then_queue_busy_degrades(matrix, monkeypatch):  # noqa: F811
    """自动验收（开关 on）：上传响应即刻返回 unverified，后台编译成功翻 verified + 缩略图；
    队列繁忙 ⇒ 资产保留、verify 保持 unverified 并记录可读原因。"""
    from app import config
    from app.domain import paper_templates as domain
    from app.domain import task_runner

    monkeypatch.setattr(config, "PAPER_TEMPLATE_AUTO_ACCEPT", True)
    c = admin(matrix)
    stub_run(monkeypatch, rc=0, write_pdf=True)
    monkeypatch.setattr(domain, "_pdf_first_png", lambda p: b"\x89PNG-fake" if p else None)
    row = upload_latex(c, name="自动验收-成功")
    assert row["verify"] == "unverified"
    assert domain.wait_auto_accept(30)
    mine = next(t for t in c.get(BASE).json()["items"] if t["id"] == row["id"])
    assert mine["verify"] == "verified" and mine["thumb"] is True
    # 队列繁忙：占住唯一编译槽
    class BusySlot:
        def acquire(self):
            return False
    monkeypatch.setattr(task_runner, "latex_slot", lambda: BusySlot())
    row2 = upload_latex(c, name="自动验收-繁忙")
    assert domain.wait_auto_accept(30)
    mine2 = next(t for t in c.get(BASE).json()["items"] if t["id"] == row2["id"])
    assert mine2["verify"] == "unverified" and "繁忙" in (mine2.get("verify_error") or "")
    # 资产未丢：模板仍可建工程
    author = matrix["users"]["owner"]
    assert author.post("/api/projects/latex-demo", json={"template": row2["id"]}).status_code == 200


def test_auto_accept_generation_guard_reruns_new_version(matrix, monkeypatch):  # noqa: F811
    """代际守卫：编译挂起期间替换版本 ⇒ v1 过期结果落盘前被 409 丢弃，v2 排队任务
    按新版本重新验收并最终一致（version==2 且 verified）。"""
    import os
    import threading
    import time as _time

    from app import config
    from app.domain import paper_templates as domain
    from app.domain import task_runner

    monkeypatch.setattr(config, "PAPER_TEMPLATE_AUTO_ACCEPT", True)
    c = admin(matrix)
    release = threading.Event()
    calls = {"n": 0}

    def fake_run(cmd, cwd=None, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            assert release.wait(timeout=20), "首个编译未被测试放行"
        stem = os.path.splitext(os.path.basename(cmd[-1]))[0]
        with open(os.path.join(cwd, stem + ".pdf"), "wb") as f:
            f.write(b"%PDF-1.4 stub")
        return 0

    monkeypatch.setattr(task_runner, "run_task", fake_run)
    monkeypatch.setattr(domain, "_pdf_first_png", lambda p: b"\x89PNG-fake" if p else None)
    row = upload_latex(c, name="代际守卫")
    tid = row["id"]
    deadline = _time.monotonic() + 10
    while calls["n"] < 1 and _time.monotonic() < deadline:
        _time.sleep(0.02)
    assert calls["n"] >= 1, "后台验收未进入编译阶段"
    # 编译挂起期间替换版本 → 新版本任务在闸后排队
    r = c.put(f"{BASE}/latex/{tid}/file", files={"file": ("template.zip", tex_zip("main.tex"))})
    assert r.status_code == 200 and r.json()["version"] == 2, r.text
    release.set()
    assert domain.wait_auto_accept(30)
    mine = next(t for t in c.get(BASE).json()["items"] if t["id"] == tid)
    assert mine["version"] == 2 and mine["verify"] == "verified" and mine["thumb"] is True
    assert calls["n"] >= 2, "替换后未按新版本重跑验收"
