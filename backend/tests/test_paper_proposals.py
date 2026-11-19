# -*- coding: utf-8 -*-
"""论文 AI 修改提案测试（v0.4）：生成（模型打桩）/ 状态机 / 幂等 / 项目隔离 / 权限 / 保护分析 / 定位。

模型调用全部打桩（不联网）；真实模型验证记录在 docs/v04-acceptance.md。
"""
import importlib
import os
import sys

import pytest
from fastapi.testclient import TestClient

PW = "pp-pw!"


def _fresh(name):
    mod = sys.modules.get(name)
    return importlib.reload(mod) if mod is not None else importlib.import_module(name)


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("pp")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "pp-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.acl", "app.auth.router", "app.main"):
            _fresh(name)
        from patent_studio.asgi import create_app

        app = create_app()

        def register(email):
            cc = TestClient(app)
            st = cc.post("/api/auth/register", json={"email": email, "password": PW})
            assert st.status_code in (200, 201), st.text
            st = cc.post("/api/auth/cookie/login", data={"username": email, "password": PW},
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            assert st.status_code == 204, st.status_code
            return cc

        admin = register("admin@pp.example.com")
        yield {"app": app, "admin": admin, "register": register}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _setup(env, email="pp@pp.example.com", provider=True):
    c = env["register"](email)
    r = c.post("/api/projects/latex-demo", json={"template": "blank"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    if provider:
        # 机构 AI 配置仅超管可写（org 级，全局共享）
        r = env["admin"].put("/api/admin/settings", json={"ai_provider": {
            "base_url": "https://api.fake.example/v1", "api_key": "sk-test",
            "model_interactive": "m1", "model_heavy": "m2", "model_fallback": "m1"}})
        assert r.status_code == 200, r.text
    return c, pid


def _read_main(c, pid):
    r = c.get(f"/api/projects/{pid}/latex/files/main.tex")
    return r.json()


def _mock_chat(monkeypatch, text='{"text": "改后的句子。", "rationale": "更流畅。"}', model="m1", capture=None):
    # v0.4.2 起 AiClient 构造统一在 app.domain.user_ai.resolve_ai_client（用户自建 > 机构）
    import app.domain.user_ai as UA

    class FakeResult:
        def __init__(self):
            self.text = text
            self.model = model

    class FakeClient:
        def __init__(self, provider, models=None):
            pass

        async def chat(self, messages, purpose, **kw):
            if capture is not None:
                capture.append(messages)
            return FakeResult()

    monkeypatch.setattr(UA, "AiClient", FakeClient)
    monkeypatch.setattr(UA, "OpenAICompatProvider", lambda key, base_url=None: type(
        "P", (), {"key": key, "base_url": base_url or ""})())


def test_generate_requires_provider(env, monkeypatch):
    c, pid = _setup(env, "noprov@pp.example.com", provider=False)
    main = _read_main(c, pid)
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "在此开始撰写。", "action": "polish"})
    assert r.status_code == 400 and "未配置" in r.json()["detail"]["message"]
    assert anon_check(env) is True


def anon_check(env):
    anon = TestClient(env["app"])
    assert anon.get("/api/projects/x/paper-proposals").status_code in (401, 404)
    return True


def _gen_pending(env, monkeypatch, email, original, suggested_json=None):
    """独立账号生成一条 pending 提案（供各测试复用；邮箱必须全局唯一）。"""
    c, pid = _setup(env, email)
    main = _read_main(c, pid)
    _mock_chat(monkeypatch, suggested_json or '{"text": "改后的句子。", "rationale": "润色"}')
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": original, "action": "polish",
        "context_before": "前文语境。", "context_after": ""})
    assert r.status_code == 200, r.text
    return c, pid, r.json()["proposal"]


