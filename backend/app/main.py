# -*- coding: utf-8 -*-
"""Patent Studio FastAPI 后端。"""

import asyncio
import copy
import hashlib
import mimetypes
import os
import sys
import tempfile
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import atomic, auth, config
from app.ai import client as ai_client
from app.ai.jobs import JobStore
from app.auth import project_access
from app.auth.invites import router as invites_router
from app.auth.router import router as auth_router
from app.auth.routes_access import router as access_router
from app.auth.routes_admin import router as admin_router
from app.auth.users_me import router as users_me_router
from app.collab import rooms as collab_rooms
from app.collab.routes import router as collab_router
from app.deadlines import scan as deadline_scan
from app.domain import cases, events, history, review_meta, terms, word_documents
from app.domain.build import artifact_path, latest_artifact_dir, run_build
from app.domain.check import run_check_all
from app.domain.lint import lint
from app.domain.projects import ProjectError, ProjectStore, default_settings, normalize_settings
from app.domain.xml_export import run_xml_export, xml_file, xml_zip_path
from app.errors import error_detail
from app.lo import docx_to_pdf, last_backend, soffice_available, unoserver_available
from app.mcp.http import mcp_lifespan, mount_mcp
from app.mcp.server import server as mcp_server
from app.routes.agent import router as agent_router
from app.routes.ai import router as ai_router
from app.routes.ast import router as ast_router
from app.routes.attachments import router as attachments_router
from app.routes.cases import router as cases_router
from app.routes.charts import router as charts_router
from app.routes.comments import router as comments_router
from app.routes.convert import router as convert_router
from app.routes.deadlines import router as deadlines_router
from app.routes.deliver import router as deliver_router
from app.routes.docset import router as docset_router
from app.routes.figlib import router as figlib_router
from app.routes.figures import router as figures_router
from app.routes.history import router as history_router
from app.routes.imports import router as import_router
from app.routes.latex import demo_router as latex_demo_router
from app.routes.latex import router as latex_router
from app.routes.latex_history import router as latex_history_router  # LaTeX 工程版本历史
from app.routes.library import router as library_router  # v0.4：智能文献管理
from app.routes.zotero_account import router as zotero_account_router  # B2：Zotero 凭据
from app.routes.notify import router as notify_router
from app.routes.novelty import router as novelty_router
from app.routes.oa import router as oa_router
from app.routes.office_refs import router as office_refs_router  # v0.4：Word 文献引用插件任务箱
from app.routes.paper_proposals import router as paper_proposals_router  # v0.4：论文 AI 修改提案
from app.routes.paper_templates import author_router as paper_templates_author_router
from app.routes.paper_templates import router as paper_templates_router
from app.routes.pat import router as pat_router
from app.routes.patch import router as patch_router
from app.routes.preflight import router as preflight_router
from app.routes.project_figures import router as project_figures_router
from app.routes.public import router as public_router
from app.routes.rebuttal import router as rebuttal_router
from app.routes.struct_writer import create_router as struct_create_router
from app.routes.struct_writer import router as struct_writer_router
from app.routes.style import router as style_router
from app.routes.templates import router as templates_router
from app.routes.terms import router as terms_router
from app.routes.timeline import router as timeline_router
from app.routes.tracked import author_name
from app.routes.tracked import router as tracked_router
from app.routes.latex_preflight import router as latex_preflight_router
from app.routes.word_editor import router as word_editor_router
from app.routes.word_preflight import router as word_preflight_router
from patent_studio.kernel import critic
from patent_studio.kernel.style import DEFAULT_STYLE, merge_style


