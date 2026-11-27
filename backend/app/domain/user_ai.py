# -*- coding: utf-8 -*-
"""用户自带 AI 接入 `<projects>/.studio/user-ai/<uid>.json`（v0.4.2 用户级 BYO key）。

与机构接入（org.json 的 ai_provider，管理员配置）同形——直接复用 org.AiProvider；
解析优先级：用户自建 > 机构接入；机构 ai_enabled 总闸（require_org_ai）不因此绕过。
存储与 org.json 同模式（json + atomic write，数据卷内随备份走），不进 studio.db——零迁移。
api_key 永不回传（masked 同 org 口径）；PUT 时 api_key 留空 = 保留已存值（首配必填）。
auth=off 时 uid 落在 "anon" 单文件（与前端 draftStore 的 userScope 同语义）。
"""

import json
import os
import re

from fastapi import HTTPException

from app import atomic, config
from app.ai.client import AiClient, OpenAICompatProvider
from app.domain.org import AiProvider, load_org
from app.errors import error_detail

_DIR = os.path.join(".studio", "user-ai")
_SAFE = re.compile(r"[^0-9a-zA-Z_-]")


def user_key(uid: str | None) -> str:
    safe = _SAFE.sub("", str(uid or "anon"))
    return safe or "anon"


def user_ai_path(uid: str | None) -> str:
    return os.path.join(config.PROJECTS_DIR, _DIR, f"{user_key(uid)}.json")


def load_user_provider(uid: str | None) -> AiProvider | None:
    p = user_ai_path(uid)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return AiProvider.model_validate(json.load(f))
    except Exception:  # noqa: BLE001 — 损坏文件按未配置处理（用户重新保存即覆盖）
        return None


def save_user_provider(uid: str | None, provider_in) -> AiProvider:
    """api_key 留空 = 保留已存值；首配（无已存 key）必须显式给 key。"""
    data = provider_in.model_dump()
    if not data["api_key"].strip():
        existing = load_user_provider(uid)
        if existing is None or not existing.api_key:
            raise HTTPException(400, error_detail(
                "validation", "API Key 不能为空（首次配置必填；已配置时留空表示保留原值）"))
        data["api_key"] = existing.api_key
    base = data["base_url"].strip()
    if not base.lower().startswith(("http://", "https://")):
        raise HTTPException(422, error_detail("validation", "接口地址必须以 http:// 或 https:// 开头"))
    provider = AiProvider.model_validate({**data, "base_url": base.rstrip("/")})
    atomic.write_json(user_ai_path(uid), provider.model_dump())
    return provider


def clear_user_provider(uid: str | None) -> bool:
    p = user_ai_path(uid)
    if os.path.isfile(p):
        os.remove(p)
        return True
    return False


def resolve_provider(uid: str | None) -> tuple[AiProvider | None, str]:
    """用户自建优先，机构回退。返回 (provider, source: user|org|none)。"""
    up = load_user_provider(uid)
    if up is not None and up.api_key:
        return up, "user"
    org_p = load_org().ai_provider
    if org_p is not None and org_p.api_key:
        return org_p, "org"
    return None, "none"


class _QuotaStreamProxy:
    """将流式 AI 配额预留的结算延后至流结束、异常或主动关闭（aclose）。"""

    def __init__(self, inner, release_fn):
        self._inner = inner
        self._release = release_fn

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self._inner.__anext__()
        except StopAsyncIteration:
            self._release()
            raise
        except BaseException:
            self._release()
            raise

    async def aclose(self):
        try:
            aclose = getattr(self._inner, "aclose", None)
            if aclose is not None:
                await aclose()
        finally:
            self._release()

    @property
    def result(self):
        return getattr(self._inner, "result", None)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def resolve_ai_client(user):
    """三个论文线 AI 消费点共用的解析入口：用户自建 > 机构接入；都没有 ⇒ 400 ai_not_configured（文案含自助路径）。

    机构接入时叠加 per-user 每日配额（ai_quota）：调用前闸（超限 429 budget）+ 记账
    （client.on_record 钩子在每次上游请求的 usage 落盘点累加，失败尝试不计）；
    BYOK（source=user）不占机构额度，闸与记账都不生效。
    AiClient/OpenAICompatProvider 取本模块符号（测试打桩点：monkeypatch user_ai.AiClient）。
    """
    uid = getattr(user, "id", None)
    provider, source = resolve_provider(uid)
    if provider is None or not provider.api_key:
        raise HTTPException(400, error_detail(
            "ai_not_configured",
            "AI 接入未配置：可在「账户 → AI 接入」自己填写接口地址与 API Key，或联系管理员配置机构接入"))
    from app.domain import ai_quota

    # 预留制（chat 内惰性）：真正进入 chat 才 check+扣减（同一 flock，封排队超额窗口），
    # 客户端创建后的早返回（无缺失字段/超长 413 等）零上游调用也零占用。
    # 预留持有到调用结束（finally）才释放——失败重试期间绝不提前退，在途窗口全程封锁；
    # 成功回执按实际用量直接累加，释放预留后净额=Σactual。
    client = AiClient(
        OpenAICompatProvider(provider.api_key, provider.base_url),
        models={"interactive": provider.model_interactive,
                "heavy": provider.model_heavy,
                "fallback": provider.model_fallback},
    )
    if source == "org":
        active_releases: list = []

        def _count(kw: dict) -> None:
            usage = kw.get("usage")
            tokens = int(getattr(usage, "total_tokens", 0) or 0) if usage is not None else 0
            if kw.get("ok") and tokens > 0:
                try:
                    ai_quota.add(uid, tokens)
                except OSError:
                    pass  # 计数盘不可写不阻断调用（额度闸下次仍会尝试读）

        def _release() -> None:
            for fn in list(active_releases):
                fn()

        chat_orig = getattr(client, "chat", None)

        if chat_orig is not None:
            async def chat_guard(*args, **kwargs):
                est = ai_quota.reserve(uid)
                est_day = ai_quota.today()
                box = [est]

                def _rel() -> None:
                    if not box[0]:
                        return
                    val = box[0]
                    box[0] = 0
                    try:
                        ai_quota.settle(uid, 0, val, day=est_day)
                    except OSError:
                        pass

                active_releases.append(_rel)
                try:
                    res = await chat_orig(*args, **kwargs)
                except BaseException:
                    _rel()
                    raise
                if hasattr(res, "__aiter__"):
                    return _QuotaStreamProxy(res, _rel)
                _rel()
                return res

            client.chat = chat_guard
        client.on_record = _count
        client.release_quota = _release
    return client, provider
