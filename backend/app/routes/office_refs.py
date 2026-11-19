# -*- coding: utf-8 -*-
"""文献引用插件桥（v0.4.1）：应用侧「文献」面板 ⇄ ONLYOFFICE 插件的服务端任务箱。

v0.4.1 会话绑定（取代 v0.4 的按 pid 内存分桶）：
- 任务绑定 (pid, doc_key)：doc_key = DS 编辑器会话键（word session key），
  页面从 editorConfig 取得、插件从 Asc.plugin.info.documentId 取得——两端一致才可见；
- doc_key 与该工程当前会话不符（关闭重开/会话重建）⇒ 任务对插件不可见，过期语义由此产生；
- 同一文档会话多标签页共享通道：任务以 request_id 配对，插入类操作在任一同会话标签执行
  等效（DS 协同同步），不宣称跨标签 exactly-once；
- 认领语义：GET task 只读观察（可重复）；POST result 认领+完成回执（request_id 匹配在途
  任务才接受，接受即清除——重试回执幂等）；插件本地对已完成 request_id 去重，防止回执
  丢失后的重复执行；
- 角色：下发任务需 editor（路由内 check_access 显式校验，viewer/reviewer 403）；
  回执需匹配在途任务的 request_id + doc_key（伪造者拿不到在途标识）。
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app import auth, config
from app.domain import word_documents
from app.domain.word_documents import ProjectError

router = APIRouter(tags=["office-refs"])

MAX_PAYLOAD_BYTES = 64 * 1024
TASK_TTL_S = 120
RESULT_TTL_S = 120

_lock = threading.Lock()
# doc_key → {"pid": str, "task": {...} | None, "result": {...} | None}
_inbox: dict[str, dict[str, Any]] = {}


def _bucket_locked(doc_key: str, pid: str | None = None) -> dict[str, Any]:
    """锁内辅助：调用方必须已持有 _lock（非重入锁——自锁即整循环死锁，v0.4 实测）。"""
    b = _inbox.setdefault(doc_key, {"pid": pid, "task": None, "result": None})
    # 过期清理：任务/结果超时未取走即作废（插件离线或页面已关）
    now = time.time()
    if b["task"] and now - b["task"]["ts"] > TASK_TTL_S:
        b["task"] = None
    if b["result"] and now - b["result"]["ts"] > RESULT_TTL_S:
        b["result"] = None
    return b


def _session_key(project_dir: str) -> str | None:
    """该工程当前 DS 会话键（doc_key 必须与它一致——旧会话的任务自然过期）。"""
    try:
        return word_documents.session(project_dir, rotate_if_closed=False).get("key")
    except ProjectError:
        return None


class TaskIn(BaseModel):
    pid: str = Field(min_length=1, max_length=80)
    doc_key: str = Field(min_length=8, max_length=80)
    kind: str = Field(pattern=r"^(insert-citation|collect-refs|set-bibliography|apply-proposal|strip-bib-markers)$")
    payload: dict[str, Any] = Field(default_factory=dict)


@router.post("/api/office-plugin-refs/task")
async def post_task(body: TaskIn, request: Request, user: auth.CurrentUser = None):
    """页面 → 插件下发任务（写编排：editor 门槛 + doc_key 会话绑定）。"""
    if config.AUTH_ON:
        await auth.check_access(request, user, body.pid, "editor")
    payload_bytes = len(str(body.payload).encode())
    if payload_bytes > MAX_PAYLOAD_BYTES:
        raise HTTPException(413, {"kind": "content", "message": "任务载荷过大"})
    project = request.app.state.store.get(body.pid)
    cur_key = _session_key(project.dir)
    if cur_key is None:
        raise HTTPException(409, {"kind": "conflict", "message": "文档没有活动编辑会话（请在编辑器中打开后重试）"})
    if body.doc_key != cur_key:
        raise HTTPException(409, {"kind": "stale", "message": "文档会话已更新（编辑器可能已重开），请刷新页面后重试"})
    request_id = "rp_" + uuid.uuid4().hex[:12]
    with _lock:
        b = _bucket_locked(body.doc_key, pid=body.pid)
        if b["task"] is not None:
            raise HTTPException(409, {"kind": "job_busy", "message": "上一个插件任务尚未完成，请稍候重试"})
        b["task"] = {"request_id": request_id, "kind": body.kind, "payload": body.payload, "ts": time.time()}
        b["result"] = None
    return {"request_id": request_id}


_last_seen: dict[str, float] = {}
# 30s：浏览器对后台/非激活 iframe 的 timer 节流可到分钟级，窗口太窄会造成就绪状态抖动（IAB 验收实测）
BRIDGE_ALIVE_WINDOW_S = 30.0


@router.get("/api/office-plugin-refs/task")
async def get_task(request: Request, doc_key: str, user: auth.CurrentUser = None):
    """插件按自身 documentId 轮询（只读观察、可重复；认领发生在 POST result）。
    轮询即心跳：bridge 端点据此报告插件就绪状态（侧栏按钮不伪装可执行）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    with _lock:
        b = _bucket_locked(doc_key)
        task = b["task"]
        out = {k: task[k] for k in ("request_id", "kind", "payload")} if task else None
    _last_seen[doc_key] = time.time()
    return {"task": out}


