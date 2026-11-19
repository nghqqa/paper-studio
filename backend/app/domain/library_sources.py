# -*- coding: utf-8 -*-
"""文献元数据外部源客户端（v0.4）：Crossref / OpenAlex / arXiv。

安全边界：
- 出站域名硬白名单（config.LIBRARY_ALLOWED_HOSTS），URL 全部由固定模板 + 校验后的标识符构造；
  绝不抓取用户输入的 URL；follow_redirects=False（3xx 视为失败，防不受控重定向）；
- 代理只作用于这三类查询（config.LIBRARY_PROXY_URL；开发机需要时注入，服务器部署不设值）；
- 超时 / 有限重试（1 次，仅 429/5xx/网络错误，尊重 Retry-After）/ 进程内 TTL 缓存 / 每主机最小间隔；
- 返回内容一律视为数据（只进字段/展示，绝不执行其中任何指令）。

"未查询到撤稿记录" 恒为 unknown——不推断 "已证明未撤稿"。
"""

from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from app import config

ALLOWED_HOSTS = set(config.LIBRARY_ALLOWED_HOSTS)

_DOI_RE = re.compile(r"^10\.\d{4,9}/[^\s\"<>]+$")
_ARXIV_RE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+(\.[A-Z]{2})?/\d{7}(v\d+)?$", re.IGNORECASE)

_cache: dict[str, tuple[float, Any]] = {}
_last_hit: dict[str, float] = {}


