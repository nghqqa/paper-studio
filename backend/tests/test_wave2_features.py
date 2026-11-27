# -*- coding: utf-8 -*-
"""Wave 2 差异化核心功能综合回归测试：
- Wave 2A: Glossary CRUD/自动提取/Preflight 术语一致性/AI Prompt 注入 + 文献 PDF 归档/文字层提取/Citation-Aware AI
- Wave 2B: PAT 个人令牌/Bearer 鉴权 + Native MCP Server (JSON-RPC 2.0, Proposal-Only, ACL) + 跨项目共享文献库与 LaTeX 片段库
- Wave 2C: 审阅批注一键转 Issue 与转回复信（含幂等/ACL） + 公开审阅版本修订摘要 + 截稿日历/.ics 导出/站内提醒去重 + 协同 Presence 心跳
"""
from __future__ import annotations

import importlib
import io
import json
import os
import sys
from datetime import date, timedelta

import pytest
from docx import Document
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

if sys.platform == "win32":
    import asyncio

    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def _make_text_pdf(text: str) -> bytes:
    """生成带 Helvetica 文字层的单页合法 PDF（供 pypdf 提取文本测试）。"""
    writer = PdfWriter()
    page = writer.add_blank_page(width=595, height=842)
    safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 72 720 Td ({safe}) Tj ET".encode("latin1"))
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    stream_ref = writer._add_object(stream)
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})})
    page[NameObject("/Contents")] = stream_ref
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("wave2")
    projects = base / "projects"
    projects.mkdir()
    vars_env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "wave2-test-auth-secret-at-least-32-bytes!",
        "PATENT_PROJECTS_DIR": str(projects),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
        "PATENT_STUDIO_WORD_EDITOR": "on",
        "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "wave2-word-secret",
        "PATENT_STUDIO_ONLYOFFICE_URL": "http://localhost:9980",
        "PATENT_STUDIO_ONLYOFFICE_INTERNAL_URL": "http://onlyoffice:80",
        "PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL": "http://studio:8000",
        "PATENT_STUDIO_PUBLIC_ORIGIN": "",
        "PAPER_STUDIO_PRODUCT": "paper",
        "PAPER_STUDIO_LIBRARY_SOURCES": "on",
    }
    saved_modules = {k: m for k, m in sys.modules.items() if k == "app" or k.startswith("app.")}
    saved_env = {k: os.environ.get(k) for k in vars_env}
    os.environ.update(vars_env)
    try:
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]
        import app.main as main_mod

        importlib.reload(main_mod)
        app = main_mod.app

        def reg(name: str) -> TestClient:
            c = TestClient(app)
            email = f"{name}@wave2.example.com"
            r = c.post("/api/auth/register", json={"email": email, "password": "Wave2-test-pw!", "display_name": name})
            assert r.status_code in (200, 201), r.text
            r2 = c.post(
                "/api/auth/cookie/login",
                data={"username": email, "password": "Wave2-test-pw!"},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert r2.status_code == 204, r2.text
            return c

        admin = reg("admin")
        users = {k: reg(k) for k in ("owner", "editor", "reviewer", "viewer", "outsider")}
        assert admin.put(
            "/api/admin/settings",
            json={
                "ai_provider": {
                    "base_url": "https://api.fake.example/v1",
                    "api_key": "sk-wave2-test",
                    "model_interactive": "m-fast",
                    "model_heavy": "m-heavy",
                    "model_fallback": "m-fast",
                }
            },
        ).status_code == 200
        yield {"app": app, "admin": admin, "users": users, "projects": projects}
    finally:
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
            del sys.modules[k]
        sys.modules.update(saved_modules)


def _create_latex_project(env) -> str:
    owner = env["users"]["owner"]
    r = owner.post("/api/projects/latex-demo", json={"template": "blank"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    for role in ("editor", "reviewer", "viewer"):
        rm = owner.put(
            f"/api/projects/{pid}/members",
            json={"email": f"{role}@wave2.example.com", "role": role},
        )
        assert rm.status_code in (200, 201), rm.text
    return pid


def _mock_ai(monkeypatch, chunks: list[str], capture: list | None = None):
    import app.domain.user_ai as ua

    class _FakeRes:
        def __init__(self, text: str, model: str = "m-fast"):
            self.text = text
            self.model = model

    class _FakeClient:
        async def chat(self, messages, purpose, **kwargs):
            if capture is not None:
                capture.append((messages, purpose, kwargs))
            return _FakeRes("".join(chunks))

    monkeypatch.setattr(ua, "resolve_ai_client", lambda *a, **kw: (_FakeClient(), None))


def test_glossary_crud_extract_preflight_and_ai_injection(env, monkeypatch):
    pid = _create_latex_project(env)
    owner = env["users"]["owner"]
    viewer = env["users"]["viewer"]

    tex = (
        "\\documentclass{article}\n"
        "\\newcommand{\\lossop}{\\mathcal{L}}\n"
        "\\begin{document}\n"
        "We propose a Federated Aggregation Module (FAM) using neural net training.\n"
        "Our Adaptive Gradient Routing (AGR) module scales smoothly.\n"
        "\\end{document}\n"
    )
    assert owner.put(f"/api/projects/{pid}/latex/files/main.tex", json={"content": tex}).status_code == 200

    # viewer 只读不可增删改术语表
    assert (
        viewer.post(
            f"/api/projects/{pid}/glossary",
            json={"term": "Neural Network", "aliases": ["neural net"], "enforce": True},
        ).status_code
        == 403
    )

    rc = owner.post(
        f"/api/projects/{pid}/glossary",
        json={
            "term": "Neural Network",
            "category": "term",
            "aliases": ["neural net"],
            "symbol": "\\mathcal{N}",
            "definition": "Standard capitalized terminology.",
            "enforce": True,
        },
    )
    assert rc.status_code == 200, rc.text
    gid = rc.json()["entry"]["id"]

    # 自动扫描缩略语与自定义数学宏并入库
    rx = owner.post(f"/api/projects/{pid}/glossary/extract", json={"commit": True})
    assert rx.status_code == 200, rx.text
    terms = {e["term"] for e in rx.json()["entries"]}
    assert "Neural Network" in terms
    assert "FAM" in terms or "\\lossop" in terms

    # Preflight 应检出弃用别名 "neural net"（告警 warn）
    rp = owner.post(f"/api/projects/{pid}/latex/preflight", json={"ruleset": "latex-general"})
    assert rp.status_code == 200, rp.text
    items = {it["rule_id"]: it for it in rp.json()["report"]["items"]}
    assert "latex-glossary-consistency" in items
    assert items["latex-glossary-consistency"]["status"] == "warn"
    assert "neural net" in items["latex-glossary-consistency"]["evidence"]

    # 替换为规范术语后，Preflight 术语一致性变为 pass
    fixed_tex = tex.replace("neural net", "Neural Network")
    r_put = owner.put(f"/api/projects/{pid}/latex/files/main.tex", json={"content": fixed_tex})
    assert r_put.status_code == 200
    sha = r_put.json()["sha"]
    rp2 = owner.post(f"/api/projects/{pid}/latex/preflight", json={"ruleset": "latex-general"})
    assert rp2.status_code == 200
    items2 = {it["rule_id"]: it for it in rp2.json()["report"]["items"]}
    assert items2["latex-glossary-consistency"]["status"] == "pass"

    # AI 生成提案注入项目术语表约束
    captured: list = []
    _mock_ai(monkeypatch, ['{"text": "We train the Neural Network efficiently.", "rationale": "统一术语"}'], captured)
    r_ai = owner.post(
        f"/api/projects/{pid}/paper-proposals/generate",
        json={
            "mode": "latex",
            "action": "polish",
            "file": "main.tex",
            "base_sha": sha,
            "original_text": "We train neural net fast.",
            "use_glossary": True,
        },
    )
    assert r_ai.status_code == 200, r_ai.text
    prompt_dump = json.dumps(captured[0][0], ensure_ascii=False)
    assert "Neural Network" in prompt_dump and "neural net" in prompt_dump

    assert owner.patch(f"/api/projects/{pid}/glossary/{gid}", json={"enforce": False}).status_code == 200
    assert owner.delete(f"/api/projects/{pid}/glossary/{gid}").status_code == 200


def test_library_pdf_archive_and_citation_aware_ai(env, monkeypatch):
    pid = _create_latex_project(env)
    owner = env["users"]["owner"]
    viewer = env["users"]["viewer"]

    assert owner.post(f"/api/projects/{pid}/library/bib-file", json={"name": "refs.bib"}).status_code == 200
    rc = owner.post(
        f"/api/projects/{pid}/library/commit",
        json={
            "target_bib": "refs.bib",
            "entries": [
                {
                    "citation_key": "vaswani2017attention",
                    "entry_type": "inproceedings",
                    "title": "Attention Is All You Need",
                    "authors": ["Ashish Vaswani", "Noam Shazeer"],
                    "year": "2017",
                    "venue": "NeurIPS",
                }
            ],
        },
    )
    assert rc.status_code == 200, rc.text
    rid = rc.json()["reference_ids"][0]

    # 拒绝非 PDF 上传
    bad = owner.post(
        f"/api/projects/{pid}/library/entries/{rid}/pdf",
        files={"file": ("not_pdf.txt", b"hello", "text/plain")},
    )
    assert bad.status_code == 422

    pdf_bytes = _make_text_pdf("Transformer Scaling Law Evidence 2017")
    up = owner.post(
        f"/api/projects/{pid}/library/entries/{rid}/pdf",
        files={"file": ("attention.pdf", pdf_bytes, "application/pdf")},
    )
    assert up.status_code == 200, up.text
    assert up.json()["pdf"]["pages"] == 1

    # 列表应附带 pdf 元信息
    lib = viewer.get(f"/api/projects/{pid}/library").json()
    ent = next(e for e in lib["entries"] if e["reference_id"] == rid)
    assert ent["pdf"]["filename"] == "attention.pdf"

    # 阅读器下载 PDF 与提取文本
    got_pdf = viewer.get(f"/api/projects/{pid}/library/entries/{rid}/pdf")
    assert got_pdf.status_code == 200 and got_pdf.headers["content-type"] == "application/pdf"
    got_txt = viewer.get(f"/api/projects/{pid}/library/entries/{rid}/pdf/text")
    assert got_txt.status_code == 200, got_txt.text
    assert "Transformer Scaling Law Evidence 2017" in got_txt.json()["text"]

    # Citation-Aware AI：自动把 cite_keys 文献卡片及 PDF 原文摘录注入 Prompt
    main_sha = owner.get(f"/api/projects/{pid}/latex/files/main.tex").json()["sha"]
    captured: list = []
    _mock_ai(
        monkeypatch,
        ['{"text": "Self-attention replaces recurrence \\\\cite{vaswani2017attention}.", "rationale": "已附真实引用"}'],
        captured,
    )
    gen = owner.post(
        f"/api/projects/{pid}/paper-proposals/generate",
        json={
            "mode": "latex",
            "action": "writing",
            "file": "main.tex",
            "base_sha": main_sha,
            "instruction": "撰写自注意力机制背景",
            "cite_keys": ["vaswani2017attention"],
        },
    )
    assert gen.status_code == 200, gen.text
    prompt_dump = json.dumps(captured[0][0], ensure_ascii=False)
    assert "vaswani2017attention" in prompt_dump
    assert "Attention Is All You Need" in prompt_dump
    assert "Transformer Scaling Law Evidence 2017" in prompt_dump

    assert owner.delete(f"/api/projects/{pid}/library/entries/{rid}/pdf").status_code == 200
    assert owner.get(f"/api/projects/{pid}/library/entries/{rid}/pdf").status_code == 404


def test_pat_mcp_server_and_proposal_only_acl(env):
    pid = _create_latex_project(env)
    owner = env["users"]["owner"]
    viewer = env["users"]["viewer"]

    orig_tex = owner.get(f"/api/projects/{pid}/latex/files/main.tex").json()["content"]

    # 1) 创建并校验 PAT 明文脱敏
    rt = owner.post("/api/tokens", json={"name": "Claude Code CLI", "expires_days": 30})
    assert rt.status_code == 201, rt.text
    pat_obj = rt.json()["token"]
    plain_pat = pat_obj["token"]
    assert plain_pat.startswith("ps_pat_")

    rl = owner.get("/api/tokens").json()
    listed = next(t for t in rl["tokens"] if t["id"] == pat_obj["id"])
    assert "token" not in listed and plain_pat.startswith(listed["prefix"])

    vt = viewer.post("/api/tokens", json={"name": "Viewer PAT"}).json()["token"]["token"]

    # 2) 使用无 Cookie 客户端 Bearer 调用原生 MCP Server
    anon = TestClient(env["app"])
    assert anon.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}).status_code == 401

    hdr_owner = {"Authorization": f"Bearer {plain_pat}"}
    hdr_viewer = {"Authorization": f"Bearer {vt}"}

    r_init = anon.post("/api/mcp", headers=hdr_owner, json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert r_init.status_code == 200 and r_init.json()["result"]["serverInfo"]["name"] == "paper-studio-mcp"

    r_tools = anon.post("/api/mcp", headers=hdr_owner, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tool_names = {t["name"] for t in r_tools.json()["result"]["tools"]}
    assert {"paper_list_projects", "paper_read_file", "paper_create_proposal", "paper_run_preflight"}.issubset(tool_names)

    # 验证修复后的 paper_list_projects 与 paper://projects 资源
    r_proj = anon.post(
        "/api/mcp",
        headers=hdr_owner,
        json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "paper_list_projects", "arguments": {}}},
    )
    assert r_proj.status_code == 200, r_proj.text
    assert any(p["id"] == pid for p in r_proj.json()["result"]["structuredContent"]["projects"])

    r_res = anon.post(
        "/api/mcp",
        headers=hdr_owner,
        json={"jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": {"uri": "paper://projects"}},
    )
    assert r_res.status_code == 200 and pid in r_res.json()["result"]["contents"][0]["text"]

    # Proposal-Only 合约：MCP 生成提案仅进 pending 队列，不静默改写源码
    r_prop = anon.post(
        "/api/mcp",
        headers=hdr_owner,
        json={
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "paper_create_proposal",
                "arguments": {
                    "pid": pid,
                    "file": "main.tex",
                    "action": "writing",
                    "instruction": "Insert abstract note",
                    "suggested_text": "% MCP Suggested Abstract",
                },
            },
        },
    )
    assert r_prop.status_code == 200, r_prop.text
    prop_data = r_prop.json()["result"]["structuredContent"]
    assert prop_data["proposal"]["status"] == "pending"
    assert "proposal_only" in prop_data["contract"]
    assert owner.get(f"/api/projects/{pid}/latex/files/main.tex").json()["content"] == orig_tex

    # viewer PAT 调用写提案必须被 403 拦截
    r_v = anon.post(
        "/api/mcp",
        headers=hdr_viewer,
        json={
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "paper_create_proposal",
                "arguments": {"pid": pid, "file": "main.tex", "suggested_text": "bad"},
            },
        },
    )
    assert r_v.status_code == 403

    # 3) 吊销后令牌立即失效 401
    assert owner.delete(f"/api/tokens/{pat_obj['id']}").status_code == 200
    assert (
        anon.post("/api/mcp", headers=hdr_owner, json={"jsonrpc": "2.0", "id": 7, "method": "tools/list"}).status_code
        == 401
    )