@asynccontextmanager
async def _lifespan(_: FastAPI):
    # W5 deadlines：每小时扫全部 case.json，对剩余 30/7/1 天的未完成期限 emit deadline.due（notify 订阅写站内通知）
    scanner = asyncio.create_task(deadline_scan.run_forever(config.PROJECTS_DIR))
    try:
        # R7：MCP Streamable HTTP 会话管理器随进程启停（docs/plan/10 §3.1）
        async with mcp_lifespan(mcp_server):
            yield
    finally:
        scanner.cancel()
    # R8（11 §4）：进程退出前把未到去抖点（<0.8s）的协同键入落盘并释放全部房间
    await collab_rooms.shutdown()
    # R97：收编在飞 aiosqlite 连接——但 AUTH=off 下 app.auth.db 本就不该被引入（test_off 约束），懒取模块
    auth_db = sys.modules.get("app.auth.db")
    if auth_db is not None:
        await auth_db.engine.dispose()


# R6（07 §3）：project_access 是全局依赖，PATENT_STUDIO_AUTH=off 时直接返回，不产生参数、不改 OpenAPI
app = FastAPI(
    title="研稿 · 论文写作与审阅 API",
    version="0.1.0",
    dependencies=[Depends(project_access)],
    lifespan=_lifespan,
)
store = ProjectStore(config.PROJECTS_DIR)
app.state.store = store

# W5 新建案件钩子（docs/plan/21 §7.4.8）：`async hook(project, user)`，在 grant_owner 之后、case.created 事件之前
# 依次执行。
# deliver-account-admin 单元在此注册「继承机构默认协同设置（OrgSettings.default_collab → ProjectCollabSettings）」，
# 不改 create_project 本体。
PROJECT_CREATED_HOOKS: list = []


# 轨道 E（docs/plan/09 §2）：AI 客户端与后台任务表挂在 app.state，路由经 request.app.state 取用
app.state.ai = ai_client.from_env()
app.state.jobs = JobStore(config.PROJECTS_DIR)
mount_mcp(app, mcp_server)  # R7：Streamable HTTP 精确路径 /mcp（docs/plan/10 §3.3）
app.include_router(ast_router)
app.include_router(docset_router)
app.include_router(figures_router)
app.include_router(figlib_router)  # 附图图库：docs/figure-library 只读浏览
app.include_router(attachments_router)  # W4-C：/attachments 上传 / 预览 / 删除
app.include_router(preflight_router)
app.include_router(patch_router)
app.include_router(style_router)  # W4-D D1：/style.css（prep 501）
app.include_router(auth_router)
app.include_router(access_router)  # W4-B B1：/access /collab-settings
app.include_router(invites_router)  # W4-B B2：/invites
app.include_router(users_me_router)  # W4-E E2：PUT /users/me
app.include_router(admin_router)  # W4-E E2：/admin/users /admin/org
app.include_router(comments_router)
app.include_router(history_router)
app.include_router(ai_router)
app.include_router(terms_router)
app.include_router(convert_router)
app.include_router(oa_router)
app.include_router(pat_router)
app.include_router(tracked_router)
app.include_router(import_router)
app.include_router(latex_router)  # w21 批A：原生 LaTeX 最小闭环
app.include_router(latex_history_router)  # LaTeX 工程版本历史（防丢稿，同一 per-project git）
app.include_router(latex_demo_router)
app.include_router(struct_writer_router)
app.include_router(charts_router)
app.include_router(project_figures_router)  # v0.1 proto：结构化中文论文（实验，默认关闭）
app.include_router(struct_create_router)  # 结构化创建（无 {pid} 前缀，与 latex-demo 同位）
app.include_router(word_editor_router)
app.include_router(word_preflight_router)  # Word 投稿前检查（多规则集：jcip/cn-general/double-blind，只读报告）
app.include_router(latex_preflight_router)  # LaTeX 投稿前检查（latex-general/double-blind，只读报告）
app.include_router(paper_templates_router)
app.include_router(paper_templates_author_router)  # 作者端模板缩略图（登录态只读）
app.include_router(library_router)  # v0.4：智能文献管理（.bib 事实源 + 可重建索引 + 外部元数据源）
app.include_router(zotero_account_router)  # B2：Zotero API Key 用户级凭据（masked，永不回传）
app.include_router(paper_proposals_router)  # v0.4：论文 AI 修改提案（生成/审阅台账；落地在编辑器）
app.include_router(rebuttal_router)  # P1-1：审稿回复信（拆条 / 进度 / AI 草稿 / 导出 Response Letter，仅 paper 项目）
app.include_router(office_refs_router)  # v0.4：Word 引用插件任务箱（动态 config 路由在库内）
# Plugin config is a dynamic route registered above; other plugin files are
# served locally, including the vendored formula preview renderer.
app.mount("/api/office-plugin", StaticFiles(directory=os.path.join(config.BACKEND_DIR, "app", "office_plugin"),
                                          check_dir=False), name="office-plugin")
