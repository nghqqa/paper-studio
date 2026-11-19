# -*- coding: utf-8 -*-
"""平台部署健康诊断（System Doctor）：管理员只读体检，快速定位自托管配置问题。

红线：只读检测，绝不返回任何密钥、JWT Secret、AI API Key 等凭据原文。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from typing import Any

import httpx

from app import config
from app.domain.org import load_org


def _cmd_version(bin_name: str, args: list[str]) -> tuple[bool, str]:
    path = shutil.which(bin_name)
    if not path:
        return False, ""
    try:
        r = subprocess.run([path, *args], capture_output=True, text=True, timeout=5)
        first = ((r.stdout or r.stderr or "").strip().splitlines() or [""])[0].strip()
        return r.returncode == 0, first[:140]
    except Exception:
        return False, ""


async def run_doctor() -> dict[str, Any]:
    checks: list[dict[str, str]] = []

    # 1. Auth & Session Security
    secret_len = len(config.AUTH_SECRET or "")
    if not config.AUTH_ON:
        checks.append({
            "id": "auth",
            "name": "账号鉴权与会话安全",
            "status": "warn",
            "summary": "PAPER_STUDIO_AUTH=off（无鉴权单人模式）",
            "hint": "局域网或公网团队部署请务必开启 PAPER_STUDIO_AUTH=on 并配置 >=32 位随机 PAPER_STUDIO_SECRET。",
        })
    elif secret_len < 32:
        checks.append({
            "id": "auth",
            "name": "账号鉴权与会话安全",
            "status": "warn",
            "summary": f"鉴权已开启，但会话密钥长度偏短（{secret_len} 字符）",
            "hint": "建议使用 `openssl rand -hex 32` 生成至少 32 位随机密钥替换 PAPER_STUDIO_SECRET。",
        })
    else:
        https_origin = (config.PUBLIC_ORIGIN or "").startswith("https://")
        if https_origin and not config.COOKIE_SECURE:
            checks.append({
                "id": "auth",
                "name": "账号鉴权与会话安全",
                "status": "warn",
                "summary": "鉴权与密钥强度正常，但 HTTPS 站点下 COOKIE_SECURE=off",
                "hint": "建议在 .env 中设置 PAPER_STUDIO_COOKIE_SECURE=on 防止明文传输会话 Cookie。",
            })
        else:
            checks.append({
                "id": "auth",
                "name": "账号鉴权与会话安全",
                "status": "ok",
                "summary": f"鉴权已开启，密钥长度合格（COOKIE_SECURE={'on' if config.COOKIE_SECURE else 'off'}）",
                "hint": "",
            })

    # 2. Storage & Disk Free
    try:
        os.makedirs(config.PROJECTS_DIR, exist_ok=True)
        usage = shutil.disk_usage(config.PROJECTS_DIR)
        free_gb = usage.free / (1024 ** 3)
        pct_free = (usage.free / usage.total * 100) if usage.total else 0.0
        writable = os.access(config.PROJECTS_DIR, os.W_OK)
        if not writable:
            st, hint = "error", "数据目录不可写，请检查容器卷挂载权限（UID 1000）。"
        elif free_gb < 1.0:
            st, hint = "error", f"剩余磁盘空间不足（仅 {free_gb:.2f} GB），请尽快扩容或清理构建缓存。"
        elif free_gb < 5.0:
            st, hint = "warn", f"剩余磁盘空间偏低（{free_gb:.1f} GB），建议保持至少 5 GB 可用空间。"
        else:
            st, hint = "ok", ""
        checks.append({
            "id": "storage",
            "name": "持久化存储与磁盘空间",
            "status": st,
            "summary": f"数据目录可写，剩余 {free_gb:.1f} GB（{pct_free:.0f}%）",
            "hint": hint,
        })
    except OSError as exc:
        checks.append({
            "id": "storage",
            "name": "持久化存储与磁盘空间",
            "status": "error",
            "summary": f"无法检查数据目录：{exc}",
            "hint": "请检查 PAPER_STUDIO_PROJECTS_DIR 挂载路径。",
        })

    # 3. LaTeX Toolchain
    ok_lmk, v_lmk = _cmd_version(config.LATEX_LATEXMK, ["--version"])
    ok_xe, v_xe = _cmd_version("xelatex", ["--version"])
    if ok_lmk and ok_xe:
        checks.append({
            "id": "latex",
            "name": "LaTeX 编译工具链",
            "status": "ok",
            "summary": f"latexmk 与 xelatex 就绪（{v_xe or v_lmk}）",
            "hint": "",
        })
    else:
        checks.append({
            "id": "latex",
            "name": "LaTeX 编译工具链",
            "status": "warn",
            "summary": f"latexmk={'就绪' if ok_lmk else '缺失'} · xelatex={'就绪' if ok_xe else '缺失'}",
            "hint": "推荐使用官方 Docker 镜像（已内置完整 TeXLive + 中文 Fandol 字体）。",
        })

    # 4. Pandoc
    ok_pd, v_pd = _cmd_version(config.DOCX_EXPORT_PANDOC, ["--version"])
    checks.append({
        "id": "pandoc",
        "name": "Pandoc 文档转换引擎",
        "status": "ok" if ok_pd else "warn",
        "summary": v_pd if ok_pd else "未检测到 pandoc（Word ↔ LaTeX 导入导出不可用）",
        "hint": "" if ok_pd else "请安装 pandoc 3.x 或使用官方 Docker 镜像。",
    })

    # 5. Poppler (pdftoppm for template thumbnails)
    ok_ppm, _ = _cmd_version("pdftoppm", ["-v"])
    checks.append({
        "id": "poppler",
        "name": "PDF 缩略图渲染（poppler）",
        "status": "ok" if ok_ppm else "warn",
        "summary": "pdftoppm 就绪（支持自动生成模板首页缩略图）" if ok_ppm else "未检测到 pdftoppm",
        "hint": "" if ok_ppm else "安装 poppler-utils 后可为上传模板自动生成封面缩略图。",
    })

    # 6. ONLYOFFICE Docs (Word Mode)
    if not config.WORD_EDITOR_ON:
        checks.append({
            "id": "onlyoffice",
            "name": "Word 文档服务（ONLYOFFICE）",
            "status": "off",
            "summary": "Word 编辑开关已关闭（纯 LaTeX 轻量模式）",
            "hint": "如需原生 Word 写作，请在 .env 开启 PAPER_STUDIO_WORD_EDITOR=on 并使用 `docker compose --profile word up -d`。",
        })
    elif not config.ONLYOFFICE_JWT_SECRET:
        checks.append({
            "id": "onlyoffice",
            "name": "Word 文档服务（ONLYOFFICE）",
            "status": "warn",
            "summary": "已开启 Word 模式，但未配置 ONLYOFFICE_JWT_SECRET",
            "hint": "在 .env 为应用与 ONLYOFFICE 容器配置一致的随机 JWT 密钥并重启服务。",
        })
    else:
        ds_internal = config.ONLYOFFICE_INTERNAL_URL
        ds_url = config.ONLYOFFICE_URL
        pub = config.PUBLIC_ORIGIN
        https_mismatch = pub.startswith("https://") and ds_url.startswith("http://")
        try:
            async with httpx.AsyncClient(timeout=4.0, follow_redirects=False) as client:
                resp = await client.get(f"{ds_internal}/healthcheck")
            healthy = resp.status_code == 200 and resp.text.strip().lower() == "true"
            if healthy and not https_mismatch:
                checks.append({
                    "id": "onlyoffice",
                    "name": "Word 文档服务（ONLYOFFICE）",
                    "status": "ok",
                    "summary": f"Document Server 健康（浏览器入口：{ds_url}）",
                    "hint": "",
                })
            elif healthy and https_mismatch:
                checks.append({
                    "id": "onlyoffice",
                    "name": "Word 文档服务（ONLYOFFICE）",
                    "status": "warn",
                    "summary": "Document Server 健康，但存在 HTTPS/HTTP 混合内容风险",
                    "hint": "站点使用 HTTPS 时，PAPER_STUDIO_ONLYOFFICE_URL 也必须使用 HTTPS，否则浏览器会拦截编辑器加载。",
                })
            else:
                checks.append({
                    "id": "onlyoffice",
                    "name": "Word 文档服务（ONLYOFFICE）",
                    "status": "error",
                    "summary": f"Document Server 探活返回 HTTP {resp.status_code}",
                    "hint": "检查 onlyoffice 容器是否已通过 `--profile word` 启动并完成初始化。",
                })
        except Exception:
            checks.append({
                "id": "onlyoffice",
                "name": "Word 文档服务（ONLYOFFICE）",
                "status": "error",
                "summary": f"无法连接 Document Server（{ds_internal}）",
                "hint": "若仅需 LaTeX 模式可忽略或设 PAPER_STUDIO_WORD_EDITOR=off；如需 Word 模式请运行 `docker compose --profile word up -d`。",
            })

    # 7. AI Gateway Configuration
    org_cfg = load_org()
    ai_on = bool(getattr(org_cfg, "ai_enabled", True))
    ai_prov = getattr(org_cfg, "ai_provider", None)
    prov_key = (
        (ai_prov.get("api_key") if isinstance(ai_prov, dict) else getattr(ai_prov, "api_key", ""))
        or ""
    ).strip()
    has_org_key = bool(prov_key or config.AI_KEY)
    if not ai_on:
        checks.append({
            "id": "ai",
            "name": "机构 AI 服务接入",
            "status": "off",
            "summary": "机构 AI 开关已关闭（纯离线写作模式）",
            "hint": "如需启用论文助手与提案润色，请在「AI 接入」页开启并配置 OpenAI 兼容网关。",
        })
    elif has_org_key:
        checks.append({
            "id": "ai",
            "name": "机构 AI 服务接入",
            "status": "ok",
            "summary": "机构 AI 已启用并已配置模型凭据（成员也可在个人账户配置 BYOK）",
            "hint": "",
        })
    else:
        checks.append({
            "id": "ai",
            "name": "机构 AI 服务接入",
            "status": "warn",
            "summary": "机构 AI 已开启但尚未配置共享 API Key",
            "hint": "可在「AI 接入」配置团队共享模型网关，或引导成员在各自账户中配置个人 API Key（BYOK）。",
        })

    overall = "ok"
    if any(c["status"] == "error" for c in checks):
        overall = "error"
    elif any(c["status"] == "warn" for c in checks):
        overall = "warn"

    return {
        "overall": overall,
        "checked_at": time.time(),
        "product": config.PRODUCT,
        "demo_mode": config.DEMO_MODE,
        "checks": checks,
    }