def test_generate_pending_with_protection_flags(env, monkeypatch):
    c, pid, prop = _gen_pending(
        env, monkeypatch, "gen@pp.example.com",
        "实验中精度达到 92.3%，如 \\cite{vaswani} 所示。该方法效果很好。",
        '{"text": "实验中精度达到 95.7%，如 \\\\cite{other} 所示。该方法效果显著。", "rationale": "润色"}')
    assert prop["status"] == "pending"
    assert set(prop["protection_flags"]) >= {"numbers", "citations"}
    assert prop["model"] == "m1" and prop["rationale"]


def test_generate_plain_text_output(env, monkeypatch):
    c, pid = _setup(env, "plain@pp.example.com")
    main = _read_main(c, pid)
    # 模型没给 JSON，整段当建议文本
    _mock_chat(monkeypatch, "这是直接的润色结果，没有 JSON 包装。")
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "在此开始撰写。", "action": "polish"})
    prop = r.json()["proposal"]
    assert prop["suggested_text"].startswith("这是直接的润色结果")
    assert "在此开始撰写。" in _read_main(c, pid)["content"]  # 正文未被改动（服务端不落盘）


def test_generate_empty_model_output_is_failure(env, monkeypatch):
    c, pid = _setup(env, "empty@pp.example.com")
    main = _read_main(c, pid)
    _mock_chat(monkeypatch, '{"text": "  ", "rationale": ""}')
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "在此开始撰写。", "action": "polish"})
    assert r.status_code == 502
    # 失败记录持久化（刷新可查）
    props = c.get(f"/api/projects/{pid}/paper-proposals").json()["proposals"]
    assert any(p["status"] == "failed" for p in props)


def test_generate_sends_only_selection_scope(env, monkeypatch):
    c, pid = _setup(env, "scope@pp.example.com")
    main = _read_main(c, pid)
    msgs = []
    _mock_chat(monkeypatch, '{"text": "改。", "rationale": ""}', capture=msgs)
    c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "在此开始撰写。", "context_before": "AB" * 10, "context_after": "",
        "action": "polish"})
    joined = "".join(m["content"] for m in msgs[-1] if m["role"] != "system")
    full_doc = _read_main(c, pid)["content"]
    # 不外发整篇文档
    assert "\\end{document}" not in joined
    assert "在此开始撰写。" in joined  # 选区在内
    assert len(joined) < len(full_doc) + 200


def test_status_transitions_idempotent_and_invalid(env, monkeypatch):
    c, pid, prop = _gen_pending(env, monkeypatch, "trans@pp.example.com", "在此开始撰写。")
    ppid = prop["proposal_id"]
    # pending → applied（幂等重放）
    r1 = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "applied"})
    assert r1.status_code == 200 and r1.json()["proposal"]["status"] == "applied"
    r2 = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "applied"})
    assert r2.status_code == 200 and r2.json()["proposal"]["proposal_id"] == ppid
    # applied → rejected 非法 409
    r3 = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "rejected"})
    assert r3.status_code == 409
    # applied → undone → applied
    r4 = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "undone"})
    assert r4.status_code == 200 and r4.json()["proposal"]["status"] == "undone"
    r5 = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "applied"})
    assert r5.status_code == 200
    # pending → stale 可（另建一条）
    _mock_chat(monkeypatch)
    main = _read_main(c, pid)
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "另一句待改。", "action": "condense"})
    p2 = r.json()["proposal"]["proposal_id"]
    r = c.post(f"/api/projects/{pid}/paper-proposals/{p2}/status", json={"status": "stale"})
    assert r.status_code == 200
    # stale 是终态
    r = c.post(f"/api/projects/{pid}/paper-proposals/{p2}/status", json={"status": "applied"})
    assert r.status_code == 409
    # 非法状态名 422
    r = c.post(f"/api/projects/{pid}/paper-proposals/{p2}/status", json={"status": "bogus"})
    assert r.status_code == 422