# AI 润色插件（论文线 v0.3）：独立插件目录与挂载，config.json 走 word_editor 动态路由。
app.mount("/api/office-plugin-ai", StaticFiles(directory=os.path.join(config.BACKEND_DIR, "app", "office_plugin_ai"),
                                               check_dir=False), name="office-plugin-ai")
# 文献引用插件（v0.4）：config/settings/debug 走 office_refs 动态路由，静态件本地伺服。
app.mount("/api/office-plugin-refs",
          StaticFiles(directory=os.path.join(config.BACKEND_DIR, "app", "office_plugin_refs"),
                      check_dir=False), name="office-plugin-refs")
# 科研图表插件（v0.6.2）：自 LaTeX公式 插件拆分的独立插件，config/settings 走 word_editor 动态路由。
app.mount("/api/office-charts",
          StaticFiles(directory=os.path.join(config.BACKEND_DIR, "app", "office_charts"),
                      check_dir=False), name="office-charts")
app.include_router(templates_router)
app.include_router(cases_router)
app.include_router(deliver_router)  # W4-E E1：/deliver 清单 + /deliver/bundle
# W5（docs/plan/21 §7.4.8）：期限 / 通知 / 公开分享 / 时间线 / AI 智能体；各 routes/*.py 内实现，经 events.py 解耦
app.include_router(deadlines_router)
app.include_router(notify_router)
app.include_router(novelty_router)  # W19 批4：/novelty 查新记录卡
app.include_router(public_router)
app.include_router(timeline_router)
app.include_router(agent_router)
app.include_router(collab_router)  # R8：含 Starlette WebSocketRoute，须在末尾 StaticFiles mount 之前


# /api/ 非 multipart 请求体上限：公开端点（分享/客户页）未认证即可 POST JSON——裸读超大 body
# 直接爆整机内存（multipart 上传由 read_bounded 各路由自管；starlette form() 大件本就走磁盘池化）。
# 注册在 _security_headers 之前（add_middleware 前插，后定义者反而最外层）：本中间件跑内层，
# 它的 413 早退回包仍会经安全头中间件补 no-store 等头。
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
    # chunked/无 CL：流读封顶，读出的体回填供下游 body()/json() 复用
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
    """R31-01：全站安全响应头基线。同源 SPA + cookie 会话：nosniff 防 MIME 嗅探、
    SAMEORIGIN 防点击劫持、referrer same-origin 防公开链 token 经 Referer 泄漏。
    CSP 暂不加：index.html boot splash 依赖内联 <style>，收紧需 nonce 化（另立项）。"""
    resp = await call_next(request)
    # /api/ 全响应（含错误）no-store：Chrome 实测会缓存 410——公开链接复活后仍渲「已过期」；
    # 已显式声明的（style.css no-cache / 下载 no-store）不受影响。静态资源在 / 不归此闸。
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    # index.html 每次重验证：部署换 hash 资产后，缓存旧壳引用已删文件即整页 404；
    # ETag 304 走快路径不传内容。hash 命名的 /assets/* 保留启发式缓存。
    if request.url.path == "/" or request.url.path.endswith(".html"):
        resp.headers["Cache-Control"] = "no-cache"
    elif request.url.path.startswith("/assets/") and resp.status_code == 200:
        resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    # DS 插件三桥（公式/AI 选区桥/文献引用桥）：config 由 web-apps（DS 源）跨源 fetch
    # （Plugins.getPlugins 对失败静默吞掉——缺 CORS 头时插件 iframe 直接不创建，无任何报错），
    # 插件 iframe 也由 DS 文档源嵌入——故放行 XFO 并把 ACAO 精确指到所配 DS 源。
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
        # LaTeX 源文件 raw 预览（图片/PDF）由本站 iframe 嵌入：放行 XFO。
        # 跨站 iframe 因 SameSite=Lax 不带 cookie 本就 401；XFO 防的是点击劫持——只读媒体无此风险。
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
    """请求体校验失败 → 与结构错误同形的中文 detail（登录/注册页直接展示 message；原始错误放 detail 供排查）。"""
    errors = [
        _jsonable({k: v for k, v in e.items() if k != "ctx"}) | {"loc": list(e.get("loc", ()))} for e in exc.errors()
    ]
    message = "；".join(dict.fromkeys(_validation_zh(e) for e in errors)) or "请求参数不合法"
    return JSONResponse(status_code=422, content={"detail": error_detail("validation", message, detail=errors)})


