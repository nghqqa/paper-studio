# -*- coding: utf-8 -*-
"""P1-1 审稿回复信：确定性拆条 / replace·append 轮次 / paper 门槛 / 条目更新 /
AI mock 草稿（ai_draft 降级、不覆盖用户回复）/ 三格式导出 / ACL（sqlite AUTH=on）。

主 fixture 照 test_oa.py 的 reload 链（monkeypatch 隔离环境变量）；所有项目数据都在
pytest tmp_path 里操作，不写仓库 examples/。ACL 用 test_user_ai.py 的 sqlite AUTH=on
module fixture 形态（try/finally 还原环境，不污染后续认证测试）。
"""

import importlib
import io
import os
import sys

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app.domain import rebuttal as rb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REVIEW_TEXT = """The manuscript studies X. Overall the contribution is solid but needs work.

Reviewer #1
Major Comment 1: The motivation in the introduction is too weak for a general audience.
Minor Comment 2: There are several typos, e.g. "teh" on page 3.
Reviewer 2:
Q1: Why is the comparison limited to baseline X instead of the newer Y?
"""


def _parse(c, pid, text, mode=None):
    body = {"text": text}
    if mode:
        body["mode"] = mode
    return c.post(f"/api/projects/{pid}/rebuttal/parse", json=body)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("PATENT_STUDIO_AI_PROVIDER", "mock")
    from app import config, main
    from app.domain import projects as projects_mod

    for m in (config, projects_mod, main):
        importlib.reload(m)
    with TestClient(main.app) as c:
        r = c.post("/api/projects", json={"id": "pap1", "title": "示例论文", "document_type": "paper"})
        assert r.status_code == 201, r.text
        yield c, projects, main.app


# ---------------- 拆条 ----------------


def test_parse_multi_reviewer_categories(client):
    c, _, _ = client
    r = _parse(c, "pap1", REVIEW_TEXT)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["round"] == 1
    items = body["items"]
    assert all(it["id"].startswith("rb-") for it in items)
    assert items[0]["reviewer"] == "Editor" and items[0]["category"] == "general"  # 导语保留
    assert any("导语" in w for w in body["warnings"])
    r1 = [it for it in items if it["reviewer"] == "Reviewer 1"]
    assert [it["category"] for it in r1] == ["major", "minor"]
    assert r1[0]["text"].startswith("Major Comment 1:")
    q1 = [it for it in items if it["reviewer"] == "Reviewer 2"]
    assert len(q1) == 1 and q1[0]["category"] == "general"
    assert all(it["status"] == "todo" and it["response"] == "" and it["ai_draft"] is None for it in items)


def test_parse_fallback_whole_text_and_empty(client):
    c, _, _ = client
    r = _parse(c, "pap1", "这篇稿子的创新性论证需要加强，实验对照也不够充分。")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1 and items[0]["reviewer"] == "Reviewer 1" and items[0]["category"] == "general"
    assert any("未识别" in w for w in r.json()["warnings"])
    # 空文本 ⇒ 422（不落盘空条目）
    r = _parse(c, "pap1", "  \n ")
    assert r.status_code == 422 and r.json()["detail"]["kind"] == "validation"


def test_parse_plain_numbered_and_editorial_signal(client):
    c, _, _ = client
    text = "Reviewer A\n1. The proof of Lemma 2 skips a case.\n2. Fix the formatting of Table 3."
    items = _parse(c, "pap1", text).json()["items"]
    assert [it["category"] for it in items] == ["general", "editorial"]
    assert all(it["reviewer"] == "Reviewer A" for it in items)


def test_replace_round_and_append(client):
    c, _, _ = client
    t1 = "Reviewer #1\n1. First point."
    t2 = "Reviewer #2\nComment 1: Second round point."
    assert _parse(c, "pap1", t1).json()["round"] == 1
    r2 = _parse(c, "pap1", t2).json()  # 默认 replace：round+1、整表替换、id 重新编号
    assert r2["round"] == 2 and len(r2["items"]) == 1 and r2["items"][0]["id"] == "rb-1"
    assert r2["items"][0]["reviewer"] == "Reviewer 2"
    r3 = _parse(c, "pap1", t1, mode="append").json()  # append：保留旧条目、round 不变
    assert r3["round"] == 2 and len(r3["items"]) == 2
    assert {it["id"] for it in r3["items"]} == {"rb-1", "rb-2"}
    assert r3["items"][0]["text"].startswith("Comment 1:")
    # 非法模式 ⇒ 422
    assert _parse(c, "pap1", t1, mode="merge").status_code == 422


