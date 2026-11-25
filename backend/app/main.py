# -*- coding: utf-8 -*-
"""研稿 · Paper Studio FastAPI 后端主入口。"""

import asyncio
import mimetypes
import os
import sys
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import atomic, auth, config
from app.ai import client as ai_client
from app.auth import project_access
from app.auth.invites import router as invites_router
from app.auth.router import router as auth_router
from app.auth.routes_access import router as access_router
from app.auth.routes_admin import router as admin_router
from app.auth.users_me import router as users_me_router
from app.domain import cases, events, org, org_audit, word_documents
from app.domain.projects import ProjectError, ProjectStore
from app.errors import error_detail
from app.routes.ai import router as ai_router
from app.routes.cases import router as cases_router
from app.routes.charts import router as charts_router
from app.routes.comments import router as comments_router
from app.routes.latex import demo_router as latex_demo_router
from app.routes.latex import router as latex_router
from app.routes.latex_history import router as latex_history_router
from app.routes.latex_preflight import router as latex_preflight_router
from app.routes.library import router as library_router
from app.routes.office_refs import router as office_refs_router
from app.routes.paper_proposals import router as paper_proposals_router
from app.routes.paper_templates import author_router as paper_templates_author_router
from app.routes.paper_templates import router as paper_templates_router
from app.routes.project_figures import router as project_figures_router
from app.routes.public import router as public_router
from app.routes.rebuttal import router as rebuttal_router
from app.routes.struct_writer import create_router as struct_create_router
from app.routes.struct_writer import router as struct_writer_router
from app.routes.word_editor import router as word_editor_router
from app.routes.word_preflight import router as word_preflight_router
from app.routes.zotero_account import router as zotero_account_router


@asynccontextmanager
async def _lifespan(_: FastAPI):
    yield
    auth_db = sys.modules.get("app.auth.db")
    if auth_db is not None:
        await auth_db.engine.dispose()


app = FastAPI(
    title="研稿 · 论文写作与审阅 API",
    version="0.1.0",
    dependencies=[Depends(project_access)],
    lifespan=_lifespan,
)
store = ProjectStore(config.PROJECTS_DIR)
app.state.store = store
app.state.ai = ai_client.from_env()

# 事件订阅：机构审计 + 新建项目继承机构默认协作设置
org_audit.install()


def _on_case_created(ev: events.Event) -> None:
    if config.AUTH_ON and ev.pid:
        org.apply_default_collab(ev.pid)


events.subscribe("case.created", _on_case_created)

# 认证 / 权限 / 机构管理
app.include_router(auth_router)
app.include_router(access_router)
app.include_router(invites_router)
app.include_router(users_me_router)
app.include_router(admin_router)
# 批注 / 公开审阅 / 项目台账 / AI
app.include_router(comments_router)
app.include_router(ai_router)
app.include_router(cases_router)
app.include_router(public_router)
# 论文主线（LaTeX / Word / 结构化迁移壳 / 文献 / 提案 / 审稿回复 / 图表 / 模板）
app.include_router(latex_router)
app.include_router(latex_history_router)
app.include_router(latex_demo_router)
app.include_router(latex_preflight_router)
app.include_router(struct_writer_router)
app.include_router(struct_create_router)
app.include_router(charts_router)
app.include_router(project_figures_router)
app.include_router(word_editor_router)
app.include_router(word_preflight_router)
app.include_router(paper_templates_router)
app.include_router(paper_templates_author_router)
app.include_router(library_router)
app.include_router(zotero_account_router)
app.include_router(paper_proposals_router)
app.include_router(rebuttal_router)
app.include_router(office_refs_router)

# ONLYOFFICE 本地插件静态目录
app.mount(
    "/api/office-plugin",
    StaticFiles(directory=os.path.join(config.BACKEND_DIR, "app", "office_plugin"), check_dir=False),
    name="office-plugin",
)
app.mount(
    "/api/office-plugin-ai",
    StaticFiles(directory=os.path.join(config.BACKEND_DIR, "app", "office_plugin_ai"), check_dir=False),
    name="office-plugin-ai",
)
app.mount(
    "/api/office-plugin-refs",
    StaticFiles(directory=os.path.join(config.BACKEND_DIR, "app", "office_plugin_refs"), check_dir=False),
    name="office-plugin-refs",
)
app.mount(
    "/api/office-charts",
    StaticFiles(directory=os.path.join(config.BACKEND_DIR, "app", "office_charts"), check_dir=False),
    name="office-charts",
)

_API_BODY_MAX = 8 * 1024 * 1024


@app.middleware("http")
async def _api_body_limit(request: Request, call_next):
    if request.method not in ("POST", "PUT", "PATCH", "DELETE") or not request.url.path.startswith("/api/"):
        return await call_next(request)
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        return await call_next(request)
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > _API_BODY_MAX:
                return _body_too_large()
        except ValueError:
            pass
        return await call_next(request)
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > _API_BODY_MAX:
            return _body_too_large()
    request._body = bytes(body)
    return await call_next(request)


