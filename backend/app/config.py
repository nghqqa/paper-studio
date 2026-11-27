# -*- coding: utf-8 -*-
"""运行配置（环境变量）。

优先读取 ``PAPER_STUDIO_*`` 变量，同时完全向后兼容既有 ``PATENT_STUDIO_*`` / ``PATENT_*`` 前缀。
"""

import os
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


def _env(paper_key: str, legacy_key: str, default: str = "") -> str:
    val = os.environ.get(paper_key)
    if val is not None and val != "":
        return val
    return os.environ.get(legacy_key, default)


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(BACKEND_DIR)

PROJECTS_DIR = os.path.abspath(
    _env("PAPER_STUDIO_PROJECTS_DIR", "PATENT_PROJECTS_DIR", os.path.join(REPO_ROOT, "examples"))
)
STATIC_DIR = _env("PAPER_STUDIO_STATIC_DIR", "PATENT_STATIC_DIR", os.path.join(REPO_ROOT, "frontend", "dist"))
KEEP_BUILDS = int(_env("PAPER_STUDIO_KEEP_BUILDS", "PATENT_KEEP_BUILDS", "3"))
# 账号开关只在启动时读一次；off 时不建 DB、不 import fastapi-users
AUTH_ON = _env("PAPER_STUDIO_AUTH", "PATENT_STUDIO_AUTH", "off").strip().lower() == "on"
# 旧应用 SQLite 与平台 PG 命名隔离；接受 sqlite:////abs/path 或裸路径。
_LEGACY_DB = _env("PAPER_STUDIO_LEGACY_DATABASE_URL", "PATENT_STUDIO_LEGACY_DATABASE_URL", "").strip()
if _LEGACY_DB:
    for _pre in ("sqlite+aiosqlite:///", "sqlite:///"):
        if _LEGACY_DB.startswith(_pre):
            _LEGACY_DB = _LEGACY_DB[len(_pre) :]
            break
    DB_PATH = os.path.abspath(_LEGACY_DB)
else:
    DB_PATH = os.path.join(os.path.dirname(PROJECTS_DIR), "studio.db")
AUTH_SECRET = _env("PAPER_STUDIO_SECRET", "PATENT_STUDIO_SECRET", "")
COOKIE_SECURE = _env("PAPER_STUDIO_COOKIE_SECURE", "PATENT_STUDIO_COOKIE_SECURE", "off").strip().lower() == "on"
# AI 中转站 key 只从这一个变量读；provider=mock 时不出站
AI_KEY = _env("PAPER_STUDIO_AI_KEY", "PATENT_STUDIO_AI_KEY", "").strip()

# 业务统一本地时区：期限倒计时/日历语义一律按此（UTC 容器内不得用本地 tz）
TZ = ZoneInfo("Asia/Shanghai")
AI_PROVIDER = _env("PAPER_STUDIO_AI_PROVIDER", "PATENT_STUDIO_AI_PROVIDER", "aicdks").strip().lower() or "aicdks"

# 原生 LaTeX 编译设置（pdflatex / xelatex）
LATEX_LATEXMK = _env("PAPER_STUDIO_LATEXMK", "PATENT_STUDIO_LATEXMK", "latexmk").strip() or "latexmk"
LATEX_EXTRA_PATH = _env("PAPER_STUDIO_LATEX_EXTRA_PATH", "PATENT_STUDIO_LATEX_EXTRA_PATH", "").strip()
LATEX_TIMEOUT_S = int(_env("PAPER_STUDIO_LATEX_TIMEOUT", "PATENT_STUDIO_LATEX_TIMEOUT", "240"))
LATEX_ENGINES = ("pdflatex", "xelatex", "lualatex")