def test_non_paper_project_rejected(client):
    c, _, _ = client
    assert c.post("/api/projects", json={"id": "pat1", "title": "非论文", "document_type": "patent"}).status_code == 201
    r = _parse(c, "pat1", REVIEW_TEXT)
    assert r.status_code == 400 and r.json()["detail"]["kind"] == "project"
    assert c.get("/api/projects/pat1/rebuttal").status_code == 400
    assert c.get("/api/projects/ghost/rebuttal").status_code == 404


def test_parse_pdf_and_text_files(client):
    c, _, _ = client
    # 扫描件（空白页 = 无文字层）⇒ 422 no_text，诚实报错不假 OCR
    buf = io.BytesIO()
    w = PdfWriter()
    w.add_blank_page(width=300, height=300)
    w.write(buf)
    r = c.post(
        "/api/projects/pap1/rebuttal/parse",
        files={"file": ("scan.pdf", buf.getvalue(), "application/pdf")},
    )
    assert r.status_code == 422 and r.json()["detail"]["kind"] == "no_text"
    assert "文字层" in r.json()["detail"]["message"]
    # .md 上传走通
    r = c.post(
        "/api/projects/pap1/rebuttal/parse",
        files={"file": ("reviews.md", "Reviewer #1\n1. Point one.".encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 200 and r.json()["items"][0]["reviewer"] == "Reviewer 1"
    # 其他扩展名 ⇒ 422
    r = c.post(
        "/api/projects/pap1/rebuttal/parse",
        files={"file": ("x.docx", b"PK\x03\x04", "application/octet-stream")},
    )
    assert r.status_code == 422 and r.json()["detail"]["kind"] == "validation"


# ---------------- 条目更新 ----------------


def test_update_item_status_location_response(client):
    c, _, _ = client
    _parse(c, "pap1", "Reviewer #1\n1. A point.")
    r = c.put(
        "/api/projects/pap1/rebuttal/items/rb-1",
        json={"status": "addressed", "response": "已补充实验。", "edits_summary": "新增对照组",
              "location": {"file": "main.tex", "line": 12, "section": "Experiments"}},
    )
    assert r.status_code == 200, r.text
    it = r.json()
    assert it["status"] == "addressed" and it["response"] == "已补充实验。"
    assert it["location"] == {"file": "main.tex", "line": 12, "section": "Experiments", "label": None}
    # GET 回读持久化
    g = c.get("/api/projects/pap1/rebuttal").json()
    assert g["items"][0]["response"] == "已补充实验。" and g["round"] == 1
    # location 显式 null = 清除
    r = c.put("/api/projects/pap1/rebuttal/items/rb-1", json={"location": None})
    assert r.status_code == 200 and r.json()["location"] is None
    # 非法状态 / 非法 location 字段 / 未知条目
    assert c.put("/api/projects/pap1/rebuttal/items/rb-1", json={"status": "done"}).status_code == 422
    assert c.put("/api/projects/pap1/rebuttal/items/rb-1", json={"location": {"foo": 1}}).status_code == 422
    assert c.put("/api/projects/pap1/rebuttal/items/rb-99", json={"response": "x"}).status_code == 404


# ---------------- AI 起草（mock 供应商）----------------


def test_ai_draft_requires_enabled_and_never_touches_response(client):
    c, _, app = client
    from app.domain import org

    _parse(c, "pap1", "Reviewer #1\n1. A point.")
    org.save_org(org.Org(ai_enabled=False))
    try:
        r = c.post("/api/projects/pap1/rebuttal/items/rb-1/draft", json={})
        assert r.status_code == 403 and r.json()["detail"]["kind"] == "ai_disabled_by_org"
        assert app.state.ai.provider.calls == []  # 团队 AI 关闭时零出站调用
    finally:
        org.save_org(org.Org(ai_enabled=True))
    r = c.post("/api/projects/pap1/rebuttal/items/rb-1/draft", json={"context": "已补充 baseline Y 的对比"})
    assert r.status_code == 200, r.text
    body = r.json()
    it = body["item"]
    # mock 无 rebuttal_draft fixture ⇒ [mock:kind] 原文诚实降级为草稿建议 + warning
    assert "[mock:rebuttal_draft]" in it["ai_draft"]["response_draft"]
    assert body["warnings"] and "JSON" in body["warnings"][0]
    # 契约：不覆盖用户 response、不改状态
    assert it["response"] == "" and it["status"] == "todo"
    assert [x["kind"] for x in app.state.ai.provider.calls] == ["rebuttal_draft"]


def test_ai_draft_uses_user_ai_and_org_provider(client, monkeypatch):
    c, _, app = client
    from app import config
    from app.domain import org, user_ai

    _parse(c, "pap1", "Reviewer #1\n1. A point.")
    # 非 mock 且未配 provider ⇒ 400 ai_not_configured
    monkeypatch.setattr(config, "AI_PROVIDER", "aicdks")
    r0 = c.post("/api/projects/pap1/rebuttal/items/rb-1/draft", json={})
    assert r0.status_code == 400 and r0.json()["detail"]["kind"] == "ai_not_configured"

    # 配置机构 ai_provider ⇒ 走 user_ai.resolve_ai_client（不再被 app.state.ai 截流）
    org.save_org(org.Org(
        ai_enabled=True,
        ai_provider=org.AiProvider(base_url="https://api.fake.example/v1", api_key="sk-org", model_interactive="m-org"),
    ))
    captured = {}

    class FakeResult:
        text = '{"response": "感谢审稿人意见。", "edits_summary": "补充实验表 2"}'
        model = "m-org"

    class FakeClient:
        def __init__(self, provider, models=None):
            captured["base_url"] = provider.base_url
            captured["models"] = models

        async def chat(self, messages, tier, **kw):
            captured["messages"] = messages
            return FakeResult()

    monkeypatch.setattr(user_ai, "AiClient", FakeClient)
    r1 = c.post("/api/projects/pap1/rebuttal/items/rb-1/draft", json={})
    assert r1.status_code == 200, r1.text
    assert captured["base_url"] == "https://api.fake.example/v1"
    assert r1.json()["item"]["ai_draft"]["response_draft"] == "感谢审稿人意见。"
    assert app.state.ai.provider.calls == []


def test_draft_missing_item_404(client):
    c, _, _ = client
    r = c.post("/api/projects/pap1/rebuttal/items/rb-42/draft", json={})
    assert r.status_code == 404 and r.json()["detail"]["kind"] == "not_found"


# ---------------- 导出 ----------------


def test_export_guards_and_formats(client):
    c, _, _ = client
    base = "/api/projects/pap1/rebuttal/export"
    assert c.get(base).status_code == 409  # 无条目
    _parse(c, "pap1", "Reviewer #1\n1. A point about X_2.")
    assert c.get(base).status_code == 409  # 有条目但全无回复
    c.put(
        "/api/projects/pap1/rebuttal/items/rb-1",
        json={"response": r"Improved by 5% on X_2; see \cite{foo}.", "edits_summary": "新增基线对比",
              "location": {"file": "main.tex", "line": 42}},
    )
    # DOCX
    r = c.get(f"{base}?format=docx")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument")
    disp = r.headers["content-disposition"]
    assert 'filename="response-letter.docx"' in disp and "filename*=UTF-8''" in disp
    assert r.content[:2] == b"PK"
    from docx import Document

    doc = Document(io.BytesIO(r.content))
    paras = [p.text for p in doc.paragraphs] + [c.text for t in doc.tables for row in t.rows for c in row.cells]
    assert "Response to Reviewers" in paras and "Reviewer 1" in paras
    assert any("A point about X_2." in p for p in paras)
    # MD
    r = c.get(f"{base}?format=md")
    assert r.status_code == 200 and "text/markdown" in r.headers["content-type"]
    md = r.content.decode("utf-8")
    assert "> 1. A point about X_2." in md and "**Response:**" in md and "## Reviewer 1" in md
    # TeX：转义（% → \%、_ → \_）与通用环境
    r = c.get(f"{base}?format=tex")
    assert r.status_code == 200 and "application/x-tex" in r.headers["content-type"]
    tex = r.content.decode("utf-8")
    assert "\\section*{Response to Reviewers}" in tex and "\\begin{itemize}" in tex
    assert "5\\%" in tex and "X\\_2" in tex and r"\textbackslash{}cite\{foo\}." in tex and "Location: main.tex 第 42 行" in tex
    # 非法格式 ⇒ 422
    assert c.get(f"{base}?format=pdf").status_code == 422


# ---------------- ACL（sqlite AUTH=on，module 级环境隔离）----------------

PW = "rb-pw-1234"


def _fresh(name):
    mod = sys.modules.get(name)
    return importlib.reload(mod) if mod is not None else importlib.import_module(name)


@pytest.fixture(scope="module")
def acl(tmp_path_factory):
    base = tmp_path_factory.mktemp("rebuttal-acl")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "rebuttal-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
        "PATENT_STUDIO_AI_PROVIDER": "mock",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in (
            "app.config",
            "app.auth.db",
            "app.auth.users",
            "app.auth.users_me",
            "app.auth.acl",
            "app.auth.router",
            "app.main",
        ):
            _fresh(name)
        from app.main import app

        def register(email):
            cc = TestClient(app)
            assert cc.post("/api/auth/register", json={"email": email, "password": PW}).status_code in (200, 201)
            assert (
                cc.post(
                    "/api/auth/cookie/login",
                    data={"username": email, "password": PW},
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                ).status_code
                == 204
            )
            return cc

        owner = register("rb-owner@x.example.com")
        r = owner.post("/api/projects", json={"id": "acl-paper", "title": "ACL", "document_type": "paper"})
        assert r.status_code == 201, r.text
        users = {}
        for email, role in (("rb-viewer@x.example.com", "viewer"), ("rb-editor@x.example.com", "editor")):
            users[role] = register(email)
            r = owner.put("/api/projects/acl-paper/members", json={"email": email, "role": role})
            assert r.status_code in (200, 201), r.text
        yield {"app": app, "viewer": users["viewer"], "editor": users["editor"]}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        # 归位 AUTH=off 并清掉仅在 on 态加载的 Auth 子模块，避免下一文件复用旧 db/users 绑定
        for name in ("app.config", "app.auth.router", "app.auth.users_me", "app.main"):
            if name in sys.modules:
                importlib.reload(sys.modules[name])
        for name in ("app.auth.users", "app.auth.acl", "app.auth.db"):
            sys.modules.pop(name, None)


def test_acl_default_method_roles(acl):
    app, viewer, editor = acl["app"], acl["viewer"], acl["editor"]
    anon = TestClient(app)
    # 未登录 401
    assert anon.get("/api/projects/acl-paper/rebuttal").status_code == 401
    assert anon.post("/api/projects/acl-paper/rebuttal/parse", json={"text": "x"}).status_code == 401
    # viewer：读 ✓，写 ✗
    assert viewer.get("/api/projects/acl-paper/rebuttal").status_code == 200
    assert viewer.post("/api/projects/acl-paper/rebuttal/parse", json={"text": "Reviewer #1\n1. p."}).status_code == 403
    assert viewer.put("/api/projects/acl-paper/rebuttal/items/rb-1", json={"response": "x"}).status_code == 403
    assert viewer.post("/api/projects/acl-paper/rebuttal/items/rb-1/draft", json={}).status_code == 403
    # export 是 GET ⇒ viewer 可进门（业务上因无回复 409，证明 ACL 已过）
    assert viewer.get("/api/projects/acl-paper/rebuttal/export?format=md").status_code == 409
    # editor：写 ✓
    r = editor.post("/api/projects/acl-paper/rebuttal/parse", json={"text": "Reviewer #1\n1. p."})
    assert r.status_code == 200, r.text
    assert editor.put("/api/projects/acl-paper/rebuttal/items/rb-1", json={"response": "ok"}).status_code == 200


# ---------------- 领域函数直测 ----------------


def test_state_corrupt_422(tmp_path):
    d = tmp_path / "p"
    (d / ".studio" / "rebuttal").mkdir(parents=True)
    (d / ".studio" / "rebuttal" / "state.json").write_text("{broken", encoding="utf-8")
    with pytest.raises(rb.RebuttalError) as ei:
        rb.load_state(str(d))
    assert ei.value.status == 422


def test_parse_reviewer_heading_styles():
    for line, name in [
        ("Reviewer #2", "Reviewer 2"),
        ("Reviewer B:", "Reviewer B"),
        ("**Reviewer 3**", "Reviewer 3"),
        ("### Reviewer 4 – Dr. Lee", "Reviewer 4"),
        ("R5:", "Reviewer 5"),
        ("审稿人1", "审稿人1"),
        ("审稿人三：", "审稿人3"),
        ("AE", "AE"),
        ("Editor:", "Editor"),
    ]:
        assert rb._reviewer_match(line) is not None
        assert rb._reviewer_match(line)[0] == name
    # 「Reviewer N 尾注正文」是合法分组标题形态（如 Reviewer 4 – Dr. Lee），尾注进正文
    hit = rb._reviewer_match("Reviewer 2 的意见很中肯")
    assert hit is not None and hit[0] == "Reviewer 2" and hit[1] == "的意见很中肯"