def _body_too_large() -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={"detail": error_detail("file", f"请求体过大（上限 {_API_BODY_MAX // 1024 // 1024} MB）")},
    )


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    if request.url.path == "/" or request.url.path.endswith(".html"):
        resp.headers["Cache-Control"] = "no-cache"
    elif request.url.path.startswith("/assets/") and resp.status_code == 200:
        resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    if (
        request.url.path.startswith("/api/office-plugin/")
        or request.url.path.startswith("/api/office-plugin-ai/")
        or request.url.path.startswith("/api/office-plugin-refs/")
        or request.url.path.startswith("/api/office-charts/")
    ):
        if "X-Frame-Options" in resp.headers:
            del resp.headers["X-Frame-Options"]
        from urllib.parse import urlsplit

        ds = urlsplit(config.ONLYOFFICE_URL)
        resp.headers["Access-Control-Allow-Origin"] = f"{ds.scheme}://{ds.netloc}"
        resp.headers["Vary"] = "Origin"
    elif "/latex/raw/" in request.url.path:
        if "X-Frame-Options" in resp.headers:
            del resp.headers["X-Frame-Options"]
    else:
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


@app.exception_handler(ProjectError)
async def _project_error(_: Request, exc: ProjectError):
    return JSONResponse(status_code=exc.status, content={"detail": str(exc)})


_FIELD_ZH = {
    "email": "邮箱",
    "password": "密码",
    "display_name": "显示名",
    "content": "正文",
    "title": "标题",
    "role": "角色",
}
_TYPE_ERRORS = ("string_type", "int_type", "bool_type", "float_type", "dict_type", "list_type", "literal_error", "enum")


def _validation_zh(err: dict) -> str:
    loc = [str(x) for x in err.get("loc", ()) if x != "body"]
    field = ".".join(loc)
    name = _FIELD_ZH.get(field, field)
    kind = str(err.get("type", ""))
    raw = str(err.get("msg", ""))
    if kind == "missing":
        return f"缺少字段：{name}"
    if field == "email" or "email" in raw.lower():
        return "邮箱格式不正确（须为可投递的邮箱地址，不能使用 .test / .local 等保留域名）"
    if kind.startswith("string_too_short") or kind.startswith("too_short"):
        return f"{name}过短"
    if kind.startswith("string_too_long") or kind.startswith("too_long"):
        return f"{name}过长"
    if kind.startswith(_TYPE_ERRORS):
        return f"{name}类型或取值不合法"
    return f"{name}不合法：{raw}" if name else raw


def _jsonable(v):
    if isinstance(v, bytes):
        return "<binary>"
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return str(v)


@app.exception_handler(RequestValidationError)
async def _request_validation(_: Request, exc: RequestValidationError):
    errors = [
        _jsonable({k: v for k, v in e.items() if k != "ctx"}) | {"loc": list(e.get("loc", ()))} for e in exc.errors()
    ]
    message = "；".join(dict.fromkeys(_validation_zh(e) for e in errors)) or "请求参数不合法"
    return JSONResponse(status_code=422, content={"detail": error_detail("validation", message, detail=errors)})


class ProjectIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    title: str = ""
    document_type: str | None = None
    case: cases.CasePatch | None = None
    parent_pid: str | None = Field(default=None, max_length=64)


class SettingsIn(BaseModel):
    document_type: str | None = None
    source_format: str | None = None
    latex: dict | None = None
    title: str | None = None
    submission: dict[str, str] | None = None
    blind_terms: list[str] | None = None
    style: dict | None = None
    ai_enabled: bool | None = None
    ai_daily_tokens: int | None = None
    preflight: dict | None = None


def _mtime(p):
    try:
        fmt = p.settings.get("source_format")
        if fmt == "docx":
            paths = [os.path.join(p.dir, "document.docx")]
        elif fmt == "latex":
            from app.domain.latex_build import list_source_files

            paths = [os.path.join(p.dir, item["path"]) for item in list_source_files(p)]
        elif fmt == "structured":
            paths = [os.path.join(p.dir, "content.json")]
        else:
            paths = [p.content_path]
        paths.append(os.path.join(p.dir, "studio.json"))
        return max((os.path.getmtime(path) for path in paths if os.path.isfile(path)), default=0.0)
    except OSError:
        return 0.0


def _project_out(p):
    return {
        "id": p.id,
        "title": p.title,
        "source_format": p.settings.get("source_format", "markdown"),
        "mtime": _mtime(p),
        "figs": store.list_figs(p.dir),
        "settings": p.settings,
        "has_settings_file": store.has_settings_file(p.id),
        "case": cases.summary(cases.ensure_case(p.dir)),
    }