@router.get("/api/office-plugin-refs/bridge")
async def bridge_status(request: Request, doc_key: str, user: auth.CurrentUser = None):
    """插件就绪状态（轮询心跳）；侧栏据此启用/禁用插入与更新入口。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    seen = _last_seen.get(doc_key)
    alive = bool(seen and time.time() - seen < BRIDGE_ALIVE_WINDOW_S)
    return {"alive": alive}


class ResultIn(BaseModel):
    doc_key: str = Field(min_length=8, max_length=80)
    request_id: str = Field(min_length=3, max_length=64)
    ok: bool
    data: dict[str, Any] | None = None
    error: str | None = None


@router.post("/api/office-plugin-refs/result")
async def post_result(body: ResultIn, request: Request, user: auth.CurrentUser = None):
    """插件认领 + 完成回执：request_id 必须匹配该 doc_key 桶内的在途任务（防伪造/跨会话回执）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    with _lock:
        b = _bucket_locked(body.doc_key)
        task = b["task"]
        if task is None or task["request_id"] != body.request_id:
            raise HTTPException(404, {"kind": "not_found", "message": "任务不存在或已过期（可能已被认领）"})
        b["result"] = {
            "request_id": body.request_id, "ok": body.ok,
            "data": body.data, "error": body.error, "ts": time.time(),
        }
        b["task"] = None  # 结果已回：任务取走（单飞闭环；重试回执幂等）
    return {"ok": True}


@router.get("/api/office-plugin-refs/result")
async def get_result(request: Request, request_id: str, doc_key: str, user: auth.CurrentUser = None):
    """页面按 request_id 取回执（request_id 由下发方持有，天然绑定会话）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    with _lock:
        b = _bucket_locked(doc_key)
        r = b["result"]
    if r is None or r["request_id"] != request_id:
        return {"result": None}
    return {"result": {"request_id": r["request_id"], "ok": r["ok"], "data": r["data"], "error": r["error"]}}


# ---- 调试回传（与 office-plugin-ai/debug 同款） ----

_BRIDGE_DEBUG: list[str] = []


@router.get("/api/office-plugin-refs/debug")
async def refs_debug_get(user: auth.CurrentUser) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    return {"steps": list(_BRIDGE_DEBUG[-40:])}


@router.post("/api/office-plugin-refs/debug")
async def refs_debug_post(request: Request, user: auth.CurrentUser) -> dict:
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    try:
        body = await request.json()
    except (ValueError, UnicodeError):
        raise ProjectError("调试回传 JSON 无效", 400) from None
    step = body.get("step") if isinstance(body, dict) else None
    if isinstance(step, str) and step:
        _BRIDGE_DEBUG.append(step[:200])
        del _BRIDGE_DEBUG[:-80]
    return {"ok": True}


@router.get("/api/office-plugin-refs/settings.json")
async def refs_plugin_settings():
    return {"document_server_url": config.ONLYOFFICE_URL}


@router.get("/api/office-plugin-refs/config.json")
async def refs_plugin_config(request: Request):
    import json
    import os

    path = os.path.join(config.BACKEND_DIR, "app", "office_plugin_refs", "config.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise ProjectError("文献引用插件尚未安装", 503) from e
    data["variations"][0]["url"] = "index.html"
    data["baseUrl"] = config.PUBLIC_ORIGIN + "/api/office-plugin-refs/"
    return data
