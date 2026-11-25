# -*- coding: utf-8 -*-
"""回归测试：公网注册访问控制（open/invite_only/closed + 邀请码 + 域名白名单）与站内通知铃铛后端链路。"""
from __future__ import annotations

import importlib
import json
import sys

from fastapi.testclient import TestClient


def _boot(tmp_path, monkeypatch, request, *, reg_mode: str = "open", invite_code: str = "", domains: str = ""):
    proj = tmp_path / "projects"
    proj.mkdir(parents=True, exist_ok=True)
    d = proj / "demo-paper"
    d.mkdir()
    (d / "studio.json").write_text(
        json.dumps({"document_type": "paper", "source_format": "latex", "title": "演示科研论文"}, ensure_ascii=False),
        encoding="utf-8",
    )
    (d / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\nHello\\end{document}\n", encoding="utf-8")

    monkeypatch.setenv("PAPER_STUDIO_PROJECTS_DIR", str(proj))
    monkeypatch.setenv("PAPER_STUDIO_AUTH", "on")
    monkeypatch.setenv("PAPER_STUDIO_SECRET", "reg-notify-test-secret-32-chars-!!")
    monkeypatch.setenv("PAPER_STUDIO_PRODUCT", "paper")
    monkeypatch.setenv("PAPER_STUDIO_REGISTRATION_MODE", reg_mode)
    monkeypatch.setenv("PAPER_STUDIO_REGISTRATION_INVITE_CODE", invite_code)
    monkeypatch.setenv("PAPER_STUDIO_REGISTRATION_ALLOWED_DOMAINS", domains)

    saved = {k: m for k, m in sys.modules.items() if k == "app" or k.startswith("app.")}

    def _restore():
        for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
            del sys.modules[k]
        sys.modules.update(saved)

    request.addfinalizer(_restore)

    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    import app.main as main_mod

    importlib.reload(main_mod)
    return main_mod.app


def _register(client: TestClient, email: str, password: str = "ValidPass123!", invite_code: str = "", display_name: str = ""):
    body = {"email": email, "password": password, "display_name": display_name}
    if invite_code:
        body["invite_code"] = invite_code
    return client.post("/api/auth/register", json=body)


def _login(app, email: str, password: str = "ValidPass123!") -> TestClient:
    c = TestClient(app)
    r = c.post("/api/auth/cookie/login", data={"username": email, "password": password})
    assert r.status_code == 204, r.text
    return c


def test_registration_policy_enforcement_and_masking(tmp_path, monkeypatch, request):
    # 1. 启动默认为 open，首个注册用户自动成为管理员；之后由管理员切换为 closed
    app = _boot(tmp_path / "t1", monkeypatch, request)
    anon = TestClient(app)
    r_su = _register(anon, "admin@example.com", display_name="管理员")
    assert r_su.status_code == 201, r_su.text
    su = _login(app, "admin@example.com")

    # 切为 closed
    r_set = su.put("/api/admin/settings", json={"registration": {"mode": "closed"}})
    assert r_set.status_code == 200, r_set.text
    assert r_set.json()["registration"]["mode"] == "closed"
    assert anon.get("/api/meta").json()["registration"] == {
        "mode": "closed",
        "invite_code_required": False,
        "allowed_domains": [],
    }
    r_closed = _register(anon, "newuser@example.com")
    assert r_closed.status_code == 403
    assert r_closed.json()["detail"]["detail"] == "registration_closed"

    # 2. 切为 invite_only + 邀请码 + 域名白名单 edu.cn
    r_set2 = su.put(
        "/api/admin/settings",
        json={"registration": {"mode": "invite_only", "invite_code": "LAB-2026", "allowed_domains": ["edu.cn"]}},
    )
    assert r_set2.status_code == 200, r_set2.text
    reg_info = r_set2.json()["registration"]
    assert reg_info == {
        "mode": "invite_only",
        "has_invite_code": True,
        "invite_code_hint": "•••2026",
        "allowed_domains": ["edu.cn"],
    }
    meta_reg = anon.get("/api/meta").json()["registration"]
    assert "LAB-2026" not in json.dumps(meta_reg)
    assert "LAB-2026" not in json.dumps(su.get("/api/admin/settings").json())
    assert meta_reg == {"mode": "invite_only", "invite_code_required": True, "allowed_domains": ["edu.cn"]}

    # 仅改 mode 时传 omit invite_code，不应覆盖既有邀请码
    r_keep = su.put("/api/admin/settings", json={"registration": {"allowed_domains": ["edu.cn"]}})
    assert r_keep.json()["registration"]["has_invite_code"] is True

    # 无码 / 错码被拒
    r_no_code = _register(anon, "student@mails.tsinghua.edu.cn")
    assert r_no_code.status_code == 403
    assert r_no_code.json()["detail"]["detail"] == "registration_invite_invalid"

    r_bad_code = _register(anon, "student@mails.tsinghua.edu.cn", invite_code="WRONG")
    assert r_bad_code.status_code == 403
    assert r_bad_code.json()["detail"]["detail"] == "registration_invite_invalid"

    # 对码但非白名单域名（及后缀欺骗 badedu.cn）被拒
    for bad_mail in ("user@gmail.com", "user@badedu.cn"):
        r_bad_dom = _register(anon, bad_mail, invite_code="LAB-2026")
        assert r_bad_dom.status_code == 403, bad_mail
        assert r_bad_dom.json()["detail"]["detail"] == "registration_domain_not_allowed"

    # 正确邀请码 + 白名单子域名邮箱放行
    r_ok = _register(anon, "student@mails.tsinghua.edu.cn", invite_code="LAB-2026", display_name="张同学")
    assert r_ok.status_code == 201, r_ok.text

    # 3. 管理员在项目里先发待接受邮箱邀请（即使非白名单、且不填站点邀请码）也可完成注册
    r_inv = su.post("/api/projects/demo-paper/invites", json={"email": "ext@partner.org", "role": "reviewer"})
    assert r_inv.status_code in (200, 201), r_inv.text
    r_ext = _register(anon, "ext@partner.org", display_name="外部合作者")
    assert r_ext.status_code == 201, r_ext.text


def test_in_app_notifications_lifecycle(tmp_path, monkeypatch, request):
    app = _boot(tmp_path / "t2", monkeypatch, request)
    anon = TestClient(app)
    assert anon.get("/api/notifications").status_code == 401

    assert _register(anon, "owner@example.com", display_name="导师").status_code == 201
    assert _register(anon, "editor@example.com", display_name="一作").status_code == 201
    assert _register(anon, "reviewer@example.com", display_name="二作").status_code == 201

    owner = _login(app, "owner@example.com")
    editor = _login(app, "editor@example.com")
    reviewer = _login(app, "reviewer@example.com")

    # owner 加入 editor 与 reviewer 到项目 demo-paper
    assert owner.put("/api/projects/demo-paper/members", json={"email": "editor@example.com", "role": "editor"}).status_code == 200
    assert owner.put("/api/projects/demo-paper/members", json={"email": "reviewer@example.com", "role": "reviewer"}).status_code == 200

    # editor 与 reviewer 都应收到 invite 通知；owner 不应收到自己发出的 invite 通知
    ed_notes = editor.get("/api/notifications").json()
    assert ed_notes["unread_count"] == 1
    assert ed_notes["items"][0]["kind"] == "invite"
    assert "演示科研论文" in ed_notes["items"][0]["title"]
    assert owner.get("/api/notifications").json()["unread_count"] == 0

    # reviewer 发表评论并 @editor：editor 只收 1 条 mention（不与 comment 重复），owner 收 1 条 comment
    r_cmt = reviewer.post(
        "/api/projects/demo-paper/comments",
        json={"anchor": {"block_id": "latex:main.tex:L3", "line": 3, "file": "main.tex"}, "body": "@一作 请核对这一段公式"},
    )
    assert r_cmt.status_code == 201, r_cmt.text
    cid = r_cmt.json()["id"]

    ed_notes2 = editor.get("/api/notifications").json()
    assert [n["kind"] for n in ed_notes2["items"]] == ["mention", "invite"]
    assert f"#/p/demo-paper?c={cid}" == ed_notes2["items"][0]["href"]

    owner_notes = owner.get("/api/notifications").json()
    assert owner_notes["unread_count"] == 1
    assert owner_notes["items"][0]["kind"] == "comment"

    # 创建公开审阅链接，匿名审阅者发表批注与确认定稿
    link = owner.post("/api/projects/demo-paper/public-links", json={"scope": "confirm", "allow_download": False}).json()
    token = link["token"]
    assert anon.post(
        f"/api/public/{token}/comments",
        json={"name": "外审专家", "anchor": {"block_id": "pdf:page-1", "line": 1, "quote": "第 1 页"}, "body": "请补充实验对比"},
    ).status_code == 201
    assert anon.post(f"/api/public/{token}/confirm", json={"name": "外审专家", "note": "同意定稿"}).status_code == 200

    owner_notes2 = owner.get("/api/notifications").json()
    assert owner_notes2["unread_count"] == 3
    assert [n["kind"] for n in owner_notes2["items"]] == ["confirm", "comment", "comment"]

    # 单条标记已读（跨用户无权操作返回 404）
    first_id = owner_notes2["items"][0]["id"]
    assert editor.post(f"/api/notifications/{first_id}/read").status_code == 404
    r_read1 = owner.post(f"/api/notifications/{first_id}/read")
    assert r_read1.status_code == 200
    assert r_read1.json()["unread_count"] == 2

    # 全部已读
    r_read_all = owner.post("/api/notifications/read-all")
    assert r_read_all.status_code == 200
    assert r_read_all.json()["unread_count"] == 0
    assert owner.get("/api/notifications?unread_only=true").json()["items"] == []
