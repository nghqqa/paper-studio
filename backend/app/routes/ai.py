# -*- coding: utf-8 -*-
"""AI 路由：模型接入状态探活、个人自带 AI 接入配置（BYOK）、选区文本润色（v0.3）。"""

import asyncio
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app import auth, config
from app.ai.client import MODELS, PROBE_TIMEOUT, AiClient, AiError
from app.auth import CurrentUser
from app.domain import org as org_domain
from app.domain import user_ai
from app.domain.org import ai_enabled as _org_ai_enabled
from app.domain.org import require_org_ai
from app.errors import error_detail

router = APIRouter(tags=["ai"])
UNIT = "E1-ai-client"


@router.get("/api/ai/status")
async def ai_status(request: Request, probe: bool = False):
    ai: AiClient = request.app.state.ai
    out = {
        "provider": ai.provider.name,
        "key_present": ai.key_present,
        "models": dict(MODELS),
        "org_ai_enabled": _org_ai_enabled(),
        "reachable": None,
        "checked_at": None,
        "error": None,
    }
    if not probe:
        return out
    out["checked_at"] = time.time()
    if not ai.key_present:
        out.update(reachable=False, error="未配置 AI_KEY")
        return out
    try:
        listed = await asyncio.wait_for(ai.models(), PROBE_TIMEOUT + 1)
    except AiError as e:
        out.update(reachable=False, error=str(e))
    except TimeoutError:
        out.update(reachable=False, error=f"探测超时（{PROBE_TIMEOUT:.0f} s）")
    else:
        missing = [m for m in MODELS.values() if m not in listed]
        out["reachable"] = not missing
        if missing:
            out["error"] = "中转站模型列表缺少：" + "、".join(missing)
    return out


POLISH_MODES = {
    "polish": (
        "你是中文学术论文润色助手。在不改变原意、术语与事实的前提下，优化句子流畅度、用词准确性与学术表达；"
        "保持段落结构，不新增观点。输出必须是纯文本：禁止使用 Markdown 语法"
        "（包括 **加粗**、#标题、- 列表、`代码` 等标记），直接输出改写后的正文。"
    ),
    "academic": (
        "你是中文学术写作编辑。把文本改写为更严谨的学术论文表达：客观语气、规范术语、逻辑连接清晰；"
        "不改变事实与结论。输出必须是纯文本，禁止 Markdown 标记。"
    ),
    "expand": (
        "你是中文学术写作助手。在忠实原意的前提下把文本适度扩写：补充过渡与解释性语句，使论述更完整；"
        "不编造数据与引用。输出必须是纯文本，禁止 Markdown 标记。"
    ),
    "condense": (
        "你是中文学术写作助手。把文本凝练压缩为一半左右篇幅，保留全部关键信息与结论，删除冗余表达。"
        "输出必须是纯文本，禁止 Markdown 标记。"
    ),
}


class PolishIn(BaseModel):
    text: str = Field(min_length=2, max_length=8000)
    mode: str = Field(default="polish")


class MyProviderIn(BaseModel):
    """用户自带 AI 接入（OpenAI 兼容）。api_key 留空 = 保留已存值（首配必填）；key 永不回传。"""

    base_url: str = Field(min_length=1, max_length=300)
    api_key: str = Field(default="", max_length=300)
    model_interactive: str = Field(min_length=1, max_length=120)
    model_heavy: str = Field(default="", max_length=120)
    model_fallback: str = Field(default="", max_length=120)


def _my_uid(user) -> str:
    return user_ai.user_key(getattr(user, "id", None))


@router.get("/api/ai/my-provider")
async def my_provider_get(user: CurrentUser) -> dict:
    """我的 AI 接入：masked 回显 + 机构回退是否可用 + 当前生效来源（user|org|none）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    uid = _my_uid(user)
    up = user_ai.load_user_provider(uid)
    org_p = org_domain.load_org().ai_provider
    org_ok = bool(org_p and org_p.api_key)
    effective = "user" if (up and up.api_key) else ("org" if org_ok else "none")
    return {
        "provider": up.masked() if up else None,
        "org_fallback": org_p.masked() if org_ok else None,
        "effective": effective,
    }


@router.put("/api/ai/my-provider")
async def my_provider_put(body: MyProviderIn, user: CurrentUser) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    provider = user_ai.save_user_provider(_my_uid(user), body)
    return {"ok": True, "provider": provider.masked()}


@router.delete("/api/ai/my-provider")
async def my_provider_delete(user: CurrentUser) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    removed = user_ai.clear_user_provider(_my_uid(user))
    return {"ok": True, "removed": removed}


@router.post("/api/ai/polish")
async def polish(body: PolishIn, user: CurrentUser) -> dict:
    """选中文本 AI 润色（论文线 v0.3）：机构 AI 开关 → 用户自建接入 > 机构接入 → 单轮改写。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    await require_org_ai()
    if body.mode not in POLISH_MODES:
        raise HTTPException(422, error_detail("validation", f"未知润色模式：{body.mode}"))
    client, _provider = user_ai.resolve_ai_client(user)
    messages = [
        {"role": "system", "content": POLISH_MODES[body.mode]},
        {"role": "user", "content": body.text},
    ]
    try:
        result = await client.chat(messages, "interactive", max_tokens=4096, temperature=0.4)
    except AiError as e:
        raise HTTPException(e.status or 502, error_detail("ai", str(e)))
    return {"text": result.text, "model": result.model}
