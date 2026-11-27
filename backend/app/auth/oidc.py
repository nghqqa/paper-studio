# -*- coding: utf-8 -*-
"""通用企业 OIDC / OAuth 2.0 单点登录（PKCE S256 + Session Cookie 签发）。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from datetime import UTC, datetime
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select

from app import config
from app.domain import events, org
from app.errors import error_detail

router = APIRouter(prefix="/api/auth/oidc", tags=["oidc"])

_STATE_TTL = 600.0
_DISCOVER_TTL = 300.0
_STATE_COOKIE = "ps_oidc_state"
_lock = threading.Lock()
_states: dict[str, dict] = {}
_discover_cache: dict[tuple[str, int], tuple[float, dict]] = {}


def _prune_states(now: float) -> None:
    stale = [k for k, v in _states.items() if now - float(v.get("at", 0.0)) > _STATE_TTL]
    for k in stale:
        _states.pop(k, None)


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _valid_oidc_url(raw: str) -> bool:
    try:
        p = urlsplit(raw)
    except ValueError:
        return False
    if p.scheme == "https" and p.hostname:
        return True
    if p.scheme == "http" and p.hostname in ("localhost", "127.0.0.1", "::1"):
        return True
    return False


async def _discover(issuer: str) -> dict:
    clean_issuer = issuer.rstrip("/")
    cache_key = (clean_issuer, id(httpx.AsyncClient))
    now = time.time()
    with _lock:
        hit = _discover_cache.get(cache_key)
        if hit is not None and now - hit[0] < _DISCOVER_TTL:
            return hit[1]

    url = clean_issuer + "/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()
    if not isinstance(data, dict) or not data.get("authorization_endpoint") or not data.get("token_endpoint"):
        raise ValueError("OIDC discovery 缺少 authorization_endpoint 或 token_endpoint")
    if "issuer" in data and str(data["issuer"]).rstrip("/") != clean_issuer:
        raise ValueError("OIDC discovery issuer 与配置不一致")
    for k in ("authorization_endpoint", "token_endpoint", "userinfo_endpoint"):
        if data.get(k) and not _valid_oidc_url(str(data[k])):
            raise ValueError(f"OIDC discovery {k} URL 不合法")

    with _lock:
        _discover_cache[cache_key] = (now, data)
    return data


def _redirect_uri(request: Request) -> str:
    if config.OIDC_REDIRECT_URI:
        return config.OIDC_REDIRECT_URI
    base = (config.PUBLIC_ORIGIN or str(request.base_url)).rstrip("/")
    return f"{base}/api/auth/oidc/callback"


@router.get("/config")
async def oidc_config() -> dict:
    return {"enabled": config.OIDC_ENABLED, "label": config.OIDC_LABEL}


@router.get("/login")
async def oidc_login(request: Request):
    if not config.OIDC_ENABLED:
        raise HTTPException(404, error_detail("not_found", "尚未启用 OIDC 单点登录"))
    try:
        meta = await _discover(config.OIDC_ISSUER)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, error_detail("upstream", f"无法连接 OIDC 身份提供商：{exc}")) from exc

    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    redir = _redirect_uri(request)
    now = time.time()
    with _lock:
        _prune_states(now)
        if len(_states) >= 2000:
            raise HTTPException(429, error_detail("rate_limit", "当前单点登录请求过多，请稍后重试"))
        _states[state] = {"verifier": verifier, "redirect_uri": redir, "at": now}

    params = urlencode({
        "response_type": "code",
        "client_id": config.OIDC_CLIENT_ID,
        "redirect_uri": redir,
        "scope": config.OIDC_SCOPES,
        "state": state,
        "code_challenge": _pkce_challenge(verifier),
        "code_challenge_method": "S256",
    })
    sep = "&" if "?" in meta["authorization_endpoint"] else "?"
    resp = RedirectResponse(url=f"{meta['authorization_endpoint']}{sep}{params}", status_code=302)
    resp.set_cookie(
        _STATE_COOKIE,
        state,
        max_age=int(_STATE_TTL),
        httponly=True,
        samesite="lax",
        secure=config.COOKIE_SECURE,
        path="/api/auth/oidc/callback",
    )
    return resp


@router.get("/callback")
async def oidc_callback(
    request: Request,
    code: str = Query(default=""),
    state: str = Query(default=""),
    error: str = Query(default=""),
):
    if not config.OIDC_ENABLED:
        raise HTTPException(404, error_detail("not_found", "尚未启用 OIDC 单点登录"))
    if error:
        raise HTTPException(400, error_detail("auth", f"OIDC 认证被拒绝：{error}"))
    if not code or not state:
        raise HTTPException(400, error_detail("auth", "缺少授权码或 state 参数"))

    cookie_state = request.cookies.get(_STATE_COOKIE) or ""
    if not cookie_state or not hmac.compare_digest(cookie_state, state):
        raise HTTPException(400, error_detail("auth", "登录 state 已过期或无效，请重新发起单点登录"))
    now = time.time()
    with _lock:
        _prune_states(now)
        rec = _states.pop(state, None)
    if rec is None:
        raise HTTPException(400, error_detail("auth", "登录 state 已过期或无效，请重新发起单点登录"))

    try:
        meta = await _discover(config.OIDC_ISSUER)
        token_form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": rec["redirect_uri"],
            "client_id": config.OIDC_CLIENT_ID,
            "code_verifier": rec["verifier"],
        }
        if config.OIDC_CLIENT_SECRET:
            token_form["client_secret"] = config.OIDC_CLIENT_SECRET
        async with httpx.AsyncClient(timeout=15.0) as client:
            tok_resp = await client.post(meta["token_endpoint"], data=token_form)
            tok_resp.raise_for_status()
            tok_json = tok_resp.json()
            access_token = str(tok_json.get("access_token") or "")
            if not access_token:
                raise ValueError("token 响应缺少 access_token")
            userinfo_url = meta.get("userinfo_endpoint")
            if not userinfo_url:
                raise ValueError("OIDC discovery 缺少 userinfo_endpoint")
            ui_resp = await client.get(userinfo_url, headers={"Authorization": f"Bearer {access_token}"})
            ui_resp.raise_for_status()
            uinfo = ui_resp.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, error_detail("upstream", f"OIDC 令牌换取失败：{exc}")) from exc

    email = str(uinfo.get("email") or "").strip().lower()
    if "@" not in email:
        raise HTTPException(422, error_detail("auth", "身份提供商未返回有效邮箱字段 (email)"))
    if uinfo.get("email_verified") is not True:
        raise HTTPException(403, error_detail("forbidden", "身份提供商未验证该邮箱（需要 email_verified=true）"))
    display_name = str(uinfo.get("name") or uinfo.get("preferred_username") or email.split("@", 1)[0]).strip()[:64]

    from fastapi_users.db import SQLAlchemyUserDatabase

    from app.auth import invites
    from app.auth.db import SessionLocal, UserManager, first_user_lock, init_db
    from app.auth.models import PendingInvite, User
    from app.auth.users import auth_backend, get_jwt_strategy

    await init_db()
    async with SessionLocal() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            if not config.OIDC_AUTO_PROVISION:
                raise HTTPException(403, error_detail("forbidden", "当前站点未开启 SSO 自动创建账号，请联系管理员预建成员"))
            policy = org.load_org().registration
            has_pending = bool(
                await session.scalar(select(PendingInvite.project_id).where(PendingInvite.email == email).limit(1))
            )
            if policy.allowed_domains and not has_pending and not org.domain_allowed(email, policy.allowed_domains):
                raise HTTPException(403, error_detail("forbidden", f"仅允许域名：{', '.join(policy.allowed_domains)}"))
            mgr = UserManager(SQLAlchemyUserDatabase(session, User))
            async with first_user_lock:
                total = await session.scalar(select(func.count()).select_from(User))
                is_first = (total or 0) == 0
                user = User(
                    email=email,
                    hashed_password=mgr.password_helper.hash(secrets.token_urlsafe(32)),
                    is_active=True,
                    is_superuser=is_first,
                    is_verified=True,
                    display_name=display_name,
                    title="",
                )
                session.add(user)
                await session.commit()
                await session.refresh(user)
        if not user.is_active:
            raise HTTPException(403, error_detail("forbidden", "该账号已被管理员停用"))
        user.last_login_at = datetime.now(UTC)
        await session.commit()
        await invites.consume(user.email, user.id)
        events.emit("auth.login", actor=events.actor_of(user), data={"email": user.email, "provider": "oidc"})

    login_resp = await auth_backend.login(get_jwt_strategy(), user)
    out = RedirectResponse(url="/#/", status_code=302)
    for cookie_hdr in login_resp.headers.getlist("set-cookie"):
        out.headers.append("set-cookie", cookie_hdr)
    out.delete_cookie(_STATE_COOKIE, path="/api/auth/oidc/callback")
    out.set_cookie(
        "ps_oidc_ok",
        "1",
        max_age=60,
        httponly=False,
        samesite="lax",
        secure=config.COOKIE_SECURE,
        path="/",
    )
    return out