class SourceError(Exception):
    def __init__(self, status: int, message: str, kind: str = "source"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.kind = kind


def _cache_get(key: str) -> Any | None:
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < config.LIBRARY_SOURCE_CACHE_TTL_S:
        return hit[1]
    if hit:
        _cache.pop(key, None)
    return None


def _cache_clear(prefix: str) -> int:
    """按前缀清除缓存（Zotero 一键刷新绕过 1h TTL 用）；返回清除条数。"""
    keys = [k for k in _cache if k.startswith(prefix)]
    for k in keys:
        _cache.pop(k, None)
    return len(keys)


def _cache_put(key: str, val: Any) -> None:
    if len(_cache) > 500:
        # 粗清理：过期项先走
        now = time.time()
        for k in [k for k, (t, _) in _cache.items() if now - t > config.LIBRARY_SOURCE_CACHE_TTL_S]:
            _cache.pop(k, None)
        if len(_cache) > 500:
            _cache.pop(next(iter(_cache)))
    _cache[key] = (time.time(), val)


async def _throttle(host: str) -> None:
    """每主机最小间隔（礼貌池）。"""
    import asyncio

    last = _last_hit.get(host, 0.0)
    wait = config.LIBRARY_SOURCE_MIN_INTERVAL_S - (time.time() - last)
    if wait > 0:
        await asyncio.sleep(wait)
    _last_hit[host] = time.time()


def _validate_doi(doi: str) -> str:
    doi = (doi or "").strip()
    if not _DOI_RE.match(doi):
        raise SourceError(422, f"DOI 格式不合法：{doi[:80]}")
    return doi


def _validate_arxiv(ident: str) -> str:
    s = (ident or "").strip()
    m = re.search(r"arxiv\.org/(?:abs|pdf)/([^\s?#]+)", s, re.IGNORECASE)
    if m:
        s = m.group(1)
    s = re.sub(r"(?i)^arxiv[:\s]*", "", s).strip()
    if not _ARXIV_RE.match(s):
        raise SourceError(422, f"arXiv 标识不合法：{s[:80]}")
    return s


def _headers() -> dict[str, str]:
    ua = "paper-studio-library/0.4"
    if config.CROSSREF_MAILTO:
        ua += f" (mailto:{config.CROSSREF_MAILTO})"
    return {"User-Agent": ua}


def _client() -> httpx.AsyncClient:
    proxy = config.LIBRARY_PROXY_URL or None
    return httpx.AsyncClient(
        timeout=config.LIBRARY_SOURCE_TIMEOUT_S,
        follow_redirects=False,
        proxy=proxy,
        headers=_headers(),
    )


async def _get(host: str, url: str, expect_json: bool = True) -> httpx.Response:
    if host not in ALLOWED_HOSTS:
        raise SourceError(400, f"非白名单元数据源：{host}")
    for attempt in range(config.LIBRARY_SOURCE_RETRIES + 1):
        try:
            await _throttle(host)
            async with _client() as c:
                r = await c.get(url)
        except httpx.TimeoutException as e:
            if attempt < config.LIBRARY_SOURCE_RETRIES:
                continue
            raise SourceError(
                504, f"{host} 查询超时（{config.LIBRARY_SOURCE_TIMEOUT_S}s）", kind="source_timeout") from e
        except httpx.HTTPError as e:
            if attempt < config.LIBRARY_SOURCE_RETRIES:
                continue
            raise SourceError(502, f"无法连接 {host}：{type(e).__name__}", kind="source_unreachable") from e
        if r.status_code == 429 or r.status_code >= 500:
            if attempt < config.LIBRARY_SOURCE_RETRIES:
                retry_after = r.headers.get("Retry-After")
                delay = min(float(retry_after), 5.0) if retry_after and retry_after.isdigit() else 1.5
                import asyncio

                await asyncio.sleep(delay)
                continue
            if r.status_code == 429:
                raise SourceError(429, f"{host} 限流（429），请稍后重试", kind="source_rate_limited")
            raise SourceError(502, f"{host} 服务异常（{r.status_code}）", kind="source_upstream")
        if 300 <= r.status_code < 400:
            # 仅允许白名单主机内的 http→https 升级重定向（arXiv API 强制 HTTPS）；
            # 跨主机/降级/非常规重定向一律阻止
            loc = r.headers.get("Location", "")
            try:
                from urllib.parse import urlsplit

                parts = urlsplit(loc)
                if parts.scheme == "https" and parts.netloc == host:
                    url = loc
                    continue
            except ValueError:
                pass
            raise SourceError(502, f"{host} 返回了未预期的重定向（已阻止跟随）", kind="source_redirect")
        if r.status_code == 404:
            raise SourceError(404, "未找到该标识符对应的文献", kind="source_not_found")
        if r.status_code != 200:
            raise SourceError(502, f"{host} 查询失败（{r.status_code}）", kind="source_upstream")
        return r
    raise SourceError(502, f"{host} 查询失败", kind="source_upstream")  # pragma: no cover


# ---------------------------------------------------------------- Crossref ----


def _crossref_work_to_fields(item: dict[str, Any]) -> dict[str, Any]:
    def first_date(obj: dict | None) -> str | None:
        parts = ((obj or {}).get("date-parts") or [[None]])[0]
        return str(parts[0]) if parts and parts[0] else None

    authors = []
    for a in item.get("author") or []:
        fam, giv = a.get("family"), a.get("given")
        if fam:
            authors.append(f"{fam}, {giv}" if giv else fam)
        elif a.get("name"):
            authors.append(a["name"])
    venue = None
    if item.get("container-title"):
        venue = item["container-title"][0]
    etype = "article"
    t = (item.get("type") or "").lower()
    if "proceedings-article" in t:
        etype = "inproceedings"
    elif "book" in t:
        etype = "book"
    elif "report" in t:
        etype = "techreport"
    elif "thesis" in t:
        etype = "phdthesis"
    pages = item.get("page")
    fields = {
        "entry_type": etype,
        "title": (item.get("title") or [""])[0],
        "authors": authors,
        "year": first_date(item.get("issued")),
        "venue": venue,
        "volume": item.get("volume"),
        "number": item.get("issue"),
        "pages": pages,
        "publisher": (item.get("publisher") or None),
        "doi": item.get("DOI"),
        "url": item.get("URL"),
        "abstract": _strip_jats(item.get("abstract")),
    }
    return {k: v for k, v in fields.items() if v not in (None, "")}


def _strip_jats(s: str | None) -> str | None:
    if not s:
        return None
    return re.sub(r"<[^>]+>", "", s).strip() or None


def _retraction_from_crossref(item: dict[str, Any]) -> dict[str, Any] | None:
    upd = item.get("update-to") or item.get("updated-by")
    if not upd:
        return None
    if isinstance(upd, dict):
        upd = [upd]
    for u in upd or []:
        utable = str(u.get("type", "")).lower()
        if "retract" in utable:
            return {"status": "retracted", "source": "crossref",
                    "note": f"update-to: {u.get('DOI', '')}", "checked_at": time.time()}
        if "correct" in utable:
            return {"status": "corrected", "source": "crossref",
                    "note": f"update-to: {u.get('DOI', '')}", "checked_at": time.time()}
    return None


async def lookup_doi(doi: str) -> dict[str, Any]:
    """DOI → Crossref 优先、OpenAlex 兜底；返回候选（含撤稿状态：有记录才标，否则 unknown）。"""
    doi = _validate_doi(doi)
    cache_key = f"doi:{doi.lower()}"
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit
    r = await _get("api.crossref.org", f"https://api.crossref.org/works/{doi}")
    try:
        message = r.json().get("message", {})
    except Exception as e:  # noqa: BLE001
        raise SourceError(502, "Crossref 返回了无法解析的内容", kind="source_format") from e
    fields = _crossref_work_to_fields(message)
    if not fields.get("title"):
        raise SourceError(404, "Crossref 记录缺少标题，视为未匹配", kind="source_not_found")
    out: dict[str, Any] = {
        "source": "crossref",
        "matched": True,
        "query": f"doi:{doi}",
        "fields": fields,
        "retraction": _retraction_from_crossref(message)
        or {"status": "unknown", "source": "crossref", "checked_at": time.time()},
    }
    _cache_put(cache_key, out)
    return out


# ---------------------------------------------------------------- OpenAlex ----


def _openalex_to_fields(w: dict[str, Any]) -> dict[str, Any]:
    authors = []
    for a in w.get("authorships") or []:
        name = ((a.get("author") or {}).get("display_name") or "").strip()
        if name:
            authors.append(name)
    venue = None
    primary = w.get("primary_location") or {}
    src = primary.get("source") or {}
    venue = src.get("display_name")
    bib = w.get("biblio") or {}
    etype = "article"
    t = (w.get("type") or "").lower()
    if "proceedings" in t or "conference" in t:
        etype = "inproceedings"
    elif "book" in t:
        etype = "book"
    elif "report" in t:
        etype = "techreport"
    elif "dissertation" in t:
        etype = "phdthesis"
    pages = None
    if bib.get("first_page") or bib.get("last_page"):
        pages = "-".join(x for x in (bib.get("first_page"), bib.get("last_page")) if x)
    doi = (w.get("doi") or "").replace("https://doi.org/", "") or None
    fields = {
        "entry_type": etype,
        "title": w.get("title") or "",
        "authors": authors,
        "year": str(w.get("publication_year")) if w.get("publication_year") else None,
        "venue": venue,
        "volume": bib.get("volume"),
        "number": bib.get("issue"),
        "pages": pages,
        "doi": doi,
        "url": (primary.get("landing_page_url") or None),
    }
    return {k: v for k, v in fields.items() if v not in (None, "")}


def _retraction_from_openalex(w: dict[str, Any]) -> dict[str, Any] | None:
    if w.get("is_retracted"):
        return {"status": "retracted", "source": "openalex", "checked_at": time.time()}
    return {"status": "unknown", "source": "openalex", "checked_at": time.time()}


async def search_openalex(query: str, limit: int = 5) -> list[dict[str, Any]]:
    q = re.sub(r"[\s]+", " ", (query or "").strip())[:200]
    if not q:
        return []
    cache_key = f"oasearch:{q.lower()}:{limit}"
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit
    mailto = config.CROSSREF_MAILTO or "paper-studio@example.org"
    url = f"https://api.openalex.org/works?search={_q(q)}&per-page={min(limit, 20)}&mailto={mailto}"
    r = await _get("api.openalex.org", url)
    try:
        results = r.json().get("results", [])
    except Exception as e:  # noqa: BLE001
        raise SourceError(502, "OpenAlex 返回了无法解析的内容", kind="source_format") from e
    out = [
        {"source": "openalex", "matched": bool(w.get("title")), "query": q,
         "fields": _openalex_to_fields(w), "retraction": _retraction_from_openalex(w)}
        for w in results
    ]
    _cache_put(cache_key, out)
    return out


async def lookup_doi_openalex(doi: str) -> dict[str, Any]:
    doi = _validate_doi(doi)
    cache_key = f"oad:{doi.lower()}"
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit
    r = await _get("api.openalex.org", f"https://api.openalex.org/works/doi:{_q(doi)}")
    try:
        w = r.json()
    except Exception as e:  # noqa: BLE001
        raise SourceError(502, "OpenAlex 返回了无法解析的内容", kind="source_format") from e
    out = {
        "source": "openalex", "matched": bool(w.get("title")), "query": f"doi:{doi}",
        "fields": _openalex_to_fields(w), "retraction": _retraction_from_openalex(w),
    }
    _cache_put(cache_key, out)
    return out


# ---------------------------------------------------------------- arXiv ----

_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV_NS = "{http://arxiv.org/schemas/atom}"


async def lookup_arxiv(ident: str) -> dict[str, Any]:
    ident = _validate_arxiv(ident)
    canonical = re.sub(r"v\d+$", "", ident)  # 存储口径去版本号（查询保留原样亦可解析）
    cache_key = f"arxiv:{ident.lower()}"
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit
    r = await _get("export.arxiv.org", f"http://export.arxiv.org/api/query?id_list={_q(ident)}&max_results=1")
    try:
        root = ET.fromstring(r.text)
    except ET.ParseError as e:
        raise SourceError(502, "arXiv 返回了无法解析的内容", kind="source_format") from e
    entries = root.findall(f"{_ATOM}entry")
    if not entries:
        raise SourceError(404, "arXiv 未返回该标识符的条目", kind="source_not_found")
    entry = entries[0]
    title = (entry.findtext(f"{_ATOM}title") or "").strip().replace("\n", " ")
    if not title or title.lower() == "error":
        raise SourceError(404, "arXiv 未找到该标识符（或标识符错误）", kind="source_not_found")
    authors = [
        (a.findtext(f"{_ATOM}name") or "").strip()
        for a in entry.findall(f"{_ATOM}author")
        if (a.findtext(f"{_ATOM}name") or "").strip()
    ]
    published = entry.findtext(f"{_ATOM}published") or ""
    year = published[:4] or None
    doi = entry.findtext(f"{_ARXIV_NS}doi") or None
    pages_m = re.search(r"(\d+)\s*pages", entry.findtext(f"{_ARXIV_NS}comment") or "")
    out = {
        "source": "arxiv",
        "matched": True,
        "query": f"arxiv:{ident}",
        "fields": {
            "entry_type": "article",
            "title": title,
            "authors": authors,
            "year": year,
            "venue": "arXiv preprint",
            "arxiv_id": canonical,
            "doi": doi,
            "url": f"https://arxiv.org/abs/{ident}",
            "pages": pages_m.group(1) if pages_m else None,
        },
        # arXiv API 不提供撤稿状态：恒 unknown（不推断）
        "retraction": {"status": "unknown", "source": "arxiv", "checked_at": time.time()},
    }
    _cache_put(cache_key, out)
    return out


# ---------------------------------------------------------------- 综合 ----


async def search(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """标题/关键词搜索：Crossref bibliographic + OpenAlex，合并去重（按 DOI/标题）。"""
    q = (query or "").strip()
    if len(q) < 2:
        return []
    results: list[dict[str, Any]] = []
    errors: list[str] = []
    cache_key = f"search:{q.lower()}:{limit}"
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit
    try:
        r = await _get(
            "api.crossref.org",
            f"https://api.crossref.org/works?query.bibliographic={_q(q)}&rows={min(limit, 20)}"
            + (f"&mailto={config.CROSSREF_MAILTO}" if config.CROSSREF_MAILTO else ""),
        )
        items = r.json().get("message", {}).get("items", [])
        for item in items:
            fields = _crossref_work_to_fields(item)
            if fields.get("title"):
                results.append({
                    "source": "crossref", "matched": True, "query": q, "fields": fields,
                    "retraction": _retraction_from_crossref(item)
                    or {"status": "unknown", "source": "crossref", "checked_at": time.time()},
                })
    except SourceError as e:
        errors.append(f"Crossref：{e.message}")
    try:
        results.extend(await search_openalex(q, limit))
    except SourceError as e:
        errors.append(f"OpenAlex：{e.message}")
    # 去重：DOI 优先，其次规范化标题
    seen: set[str] = set()
    deduped = []
    for c in results:
        doi = (c["fields"].get("doi") or "").lower()
        tn = re.sub(r"[^a-z0-9]+", "", (c["fields"].get("title") or "").lower())[:120]
        key = f"doi:{doi}" if doi else f"t:{tn}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(c)
    deduped = deduped[: max(limit, 3)]
    if not deduped and errors:
        raise SourceError(502, "；".join(errors), kind="source_unreachable")
    _cache_put(cache_key, deduped)
    return deduped


def _q(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="")
