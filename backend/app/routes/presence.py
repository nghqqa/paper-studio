# -*- coding: utf-8 -*-
"""轻量协同在线状态心跳（内存 TTL=35s，供编辑器顶栏显示当前协作者头像）。"""
from __future__ import annotations

import threading
import time

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field

from app import auth

router = APIRouter(prefix="/api/projects/{pid}", tags=["presence"])

TTL_SEC = 35.0
_MAX_PROJECT_PEERS = 200
_MAX_USER_PEERS = 16
_lock = threading.Lock()
_store: dict[str, dict[str, dict]] = {}


class PresenceIn(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    file: str | None = Field(default=None, max_length=300)
    line: int | None = Field(default=None, ge=1, le=200000)
    mode: str = Field(default="latex", max_length=24)


def _prune(bucket: dict[str, dict], now: float) -> None:
    stale = [k for k, rec in bucket.items() if now - float(rec.get("updated_at") or 0.0) > TTL_SEC]
    for k in stale:
        bucket.pop(k, None)


def _snapshot(pid: str, now: float) -> list[dict]:
    with _lock:
        bucket = _store.get(pid)
        if not bucket:
            return []
        _prune(bucket, now)
        if not bucket:
            _store.pop(pid, None)
            return []
        peers = list(bucket.values())
    peers.sort(key=lambda r: (str(r.get("name") or ""), str(r.get("client_id") or "")))
    return peers


@router.post("/presence")
async def heartbeat_presence(pid: str, body: PresenceIn, request: Request, user: auth.CurrentUser):
    request.app.state.store.get(pid)
    now = time.time()
    cur_uid = str(user.id) if user is not None else "local"
    comp_key = f"{cur_uid}:{body.client_id}"
    rec = {
        "client_id": body.client_id,
        "user_id": cur_uid,
        "name": (user.display_name or user.email) if user is not None else "本机作者",
        "file": body.file,
        "line": body.line,
        "mode": body.mode,
        "updated_at": now,
    }
    with _lock:
        bucket = _store.setdefault(pid, {})
        _prune(bucket, now)
        if comp_key not in bucket:
            mine = [(k, r) for k, r in bucket.items() if r.get("user_id") == cur_uid]
            if len(mine) >= _MAX_USER_PEERS:
                oldest_k = min(mine, key=lambda kv: float(kv[1].get("updated_at") or 0.0))[0]
                bucket.pop(oldest_k, None)
            if len(bucket) >= _MAX_PROJECT_PEERS:
                oldest_k = min(bucket.items(), key=lambda kv: float(kv[1].get("updated_at") or 0.0))[0]
                bucket.pop(oldest_k, None)
        bucket[comp_key] = rec
        peers = list(bucket.values())
    peers.sort(key=lambda r: (str(r.get("name") or ""), str(r.get("client_id") or "")))
    return {"peers": peers, "ttl_sec": TTL_SEC}


@router.get("/presence")
async def list_presence(pid: str, request: Request):
    request.app.state.store.get(pid)
    return {"peers": _snapshot(pid, time.time()), "ttl_sec": TTL_SEC}


@router.delete("/presence", status_code=204)
async def leave_presence(
    pid: str,
    request: Request,
    user: auth.CurrentUser = None,
    client_id: str = Query(..., min_length=1, max_length=64),
):
    request.app.state.store.get(pid)
    cur_uid = str(user.id) if user is not None else "local"
    comp_key = f"{cur_uid}:{client_id}"
    with _lock:
        bucket = _store.get(pid)
        if bucket:
            bucket.pop(comp_key, None)
            if not bucket:
                _store.pop(pid, None)
    return Response(status_code=204)
