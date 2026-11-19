# -*- coding: utf-8 -*-
"""per-user 每日 AI 配额（v0.6.7）：计数/跨天归零/闸/BYOK 豁免/记账/管理端点。"""
import json
import time

import pytest

from app.domain import ai_quota


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(tmp_path / "projects"))
    monkeypatch.setenv("PATENT_STUDIO_AUTH", "off")
    import importlib

    from app import config, atomic
    from app.domain import org as org_mod
    from app.domain import user_ai as user_ai_mod
    from app.domain import ai_quota as ai_quota_mod

    importlib.reload(config)
    importlib.reload(atomic)
    importlib.reload(org_mod)
    importlib.reload(user_ai_mod)
    importlib.reload(ai_quota_mod)
    (tmp_path / "projects").mkdir()
    return tmp_path / "projects", ai_quota_mod, org_mod, user_ai_mod, config


def test_add_and_cross_day_roll(env):
    projects, q, _org, _ua, _config = env
    import os

    q.add("u1", 100, now=time.time())
    q.add("u1", 50, now=time.time())
    assert q.used_today("u1") == 150
    assert os.path.isfile(q.quota_path("u1"))
    # 跨天：_load 按本地日串判定，day 不匹配归零
    yesterday = time.time() - 86400 * 2
    q.add("u2", 999, now=yesterday)
    assert q.used_today("u2") == 0  # 文件里的 day 是两天前 ⇒ 视为新一天从零
    # 非正数不落盘
    q.add("u3", 0)
    assert not os.path.exists(q.quota_path("u3"))


def test_check_gate_and_zero_means_off(env):
    projects, q, org, _ua, _config = env
    # 缺省 0=不限
    q.check("u1")  # 不抛
    # 设上限 100：80 已用 → 放行；再 30 → 闸
    data = org.load_org()
    org.save_org(data.model_copy(update={"ai_user_daily_tokens": 100}))
    q.add("u1", 80)
    q.check("u1")
    q.add("u1", 30)
    from app.errors import kind_error

    with pytest.raises(Exception) as ei:
        q.check("u1")
    assert "budget" in str(ei.value.detail.get("kind") if hasattr(ei.value, "detail") else ei.value)


def test_resolve_ai_client_byok_exempt_and_org_counted(env, monkeypatch):
    projects, q, org, ua, config = env
    # 机构接入 + 上限 10
    data = org.load_org()
    org.save_org(data.model_copy(update={
        "ai_user_daily_tokens": 10,
        "ai_provider": {"base_url": "https://api.example.com/v1", "api_key": "sk-org",
                        "model_interactive": "m1"},
    }))
    # BYOK：自建接入不占机构额度
    from app.domain.org import AiProvider

    ua.save_user_provider("byok-user", AiProvider(
        base_url="https://my.api/v1", api_key="sk-my", model_interactive="m-my",
        model_heavy="", model_fallback="",
    ))

    class FakeUsage:
        def __init__(self, t):
            self.total_tokens = t

    # 打桩 AiClient（既有打桩点语义）：捕获 provider；on_record 钩子照常可挂
    class FakeClient:
        def __init__(self, provider, models=None):
            self.provider = provider
            self.on_record = None
            self.recorded = []

        async def chat(self, *a, **k):
            # 预留制下结算发生在 chat（guard）内部经 _record 回执
            return type("R", (), {"text": "x", "model": "m"})()

        def _record(self, project_dir, **kw):
            if self.on_record is not None:
                self.recorded.append(kw)
                self.on_record(kw)

    monkeypatch.setattr(ua, "AiClient", FakeClient)

    import asyncio

    # org 用户：惰性预留（chat 前零占用），chat 后回执结算净额
    user = type("U", (), {"id": "u-org"})()
    client, _p = ua.resolve_ai_client(user)
    assert callable(client.on_record) and q.used_today("u-org") == 0
    asyncio.run(client.chat([{"role": "user", "content": "x"}]))
    client._record(None, usage=FakeUsage(7), ok=True)
    assert q.used_today("u-org") == 7
    asyncio.run(client.chat([{"role": "user", "content": "y"}]))
    client._record(None, usage=FakeUsage(5), ok=True)
    assert q.used_today("u-org") == 12
    # 失败回执不计
    before = q.used_today("u-org")
    client.on_record({"usage": FakeUsage(50), "ok": False})
    assert q.used_today("u-org") == before
    # BYOK 用户：不触发闸与记账
    user2 = type("U", (), {"id": "byok-user"})()
    client2, _p2 = ua.resolve_ai_client(user2)
    assert client2.on_record is None
    asyncio.run(client2.chat([]))
    client2._record(None, usage=FakeUsage(100000), ok=True)
    assert q.used_today("byok-user") == 0
    # org 用户已超限（12 >= 10）→ chat 内预留 429
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        asyncio.run(client.chat([]))
    assert ei.value.status_code == 429