# 任务运行边界：并发上限（默认单任务）与子进程资源上限（POSIX RLIMIT）
LATEX_CONCURRENCY = int(_env("PAPER_STUDIO_LATEX_CONCURRENCY", "PATENT_STUDIO_LATEX_CONCURRENCY", "1"))
DOCX_EXPORT_CONCURRENCY = int(
    _env("PAPER_STUDIO_DOCX_EXPORT_CONCURRENCY", "PATENT_STUDIO_DOCX_EXPORT_CONCURRENCY", "1")
)
LATEX_RLIMIT_AS_GB = float(_env("PAPER_STUDIO_LATEX_RLIMIT_AS_GB", "PATENT_STUDIO_LATEX_RLIMIT_AS_GB", "3"))
LATEX_RLIMIT_CPU_S = int(_env("PAPER_STUDIO_LATEX_RLIMIT_CPU", "PATENT_STUDIO_LATEX_RLIMIT_CPU", "0"))
ARTIFACT_KEEP = int(_env("PAPER_STUDIO_ARTIFACT_KEEP", "PATENT_STUDIO_ARTIFACT_KEEP", "20"))
TASK_QUEUE_WAIT_S = int(_env("PAPER_STUDIO_TASK_QUEUE_WAIT", "PATENT_STUDIO_TASK_QUEUE_WAIT", "30"))

# 产品形态：固定为论文工作室（保留变量名以便既有部署脚本兼容）
PRODUCT = _env("PAPER_STUDIO_PRODUCT", "PATENT_STUDIO_PRODUCT", "paper").strip().lower() or "paper"

# 受限 LaTeX ZIP 工程导入上限
IMPORT_MAX_UPLOAD_MB = int(_env("PAPER_STUDIO_IMPORT_MAX_UPLOAD_MB", "PATENT_STUDIO_IMPORT_MAX_UPLOAD_MB", "50"))
IMPORT_MAX_TOTAL_MB = int(_env("PAPER_STUDIO_IMPORT_MAX_TOTAL_MB", "PATENT_STUDIO_IMPORT_MAX_TOTAL_MB", "200"))
IMPORT_MAX_FILE_MB = int(_env("PAPER_STUDIO_IMPORT_MAX_FILE_MB", "PATENT_STUDIO_IMPORT_MAX_FILE_MB", "10"))
IMPORT_MAX_FILES = int(_env("PAPER_STUDIO_IMPORT_MAX_FILES", "PATENT_STUDIO_IMPORT_MAX_FILES", "500"))
IMPORT_STAGE_TTL_S = int(_env("PAPER_STUDIO_IMPORT_STAGE_TTL", "PATENT_STUDIO_IMPORT_STAGE_TTL", "3600"))

# 论文模板上传/替换后的自动验收（LaTeX 真实编译、Word 走 ONLYOFFICE /converter 转换）与首页缩略图
PAPER_TEMPLATE_AUTO_ACCEPT = (
    _env("PAPER_STUDIO_TEMPLATE_AUTO_ACCEPT", "PATENT_STUDIO_TEMPLATE_AUTO_ACCEPT", "off").strip().lower() == "on"
)

# LaTeX→DOCX 实验性导出（jcip profile）：默认关闭，显式开启才暴露入口
DOCX_EXPORT_ON = _env("PAPER_STUDIO_DOCX_EXPORT", "PATENT_STUDIO_DOCX_EXPORT", "off").strip().lower() == "on"

DOCX_EXPORT_IMAGE = (
    _env("PAPER_STUDIO_DOCX_IMAGE", "PATENT_STUDIO_DOCX_IMAGE", "pandoc/latex:3.6.4").strip()
    or "pandoc/latex:3.6.4"
)
DOCX_EXPORT_TIMEOUT_S = int(_env("PAPER_STUDIO_DOCX_EXPORT_TIMEOUT", "PATENT_STUDIO_DOCX_EXPORT_TIMEOUT", "300"))
DOCX_EXPORT_RUNTIME = (
    _env("PAPER_STUDIO_DOCX_EXPORT_RUNTIME", "PATENT_STUDIO_DOCX_EXPORT_RUNTIME", "docker").strip().lower()
    or "docker"
)
DOCX_EXPORT_PANDOC = _env("PAPER_STUDIO_DOCX_PANDOC", "PATENT_STUDIO_DOCX_PANDOC", "pandoc").strip() or "pandoc"
LATEX_SEED_DIR = os.path.join(BACKEND_DIR, "app", "latex_seed", "ieee_bare_conf")
JCIP_SEED_DIR = os.path.join(BACKEND_DIR, "app", "jcip_seed")

# 模型全局并发与每案日 token 预算缺省
AI_CONCURRENCY = max(1, int(_env("PAPER_STUDIO_AI_CONCURRENCY", "PATENT_STUDIO_AI_CONCURRENCY", "2") or 2))
AI_DAILY_TOKENS = max(0, int(_env("PAPER_STUDIO_AI_DAILY_TOKENS", "PATENT_STUDIO_AI_DAILY_TOKENS", "200000") or 200000))