class ContentIn(BaseModel):
    content: str
    # 乐观并发（批76，putDoc base_sha 同族）：客户端自认与盘一致的内容 sha256；
    # 与现值不符 ⇒ 409，多页签/多会话互不覆盖。缺省 = 不校验（旧客户端兼容）
    base: str | None = None


class ProjectIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    title: str = ""
    # w20 批 A1：文档档案（patent 缺省 / paper）；未知值 → store.create 转 ProjectError(422)
    document_type: str | None = None
    # W4-A：新建案卷对话框的案号 / 客户 / 责任人等直接落 case.json（可省）
    case: cases.CasePatch | None = None
    # W19 批7 ⑪c：新建分案时给母案 pid——子案落 related(parent) 并在母案追加 related(divisional)
    parent_pid: str | None = Field(default=None, max_length=64)


CriticMode = Literal["final", "original", "markup"]


class BuildIn(BaseModel):
    content: str | None = None
    settings: dict | None = None
    pdf: bool = True
    mode: CriticMode = "final"


class XmlExportIn(BaseModel):
    content: str | None = None
    settings: dict | None = None
    mode: CriticMode = "final"


class LintIn(BaseModel):
    content: str | None = None
    settings: dict | None = None


class SettingsIn(BaseModel):
    document_type: str | None = None
    # w21 批A：LaTeX 工程配置（markdown 项目不携带这些键）
    source_format: str | None = None
    latex: dict | None = None
    title: str | None = None
    submission: dict[str, str] | None = None
    blind_terms: list[str] | None = None  # 双盲检查屏蔽词（double-blind 规则集扫描用）
    abstract_figure: list | None = None
    spec_figures: list[list] | None = None
    sub_except: list[str] | None = None
    abstract_limit: int | None = None
    style: dict | None = None
    ai_enabled: bool | None = None
    ai_daily_tokens: int | None = None
    preflight: dict | None = None
    notify_webhook_url: str | None = None


def _mtime(p):
    """content.md 最后修改时间（秒），前端案子列表展示/排序用。"""
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
        if fmt in ("latex", "structured", "docx"):
            paths.append(os.path.join(p.dir, "studio.json"))
        return max((os.path.getmtime(path) for path in paths if os.path.isfile(path)), default=0.0)
    except OSError:
        return 0.0


