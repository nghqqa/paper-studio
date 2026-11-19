# -*- coding: utf-8 -*-
"""Zotero API Key 用户级凭据 `<projects>/.studio/zotero-credentials/<uid>.json`（B2）。

比照 user_ai（BYOK）合同：
- 用户级目录（数据卷根 .studio/），绝不进任何工程 .studio/ —— 工程导出/备份天然不含；
- key 本体永不回传：masked 只给 has_api_key / api_key_hint（•••+尾4）；
- PUT key 留空 = 保留已存值（首配必填）；DELETE 清除；
- auth=off 时 uid 落 "anon" 单文件（与 user_ai / 前端 userScope 同语义）。
"""
from __future__ import annotations

import json
import os
import re
import time

from fastapi import HTTPException

from app import atomic, config
from app.errors import error_detail

_DIR = os.path.join(".studio", "zotero-credentials")
_SAFE = re.compile(r"[^0-9a-zA-Z_-]")


def user_key(uid: str | None) -> str:
    safe = _SAFE.sub("", str(uid or "anon"))
    return safe or "anon"


def credentials_path(uid: str | None) -> str:
    return os.path.join(config.PROJECTS_DIR, _DIR, f"{user_key(uid)}.json")


def load_credentials(uid: str | None) -> dict | None:
    """损坏文件按未配置处理（用户重新保存即覆盖）；绝无结构异常外泄。"""
    p = credentials_path(uid)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("api_key"):
        return None
    return data


def masked_out(data: dict | None) -> dict:
    """脱敏视图：key 本体与其不可逆痕迹（哈希/全文）都不出现在任何响应。"""
    if not data or not data.get("api_key"):
        return {"has_api_key": False, "api_key_hint": "", "zotero_user_id": None, "updated_at": None}
    key = str(data["api_key"])
    return {"has_api_key": True,
            "api_key_hint": "•••" + key[-4:],
            "zotero_user_id": str(data.get("zotero_user_id") or "") or None,
            "updated_at": data.get("updated_at")}


def save_credentials(uid: str | None, *, api_key: str, zotero_user_id: str = "") -> dict:
    """api_key 留空 = 保留已存值；首配（无已存 key）必须显式给 key。"""
    existing = load_credentials(uid) or {}
    key = (api_key or "").strip()
    if not key:
        key = str(existing.get("api_key") or "")
        if not key:
            raise HTTPException(400, error_detail(
                "validation", "API Key 不能为空（首次配置必填；已配置时留空表示保留原值）"))
    uid_val = (zotero_user_id or "").strip() or str(existing.get("zotero_user_id") or "")
    data = {"api_key": key, "zotero_user_id": uid_val[:40], "updated_at": time.time()}
    atomic.write_json(credentials_path(uid), data)
    return data


def clear_credentials(uid: str | None) -> bool:
    p = credentials_path(uid)
    if os.path.isfile(p):
        os.remove(p)
        return True
    return False


def redact(text: str, uid: str | None) -> str:
    """错误文本兜底擦除：把已存 key 从任何回显文本中替换为 ***（key 只应在 header 里）。"""
    data = load_credentials(uid)
    if not data:
        return text
    key = str(data.get("api_key") or "")
    if key and key in text:
        return text.replace(key, "***")
    return text