def test_overview_and_reset(env):
    projects, q, _org, _ua, _config = env
    q.add("u1", 100)
    q.add("u2", 30)
    rows = q.overview()
    assert {r["uid"] for r in rows} >= {"u1", "u2"}
    assert next(r for r in rows if r["uid"] == "u1")["used"] == 100
    assert q.reset("u1") is True
    assert q.used_today("u1") == 0
    assert q.reset("nonexistent") is False


def test_admin_endpoints_superuser_gate(env):
    projects, q, _org, _ua, _config = env
    import importlib

    from app import main
    importlib.reload(main)
    from fastapi.testclient import TestClient

    c = TestClient(main.app)
    q.add("someone", 42)
    # auth=off：管理端点可用（无超管概念）
    r = c.get("/api/admin/ai-usage")
    assert r.status_code == 200
    body = r.json()
    assert body["user_quota"] == 0
    assert any(x["uid"] == "someone" and x["used"] == 42 for x in body["by_user"])
    r = c.post("/api/admin/ai-usage/someone/reset")
    assert r.status_code == 200 and r.json()["removed"] is True
    assert all(x["uid"] != "someone" for x in c.get("/api/admin/ai-usage").json()["by_user"])
    # org settings 读写新字段
    r = c.put("/api/admin/settings", json={"ai_user_daily_tokens": 5000})
    assert r.status_code == 200 and r.json()["ai_user_daily_tokens"] == 5000
    assert c.get("/api/admin/settings").json()["ai_user_daily_tokens"] == 5000


def test_reserve_and_settle(env, monkeypatch):
    """预留制：请求时 check+扣减原子完成（封排队窗口），落账净额多退少补；
    尾部不足按剩余量预留；超限 429。"""
    projects, q, org, ua, config = env
    monkeypatch.setattr(q, "limit", lambda: 10)
    grant = q.reserve("u1")             # 尾部不足：min(est, 10) = 10
    assert grant == 10 and q.used_today("u1") == 10
    q.settle("u1", 7, grant)            # 实际 7：10 - 10 + 7
    assert q.used_today("u1") == 7
    q.settle("u1", 5, 0)                # 后续上游尝试（无预留垫）：纯累加
    assert q.used_today("u1") == 12
    q.settle("u1", 0, 0)                # 失败回执（无预留垫可退）：不动
    assert q.used_today("u1") == 12
    monkeypatch.setattr(q, "limit", lambda: 12)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        q.reserve("u1")                 # 12/12 → 429
    assert ei.value.status_code == 429


def test_reserve_settle_cross_day(env, monkeypatch):
    """跨日完成的请求：旧日预留不得冲减新一天用量（day 绑定）。"""
    projects, q, org, ua, config = env
    monkeypatch.setattr(q, "limit", lambda: 5000)
    ts1, ts2 = 1700000000, 1700000000 + 86400
    day1, day2 = q.today(ts1), q.today(ts2)
    grant = q.reserve("u9", est=1500, now=ts1)
    assert grant == 1500 and q.used_today("u9", ts1) == 1500
    q.reserve("u9", est=1500, now=ts2)                       # 新一天另一笔预留
    assert q.used_today("u9", ts2) == 1500
    q.settle("u9", 0, grant, now=ts2, day=day1)              # 旧日预留的结算 → 跳过
    assert q.used_today("u9", ts2) == 1500                   # 不被冲减成 0
    q.settle("u9", 0, 1500, now=ts2, day=day2)               # 当日预留正常退还（全额）
    assert q.used_today("u9", ts2) == 0


