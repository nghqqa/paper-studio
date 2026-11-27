# -*- coding: utf-8 -*-
"""个人访问令牌（Personal Access Token, PAT）管理：<projects>/.studio/pat-tokens/index.json。

用于外部 MCP 客户端 / CI 脚本通过 `Authorization: Bearer ps_pat_<hex>` 安全接入：
- 明文令牌仅在创建响应中返回一次；磁盘只保存 SHA-256 摘要、前 14 位脱敏前缀与元数据；
- 校验使用 hmac.compare_digest 防时序侧信道；支持吊销与过期时间。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
import uuid

from app import atomic, config
from app.errors import kind_error

_DIR = os.path.join(".studio", "pat-tokens")
PREFIX = "ps_pat_"


def _root_path() -> str:
    return os.path.join(config.PROJECTS_DIR, _DIR, "index.json")


def _load_records() -> list[dict]:
    p = _root_path()
    if not os.path.isfile(p):
        return []
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    recs = data.get("tokens") if isinstance(data, dict) else data
    return [dict(x) for x in recs if isinstance(x, dict)] if isinstance(recs, list) else []


def _save_records(records: list[dict]) -> None:
    p = _root_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    atomic.write_json(p, {"schema_version": 1, "tokens": records})


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _public_record(rec: dict) -> dict:
    return {
        "id": rec["id"],
        "name": rec["name"],
        "prefix": rec["prefix"],
        "scopes": list(rec.get("scopes") or ["read", "propose"]),
        "created_at": rec["created_at"],
        "last_used_at": rec.get("last_used_at"),
        "expires_at": rec.get("expires_at"),
        "revoked_at": rec.get("revoked_at"),
    }


def list_tokens(uid: str) -> list[dict]:
    with atomic.studio_lock(config.PROJECTS_DIR, "pat-tokens"):
        recs = _load_records()
        mine = [r for r in recs if str(r.get("user_id") or "") == uid]
        mine.sort(key=lambda r: float(r.get("created_at") or 0), reverse=True)
        return [_public_record(r) for r in mine]


def create_token(uid: str, name: str, expires_days: int | None = None) -> dict:
    clean_name = str(name or "").strip()[:64]
    if not clean_name:
        raise kind_error("validation", "令牌名称不能为空", detail="name")
    raw = f"{PREFIX}{secrets.token_hex(16)}"
    now = time.time()
    expires_at = (now + int(expires_days) * 86400) if expires_days and int(expires_days) > 0 else None
    rec = {
        "id": f"pat_{uuid.uuid4().hex[:12]}",
        "user_id": uid,
        "name": clean_name,
        "prefix": raw[:14],
        "token_hash": _hash_token(raw),
        "scopes": ["read", "propose"],
        "created_at": now,
        "last_used_at": None,
        "expires_at": expires_at,
        "revoked_at": None,
    }
    with atomic.studio_lock(config.PROJECTS_DIR, "pat-tokens"):
        recs = _load_records()
        recs.append(rec)
        _save_records(recs)
    return {**_public_record(rec), "token": raw}


def revoke_token(uid: str, token_id: str) -> bool:
    with atomic.studio_lock(config.PROJECTS_DIR, "pat-tokens"):
        recs = _load_records()
        hit = next((r for r in recs if r.get("id") == token_id and str(r.get("user_id") or "") == uid), None)
        if hit is None:
            return False
        if not hit.get("revoked_at"):
            hit["revoked_at"] = time.time()
            _save_records(recs)
        return True


def verify_token(raw: str) -> dict | None:
    raw = (raw or "").strip()
    if not raw.startswith(PREFIX) or len(raw) < len(PREFIX) + 16:
        return None
    digest = _hash_token(raw)
    now = time.time()
    with atomic.studio_lock(config.PROJECTS_DIR, "pat-tokens"):
        recs = _load_records()
        matched: dict | None = None
        for r in recs:
            stored = str(r.get("token_hash") or "")
            if stored and hmac.compare_digest(stored, digest):
                matched = r
                break
        if matched is None:
            return None
        if matched.get("revoked_at") is not None:
            return None
        exp = matched.get("expires_at")
        if exp is not None and float(exp) <= now:
            return None
        matched["last_used_at"] = now
        _save_records(recs)
        return {
            "id": matched["id"],
            "user_id": matched["user_id"],
            "name": matched["name"],
            "prefix": matched["prefix"],
            "scopes": list(matched.get("scopes") or ["read", "propose"]),
        }
