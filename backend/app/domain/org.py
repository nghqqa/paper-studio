# -*- coding: utf-8 -*-
"""机构设置 `<projects>/.studio/org.json`（docs/plan/21 §2 R-ADM-03 / R-AI-01 机构级；notify-audit-backend）。

文件里只有四个可写字段：name（W4-E 起就在）、ai_enabled（默认 true）、default_collab、ai_daily_tokens。
SMTP 不落文件：只从环境变量 PATENT_STUDIO_SMTP_URL 读出「是否配置 / 主机 / 端口 / 账号」作为只读状态回给前端
（notify/mail.py），密码永不出网。老的 org.json 只有 name 时其余字段取默认，读写形式与 tags.json 同（json + 换行）。

- `require_org_ai`：/ai/* 与 /agent/* 的路由级依赖；机构关闭 AI 时 403 kind=ai_disabled_by_org（接线归 integrate）。
- `apply_default_collab`：新案建好后把机构默认协作设置写进 project_collab_settings（订阅 case.created，见 notify）。
"""

import json
import os

from pydantic import BaseModel, Field

from app import atomic, config
from app.domain import mail
from app.errors import kind_error
from app.schemas import DefaultCollab, OrgSettings, OrgSettingsPatch

ORG_FILE = os.path.join(".studio", "org.json")
ORG_NAME_MAX = 64


class AiProvider(BaseModel):
    """管理员配置的自定义模型接入（OpenAI 兼容）。api_key 存 org.json（数据卷内，接口永不回传）。"""

    base_url: str = Field(min_length=1, max_length=300)
    api_key: str = Field(default="", max_length=300)
    model_interactive: str = Field(min_length=1, max_length=120)
    model_heavy: str = Field(default="", max_length=120)
    model_fallback: str = Field(default="", max_length=120)

    def masked(self) -> dict:
        key = self.api_key or ""
        hint = ("•••" + key[-4:]) if len(key) >= 4 else ("•••" if key else "")
        return {"base_url": self.base_url, "model_interactive": self.model_interactive,
                "model_heavy": self.model_heavy, "model_fallback": self.model_fallback,
                "has_api_key": bool(key), "api_key_hint": hint}


class Org(BaseModel):
    name: str = Field(default="", max_length=ORG_NAME_MAX)
    ai_enabled: bool = True
    default_collab: DefaultCollab = Field(default_factory=DefaultCollab)
    ai_daily_tokens: int = Field(default=config.AI_DAILY_TOKENS, ge=0)
    # per-user 每日 token 上限（v0.6.7，护机构 key：多账号共用时按人封顶）；0=不限（缺省关）
    ai_user_daily_tokens: int = Field(default=0, ge=0)
    ai_provider: AiProvider | None = None


def org_path(projects_dir: str | None = None) -> str:
    return os.path.join(projects_dir or config.PROJECTS_DIR, ORG_FILE)


def load_org(projects_dir: str | None = None) -> Org:
    p = org_path(projects_dir)
    if not os.path.isfile(p):
        return Org()
    try:
        with open(p, encoding="utf-8") as f:
            return Org.model_validate(json.load(f))
    except ValueError as e:
        raise kind_error("settings", f"org.json 无法读取：{e}", detail="org") from e


def save_org(org: Org, projects_dir: str | None = None) -> Org:
    p = org_path(projects_dir)
    atomic.write_json(p, org.model_dump())
    return org


def settings_out(org: Org) -> OrgSettings:
    return OrgSettings(
        ai_enabled=org.ai_enabled,
        default_collab=org.default_collab,
        smtp=mail.status(),
        ai_daily_tokens=org.ai_daily_tokens,
        ai_user_daily_tokens=org.ai_user_daily_tokens,
        ai_provider=org.ai_provider.masked() if org.ai_provider else None,
    )


def apply_settings(patch: OrgSettingsPatch, projects_dir: str | None = None) -> OrgSettings:
    """只改给出的字段；patch.smtp 忽略（配置在环境变量里，接口只读）。"""
    org = load_org(projects_dir)
    changes = patch.model_dump(exclude_none=True, exclude={"smtp"})
    if changes:
        org = save_org(Org.model_validate({**org.model_dump(), **changes}), projects_dir)
    return settings_out(org)


def ai_enabled() -> bool:
    return load_org().ai_enabled


async def require_org_ai() -> None:
    """机构级 AI 开关：`dependencies=[Depends(require_org_ai)]` 挂在 /ai/* 与 /agent/* 生成类路由上。"""
    if not ai_enabled():
        raise kind_error("ai_disabled_by_org", "机构已关闭 AI 助手，请联系机构管理员", detail="org")


def apply_default_collab(pid: str) -> None:
    """新案继承机构默认协作设置（R-ADM-03）：default_collab.allow_viewer_comment → collab-settings.allow_comment。

    在 case.created 的同步订阅者里调用（notify.on_case_created），走 sink 的同步引擎；行已存在（重建同名案）则覆写。
    """
    from sqlalchemy.dialects.sqlite import insert

    from app.auth.access import DEFAULT_SETTINGS
    from app.auth.models import ProjectCollabSettings
    from app.domain import db_sink as sink

    values = {**DEFAULT_SETTINGS, "project_id": pid, "allow_comment": load_org().default_collab.allow_viewer_comment}
    stmt = insert(ProjectCollabSettings).values(**values)
    sink.run(stmt.on_conflict_do_update(index_elements=["project_id"], set_={"allow_comment": values["allow_comment"]}))
