# -*- coding: utf-8 -*-
"""Word (.docx) → LaTeX 工程导入（v0.6.8，#4b：组里存量 Word 论文搬进 LaTeX 工作台）。

与 ZIP 导入（latex_import.py）的关系：同两段式（stage → create）与同一暂存/物化机制；
本模块只多一步 pandoc 转换。转换产物是**单文件 main.tex + media/ 图片目录**（pandoc
standalone 输出），不是原始 docx 的版式复刻。

边界（如实）：
- 数学公式转 LaTeX 数学（pandoc 强项，OMML→LaTeX）；表格转 tabular（复杂表格可能走样）；
  样式/页眉页脚/编号不保留——转换语义，转换后用工作台编译与诊断修正；
- 中文自动检测（docx 正文含 CJK ⇒ documentclass=ctexart + 建议引擎 xelatex；否则 article/pdflatex）；
- runtime 复用 DOCX_EXPORT_RUNTIME（local=容器内置 pandoc / docker=宿主 pandoc/latex 镜像）；
- 上限：25MB（同文件上传）；拒绝非 .docx（.doc 老格式不支持——pandoc 也不支持）。
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile

from app import config
from app.domain import pandoc_runner
from app.domain.latex_import import STAGING_DIR, ImportRejected, _prune_stale

DOCX_MAX_BYTES = 25 * 1024 * 1024
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
_TIMEOUT_S = 120


def _cjk_sniff(payload: bytes) -> bool:
    """从 docx 主文档抽文本判断是否含中文（决定 documentclass 与建议引擎；不跑 pandoc）。"""
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
    except (zipfile.BadZipFile, KeyError) as e:
        raise ImportRejected("损坏或非标准的 .docx 文件", 422) from e
    text = re.sub(r"<[^>]+>", "", xml)
    return bool(_CJK_RE.search(text))


def _pandoc_args(cjk: bool) -> list[str]:
    args = ["--from=docx", "--to=latex", "--standalone", "--wrap=auto", "--extract-media=media"]
    if cjk:
        args += ["-V", "documentclass=ctexart"]
    return args


def _run_pandoc(stage: str, src_name: str, cjk: bool) -> tuple[int, str]:
    """在暂存目录内执行转换；返回 (rc, stderr)。local=容器内置 pandoc；docker=宿主 pandoc/latex。"""
    if config.DOCX_EXPORT_RUNTIME == "docker":
        pandoc_runner.ensure_runtime_ready(
            "docker",
            docker_msg="转换运行时为 docker，但当前环境不可用",
            which_fn=shutil.which,
        )
        cmd = (
            "pandoc --from=docx --to=latex --standalone --wrap=auto --extract-media=/proj/media "
            + ("-V documentclass=ctexart " if cjk else "")
            + f"--output=/proj/main.tex '/proj/{src_name}'"
        )
        rc, _out, err = pandoc_runner.run_pandoc_docker(
            mount_dir=stage,
            workdir="/proj",
            cmd=cmd,
            image=config.DOCX_EXPORT_IMAGE,
            timeout_s=_TIMEOUT_S,
            subprocess_run=subprocess.run,
        )
        return rc, err
    rc, _out, err = pandoc_runner.run_pandoc_local(
        [*_pandoc_args(cjk), "--output", "main.tex", src_name],
        cwd=stage,
        timeout_s=_TIMEOUT_S,
        env=pandoc_runner.clean_local_env(),
        subprocess_run=subprocess.run,
    )
    return rc, err


def stage_docx(filename: str, payload: bytes) -> dict:
    """docx → pandoc → 暂存目录 {main.tex, media/}。返回与 ZIP stage 同形 meta（+warnings/engine）。"""
    if not filename.lower().endswith(".docx"):
        raise ImportRejected("仅支持 .docx（Word 2007+）；.doc 老格式请先另存为 .docx", 415)
    if len(payload) > DOCX_MAX_BYTES:
        raise ImportRejected(f"文件 {len(payload) / 1048576:.1f}MB 超过上限 25MB", 413)
    if config.DOCX_EXPORT_RUNTIME == "local":
        pandoc_runner.ensure_runtime_ready(
            "local",
            local_msg="转换运行时为 local，但镜像内未找到 pandoc",
            which_fn=shutil.which,
        )

    _prune_stale()
    cjk = _cjk_sniff(payload)
    token = uuid.uuid4().hex
    stage = os.path.join(STAGING_DIR, token)
    if os.path.exists(stage):
        shutil.rmtree(stage)
    os.makedirs(STAGING_DIR, exist_ok=True)
    os.makedirs(stage, exist_ok=True)
    try:
        src_name = "source.docx"
        with open(os.path.join(stage, src_name), "wb") as f:
            f.write(payload)
        rc, err = _run_pandoc(stage, src_name, cjk)
        main_path = os.path.join(stage, "main.tex")
        if rc != 0 or not os.path.isfile(main_path):
            raise ImportRejected(
                "Word→LaTeX 转换失败" + (f"：{err.strip()[:300]}" if err.strip() else ""), 422)
        os.remove(os.path.join(stage, src_name))
        tex = open(main_path, encoding="utf-8").read()
        if not tex.strip():
            raise ImportRejected("转换产物为空（docx 可能没有正文内容）", 422)

        files = [{"path": "main.tex", "size": os.path.getsize(main_path), "editable": True}]
        media_dir = os.path.join(stage, "media")
        if os.path.isdir(media_dir):
            for base, _dirs, fns in os.walk(media_dir):
                for fn in fns:
                    p = os.path.join(base, fn)
                    rel = os.path.relpath(p, stage).replace(os.sep, "/")
                    files.append({"path": rel, "size": os.path.getsize(p), "editable": False})
        engine = "xelatex" if cjk else "pdflatex"
        warnings = [
            "转换的是内容语义：样式/页眉页脚/自动编号不保留，公式与表格请编译后人工核对",
        ]
        meta = {
            "token": token,
            "filename": filename,
            "staged_at": time.time(),
            "files": files,
            "main_candidates": ["main.tex"],
            "excluded": [],
            "skipped": [],
            "warnings": warnings,
            "engine": engine,
            "cjk": cjk,
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        with open(os.path.join(stage, ".import-meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return meta
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
