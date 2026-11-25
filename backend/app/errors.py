# -*- coding: utf-8 -*-
"""统一业务异常与错误详情形状。"""

from typing import Literal, get_args

from fastapi import HTTPException


class ProjectError(Exception):
    """论文线业务错误（HTTP 语义 status）。

    放在本模块（从不被 reload）保证全仓单一类身份。projects.py 仅做再导出。"""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def error_detail(kind, message, line=None, detail=None):
    return {"kind": kind, "message": message, "line": line, "detail": detail}


ErrorKind = Literal[
    "build",
    "abstract_limit",
    "equation",
    "figure",
    "file",
    "content",
    "settings",
    "auth",
    "forbidden",
    "validation",
    "internal",
    "not_implemented",
    "ai_disabled",
    "ai_disabled_by_org",
    "ai_timeout",
    "ai_upstream",
    "ai_format",
    "ai_no_key",
    "budget",
    "share.expired",
    "share.revoked",
    "share.scope",
    "oa.pdf_no_text",
    "deadline.rule",
    "not_found",
    "conflict",
    "project",
    "case",
    "history",
    "unavailable",
    "stale",
    "kind",
    "attachments",
    "figures",
    "figure-referenced",
    "terms",
    "questionnaire",
    "bundle",
    "job_busy",
    "oa_empty",
    "oa_answer_missing",
    "expired",
    "empty",
    "import",
    "ai",
    "source",
]
ERROR_KINDS: frozenset[str] = frozenset(get_args(ErrorKind))

KIND_STATUS: dict[str, int] = {
    "auth": 401,
    "forbidden": 403,
    "ai_disabled": 403,
    "ai_disabled_by_org": 403,
    "share.scope": 403,
    "not_found": 404,
    "conflict": 409,
    "share.expired": 410,
    "share.revoked": 410,
    "validation": 422,
    "oa.pdf_no_text": 422,
    "deadline.rule": 422,
    "content": 422,
    "settings": 422,
    "budget": 429,
    "not_implemented": 501,
    "internal": 500,
    "expired": 410,
    "unavailable": 503,
    "stale": 409,
    "job_busy": 409,
    "oa_empty": 409,
    "oa_answer_missing": 404,
    "figure-referenced": 409,
    "figures": 422,
    "terms": 422,
    "questionnaire": 422,
    "bundle": 422,
    "empty": 422,
    "source": 422,
    "kind": 422,
}


def kind_error(kind: str, message: str, *, detail=None, status: int | None = None) -> HTTPException:
    """按 ErrorKind 造 HTTPException；kind 必须在 ERROR_KINDS 内。"""
    if kind not in ERROR_KINDS:
        raise ValueError(f"未知错误码 {kind!r}")
    return HTTPException(status or KIND_STATUS.get(kind, 400), error_detail(kind, message, detail=detail))


def not_implemented(unit, message):
    """占位路由：501，detail 形状与结构错误一致。"""
    return HTTPException(501, error_detail("not_implemented", message, detail=unit))