def test_apply_records_edited_text(env, monkeypatch):
    c, pid = _setup(env, "edited@pp.example.com")
    main = _read_main(c, pid)
    _mock_chat(monkeypatch, '{"text": "模型原建议。", "rationale": ""}')
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "在此开始撰写。", "action": "polish"})
    ppid = r.json()["proposal"]["proposal_id"]
    # 用户编辑建议后采纳：applied_text ≠ suggested_text
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status",
               json={"status": "applied", "applied_text": "用户改过的建议。"})
    assert r.status_code == 200
    got = r.json()["proposal"]
    assert got["applied_text"] == "用户改过的建议。" and got["suggested_text"] == "模型原建议。"


def test_cross_project_isolation(env, monkeypatch):
    c, pid1 = _setup(env, "iso1@pp.example.com")
    r = c.post("/api/projects/latex-demo", json={"template": "blank"})
    pid2 = r.json()["id"]
    main = _read_main(c, pid1)
    _mock_chat(monkeypatch)
    r = c.post(f"/api/projects/{pid1}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "项目一的句子。", "action": "polish"})
    p1 = r.json()["proposal"]["proposal_id"]
    # pid2 看不到 pid1 的提案
    props2 = c.get(f"/api/projects/{pid2}/paper-proposals").json()["proposals"]
    assert all(p["proposal_id"] != p1 for p in props2)
    # pid2 上操作 pid1 的提案 → not_found
    r = c.post(f"/api/projects/{pid2}/paper-proposals/{p1}/status", json={"status": "applied"})
    assert r.status_code == 404
    # pid1 能看到并操作
    props1 = c.get(f"/api/projects/{pid1}/paper-proposals").json()["proposals"]
    assert any(p["proposal_id"] == p1 for p in props1)


def test_permissions(env, monkeypatch):
    owner, pid = _setup(env, "perm-owner@pp.example.com")
    viewer = env["register"]("perm-viewer@pp.example.com")
    reviewer = env["register"]("perm-reviewer@pp.example.com")
    anon = TestClient(env["app"])
    for email, role in (("perm-viewer@pp.example.com", "viewer"), ("perm-reviewer@pp.example.com", "reviewer")):
        r = owner.post(f"/api/projects/{pid}/invites", json={"email": email, "role": role})
        assert r.status_code in (200, 201), r.text
    main = _read_main(owner, pid)
    # 匿名 401；非成员 404
    assert anon.get(f"/api/projects/{pid}/paper-proposals").status_code == 401
    outsider = env["register"]("perm-out@pp.example.com")
    assert outsider.get(f"/api/projects/{pid}/paper-proposals").status_code == 404
    # viewer 可列表（无提案）
    assert viewer.get(f"/api/projects/{pid}/paper-proposals").status_code == 200
    # viewer/reviewer 都可发起生成（ROUTE_ROLE=viewer；模型打桩）
    _mock_chat(monkeypatch)
    for cc in (viewer, reviewer):
        r = cc.post(f"/api/projects/{pid}/paper-proposals/generate", json={
            "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
            "original_text": "在此开始撰写。", "action": "polish"})
        assert r.status_code == 200, r.text
    # 状态流转：reviewer 可以；viewer 不可以
    props = viewer.get(f"/api/projects/{pid}/paper-proposals?status=pending").json()["proposals"]
    target = props[0]["proposal_id"]
    r = viewer.post(f"/api/projects/{pid}/paper-proposals/{target}/status", json={"status": "applied"})
    assert r.status_code == 403
    r = reviewer.post(f"/api/projects/{pid}/paper-proposals/{target}/status", json={"status": "applied"})
    assert r.status_code == 200


def test_validation_bounds(env, monkeypatch):
    c, pid = _setup(env, "val@pp.example.com")
    main = _read_main(c, pid)
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "structured", "file": "content.json", "base_sha": main["sha"],
        "original_text": "结构化模式拒绝", "action": "polish"})
    assert r.status_code == 422
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "x", "action": "custom"})
    assert r.status_code == 422  # custom 无指令
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "短", "action": "nope"})
    assert r.status_code == 422