def test_resolve_quota_released_when_no_record(env, monkeypatch):
    """取消/前置失败导致上游零回执时，release 钩子全额退预留（chat guard finally 同路径）。"""
    projects, q, org, ua, config = env
    data = org.load_org()
    org.save_org(data.model_copy(update={
        "ai_user_daily_tokens": 10000,
        "ai_provider": {"base_url": "https://api.example.com/v1", "api_key": "sk-org",
                        "model_interactive": "m1"},
    }))

    class FakeClient:
        def __init__(self, provider, models=None):
            self.provider = provider
            self.on_record = None

        def _record(self, project_dir, **kw):
            if self.on_record is not None:
                self.on_record(kw)

    class CancelClient:
        def __init__(self, provider, models=None):
            self.provider = provider
            self.on_record = None

        async def chat(self, *a, **k):
            raise RuntimeError("cancelled before upstream")   # 零回执

    monkeypatch.setattr(ua, "AiClient", CancelClient)
    user = type("U", (), {"id": "u-rel"})()
    client, _p = ua.resolve_ai_client(user)
    assert q.used_today("u-rel") == 0                        # 惰性：chat 前零占用
    import asyncio

    with pytest.raises(RuntimeError):
        asyncio.run(client.chat([]))                         # 取消 → guard finally 全额退预留
    assert q.used_today("u-rel") == 0
    client.release_quota()                                   # 幂等：二次释放不动
    assert q.used_today("u-rel") == 0


def test_resolve_failure_then_retry_counts_actual_only(env, monkeypatch):
    """审查场景（2026-10-29 第三轮）：预留持有到调用结束——失败重试期间窗口不重开，
    最终只计实际用量（而非 0 也而非 est+actual）。"""
    projects, q, org, ua, config = env
    data = org.load_org()
    org.save_org(data.model_copy(update={
        "ai_user_daily_tokens": 2000,
        "ai_provider": {"base_url": "https://api.example.com/v1", "api_key": "sk-org",
                        "model_interactive": "m1"},
    }))

    class FakeClient:
        def __init__(self, provider, models=None):
            self.provider = provider
            self.on_record = None

        async def chat(self, *a, **k):
            self._record(None, usage=type("U", (), {"total_tokens": 0})(), ok=False)   # 首次失败
            # 在途窗口不变量：失败后预留仍持有（used=2000 == cap）——
            # 预留绝不因首次失败提前退还而重开排队窗口（本轮审查场景）
            assert q.used_today("u-retry") == 2000
            # 并发请求在其 chat 入口被闸（预留制的闸位在 chat guard）
            from fastapi import HTTPException

            second, _p2 = ua.resolve_ai_client(type("U", (), {"id": "u-retry"})())
            with pytest.raises(HTTPException) as ei:
                await second.chat([])
            assert ei.value.status_code == 429
            self._record(None, usage=type("U", (), {"total_tokens": 800})(), ok=True)  # 重试成功
            return type("R", (), {"text": "x", "model": "m"})()

        def _record(self, project_dir, **kw):
            if self.on_record is not None:
                self.on_record(kw)

    monkeypatch.setattr(ua, "AiClient", FakeClient)
    import asyncio

    user = type("U", (), {"id": "u-retry"})()
    client, _p = ua.resolve_ai_client(user)
    asyncio.run(client.chat([]))
    assert q.used_today("u-retry") == 800                  # 最终只计实际用量
    asyncio.run(client.chat([]))                           # 调用结束后窗口重开：800 < 2000 放行
    assert q.used_today("u-retry") == 1600                 # 第二次调用净额：800 + 800（预留按尾部余额钳制）