@app.get("/api/meta")
async def meta():
    return {
        "product": "paper",
        "docx_export": config.DOCX_EXPORT_ON,
        "struct_writer": config.STRUCT_WRITER_ON,
        "word_editor": config.WORD_EDITOR_ON,
        "word_editor_ready": word_documents.ready(),
        "demo_mode": config.DEMO_MODE,
        "contact": {
            "email": config.CONTACT_EMAIL,
            "wechat": config.CONTACT_WECHAT,
            "note": config.CONTACT_NOTE,
        },
    }


@app.get("/api/paper-templates", dependencies=[Depends(auth.require_login)])
async def paper_templates():
    from app.domain import paper_templates as registry

    struct = []
    if config.STRUCT_WRITER_ON:
        struct = [
            {
                "id": "jcip",
                "name": "中文信息学报（jcip）",
                "desc": "结构化写作 → DOCX/PDF 导出；编号为静态文本，仅支持受限公式子集（实验）",
                "experimental": True,
            }
        ]
    return {**await asyncio.to_thread(registry.catalogue), "struct": struct}


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/projects")
async def list_projects(user: auth.CurrentUser):
    out = []
    states = cases.list_states(cases.user_key(user))
    owners: dict[str, dict | None] = {}
    pids = await auth.visible_pids(user, store.list_ids())
    if config.AUTH_ON and user is not None:
        from app.auth import access, acl

        su = user.is_superuser
        roles_map = {} if su else await acl.roles_map_for(user.id)
        members_map = await acl.members_map_for_pids(pids)
        seen_map = await access.last_seen_for_pids(pids)

        def role_of(pid: str) -> str | None:
            return "owner" if su else roles_map.get(pid)

        def collab_of(pid: str) -> list[dict]:
            return cases.collaborators_of(pid, members_map.get(pid, []), seen_map.get(pid, {}))
    else:

        def role_of(pid: str) -> str | None:  # noqa: ARG001
            return None

        def collab_of(pid: str) -> list[dict]:  # noqa: ARG001
            return []

    for pid in pids:
        p = store.get(pid)
        extra = await cases.list_extra(
            p.dir, pid, user, states, owners=owners, my_role=role_of(pid), collab=collab_of(pid)
        )
        if p.settings.get("document_type") == "paper":
            extra["owner"] = next(
                (
                    {k: member.get(k) for k in ("user_id", "email", "display_name", "avatar_color")}
                    for member in extra["collaborators"]
                    if member.get("role") == "owner"
                ),
                None,
            )
        out.append(
            {
                "id": p.id,
                "title": p.title,
                "mtime": _mtime(p),
                "source_format": p.settings.get("source_format", "markdown"),
                "submission": p.settings.get("submission") or {},
                **extra,
            }
        )
    return out


@app.post("/api/projects", status_code=201)
async def create_project(body: ProjectIn, request: Request, user: auth.CurrentUser):
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    parent = None
    if body.parent_pid:
        if body.parent_pid == body.id.strip():
            raise ProjectError("母案不能是案子自身", 422)
        parent = store.get(body.parent_pid)
        await auth.check_access(request, user, parent.id, "agent")
    p = store.create(body.id.strip(), body.title, body.document_type)
    case = cases.default_case(p.dir)
    if body.case is not None:
        case = cases.apply_patch(case, body.case)
    if parent is not None:
        cases.add_related(case, parent.id, "parent")
    if user is not None and case.owner_user_id is None:
        case.owner_user_id = str(user.id)
    cases.save_case(p.dir, case)
    await auth.grant_owner(p.id, user)
    if parent is not None:
        with atomic.studio_lock(parent.dir, "case"):
            pcase = cases.load_case(parent.dir)
            if cases.add_related(pcase, p.id, "divisional"):
                cases.save_case(parent.dir, pcase)
    events.emit(
        "case.created",
        pid=p.id,
        actor=events.actor_of(user),
        data={"title": p.title, **({"parent": parent.id} if parent is not None else {})},
    )
    return _project_out(p)


@app.get("/api/projects/{pid}")
async def get_project(pid: str, user: auth.CurrentUser):
    p = store.get(pid)
    d = _project_out(p)
    d["role"] = await auth.my_role(pid, user)
    d["content"] = ""
    d["backups"] = []
    await auth.access_touch(pid, user)
    return d


@app.get("/api/projects/{pid}/settings")
async def get_settings(pid: str):
    return {"settings": store.load_settings(pid)}


@app.put("/api/projects/{pid}/settings")
async def put_settings(pid: str, body: SettingsIn):
    try:
        s = await asyncio.to_thread(store.update_settings, pid, body.model_dump(exclude_none=True))
    except (TypeError, ValueError, KeyError, IndexError) as e:
        raise HTTPException(422, f"settings 不合法：{e}")
    return {"settings": s}


mimetypes.add_type("text/javascript", ".mjs")

if os.path.isdir(config.STATIC_DIR):
    app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
