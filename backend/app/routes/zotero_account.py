# -*- coding: utf-8 -*-
"""Zotero API Key 凭据路由（B2）：`/api/zotero/credentials` GET/PUT/DELETE。

合同（比照 /api/ai/my-provider）：
- 无 {pid} 路径参数 ⇒ 全局 project_access 不覆盖，必须**显式**检查 CurrentUser：
  AUTH=on 匿名请求一律 401；AUTH=off 落 anon 单文件（单机部署语义，与 user_ai 一致）。
- 响应只含 masked 视图（has_api_key / api_key_hint / zotero_user_id / updated_at），
  key 本体永不回传；PUT key 留空 = 保留已存值；DELETE 清除。
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app import auth, config
from app.auth import CurrentUser
from app.domain import zotero_credentials

router = APIRouter(prefix="/api/zotero", tags=["zotero"])


class ZoteroCredentialsIn(BaseModel):
    api_key: str = Field(default="", max_length=200)
    zotero_user_id: str = Field(default="", max_length=40)


def _uid(user) -> str | None:
    return getattr(user, "id", None)


@router.get("/credentials")
async def credentials_get(user: CurrentUser = None) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    return {"credentials": zotero_credentials.masked_out(zotero_credentials.load_credentials(_uid(user)))}


@router.put("/credentials")
async def credentials_put(body: ZoteroCredentialsIn, user: CurrentUser = None) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    data = zotero_credentials.save_credentials(_uid(user), api_key=body.api_key,
                                               zotero_user_id=body.zotero_user_id)
    return {"ok": True, "credentials": zotero_credentials.masked_out(data)}


@router.delete("/credentials")
async def credentials_delete(user: CurrentUser = None) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    removed = zotero_credentials.clear_credentials(_uid(user))
    return {"ok": True, "removed": removed,
            "credentials": zotero_credentials.masked_out(None)}
