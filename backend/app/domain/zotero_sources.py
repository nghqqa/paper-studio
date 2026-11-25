# -*- coding: utf-8 -*-
"""Zotero 库导入（v2）：公开/私有群组 + 个人库（API Key）→ BibTeX。

设计（学 tpr-webmodule 的 provider 元数据+可刷新模型，全部自研实现）：
- v2 支持 `Zotero-API-Key` 请求头：私有群组与个人库（/users/{uid}）；公开群组行为与
  v1 完全一致（无 key 语义不退化）。key 由 zotero_credentials 用户级保存，只在
  请求头中出现——URL 模板永不拼接 key，httpx 异常文本经 redact 兜底擦除。
- 导入锚点（群组/集合/条目键）写进导入记录（routes/library.py 的 zotero-imports），
  v2 一键刷新按锚点重拉。
- 安全边界与 library_sources 一致：出站域名白名单（api.zotero.org，常量 BASE 硬编码）、
  固定 URL 模板、follow_redirects=False、超时/有限重试/TTL 缓存/每主机最小间隔（复用其节流池）。
- 外部 API 变动预案：响应解析收敛在 _parse_group/_parse_collections/_merge_bibtex_pages
  三个 adapter，配合单测 mock 锁契约；请求固定头 Zotero-API-Version: 3。
- 429 限流尊重 Retry-After；401/403 = Key 无效/无权；404 无 key = 非公开群组（v1 文案保留），
  带 key = 库不存在或无权访问。
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

import httpx

from app import config

HOST = "api.zotero.org"
BASE = "https://api.zotero.org"
API_VERSION = "3"
PAGE_SIZE = 50

# 群组 ID：纯数字，或从 zotero.org/groups/<id>(/...) URL 中提取
_GROUP_URL_RE = re.compile(r"zotero\.org/groups/(\d+)", re.IGNORECASE)
_GROUP_ID_RE = re.compile(r"^\d{3,12}$")
# Zotero userID：纯数字（个人库；zotero.org/settings/keys 页面可见）
_USER_ID_RE = re.compile(r"^\d{3,12}$")

_cache_get: Any = None  # 延迟绑定 library_sources 的缓存/节流池（避免循环导入成本）


class ZoteroError(Exception):
    def __init__(self, status: int, message: str, kind: str = "source"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.kind = kind


def parse_group_id(raw: str) -> int:
    """接受纯数字 ID 或 zotero.org/groups/<id> 形式的 URL；其余 422。"""
    s = (raw or "").strip()
    m = _GROUP_URL_RE.search(s)
    if m:
        s = m.group(1)
    if not _GROUP_ID_RE.match(s):
        raise ZoteroError(422, "请输入 Zotero 群组数字 ID 或 zotero.org/groups/<id> 链接", kind="validation")
    return int(s)


def parse_collection_key(raw: str) -> str:
    """Zotero 集合键：26 位字母数字（放宽到 1..32）；拼 URL 前强制校验，非法 422。"""
    s = (raw or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9]{1,32}", s):
        raise ZoteroError(422, "集合 key 不合法（应为字母数字）", kind="validation")
    return s


def _key_tag(api_key: str | None) -> str:
    """缓存隔离段：无 key 共享（公开群组语义）；带 key 用摘要隔离，key 本体绝不进缓存键。"""
    if not api_key:
        return "pub"
    return hashlib.sha256(api_key.encode()).hexdigest()[:12]


def parse_user_id(raw: str) -> str:
    """个人库 userID：纯数字（Zotero 账户设置页可见）；其余 422。"""
    s = (raw or "").strip()
    if not _USER_ID_RE.match(s):
        raise ZoteroError(422, "Zotero userID 应为纯数字（见 zotero.org/settings/keys）", kind="validation")
    return s


def _headers(api_key: str | None = None) -> dict[str, str]:
    h = {"Zotero-API-Version": API_VERSION,
         "User-Agent": "paper-studio-library/0.5"}
    if api_key:
        h["Zotero-API-Key"] = api_key
    return h


def _client(api_key: str | None = None) -> httpx.AsyncClient:
    proxy = config.LIBRARY_PROXY_URL or None
    return httpx.AsyncClient(timeout=config.LIBRARY_SOURCE_TIMEOUT_S,
                             follow_redirects=False, proxy=proxy, headers=_headers(api_key))


def _auth_errors(status: int, with_key: bool) -> ZoteroError:
    """401/403/404 的授权语义文案：无 key 保留 v1 公开群组语义，带 key 明确指向 Key。"""
    if status == 401:
        return ZoteroError(401, "Zotero API Key 无效或已过期，请在文献面板「私有库授权」中更新",
                           kind="source_auth")
    if status == 403:
        return ZoteroError(403, "该库为私有库，当前 API Key 无访问权限（需库所有者授权该 Key）",
                           kind="source_auth")
    if with_key:
        return ZoteroError(404, "Zotero 库不存在，或当前 API Key 无权访问", kind="not_found")
    return ZoteroError(404, "Zotero 群组不存在，或不是公开群组（私有群组需要授权，暂不支持）")


async def _get(url: str, expect: str = "json", api_key: str | None = None) -> httpx.Response:
    """白名单内 GET：有限重试（网络错误/5xx），429 尊重 Retry-After，401/403/404 显式语义。"""
    from app.domain import library_sources as ls

    last_exc: Exception | None = None
    for attempt in range(config.LIBRARY_SOURCE_RETRIES + 1):
        try:
            await ls._throttle(HOST)
            async with _client(api_key) as c:
                r = await c.get(url)
        except httpx.TimeoutException as e:
            last_exc = e
            if attempt < config.LIBRARY_SOURCE_RETRIES:
                continue
            raise ZoteroError(504, f"Zotero 查询超时（{config.LIBRARY_SOURCE_TIMEOUT_S}s）",
                              kind="source_timeout") from e
        except httpx.HTTPError as e:
            last_exc = e
            if attempt < config.LIBRARY_SOURCE_RETRIES:
                continue
            raise ZoteroError(502, "无法连接 Zotero 服务，请稍后重试", kind="source_unreachable") from e
        if r.status_code == 429:
            retry_after = r.headers.get("Retry-After")
            import asyncio

            wait = min(float(retry_after) if (retry_after or "").isdigit() else 2.0, 10.0)
            if attempt < config.LIBRARY_SOURCE_RETRIES:
                await asyncio.sleep(wait)
                continue
            raise ZoteroError(429, "Zotero 限流中，请稍后重试", kind="source_rate_limited")
        if r.status_code in (401, 403, 404):
            raise _auth_errors(r.status_code, with_key=bool(api_key))
        if r.status_code >= 500:
            last_exc = RuntimeError(f"upstream {r.status_code}")
            if attempt < config.LIBRARY_SOURCE_RETRIES:
                continue
            raise ZoteroError(502, f"Zotero 服务暂不可用（HTTP {r.status_code}）")
        if r.status_code != 200:
            raise ZoteroError(r.status_code, f"Zotero 请求失败（HTTP {r.status_code}）")
        if expect == "json":
            try:
                r.json()
            except ValueError as e:
                raise ZoteroError(502, "Zotero 返回了无法解析的内容", kind="source_bad_payload") from e
        return r
    raise ZoteroError(502, "Zotero 请求失败", kind="source_unreachable") from last_exc


# ---------------------------------------------------------------- adapter（API 变动只改这里） ----


def _parse_group(payload: dict) -> dict:
    """/groups/{id} JSON → {id, name, description}。"""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    return {
        "id": payload.get("id") or data.get("id"),
        "name": str(data.get("name") or "").strip() or "未命名群组",
        "description": str(data.get("description") or "").strip()[:500],
    }


def _parse_collections(payload: list) -> list[dict]:
    """/collections JSON → [{key, name, parent}]（保持 API 顺序）。"""
    out = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        data = row.get("data") if isinstance(row.get("data"), dict) else row
        key = str(data.get("key") or row.get("key") or "")
        if not key:
            continue
        out.append({
            "key": key,
            "name": str(data.get("name") or "").strip() or "未命名集合",
            "parent": str(data.get("parentCollection") or "") or None,
        })
    return out


def _merge_bibtex_pages(pages: list[str]) -> tuple[str, int]:
    """拼接分页 BibTeX 文本，按块头计数（@type{ 开头）。"""
    text = "\n\n".join(p.strip() for p in pages if p.strip())
    count = len(re.findall(r"(?m)^@\w+\s*[{(]", text))
    return text, count


# ---------------------------------------------------------------- 对外接口 ----


async def group_meta(group_id: int, api_key: str | None = None) -> dict:
    from app.domain import library_sources as ls

    tag = _key_tag(api_key)
    key = f"zotero:group:{group_id}:{tag}"
    hit = ls._cache_get(key)
    if hit is not None:
        return hit
    r = await _get(f"{BASE}/groups/{group_id}", api_key=api_key)
    meta = _parse_group(r.json())
    ls._cache_put(key, meta)  # 键含授权视图摘要：公开段(pub)与各 Key 段互不串户
    return meta


async def list_collections(group_id: int, api_key: str | None = None) -> list[dict]:
    from app.domain import library_sources as ls

    tag = _key_tag(api_key)
    key = f"zotero:collections:{group_id}:{tag}"
    hit = ls._cache_get(key)
    if hit is not None:
        return hit
    out: list[dict] = []
    start = 0
    while True:
        r = await _get(f"{BASE}/groups/{group_id}/collections?limit={PAGE_SIZE}&start={start}",
                       api_key=api_key)
        batch = _parse_collections(r.json())
        out.extend(batch)
        if len(batch) < PAGE_SIZE or len(out) >= 1000:
            break
        start += PAGE_SIZE
    ls._cache_put(key, out)  # 同 group_meta：键隔离，互不串户
    return out


async def user_meta(user_id: str, api_key: str) -> dict:
    """个人库连通性校验 + 显示元数据（Zotero /users/{uid} 无名称字段，展示用固定标识）。"""
    from app.domain import library_sources as ls

    key = f"zotero:user:{user_id}:{_key_tag(api_key)}"
    hit = ls._cache_get(key)
    if hit is not None:
        return hit
    await _get(f"{BASE}/users/{user_id}", api_key=api_key)
    meta = {"id": user_id, "name": f"个人库 {user_id}", "description": ""}
    ls._cache_put(key, meta)
    return meta


async def user_collections(user_id: str, api_key: str) -> list[dict]:
    from app.domain import library_sources as ls

    key = f"zotero:user-collections:{user_id}:{_key_tag(api_key)}"
    hit = ls._cache_get(key)
    if hit is not None:
        return hit
    out: list[dict] = []
    start = 0
    while True:
        r = await _get(f"{BASE}/users/{user_id}/collections?limit={PAGE_SIZE}&start={start}",
                       api_key=api_key)
        batch = _parse_collections(r.json())
        out.extend(batch)
        if len(batch) < PAGE_SIZE or len(out) >= 1000:
            break
        start += PAGE_SIZE
    ls._cache_put(key, out)
    return out


async def _fetch_bibtex_scoped(base_scope: str, collection_key: str | None,
                               max_items: int | None, api_key: str | None) -> dict:
    """`{base_scope}` = /groups/{id} 或 /users/{uid}。分页拉取顶层条目，受 ZOTERO_MAX_ITEMS 封顶。"""
    cap = min(max_items or config.ZOTERO_MAX_ITEMS, config.ZOTERO_MAX_ITEMS)
    if collection_key:
        parse_collection_key(collection_key)  # 拼 URL 前强制校验（防注入/越权拼段）
    scope = f"/collections/{parse_collection_key(collection_key)}/items/top" if collection_key else "/items/top"
    pages: list[str] = []
    total = 0
    truncated = False
    start = 0
    while total < cap:
        limit = min(PAGE_SIZE, cap - total)
        r = await _get(f"{BASE}{base_scope}{scope}?format=bibtex&limit={limit}&start={start}",
                       expect="text", api_key=api_key)
        text = r.text or ""
        pages.append(text)
        got = len(re.findall(r"(?m)^@\w+\s*[{(]", text))
        total += got
        if got < limit:
            break
        start += limit
    else:
        truncated = True
    bibtex, count = _merge_bibtex_pages(pages)
    return {"bibtex": bibtex, "count": count, "truncated": truncated}


async def fetch_bibtex(group_id: int, collection_key: str | None = None,
                       max_items: int | None = None, api_key: str | None = None) -> dict:
    """群组（或其集合）顶层条目 → {bibtex, count, truncated}。公开群组免 key；私有群组带 key。"""
    return await _fetch_bibtex_scoped(f"/groups/{group_id}", collection_key, max_items, api_key)


async def fetch_user_bibtex(user_id: str, collection_key: str | None = None,
                            max_items: int | None = None, api_key: str = "") -> dict:
    """个人库顶层条目 → {bibtex, count, truncated}（必须带 API Key）。"""
    return await _fetch_bibtex_scoped(f"/users/{user_id}", collection_key, max_items, api_key)
