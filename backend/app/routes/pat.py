# -*- coding: utf-8 -*-
"""个人访问令牌（PAT）管理路由：供用户签发/吊销 MCP 客户端专用 Bearer Token。"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app import auth, config
from app.domain import pat
from app.errors import kind_error

router = APIRouter(prefix="/api", tags=["pat"], dependencies=[Depends(auth.require_login)])


class CreateTokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    expires_days: int | None = Field(default=None, ge=1, le=3650)


def _uid(user) -> str:
    if user is None:
        if config.AUTH_ON:
            raise auth.login_required()
        return "anon"
    return str(user.id)


@router.get("/tokens")
async def list_tokens(user: auth.CurrentUser = None):
    uid = _uid(user)
    items = await asyncio.to_thread(pat.list_tokens, uid)
    return {"tokens": items}


@router.post("/tokens", status_code=201)
async def create_token(body: CreateTokenIn, request: Request, user: auth.CurrentUser = None):
    del request
    uid = _uid(user)
    created = await asyncio.to_thread(pat.create_token, uid, body.name, body.expires_days)
    return {"token": created}


@router.delete("/tokens/{token_id}")
async def revoke_token(token_id: str, user: auth.CurrentUser = None):
    uid = _uid(user)
    ok = await asyncio.to_thread(pat.revoke_token, uid, token_id)
    if not ok:
        raise kind_error("not_found", "令牌不存在或无权操作", detail=token_id)
    return {"ok": True}