_NO_STORE = {"Cache-Control": "no-store"}
_MEDIA = {"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


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


def _require_legacy_source(pid):
    p = store.get(pid)
    if p.settings.get("source_format") == "docx":
        raise ProjectError("原生 Word 工程请使用 Word 编辑器的保存与导出入口", 400)
    return p


@app.get("/api/meta")
async def meta():
    """产品形态与能力开关（匿名可读）：前端据此做论文/专利界面边界与入口显隐。"""
    return {
        "product": config.PRODUCT,  # paper=论文部署（隐藏专利导航/入口）；patent=完整专利产品线
        "docx_export": config.DOCX_EXPORT_ON,  # 实验性 DOCX 导出开关
        "struct_writer": config.STRUCT_WRITER_ON,  # 结构化中文论文（实验，默认关闭）
        "word_editor": config.WORD_EDITOR_ON,
        "word_editor_ready": word_documents.ready(),
        "contact": {
            "email": config.CONTACT_EMAIL,
            "wechat": config.CONTACT_WECHAT,
            "note": config.CONTACT_NOTE,
        },
    }


@app.get("/api/paper-templates", dependencies=[Depends(auth.require_login)])
async def paper_templates():
    """论文模板注册表（统一新建对话框数据源；来自现有种子目录与 profile 元数据，
    不为单个模板做专用页面）。结构化 profile 仅在开关开启时列出——关闭时入口与 API 双侧不可用。"""
    from app.domain import paper_templates as registry
    struct = []
    if config.STRUCT_WRITER_ON:
        struct = [{"id": "jcip", "name": "中文信息学报（jcip）",
                   "desc": "结构化写作 → DOCX/PDF 导出；编号为静态文本，仅支持受限公式子集（实验）",
                   "experimental": True}]
    return {**await asyncio.to_thread(registry.catalogue), "struct": struct}


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "soffice": soffice_available(),
        "soffice_bin": config.SOFFICE,
        "unoserver": await asyncio.to_thread(unoserver_available),
        "unoserver_url": config.UNOSERVER_URL,
        "pdf_backend": last_backend(),
        "projects_dir": config.PROJECTS_DIR,
    }


@app.get("/api/projects")
async def list_projects(user: auth.CurrentUser):
    out = []
    states = cases.list_states(cases.user_key(user))
    owners: dict[str, dict | None] = {}
    pids = await auth.visible_pids(user, store.list_ids())
    # R82-02：my_role / collaborators / last_seen 逐案查库是 3N 次往返——登录态先一次批量取回
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
            # Paper ownership comes from project ACL, not the patent case assignee.
            extra["owner"] = next((
                {k: member.get(k) for k in ("user_id", "email", "display_name", "avatar_color")}
                for member in extra["collaborators"] if member.get("role") == "owner"
            ), None)
        out.append({"id": p.id, "title": p.title, "mtime": _mtime(p),
                    "source_format": p.settings.get("source_format", "markdown"),
                    "submission": p.settings.get("submission") or {}, **extra})
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
        # 在母案 case.json 追加分案反向链等价于 PUT /case 的一次写，同门槛 agent
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
    for hook in PROJECT_CREATED_HOOKS:
        await hook(p, user)
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
    # w21 批A：LaTeX 工程无 content.md（正文走 /latex/files），content 置空不触发三书装配
    # v0.2 proto：结构化工程同理（正文走 /struct/content，JSON 事实源）
    d["content"] = (""
                    if p.settings.get("source_format") in ("latex", "structured", "docx")
                    else store.read_content(pid))
    d["backups"] = store.list_backups(pid)[:20]
    await auth.access_touch(pid, user)
    return d


@app.get("/api/projects/{pid}/content")
async def get_content(pid: str):
    return {"content": store.read_content(pid)}


@app.put("/api/projects/{pid}/content")
async def put_content(pid: str, body: ContentIn, user: auth.CurrentUser):
    if store.get(pid).settings.get("source_format") == "structured":
        raise HTTPException(
            400, error_detail("validation", "结构化工程不使用 content.md：请使用 /struct/content 端点"))
    cur = store.read_content(pid)
    await auth.check_source_write(pid, user, cur, body.content)
    if body.base is not None and hashlib.sha256(cur.encode()).hexdigest() != body.base:
        raise HTTPException(
            status_code=409,
            detail=error_detail("conflict", "文档已被另一会话修改，请刷新页面后再保存（避免互相覆盖）"),
        )
    actor = user.email if user is not None else None
    with history.override("save", actor), review_meta.writer(review_meta.author_of(user)):
        # 批80：save_content 内含 git commit（subprocess 百毫秒级）——同步跑会 stall 单 worker 事件循环
        # （协同心跳同受影响）；contextvars 的 override/author 随 to_thread 继承
        backup = await asyncio.to_thread(store.save_content, pid, body.content)
    return {"ok": True, "backup": backup, "backups": store.list_backups(pid)[:20]}