# 原生 Word 主线：社区版 ONLYOFFICE + 编辑器内公式/图表插件。密钥必须与 Document Server 一致。
WORD_EDITOR_ON = _env("PAPER_STUDIO_WORD_EDITOR", "PATENT_STUDIO_WORD_EDITOR", "on").strip().lower() == "on"
ONLYOFFICE_URL = _env("PAPER_STUDIO_ONLYOFFICE_URL", "PATENT_STUDIO_ONLYOFFICE_URL", "http://127.0.0.1:9980").strip().rstrip("/")
ONLYOFFICE_INTERNAL_URL = _env(
    "PAPER_STUDIO_ONLYOFFICE_INTERNAL_URL", "PATENT_STUDIO_ONLYOFFICE_INTERNAL_URL", ONLYOFFICE_URL
).strip().rstrip("/")
# Document Server 访问应用的地址（下载文件、回调、PDF 转换），可使用容器内网域名。
ONLYOFFICE_PUBLIC_URL = _env(
    "PAPER_STUDIO_ONLYOFFICE_PUBLIC_URL", "PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL", "http://host.docker.internal:8000"
).strip().rstrip("/")
# 浏览器加载应用插件的地址，必须是作者可访问的应用 origin；不从转发头推导。
PUBLIC_ORIGIN = _env("PAPER_STUDIO_PUBLIC_ORIGIN", "PATENT_STUDIO_PUBLIC_ORIGIN", "").strip().rstrip("/")
if PUBLIC_ORIGIN:
    try:
        _origin = urlsplit(PUBLIC_ORIGIN)
        _ = _origin.port
        if (_origin.scheme not in ("http", "https") or not _origin.hostname
                or _origin.username is not None or _origin.password is not None
                or _origin.path or _origin.query or _origin.fragment):
            raise ValueError
    except ValueError:
        raise ValueError(
            "PAPER_STUDIO_PUBLIC_ORIGIN / PATENT_STUDIO_PUBLIC_ORIGIN 必须是 http(s)://主机[:端口]，不能包含路径、账号、查询或片段"
        ) from None
else:
    PUBLIC_ORIGIN = ONLYOFFICE_PUBLIC_URL
ONLYOFFICE_JWT_SECRET = _env("PAPER_STUDIO_ONLYOFFICE_JWT_SECRET", "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET", "").strip()
WORD_MAX_BYTES = 50 * 1024 * 1024
WORD_NETWORK_TIMEOUT_S = 30

# 智能文献管理：外部元数据源（Crossref/OpenAlex/arXiv/Zotero）固定白名单出站。
LIBRARY_SOURCES_ON = _env("PAPER_STUDIO_LIBRARY_SOURCES", "PATENT_STUDIO_LIBRARY_SOURCES", "on").strip().lower() == "on"
LIBRARY_PROXY_URL = _env("PAPER_STUDIO_LIBRARY_PROXY", "PATENT_STUDIO_LIBRARY_PROXY", "").strip()
LIBRARY_SOURCE_TIMEOUT_S = float(
    _env("PAPER_STUDIO_LIBRARY_SOURCE_TIMEOUT", "PATENT_STUDIO_LIBRARY_SOURCE_TIMEOUT", "10")
)
LIBRARY_SOURCE_RETRIES = int(_env("PAPER_STUDIO_LIBRARY_SOURCE_RETRIES", "PATENT_STUDIO_LIBRARY_SOURCE_RETRIES", "1"))
LIBRARY_SOURCE_CACHE_TTL_S = int(
    _env("PAPER_STUDIO_LIBRARY_SOURCE_CACHE_TTL", "PATENT_STUDIO_LIBRARY_SOURCE_CACHE_TTL", "3600")
)
LIBRARY_SOURCE_MIN_INTERVAL_S = float(
    _env("PAPER_STUDIO_LIBRARY_SOURCE_MIN_INTERVAL", "PATENT_STUDIO_LIBRARY_SOURCE_MIN_INTERVAL", "1.0")
)
CROSSREF_MAILTO = _env("PAPER_STUDIO_CROSSREF_MAILTO", "PATENT_STUDIO_CROSSREF_MAILTO", "").strip()
ZOTERO_MAX_ITEMS = int(_env("PAPER_STUDIO_ZOTERO_MAX_ITEMS", "PATENT_STUDIO_ZOTERO_MAX_ITEMS", "200"))
LIBRARY_ALLOWED_HOSTS = ("api.crossref.org", "api.openalex.org", "export.arxiv.org", "api.zotero.org")