def test_proposal_id_validation(env):
    c, pid = _setup(env, "pidval@pp.example.com")
    r = c.get(f"/api/projects/{pid}/paper-proposals/../../escape")
    assert r.status_code in (404, 422)
    r = c.post(f"/api/projects/{pid}/paper-proposals/not-valid-id/status", json={"status": "applied"})
    assert r.status_code == 422


def test_writing_action_insert_proposal(env, monkeypatch):
    """写作（插入型）：original_text 允许为空；落地=光标处插入（前端事务/Word Paste）。"""
    c, pid = _setup(env, "writing@pp.example.com")
    main = _read_main(c, pid)
    _mock_chat(monkeypatch, '{"text": "近年来，深度学习方法在该领域得到广泛应用。", "rationale": "补充背景段。"}')
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "", "action": "writing",
        "instruction": "写一段约两句话的研究背景，承上启下"})
    assert r.status_code == 200, r.text
    prop = r.json()["proposal"]
    assert prop["anchor"]["insert"] is True
    assert "深度学习" in prop["suggested_text"]
    # 空指令写作 422
    r2 = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "", "action": "writing"})
    assert r2.status_code == 422
    # 非写作动作空原文 422（校验"请先选中"）
    r3 = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "", "action": "polish"})
    assert r3.status_code == 422


def test_deai_action_and_read_endpoint(env, monkeypatch):
    """去AI味 action + 精读端点：deai 走提案流；read 只读返回分析不产生提案。"""

    c, pid = _setup(env, "deai@pp.example.com")
    main = _read_main(c, pid)
    _mock_chat(monkeypatch, '{"text": "本段以更自然的口吻重述。", "rationale": "去除模板句式"}')
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "值得注意的是，本文提出了一种方法。", "action": "deai"})
    assert r.status_code == 200, r.text
    assert r.json()["proposal"]["action"] == "deai"
    # 精读：只读，不产生提案
    before = len(c.get(f"/api/projects/{pid}/paper-proposals").json()["proposals"])
    r2 = c.post(f"/api/projects/{pid}/paper-assistant/read", json={
        "mode": "latex", "file": "main.tex", "text": "这是需要精读的一段论文正文。"})
    assert r2.status_code == 200, r2.text
    assert "分析" in r2.json()["answer"] or r2.json()["answer"]
    after = c.get(f"/api/projects/{pid}/paper-proposals").json()["proposals"]
    assert len(after) == before


def test_domain_locate_and_analysis():
    from app.domain import paper_proposals as pp

    a = pp.Anchor(file="m.tex", base_sha="0" * 64, original_text="目标句", context_before="前。", context_after="后。")
    ok = pp.locate("前。目标句后。", a)
    assert ok["ok"] and ok["start"] == 2
    amb = pp.locate("前。目标句后。前。目标句后。", a)  # 两处上下文完全相同 ⇒ 歧义
    assert amb["ok"] is False and amb["reason"] == "ambiguous"
    # 多处出现但仅一处上下文匹配 ⇒ 消歧成功
    dis = pp.locate("目标句前。目标句后。目标句", a)
    assert dis["ok"] and dis["start"] == 5 and dis["reason"] == "context"
    miss = pp.locate("完全不同的文本。", a)
    assert miss["ok"] is False and miss["reason"] == "not_found"
    # 数学/引用/数值保护
    assert "math" in pp.analyze_changes("见式 $x=1$。", "见式 $x=2$。")
    assert "refs" in pp.analyze_changes("如图 \\ref{fig1}。", "如图 \\ref{fig2}。")
    assert pp.analyze_changes("纯文字润色前后。", "纯文字润色之后。") == []
    # 状态机
    assert "applied" in pp.TRANSITIONS["pending"] and "undone" in pp.TRANSITIONS["applied"]
    assert not pp.TRANSITIONS["rejected"]