@app.get("/api/projects/{pid}/backups")
async def list_backups(pid: str):
    return store.list_backups(pid)


@app.get("/api/projects/{pid}/backups/{name}")
async def get_backup(pid: str, name: str):
    return {"name": name, "content": store.read_backup(pid, name)}


@app.get("/api/settings/defaults")
async def settings_defaults():
    return {"style": copy.deepcopy(DEFAULT_STYLE), "settings": default_settings([])}


@app.get("/api/projects/{pid}/settings")
async def get_settings(pid: str):
    s = store.load_settings(pid)
    return {"settings": s, "effective_style": merge_style(s.get("style"))}


@app.put("/api/projects/{pid}/settings")
async def put_settings(pid: str, body: SettingsIn):
    try:
        # 批80：payload 带 FIGURE_KEYS 时内含 save_figures → git commit——offload 防阻塞事件循环
        # 拍板：PUT /settings 改 merge 语义——部分客户端（MCP/脚本）只传改动键，
        # 未携带的键保留不被重置；FIGURE_KEYS 仍走 save_figures → git commit，须 offload
        s = await asyncio.to_thread(store.update_settings, pid, body.model_dump(exclude_none=True))
    except (TypeError, ValueError, KeyError, IndexError) as e:
        raise HTTPException(422, f"settings 不合法：{e}")
    return {"settings": s, "effective_style": merge_style(s.get("style"))}


@app.post("/api/projects/{pid}/build")
async def build(pid: str, body: BuildIn, user: auth.CurrentUser):
    _require_legacy_source(pid)
    outcome = await asyncio.to_thread(
        run_build, store, pid, body.content, body.settings, body.pdf, body.mode, tagged=True, author=author_name(user)
    )
    return {**outcome.to_dict(), "mode": body.mode}


@app.post("/api/projects/{pid}/lint")
async def lint_project(pid: str, body: LintIn):
    """当前案形式检查（不构建）：content/settings 缺省为已保存内容与 studio.json。
    paper 档案（w20 批 A1）：16 族专利规则不适用，返回空报告（学术规则属批 E1/C2），
    CriticMarkup 记号检查（critic.lint_marks）与档案无关，保留。"""
    p = store.get(pid)
    if p.settings.get("source_format") == "latex":
        # w21 批A：latex 检查前置——read_content 对 LaTeX 工程会直接 400
        raise HTTPException(422, error_detail("content", "LaTeX 工程不适用专利 lint（编译诊断见 /latex/build）"))
    raw = body.content if body.content is not None else store.read_content(pid)
    try:
        s = normalize_settings(body.settings if body.settings is not None else p.settings, store.list_figs(p.dir))
    except (TypeError, ValueError, KeyError, IndexError) as e:
        raise HTTPException(422, f"settings 不合法：{e}")
    report = {
        "diagnostics": [],
        "counts": {"error": 0, "warning": 0, "info": 0},
    }
    if s.get("document_type") == "paper":
        marks = critic.lint_marks(raw)
        report["diagnostics"].extend(marks)
        for d in marks:
            report["counts"][d["severity"]] += 1
        return report
    figures = None if body.settings is not None and "spec_figures" in body.settings else store.load_figures(p.dir)
    report = lint(critic.accept(raw), s, p.figs_dir, with_preflight=True, terms=terms.load(p.dir), figures=figures)
    marks = critic.lint_marks(raw)
    report["diagnostics"].extend(marks)
    for d in marks:
        report["counts"][d["severity"]] += 1
    return report


@app.get("/api/projects/{pid}/builds/{build_id}/{name}")
async def get_artifact(pid: str, build_id: str, name: str):
    _require_legacy_source(pid)
    path = artifact_path(store, pid, build_id, name)
    media = {"out.pdf": _MEDIA["pdf"], "out.docx": _MEDIA["docx"], "content.md": "text/markdown; charset=utf-8"}[name]
    return FileResponse(path, media_type=media, headers=_NO_STORE)