# 站点公开联系方式（可选，默认空；部署方在 .env 中设置后展示于落地页页脚）
CONTACT_EMAIL = _env("PAPER_STUDIO_CONTACT_EMAIL", "PATENT_STUDIO_CONTACT_EMAIL", "").strip()
CONTACT_WECHAT = _env("PAPER_STUDIO_CONTACT_WECHAT", "PATENT_STUDIO_CONTACT_WECHAT", "").strip()
CONTACT_NOTE = _env("PAPER_STUDIO_CONTACT_NOTE", "PATENT_STUDIO_CONTACT_NOTE", "").strip()

# 免注册一键体验模式（默认关闭；开启后开放 POST /api/auth/demo-login 隔离非超管访客账号）
DEMO_MODE = _env("PAPER_STUDIO_DEMO_MODE", "PATENT_STUDIO_DEMO_MODE", "off").strip().lower() == "on"
DEMO_USER_EMAIL = "demo@demo.paperstudio.org"

# 注册访问控制（默认开放注册，可通过环境变量预设或由管理员在平台设置中实时调整）
_RAW_REG_MODE = _env("PAPER_STUDIO_REGISTRATION_MODE", "PATENT_STUDIO_REGISTRATION_MODE", "open").strip().lower()
REGISTRATION_MODE = _RAW_REG_MODE if _RAW_REG_MODE in ("open", "invite_only", "closed") else "open"
REGISTRATION_INVITE_CODE = _env("PAPER_STUDIO_REGISTRATION_INVITE_CODE", "PATENT_STUDIO_REGISTRATION_INVITE_CODE", "").strip()
_RAW_REG_DOMAINS = _env("PAPER_STUDIO_REGISTRATION_ALLOWED_DOMAINS", "PATENT_STUDIO_REGISTRATION_ALLOWED_DOMAINS", "")
REGISTRATION_ALLOWED_DOMAINS: tuple[str, ...] = tuple(
    dict.fromkeys(
        part.strip().lstrip("@.").lower()
        for part in _RAW_REG_DOMAINS.replace(";", ",").replace(" ", ",").split(",")
        if part.strip().lstrip("@.")
    )
)

# 企业 OIDC / OAuth 2.0 单点登录 SSO（可选，默认关闭）
OIDC_ISSUER = _env("PAPER_STUDIO_OIDC_ISSUER", "PATENT_STUDIO_OIDC_ISSUER", "").strip().rstrip("/")
OIDC_CLIENT_ID = _env("PAPER_STUDIO_OIDC_CLIENT_ID", "PATENT_STUDIO_OIDC_CLIENT_ID", "").strip()
OIDC_CLIENT_SECRET = _env("PAPER_STUDIO_OIDC_CLIENT_SECRET", "PATENT_STUDIO_OIDC_CLIENT_SECRET", "").strip()
OIDC_REDIRECT_URI = _env("PAPER_STUDIO_OIDC_REDIRECT_URI", "PATENT_STUDIO_OIDC_REDIRECT_URI", "").strip()
OIDC_SCOPES = _env("PAPER_STUDIO_OIDC_SCOPES", "PATENT_STUDIO_OIDC_SCOPES", "openid email profile").strip() or "openid email profile"
OIDC_LABEL = _env("PAPER_STUDIO_OIDC_LABEL", "PATENT_STUDIO_OIDC_LABEL", "机构单点登录 (SSO)").strip() or "机构单点登录 (SSO)"
OIDC_AUTO_PROVISION = _env("PAPER_STUDIO_OIDC_AUTO_PROVISION", "PATENT_STUDIO_OIDC_AUTO_PROVISION", "on").strip().lower() == "on"
OIDC_ENABLED = AUTH_ON and bool(OIDC_ISSUER and OIDC_CLIENT_ID and OIDC_CLIENT_SECRET)