def test_shared_library_and_snippets_cross_project(env):
    pid = _create_latex_project(env)
    owner = env["users"]["owner"]

    # 内置片段初始可见，删除不存在片段报 404，自定义片段可增删
    rs = owner.get("/api/shared/snippets").json()
    builtin = [s for s in rs["items"] if s["builtin"]]
    assert len(builtin) >= 4
    assert owner.delete("/api/shared/snippets/snp_nonexistent").status_code == 404

    cs = owner.post(
        "/api/shared/snippets",
        json={"title": "实验消融三线表", "category": "表格", "code": "\\begin{table}[t]\\end{table}"},
    )
    assert cs.status_code == 200, cs.text
    sid = cs.json()["item"]["id"]
    assert owner.delete(f"/api/shared/snippets/{sid}").status_code == 200

    # 个人共享文献库存入 + 导入至 LaTeX 项目并自动去重改名 key
    bib = "@article{lecun2015deep,\n  title={Deep learning},\n  author={LeCun, Yann},\n  journal={Nature},\n  year={2015}\n}"
    al = owner.post("/api/shared/library", json={"bibtex": bib})
    assert al.status_code == 200, al.text
    assert al.json()["added"] == 1
    item_id = al.json()["items"][0]["id"]

    imp1 = owner.post(f"/api/projects/{pid}/library/import-from-shared", json={"item_ids": [item_id]})
    assert imp1.status_code == 200, imp1.text
    assert imp1.json()["imported"] == 1

    imp2 = owner.post(f"/api/projects/{pid}/library/import-from-shared", json={"item_ids": [item_id]})
    assert imp2.status_code == 200
    keys = [e["citation_key"] for e in owner.get(f"/api/projects/{pid}/library").json()["entries"]]
    assert len(keys) == len(set(keys)) == 2


