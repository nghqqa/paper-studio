# -*- coding: utf-8 -*-
"""响应 / 请求共享 Pydantic 模型（公开审阅、机构审计、机构设置、AI 用量）。"""

from typing import Literal

from pydantic import BaseModel, Field

from app.domain.cases import CaseStatus


class Actor(BaseModel):
    id: str
    display_name: str
    avatar_color: str = ""


# ---------- 公开审阅（share-confirm-backend） ----------

PublicShareScope = Literal["read", "comment", "confirm"]
PublicShareBaseline = Literal["original", "final"]


class PublicShareLink(BaseModel):
    token: str
    pid: str
    scope: PublicShareScope
    baseline: PublicShareBaseline = "original"
    allow_download: bool = False
    expires_at: float | None = None
    revoked: bool = False
    created_by: Actor
    created_at: float
    visits: int = 0
    last_visit_at: float | None = None


class PublicShareLinkIn(BaseModel):
    scope: PublicShareScope = "comment"
    baseline: PublicShareBaseline = "original"
    ttl_days: int | None = Field(default=30, ge=1, le=365)
    allow_download: bool = False


class Confirmation(BaseModel):
    version: int
    sha: str
    name: str
    note: str | None = None
    confirmed_at: float


class PublicShareMeta(BaseModel):
    org_name: str
    title: str
    case_no: str | None = None
    status: CaseStatus
    version: int
    sha: str
    scope: PublicShareScope
    baseline: PublicShareBaseline = "original"
    pending_revisions: int = 0
    sub_except: list[str] = []
    allow_download: bool
    expires_at: float | None = None
    confirmation: Confirmation | None = None
    pdf_ready: bool = False
    source_format: str = "latex"
    document_type: str = "paper"
    layout_supported: bool = False


class PublicAnchor(BaseModel):
    block_id: str
    line: int
    quote: str = ""
    book: Literal["abstract", "claims", "description"] | None = None


class PublicCommentIn(BaseModel):
    anchor: PublicAnchor
    body: str = Field(min_length=1, max_length=4000)
    guest_name: str = Field(min_length=1, max_length=64)


class PublicConfirmIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    note: str | None = Field(default=None, max_length=2000)


# ---------- 机构审计 / 设置 / AI 用量 ----------

OrgAuditKind = Literal[
    "auth.login",
    "case.created",
    "case.deleted",
    "case.status",
    "member.changed",
    "admin.user",
    "template.created",
    "template.removed",
    "template.restored",
    "template.updated",
    "template.replaced",
    "share.created",
    "share.revoked",
    "share.confirmed",
    "export.downloaded",
    "ai.sent",
    "deliver.filed",
    "oa.round",
    "deadline.done",
    "deadline.undone",
    "deadline.override",
    "deadline.nudge",
    "comment.assign",
]


class OrgAuditEvent(BaseModel):
    id: str
    ts: float
    kind: OrgAuditKind
    actor: Actor | None = None
    pid: str | None = None
    data: dict = Field(default_factory=dict)


class OrgAuditResponse(BaseModel):
    items: list[OrgAuditEvent]
    total: int


class DefaultCollab(BaseModel):
    editor_mode: Literal["edit", "review"] = "edit"
    allow_viewer_comment: bool = True


class Smtp(BaseModel):
    host: str = ""
    port: int = 587
    user: str = ""
    from_: str = Field(default="", alias="from")
    enabled: bool = False

    model_config = {"populate_by_name": True}


class AiProviderTestIn(BaseModel):
    base_url: str = Field(min_length=1, max_length=300)
    api_key: str = Field(default="", max_length=300)
    model: str = Field(default="", max_length=120)


class AiProviderIn(BaseModel):
    """管理员配置的自定义模型接入（OpenAI 兼容 /v1/chat/completions）。api_key 留空 = 更新时保留已存值。"""

    base_url: str = Field(min_length=1, max_length=300)
    api_key: str = Field(default="", max_length=300)
    model_interactive: str = Field(min_length=1, max_length=120)
    model_heavy: str = Field(default="", max_length=120)
    model_fallback: str = Field(default="", max_length=120)

    model_config = {"populate_by_name": True}


class AiProviderInfo(BaseModel):
    """脱敏后的接入信息：api_key 永不回传，只回是否存在与尾号提示。"""

    base_url: str
    model_interactive: str
    model_heavy: str
    model_fallback: str
    has_api_key: bool = False
    api_key_hint: str = ""


class OrgSettings(BaseModel):
    ai_enabled: bool = True
    default_collab: DefaultCollab = Field(default_factory=DefaultCollab)
    smtp: Smtp | None = None
    ai_daily_tokens: int = Field(default=200_000, ge=0)
    ai_user_daily_tokens: int = Field(default=0, ge=0)
    ai_provider: AiProviderInfo | None = None


class OrgSettingsPatch(BaseModel):
    ai_enabled: bool | None = None
    default_collab: DefaultCollab | None = None
    smtp: Smtp | None = None
    ai_daily_tokens: int | None = Field(default=None, ge=0)
    ai_user_daily_tokens: int | None = Field(default=None, ge=0)
    ai_provider: AiProviderIn | None = None


class AiUsageByProject(BaseModel):
    pid: str
    title: str
    today_tokens: int


class AiUsageByModel(BaseModel):
    model: str
    tokens: int
    calls: int


class AiUsageByUser(BaseModel):
    uid: str
    day: str
    used: int
    updated_at: float = 0


class AiUsageSummary(BaseModel):
    today_tokens: int
    budget: int
    by_project: list[AiUsageByProject] = Field(default_factory=list)
    by_model: list[AiUsageByModel] = Field(default_factory=list)
    user_quota: int = 0
    by_user: list["AiUsageByUser"] = Field(default_factory=list)