def test_ai_usage_disclosure_report_and_permissions(env, monkeypatch):
    """AI 使用披露声明：空台账如实声明未用 AI；采纳/人工改写/保护项/撤销精确统计；中英×MD/LaTeX 与权限矩阵。"""
    c, pid = _setup(env, "disc-owner@pp.example.com")
    # 1. 空台账：如实声明未采纳 AI 提案
    r0 = c.get(f"/api/projects/{pid}/paper-proposals/disclosure")
    assert r0.status_code == 200, r0.text
    d0 = r0.json()
    assert d0["summary"]["used_ai"] is False
    assert d0["summary"]["applied_count"] == 0
    assert "未采纳任何 AI" in d0["content"]
    assert d0["filename"] == "ai-disclosure-zh.md"

    # 2. 生成 3 条提案：1 条采纳（人工二次编辑 + 数值保护触发）、1 条采纳后撤销、1 条拒绝
    main = _read_main(c, pid)
    _mock_chat(monkeypatch, '{"text": "精度达到 98.5% 且延迟更低。", "rationale": "提升清晰度"}')
    p1 = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "精度达到 95.0% 且延迟较低。", "action": "polish"}).json()["proposal"]["proposal_id"]
    c.post(f"/api/projects/{pid}/paper-proposals/{p1}/status", json={
        "status": "applied", "applied_text": "精度达到 95.0%，推理延迟进一步下降。"})

    _mock_chat(monkeypatch, '{"text": "第二条建议文本。", "rationale": "精简"}')
    p2 = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "第二条原始文本。", "action": "condense"}).json()["proposal"]["proposal_id"]
    c.post(f"/api/projects/{pid}/paper-proposals/{p2}/status", json={"status": "applied"})
    c.post(f"/api/projects/{pid}/paper-proposals/{p2}/status", json={"status": "undone"})

    p3 = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "第三条原始文本。", "action": "deai"}).json()["proposal"]["proposal_id"]
    c.post(f"/api/projects/{pid}/paper-proposals/{p3}/status", json={"status": "rejected"})

    # 3. 中文 Markdown 汇总核验
    rzh = c.get(f"/api/projects/{pid}/paper-proposals/disclosure?lang=zh&format=markdown")
    assert rzh.status_code == 200
    s = rzh.json()["summary"]
    assert s["used_ai"] is True
    assert s["total_proposals"] == 3
    assert s["applied_count"] == 1
    assert s["human_edited_count"] == 1
    assert s["undone_count"] == 1
    assert s["rejected_count"] == 1
    assert s["protected_applied_count"] == 1
    assert s["by_action"] == {"polish": 1}
    assert "disc-owner@pp.example.com" not in rzh.json()["content"]  # 不泄露个人邮箱 PII

    # 4. 英文 LaTeX 渲染与转义
    ren = c.get(f"/api/projects/{pid}/paper-proposals/disclosure?lang=en&format=latex")
    assert ren.status_code == 200
    assert ren.json()["filename"] == "ai-disclosure-en.tex"
    assert "\\section*{AI Usage Disclosure}" in ren.json()["content"]
    assert "language polishing (1)" in ren.json()["content"]

    # 5. 非法参数 422
    assert c.get(f"/api/projects/{pid}/paper-proposals/disclosure?lang=fr").status_code == 422
    assert c.get(f"/api/projects/{pid}/paper-proposals/disclosure?format=docx").status_code == 422

    # 6. 权限矩阵：匿名 401 / 外人 404 / viewer 200
    anon = TestClient(env["app"])
    assert anon.get(f"/api/projects/{pid}/paper-proposals/disclosure").status_code == 401
    outsider = env["register"]("disc-out@pp.example.com")
    assert outsider.get(f"/api/projects/{pid}/paper-proposals/disclosure").status_code == 404
    viewer = env["register"]("disc-view@pp.example.com")
    r_inv = c.post(f"/api/projects/{pid}/invites", json={"email": "disc-view@pp.example.com", "role": "viewer"})
    assert r_inv.status_code in (200, 201), r_inv.text
    assert viewer.get(f"/api/projects/{pid}/paper-proposals/disclosure").status_code == 200
