# -*- coding: utf-8 -*-
"""LaTeX 工程导入与 AI 审稿结果解析服务（multipart 解析、暂存物化与回滚、JSON 数组提取）。"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil

from fastapi import HTTPException, Request

from app import atomic
from app.domain import latex_import


async def read_multipart_upload(request: Request, *, label: str) -> tuple[str, bytes]:
    """校验 multipart/form-data 请求头并读取 `file` 字段的 `(filename, bytes)`."""
    ctype = request.headers.get("Content-Type", "")
    if "multipart/form-data" not in ctype:
        raise HTTPException(415, {"kind": "content", "message": f"请使用 multipart/form-data 上传 {label} 文件"})
    form = await request.form()
    up = form.get("file")
    if up is None or not hasattr(up, "filename") or not hasattr(up, "read"):
        raise HTTPException(422, {"kind": "content", "message": f"缺少 file 字段（{label}）"})
    payload = await up.read()
    return str(up.filename), payload


async def materialize_staged_project(
    store,
    stage: str,
    *,
    prefix: str,
    main: str,
    engine: str,
    title: str,
):
    """将暂存目录物化为正式 LaTeX 项目，失败时自动清理残余目录并释放暂存目录。"""
    pid = store.unique_pid(prefix)
    final_dir = os.path.join(store.root, pid)
    await asyncio.to_thread(latex_import.materialize, stage, final_dir)
    try:
        await asyncio.to_thread(
            atomic.write_json,
            os.path.join(final_dir, "studio.json"),
            {
                "document_type": "paper",
                "source_format": "latex",
                "latex": {"main": main.replace(os.sep, "/"), "engine": engine},
                "title": title,
            },
        )
        project = await asyncio.to_thread(store.get, pid)
    except Exception:
        shutil.rmtree(final_dir, ignore_errors=True)
        raise
    latex_import.drop_stage(stage)
    return project


def parse_ai_issue_array(text: str) -> list[dict]:
    """模型输出 → `[{line, message}]`（容错剥离代码围栏，丢弃非数组或无效项）。"""
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
    try:
        obj = json.loads(raw)
    except Exception:  # noqa: BLE001
        start, end = raw.find("["), raw.rfind("]")
        if start == -1 or end <= start:
            return []
        try:
            obj = json.loads(raw[start:end + 1])
        except Exception:  # noqa: BLE001
            return []
    if not isinstance(obj, list):
        return []
    out: list[dict] = []
    for item in obj[:20]:
        if not isinstance(item, dict):
            continue
        msg = str(item.get("message") or "").strip()
        if not msg:
            continue
        line = item.get("line")
        out.append({
            "line": int(line) if isinstance(line, (int, float)) and line > 0 else None,
            "message": msg[:500],
        })
    return out
