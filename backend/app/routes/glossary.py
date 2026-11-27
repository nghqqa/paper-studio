# -*- coding: utf-8 -*-
"""项目术语表与符号表路由（Glossary & Notation）。"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.domain import glossary
from app.errors import kind_error

router = APIRouter(prefix="/api/projects/{pid}", tags=["glossary"])


class GlossaryEntryIn(BaseModel):
    id: str | None = Field(default=None, max_length=32)
    term: str = Field(min_length=1, max_length=120)
    category: str = Field(default="term")
    aliases: list[str] = Field(default_factory=list, max_length=20)
    symbol: str = Field(default="", max_length=120)
    definition: str = Field(default="", max_length=1000)
    enforce: bool = True


class GlossaryPatchIn(BaseModel):
    term: str | None = Field(default=None, max_length=120)
    category: str | None = None
    aliases: list[str] | None = Field(default=None, max_length=20)
    symbol: str | None = Field(default=None, max_length=120)
    definition: str | None = Field(default=None, max_length=1000)
    enforce: bool | None = None


class ExtractIn(BaseModel):
    commit: bool = False


@router.get("/glossary")
async def get_glossary(pid: str, request: Request):
    project = request.app.state.store.get(pid)
    entries = await asyncio.to_thread(glossary.list_entries, project.dir)
    return {"entries": entries}


@router.post("/glossary")
async def upsert_glossary(pid: str, body: GlossaryEntryIn, request: Request):
    project = request.app.state.store.get(pid)
    saved, entries = await asyncio.to_thread(glossary.upsert_entry, project.dir, body.model_dump())
    return {"entry": saved, "entries": entries}


@router.patch("/glossary/{gid}")
async def patch_glossary(pid: str, gid: str, body: GlossaryPatchIn, request: Request):
    project = request.app.state.store.get(pid)
    saved, entries = await asyncio.to_thread(
        glossary.update_entry, project.dir, gid, body.model_dump(exclude_unset=True)
    )
    return {"entry": saved, "entries": entries}


@router.delete("/glossary/{gid}")
async def delete_glossary(pid: str, gid: str, request: Request):
    project = request.app.state.store.get(pid)
    removed, entries = await asyncio.to_thread(glossary.delete_entry, project.dir, gid)
    if not removed:
        raise kind_error("not_found", "术语条目不存在", detail=gid)
    return {"ok": True, "entries": entries}


@router.post("/glossary/extract")
async def extract_glossary(pid: str, request: Request, body: ExtractIn | None = None):
    project = request.app.state.store.get(pid)
    commit = bool(body.commit) if body is not None else False
    return await asyncio.to_thread(glossary.extract_from_project, project, commit=commit)