@app.get("/api/projects/{pid}/export")
async def export(pid: str, user: auth.CurrentUser, fmt: str = "docx", build_id: str | None = None):
    if fmt not in ("docx", "pdf"):
        raise HTTPException(400, "fmt 必须是 docx 或 pdf")
    p = _require_legacy_source(pid)
    if build_id:
        src = artifact_path(store, pid, build_id, f"out.{fmt}")
    else:
        latest = latest_artifact_dir(store, pid, f"out.{fmt}")
        if not latest:
            outcome = await asyncio.to_thread(run_build, store, pid, None, None, fmt == "pdf")
            if outcome.status != "ok":
                raise HTTPException(422, (outcome.error or {}).get("message", "构建失败"))
            latest = latest_artifact_dir(store, pid, f"out.{fmt}")
        src = os.path.join(latest, f"out.{fmt}")
    prefix = "论文" if p.settings.get("document_type") == "paper" else "申请文件"
    filename = f"{prefix}-{p.title or pid}.{fmt}"
    media = _MEDIA[fmt]
    events.emit("export.downloaded", pid=pid, actor=events.actor_of(user), data={"fmt": fmt, "build_id": build_id})
    return FileResponse(src, media_type=media, filename=filename, headers=_NO_STORE)


@app.post("/api/projects/{pid}/export/xml")
async def export_xml(pid: str, body: XmlExportIn):
    """CNIPA 五书 XML（官方 DTD 校验）+ JPG → zip；返回报告与下载/预览地址。"""
    _require_legacy_source(pid)
    out = await asyncio.to_thread(run_xml_export, store, pid, body.content, body.settings, body.mode)
    return {**out, "mode": body.mode}


@app.get("/api/projects/{pid}/xml/{xid}/zip")
async def get_xml_zip(pid: str, xid: str):
    p = _require_legacy_source(pid)
    return FileResponse(
        xml_zip_path(store, pid, xid),
        media_type="application/zip",
        filename=f"CNIPA-XML-{p.title or pid}.zip",
        headers=_NO_STORE,
    )


@app.get("/api/projects/{pid}/xml/{xid}/{code}/{name}")
async def get_xml_file(pid: str, xid: str, code: str, name: str):
    _require_legacy_source(pid)
    path, media, html = xml_file(store, pid, xid, code, name)
    if html is not None:
        return Response(html, media_type=media, headers=_NO_STORE)
    return FileResponse(path, media_type=media, headers=_NO_STORE)


@app.get("/api/projects/{pid}/figs/{name}")
async def get_fig(pid: str, name: str):
    path = store.fig_preview_path(pid, name)
    if not path:
        raise HTTPException(404, "附图不存在")
    return FileResponse(path)


@app.post("/api/check")
async def check():
    return await asyncio.to_thread(run_check_all, store)


@app.post("/api/convert")
async def convert_probe():
    """soffice 自检：用一个最小 docx 测转换链路（部署排障用）。"""
    from docx import Document

    with tempfile.TemporaryDirectory() as tmp:
        d = Document()
        d.add_paragraph("Patent Studio soffice 自检 宋体黑体")
        p = os.path.join(tmp, "probe.docx")
        d.save(p)
        try:
            await asyncio.to_thread(docx_to_pdf, p, tmp)
            return {"ok": True, "pdf_backend": last_backend()}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}


# Windows 托管 frontend/dist 的 MIME 兜底：注册表不给 .mjs 正确类型（pdf.worker.min-*.mjs 会被
# 当成 text/plain 等），叠加 X-Content-Type-Options: nosniff 后浏览器直接拒执行、pdf.js 全挂。
# 必须在任何 StaticFiles 响应前注册（模块初始化处，进程级一次性）。
mimetypes.add_type("text/javascript", ".mjs")

if os.path.isdir(config.STATIC_DIR):
    app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