def test_wave2c_comments_promote_public_revisions_deadlines_and_presence(env):
    pid = _create_latex_project(env)
    owner = env["users"]["owner"]
    viewer = env["users"]["viewer"]

    read = owner.get(f"/api/projects/{pid}/latex/files/main.tex").json()
    rc = viewer.post(
        f"/api/projects/{pid}/comments",
        json={
            "anchor": {"file": "main.tex", "line_start": 1, "line_end": 1, "line": 1, "sha": read["sha"]},
            "body": "Please clarify ablation metrics in Section 4.",
        },
    )
    assert rc.status_code == 201, rc.text
    cid = rc.json()["id"]

    # 1) 批注转待办 Issue & 转回复信条目（viewer 403，owner 200 且幂等）
    assert viewer.post(f"/api/projects/{pid}/comments/{cid}/promote-to-issue").status_code == 403
    assert viewer.post(f"/api/projects/{pid}/comments/{cid}/promote-to-rebuttal").status_code == 403

    ri1 = owner.post(f"/api/projects/{pid}/comments/{cid}/promote-to-issue")
    assert ri1.status_code == 200, ri1.text
    assert ri1.json()["already_linked"] is False
    issue_id = ri1.json()["issue"]["id"]
    ri2 = owner.post(f"/api/projects/{pid}/comments/{cid}/promote-to-issue")
    assert ri2.status_code == 200 and ri2.json()["already_linked"] is True and ri2.json()["issue_id"] == issue_id

    rb1 = owner.post(f"/api/projects/{pid}/comments/{cid}/promote-to-rebuttal")
    assert rb1.status_code == 200, rb1.text
    assert rb1.json()["already_linked"] is False
    item_id = rb1.json()["item"]["id"]
    reb_state = owner.get(f"/api/projects/{pid}/rebuttal").json()
    assert any(it["id"] == item_id and cid in it["comment_ids"] for it in reb_state["items"])
    rb2 = owner.post(f"/api/projects/{pid}/comments/{cid}/promote-to-rebuttal")
    assert rb2.status_code == 200 and rb2.json()["already_linked"] is True

    # 2) 公开审阅链接脱敏版本演进摘要（Word + LaTeX）
    tok_l = owner.post(f"/api/projects/{pid}/public-links", json={"scope": "comment", "ttl_days": 7}).json()["token"]
    anon = TestClient(env["app"])
    pub_rev_l = anon.get(f"/api/public/{tok_l}/revisions")
    assert pub_rev_l.status_code == 200, pub_rev_l.text
    assert pub_rev_l.json()["source_format"] == "latex"
    assert isinstance(pub_rev_l.json()["versions"], list)

    rw = owner.post("/api/projects/word/create", json={"title": "Word 公开对比", "template": "blank"})
    assert rw.status_code == 200, rw.text
    wpid = rw.json()["id"]
    v1_bytes = owner.get(f"/api/projects/{wpid}/word/download").content
    doc = Document(io.BytesIO(v1_bytes))
    doc.add_paragraph("Added experimental benchmark table.")
    buf = io.BytesIO()
    doc.save(buf)
    from app.domain import word_documents as w_dom

    assert (
        owner.post(
            f"/api/projects/{wpid}/word/upload-version",
            files={"file": ("v2.docx", buf.getvalue(), w_dom.DOCX_MEDIA)},
        ).status_code
        == 200
    )
    tok_w = owner.post(f"/api/projects/{wpid}/public-links", json={"scope": "comment", "ttl_days": 7}).json()["token"]
    pub_rev_w = anon.get(f"/api/public/{tok_w}/revisions")
    assert pub_rev_w.status_code == 200, pub_rev_w.text
    assert pub_rev_w.json()["source_format"] == "docx"
    assert pub_rev_w.json()["latest_diff"]["added"] >= 1
    assert "Added experimental benchmark table." in pub_rev_w.json()["latest_diff"]["unified_diff"]

    # 3) 截稿日历 + RFC 5545 .ics + 站内提醒（同日去重）
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    assert (
        owner.put(
            f"/api/projects/{pid}/settings",
            json={"submission": {"venue": "NeurIPS 2027", "deadline": tomorrow, "stage": "draft"}},
        ).status_code
        == 200
    )
    dl = owner.get("/api/deadlines").json()
    hit = next(it for it in dl["items"] if it["pid"] == pid)
    assert hit["status"] == "soon" and hit["days_left"] == 1

    ics = owner.get("/api/deadlines/calendar.ics")
    assert ics.status_code == 200 and "text/calendar" in ics.headers["content-type"]
    assert "BEGIN:VCALENDAR\r\n" in ics.text and f"UID:deadline-{pid}@paper-studio.local" in ics.text
    assert "TRIGGER:-P7D" in ics.text and "TRIGGER:-P1D" in ics.text

    rem1 = owner.post("/api/deadlines/remind-check").json()
    assert rem1["notified"] >= 1
    rem2 = owner.post("/api/deadlines/remind-check").json()
    assert rem2["notified"] == 0
    notifs = owner.get("/api/notifications").json()["items"]
    assert any(n["kind"] == "deadline" and n["project_id"] == pid for n in notifs)

    # 4) 协同 Presence 心跳（viewer 允许上报/读取/离开）
    p1 = viewer.post(
        f"/api/projects/{pid}/presence",
        json={"client_id": "cli-viewer-1", "file": "main.tex", "line": 12, "mode": "latex"},
    )
    assert p1.status_code == 200, p1.text
    assert any(p["client_id"] == "cli-viewer-1" and p["line"] == 12 for p in p1.json()["peers"])
    assert len(owner.get(f"/api/projects/{pid}/presence").json()["peers"]) == 1
    assert viewer.delete(f"/api/projects/{pid}/presence?client_id=cli-viewer-1").status_code == 204
    assert owner.get(f"/api/projects/{pid}/presence").json()["peers"] == []
