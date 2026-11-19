#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""研稿 · E2E 回归套件（对真实部署栈执行，不用 mock）。

与 deploy/paper/acceptance.py 同一风格（stdlib-only、cookie 会话、逐项 stamp、JSON 报告、
退出码=回归），但目标是「每次发版自动跑」的固化回归：

  Phase 0  预检：应用/DS 健康、插件 4 配置端点 baseUrl 前缀
  Phase L  LaTeX 全链：模板建项→编译→下载→编辑→重编译→负向诊断→ZIP 导入（子目录主文件）→重开
  Phase W  Word 全链：建项→导入含图 DOCX→字节校验→插图 HTTP 面→真实 DS 转换回环→越权
  Phase P  P1 核心链：投稿前检查（LaTeX/Word 多规则集）·审稿回复信·Word 引用重排（P1-2/P1-0-B）
           ·公开审阅链接免登录全链（P1-4，AUTH=off 段 SKIP）
  Phase F  编译错误修复闭环（需 AI 接入，未配置则 SKIP）
  Phase Z  Zotero 公开群组导入（外部 API 不可达则 SKIP）
  Phase C  自清理（--cleanup）：回收站→永久删除本次创建的测试项目，
           并抽测已删项目的公开审阅链接 meta=404（删除级联清链接）

审计：报告 JSON 恒含 created_accounts / created_projects（本次注册的全部 e2e-* 邮箱
与创建的项目 ID，供历史堆积审计）；--cleanup 才执行删除。

用法（服务器或任何可达该栈的机器）：
  python3 e2e_suite.py --base http://127.0.0.1:8011 \
      --public-origin http://127.0.0.1:8011 --ds-url http://127.0.0.1:9981 \
      [--jwt-secret-file ~/paper-e2e/.env.e2e] [--skip-word] [--skip-latex] [--out report.json]
      [--cleanup]

--jwt-secret-file 指向含 E2E_JWT_SECRET=... 的 env 文件：提供时对 editor-config 的 JWT
签名做 HS256 校验（证明与 DS 共享密钥配置正确）；缺省跳过该项。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.cookiejar
import io
import os
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone

RESULTS: list[dict] = []
PHASE = ""

# 自清理审计：本次运行注册的账号 / 创建的项目 / 成功创建的公开审阅链接。
# 账号在 register() 自动登记；项目在各相位建项成功处 track_project() 登记；
# 报告 JSON 恒输出 created_accounts / created_projects；--cleanup 才执行删除。
CREATED_ACCOUNTS: list[str] = []
CREATED_PROJECTS: list[dict] = []       # {"pid", "email"}
CREATED_PUBLIC_TOKENS: list[dict] = []  # {"token", "pid", "email"}
E2E_PW = "e2e-Passw0rd!"


def phase(name: str) -> None:
    global PHASE
    PHASE = name
    print(f"\n== {name} ==")


def stamp(status: str, name: str, detail: str = "") -> dict:
    row = {"phase": PHASE, "status": status, "name": name, "detail": detail}
    RESULTS.append(row)
    icon = {"pass": "PASS", "fail": "FAIL", "skip": "SKIP"}[status]
    print(f"[{icon}] {name}" + (f" — {detail}" if detail else ""))
    return row


class Client:
    """cookie 会话 + JSON/表单/multipart 的最小 HTTP 客户端（stdlib-only）。"""

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method: str, path: str, json_body=None, form=None, raw=None,
            content_type: str | None = None, timeout: int = 300):
        url = self.base + path
        data = None
        headers = {}
        if json_body is not None:
            data = json.dumps(json_body).encode()
            headers["Content-Type"] = "application/json"
        elif form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif raw is not None:
            data = raw
            if content_type:
                headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                if "json" in ctype and body:  # 204 等空响应体不进 json.loads
                    return resp.status, json.loads(body)
                return resp.status, body
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                return e.code, json.loads(body)
            except Exception:
                return e.code, body

    def multipart(self, path: str, field: str, filename: str, payload: bytes,
                  fields: list[tuple[str, str]] | None = None):
        boundary = "----e2e" + uuid.uuid4().hex
        buf = io.BytesIO()
        for name, value in (fields or []):
            buf.write(f"--{boundary}\r\n".encode())
            buf.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
            buf.write(f"{value}\r\n".encode())
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode())
        buf.write(b"Content-Type: application/octet-stream\r\n\r\n")
        buf.write(payload)
        buf.write(f"\r\n--{boundary}--\r\n".encode())
        return self.req("POST", path, raw=buf.getvalue(),
                        content_type=f"multipart/form-data; boundary={boundary}")


def register(c: Client, email: str, password: str) -> int:
    st, _ = c.req("POST", "/api/auth/register", json_body={"email": email, "password": password})
    if st in (200, 201) and email not in CREATED_ACCOUNTS:
        CREATED_ACCOUNTS.append(email)
    return st


def login(c: Client, email: str, password: str) -> int:
    st, _ = c.req("POST", "/api/auth/cookie/login", form={"username": email, "password": password})
    return st


def track_project(pid: str, email: str) -> None:
    """登记本次运行创建的项目（空 pid 忽略、去重），供报告审计与 --cleanup 删除。"""
    if pid and not any(item["pid"] == pid for item in CREATED_PROJECTS):
        CREATED_PROJECTS.append({"pid": pid, "email": email})


def docx_contains(data, needles: tuple[str, ...]) -> bool:
    """DOCX 容器校验：PK 魔数 + word/document.xml 含全部关键词（导出链断言用）。"""
    if not isinstance(data, bytes) or data[:2] != b"PK":
        return False
    try:
        xml = unzip_files(data).get("word/document.xml", b"").decode("utf-8", "replace")
    except Exception:
        return False
    return all(n in xml for n in needles)


def sha_of(data) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- 夹具（程序化生成，避免 CRLF/二进制污染） ----

# 1x1 蓝色 PNG（固定字节，用于 DOCX media 与图表对照）
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


def latex_fixture_zip() -> bytes:
    """多文件工程：sections/ 子目录 + figs/ + bib —— 覆盖主文件检测与递归输入。"""
    main_tex = (
        "\\documentclass{article}\n"
        "\\usepackage{graphicx}\n"
        "\\begin{document}\n"
        "\\title{E2E Fixture}\n\\maketitle\n"
        "\\input{sections/intro}\n"
        "\\includegraphics{figs/plot}\n"
        "\\bibliographystyle{plain}\n"
        "\\bibliography{refs}\n"
        "\\end{document}\n")
    intro_tex = "\\section{Result}\nThis cites prior work~\\cite{einstein1905}.\n"
    refs_bib = (
        "@article{einstein1905,\n"
        "  title = {Ist die Tragheit eines Korpers...},\n"
        "  author = {Einstein, A.},\n"
        "  journal = {Annalen der Physik},\n"
        "  year = {1905}, volume = {322}, pages = {891--921}\n}\n")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("main.tex", main_tex)
        z.writestr("sections/intro.tex", intro_tex)
        z.writestr("refs.bib", refs_bib)
        z.writestr("figs/plot.png", TINY_PNG)
        z.writestr("README.md", "e2e fixture project\n")
    return buf.getvalue()


def word_fixture_docx(title: str) -> bytes:
    """最小合法 DOCX：含 word/media/image1.png 的图片段落（供字节级校验与 DS 转换）。"""
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/word/document.xml" ContentType='
        '"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>")
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type='
        '"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>")
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type='
        '"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        'Target="media/image1.png"/>'
        "</Relationships>")
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        "<w:body>"
        "<w:p><w:r><w:t>" + title + "</w:t></w:r></w:p>"
        "<w:p><w:r><w:drawing><wp:inline><wp:extent cx=\"3048000\" cy=\"1828800\"/>"
        "<wp:docPr id=\"1\" name=\"e2e-image\"/>"
        "<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">"
        "<pic:pic><pic:nvPicPr><pic:cNvPr id=\"1\" name=\"e2e-image\"/><pic:cNvPicPr/></pic:nvPicPr>"
        "<pic:blipFill><a:blip r:embed=\"rId1\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>"
        "<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"3048000\" cy=\"1828800\"/></a:xfrm>"
        "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>"
        "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
        "</w:body></w:document>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/_rels/document.xml.rels", doc_rels)
        z.writestr("word/media/image1.png", TINY_PNG)
    return buf.getvalue()


def unzip_files(data: bytes) -> dict[str, bytes]:
    out = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            out[name] = z.read(name)
    return out


def verify_jwt_hs256(token: str, secret: str) -> bool:
    """仅验签（不验 claims 细节）：证明应用侧签名与 DS 共享密钥一致。"""
    try:
        head_b64, payload_b64, sig_b64 = token.split(".")
        signing_input = f"{head_b64}.{payload_b64}".encode()
        expected = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
        pad = "=" * (-len(sig_b64) % 4)
        return hmac.compare_digest(expected, base64.urlsafe_b64decode(sig_b64 + pad))
    except Exception:
        return False


def wait_ds_health(ds_url: str, timeout_s: int = 30) -> bool:
    deadline = time.time() + timeout_s
    probe = Client(ds_url)
    while time.time() < deadline:
        try:
            st, body = probe.req("GET", "/healthcheck", timeout=10)
            if st == 200:
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


# ---------------------------------------------------------------- Phase 0 预检 ----

PLUGIN_CONFIGS = (
    "/api/office-plugin/config.json",
    "/api/office-plugin/native/config.json",
    "/api/office-plugin-ai/config.json",
    "/api/office-plugin-refs/config.json",
    "/api/office-charts/config.json",
)


def run_phase0(base: str, public_origin: str, ds_url: str | None, frontend_mark: str = "") -> None:
    phase("P0 预检")
    s = Client(base)
    try:
        st, body = s.req("GET", "/api/health", timeout=20)
        ok = st == 200
        stamp("pass" if ok else "fail", "应用 /api/health", f"HTTP {st}")
    except Exception as e:
        stamp("fail", "应用 /api/health", str(e))
        return

    if ds_url:
        ok = wait_ds_health(ds_url)
        stamp("pass" if ok else "fail", "DS /healthcheck", ds_url)

    for path in PLUGIN_CONFIGS:
        st, cfg = s.req("GET", path)
        base_url = (cfg or {}).get("baseUrl", "") if isinstance(cfg, dict) else ""
        ok = st == 200 and isinstance(cfg, dict) and base_url.startswith(public_origin)
        stamp("pass" if ok else "fail", f"插件配置 {path.rsplit('/', 2)[-2]}/config.json",
              f"HTTP {st} baseUrl={base_url[:48]}")

    # 前端新鲜度：本次发版引入的前端标记串必须出现在线上 bundle 里
    # （教训 2026-10-24：纯前端发版漏改镜像 tag，HTTP 级套件照样全绿。
    #   目标 bundle 常是懒加载分包——从 index.html 出发爬取，JS 内再收集下一层资产路径）
    if frontend_mark:
        st, index = s.req("GET", "/", timeout=30)
        html = index.decode("utf-8", "replace") if isinstance(index, bytes) else str(index)
        seen: set[str] = set()
        # 只捕获文件名（html 引用是 /assets/x.js，bundle 内动态导入是 assets/x.js——统一拼前缀防双写）
        queue = [f"/assets/{name}" for name in
                 re.findall(r"(?:/assets/|assets/)([A-Za-z0-9._-]+\.js)", html)]
        queue = list(dict.fromkeys(queue))
        found = False
        fetched = 0
        while queue and fetched < 40 and not found:
            b = queue.pop(0)
            if b in seen:
                continue
            seen.add(b)
            st, body = s.req("GET", b, timeout=30)
            fetched += 1
            if not isinstance(body, bytes):
                continue
            if frontend_mark.encode() in body:
                found = True
                break
            for name in re.findall(r"(?:/assets/|assets/)([A-Za-z0-9._-]+\.js)",
                                   body.decode("utf-8", "replace")):
                nxt = f"/assets/{name}"
                if nxt not in seen:
                    queue.append(nxt)
        stamp("pass" if found else "fail", f"前端 bundle 含发版标记「{frontend_mark}」",
              f"已验证（爬取 {fetched} 个 bundle）" if found else f"爬取 {fetched} 个 bundle 未命中——生产前端非本次发版")


# ---------------------------------------------------------------- Phase L LaTeX 全链 ----

def run_phase_latex(base: str) -> dict:
    phase("Phase L LaTeX 全链")
    ts = datetime.now(timezone.utc).strftime("%H%M%S")
    email = f"e2e-latex-{ts}@e2e.example.com"
    pw = E2E_PW
    s = Client(base)
    ctx: dict = {}

    st = register(s, email, pw)
    if st not in (200, 201):
        stamp("fail", "注册账号", f"HTTP {st}")
        return ctx
    if login(s, email, pw) != 204:
        stamp("fail", "登录", "cookie 登录非 204")
        return ctx
    stamp("pass", "注册+登录（隔离账号）", email)

    # L1 模板建项：优先 IEEE（pdflatex）；部署模板库把 ieee 下架时（生产清场常态）回退 blank（xelatex/ctex）
    engine = "pdflatex"
    tpl_note = "IEEE 内置种子"
    st, demo = s.req("POST", "/api/projects/latex-demo", json_body={"template": "ieee"})
    if st != 200:
        st, demo = s.req("POST", "/api/projects/latex-demo", json_body={"template": "blank"})
        engine = "xelatex"
        tpl_note = "blank 种子（该部署已下架 ieee，非回归）"
    pid = demo.get("id", "") if isinstance(demo, dict) else ""
    if st != 200 or not pid:
        stamp("fail", "模板建项 latex-demo", f"HTTP {st}")
        return ctx
    stamp("pass", "模板建项", f"{pid}（{tpl_note}）")
    ctx["pid"] = pid
    track_project(pid, email)

    # L2 真实编译 + PDF + 诊断空
    def build_ok(pid_: str, engine: str, label: str) -> dict | None:
        t0 = time.time()
        st, m = s.req("POST", f"/api/projects/{pid_}/latex/build", json_body={"engine": engine})
        dur = int((time.time() - t0) * 1000)
        if st != 200 or not isinstance(m, dict) or m.get("status") != "ok":
            stamp("fail", f"编译 {label}", f"HTTP {st} status={m.get('status') if isinstance(m, dict) else '?'} "
                                         f"err={str(m.get('error'))[:120] if isinstance(m, dict) else '?'}")
            return None
        diags = m.get("diagnostics") or []
        stamp("pass" if not diags else "fail", f"编译 {label}", f"HTTP 200 {dur}ms 诊断 {len(diags)} 条")
        return m

    m = build_ok(pid, engine, "模板工程")
    if not m:
        return ctx
    pdf_url = m.get("pdf_url", "")
    st, pdf = s.req("GET", pdf_url)
    ok = st == 200 and isinstance(pdf, bytes) and pdf[:4] == b"%PDF"
    stamp("pass" if ok else "fail", "下载 PDF 产物", f"{len(pdf) if isinstance(pdf, bytes) else 0}B")
    ctx["build_id"] = m.get("build_id", "")

    # L3 builds 列表：latest_ok_build_id + 首个构建 stale=false（stale 在每个 build 上）
    st, bl = s.req("GET", f"/api/projects/{pid}/latex/builds")
    first_build = (bl.get("builds") or [{}])[0] if isinstance(bl, dict) else {}
    ok = (st == 200 and bl.get("latest_ok_build_id") == ctx["build_id"]
          and first_build.get("stale") is False)
    stamp("pass" if ok else "fail", "builds 列表 latest_ok/stale",
          f"latest={bl.get('latest_ok_build_id') if isinstance(bl, dict) else '?'} "
          f"stale={first_build.get('stale')}")

    # L4 编辑保存一致（PUT/GET/SHA）
    st, files = s.req("GET", f"/api/projects/{pid}/latex/files")
    tex_files = [f["path"] for f in files.get("files", [])
                 if f.get("editable") and f.get("path", "").endswith(".tex")]
    target = tex_files[0] if tex_files else ""
    marker = f"E2E-MARK-{ts}"
    edited = None
    ok = False
    if target:
        st, f = s.req("GET", f"/api/projects/{pid}/latex/files/{target}")
        content, sha = f.get("content", ""), f.get("sha", "")
        edited = content.replace("\\begin{document}", f"\\begin{{document}}\n% {marker}", 1)
        st, _r = s.req("PUT", f"/api/projects/{pid}/latex/files/{target}",
                       json_body={"content": edited, "base": sha})
        st2, f2 = s.req("GET", f"/api/projects/{pid}/latex/files/{target}")
        ok = st == 200 and f2.get("content") == edited and f2.get("sha") == sha_of(edited)
    stamp("pass" if ok else "fail", "编辑保存一致（PUT/GET/SHA）", f"{target} {marker}")

    # L5 重编译出新构建
    m2 = build_ok(pid, engine, "编辑后重编译")
    ok = bool(m2) and m2.get("build_id") not in ("", ctx["build_id"])
    stamp("pass" if ok else "fail", "重编译出新 build_id", str(m2.get("build_id") if m2 else "-"))

    # L6 负向：坏命令 → build error + 诊断非空 → 修复还原
    if target and edited is not None:
        st, f3 = s.req("GET", f"/api/projects/{pid}/latex/files/{target}")
        broken = edited.replace("\\begin{document}",
                                "\\begin{document}\n\\thisisnotadefinedcommandX", 1)
        st, _r = s.req("PUT", f"/api/projects/{pid}/latex/files/{target}",
                       json_body={"content": broken, "base": f3.get("sha", "")})
        st, bm = s.req("POST", f"/api/projects/{pid}/latex/build", json_body={"engine": engine})
        diag_ok = st == 200 and isinstance(bm, dict) and bm.get("status") != "ok" and (bm.get("diagnostics") or [])
        stamp("pass" if diag_ok else "fail", "坏命令→error+诊断非空",
              f"status={bm.get('status') if isinstance(bm, dict) else '?'} "
              f"diag={len((bm.get('diagnostics') or [])) if isinstance(bm, dict) else 0}")
        ctx["error_diag"] = (bm.get("diagnostics") or [{}])[0] if isinstance(bm, dict) else {}
        # 还原前必须重取 sha（坏命令那次 PUT 已推进版本）
        st, f4 = s.req("GET", f"/api/projects/{pid}/latex/files/{target}")
        st, _r = s.req("PUT", f"/api/projects/{pid}/latex/files/{target}",
                       json_body={"content": edited, "base": f4.get("sha", "")})
        m3 = build_ok(pid, engine, "修复还原后复编译")
        ok = bool(m3)
        stamp("pass" if ok else "fail", "修复还原后复编译 ok", str(m3.get("build_id") if m3 else "-"))

    # L6b 版本历史（防丢稿）：编译必快照（E2E 保存均在 90s 合并窗口内，由编译兜底提交）；
    # 恢复 HEAD ⇒ 工作区精确一致 ⇒ changed=false 且不动工作区
    st, hist = s.req("GET", f"/api/projects/{pid}/latex/history")
    hist = hist if isinstance(hist, list) else []
    msgs = [v.get("message", "") for v in hist]
    ok = st == 200 and len(hist) >= 3 and all(m_ == "build" for m_ in msgs)
    stamp("pass" if ok else "fail", "版本历史：编译快照提交",
          f"{len(hist)} 版 全为 build={all(m_ == 'build' for m_ in msgs) if msgs else '?'}")
    if len(hist) >= 1:
        head_sha = hist[0].get("sha", "")
        st, rr = s.req("POST", f"/api/projects/{pid}/latex/history/{head_sha}/restore")
        ok = (st == 200 and isinstance(rr, dict) and rr.get("ok") is True
              and rr.get("changed") is False and rr.get("written", 0) >= 1 and not rr.get("deleted"))
        stamp("pass" if ok else "fail", "版本恢复 HEAD=无变化（工作区不动）",
              f"written={rr.get('written')} changed={rr.get('changed')}" if st == 200 else f"HTTP {st}")

    # L6c 通用 Word 导出（导师阅读版）：真 pandoc 转换 → pass/degraded + DOCX 容器可下载
    st, wm = s.req("POST", f"/api/projects/{pid}/latex/export-word")
    w_ok = (st == 200 and isinstance(wm, dict) and wm.get("status") in ("pass", "degraded")
            and wm.get("artifacts", {}).get("paper.docx"))
    stamp("pass" if w_ok else "fail", "通用 Word 导出（真 pandoc）",
          f"status={wm.get('status') if isinstance(wm, dict) else '?'} "
          f"degrades={len((wm.get('degrades') or [])) if isinstance(wm, dict) else '?'} "
          f"{(wm.get('tool') or {}).get('duration_ms', '?') if isinstance(wm, dict) else '?'}ms"
          if isinstance(wm, dict) else f"HTTP {st}")
    w_eid = wm.get("export_id", "") if isinstance(wm, dict) else ""
    if w_eid:
        st, docx = s.req("GET", f"/api/projects/{pid}/latex/word-exports/{w_eid}/artifacts/paper.docx")
        ok = st == 200 and isinstance(docx, bytes) and docx[:2] == b"PK"
        stamp("pass" if ok else "fail", "Word 导出产物下载", f"{len(docx) if isinstance(docx, bytes) else 0}B")

    # L6d Word(.docx)→LaTeX 导入（真 pandoc 反向转换）：建项成功且可编译
    def docx_fixture() -> bytes:
        import io as _io
        buf = _io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("[Content_Types].xml",
                       '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                       '<Default Extension="xml" ContentType="application/xml"/>'
                       '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
            z.writestr("_rels/.rels",
                       '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                       '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
            z.writestr("word/_rels/document.xml.rels",
                       '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
            z.writestr("word/document.xml",
                       '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                       "<w:body><w:p><w:r><w:t>E2E Word import body.</w:t></w:r></w:p></w:body></w:document>")
        return buf.getvalue()

    st, dm = s.multipart("/api/projects/latex/import-docx/upload", "file", "e2e.docx", docx_fixture())
    ok = st == 200 and isinstance(dm, dict) and dm.get("main_candidates") == ["main.tex"]
    stamp("pass" if ok else "fail", "Word→LaTeX 转换暂存（真 pandoc）",
          f"cjk={dm.get('cjk') if isinstance(dm, dict) else '?'} files={len(dm.get('files') or [])}" if isinstance(dm, dict) else f"HTTP {st}")
    if ok:
        st, created = s.req("POST", "/api/projects/latex/import-docx/create",
                            json_body={"token": dm.get("token", ""), "engine": dm.get("engine", "pdflatex"),
                                       "title": "E2E Word 导入"})
        pid3 = created.get("id", "") if isinstance(created, dict) else ""
        ok = st == 200 and bool(pid3)
        stamp("pass" if ok else "fail", "Word 导入建项", pid3)
        if pid3:
            ctx["pid_word_imported"] = pid3
            track_project(pid3, email)
            m5 = build_ok(pid3, dm.get("engine", "pdflatex"), "Word 导入工程编译")
            ok = bool(m5)
            stamp("pass" if ok else "fail", "Word 导入工程编译 ok", str(m5.get("build_id") if m5 else "-"))

    # L7 ZIP 两段式导入：子目录主文件检测 + bib 编译
    st, up = s.multipart("/api/projects/latex/import/upload", "file", "e2e-fixture.zip",
                         latex_fixture_zip())
    ok = st == 200 and "main.tex" in (up.get("main_candidates") if isinstance(up, dict) else [])
    stamp("pass" if ok else "fail", "ZIP 上传+主文件检测",
          f"candidates={up.get('main_candidates') if isinstance(up, dict) else up}")
    token = up.get("token") if isinstance(up, dict) else ""
    st, imp = s.req("POST", "/api/projects/latex/import/create",
                    json_body={"token": token, "main": "main.tex", "engine": "pdflatex",
                               "title": "E2E 导入工程"})
    pid2 = imp.get("id", "") if isinstance(imp, dict) else ""
    ok = st == 200 and bool(pid2)
    stamp("pass" if ok else "fail", "ZIP 建项（子目录主文件）", pid2)
    if pid2:
        ctx["pid_imported"] = pid2
        track_project(pid2, email)
        m4 = build_ok(pid2, "pdflatex", "导入工程（含 bib/图片/子目录）")
        ok = bool(m4)
        stamp("pass" if ok else "fail", "导入工程编译 ok（bibtex 全链）", str(m4.get("build_id") if m4 else "-"))

    # L8 重开：全新会话重新登录，项目仍在、可再编译
    s2 = Client(base)
    if login(s2, email, pw) != 204:
        stamp("fail", "重开：重新登录", "非 204")
        return ctx
    st, lst = s2.req("GET", "/api/projects")
    ids = [p.get("id") for p in lst] if isinstance(lst, list) else []
    ok = pid in ids and (ctx.get("pid_imported") in ids)
    stamp("pass" if ok else "fail", "重开：新会话项目列表完整", f"{len(ids)} 个项目")
    if ctx.get("pid_imported"):
        st, files2 = s2.req("GET", f"/api/projects/{ctx['pid_imported']}/latex/files")
        names = {f.get("path") for f in (files2.get("files", []) if isinstance(files2, dict) else [])}
        ok = st == 200 and {"main.tex", "sections/intro.tex", "refs.bib"} <= names
        stamp("pass" if ok else "fail", "重开：导入工程文件树完整", f"{sorted(n for n in names if n)[:5]}")
    return ctx


# ---------------------------------------------------------------- Phase W Word 全链 ----

def run_phase_word(base: str, public_origin: str, ds_url: str | None,
                   jwt_secret: str | None, ds_public_url: str) -> dict:
    phase("Phase W Word 全链")
    ts = datetime.now(timezone.utc).strftime("%H%M%S")
    email = f"e2e-word-{ts}@e2e.example.com"
    pw = E2E_PW
    s = Client(base)
    ctx: dict = {}

    if register(s, email, pw) not in (200, 201) or login(s, email, pw) != 204:
        stamp("fail", "注册+登录（Word 链隔离账号）", email)
        return ctx

    # W1 建项
    st, proj = s.req("POST", "/api/projects/word/create",
                     json_body={"title": f"E2E Word {ts}"})
    pid = proj.get("id", "") if isinstance(proj, dict) else ""
    ok = st == 200 and bool(pid) and proj.get("source_format") == "docx"
    stamp("pass" if ok else "fail", "Word 建项", pid)
    if not pid:
        return ctx
    ctx["pid"] = pid
    track_project(pid, email)

    # W2 状态：初始版本落盘 + doc_key
    st, state = s.req("GET", f"/api/projects/{pid}/word/state")
    doc_key = state.get("doc_key", "") if isinstance(state, dict) else ""
    ok = (st == 200 and isinstance(state, dict) and state.get("version", 0) >= 1
          and state.get("versions") and bool(doc_key))
    stamp("pass" if ok else "fail", "word/state 初始版本+doc_key",
          f"v={state.get('version') if isinstance(state, dict) else '?'}")

    # W3 下载初始 DOCX：PK 魔数 + 结构
    st, docx = s.req("GET", f"/api/projects/{pid}/word/download")
    names = set(unzip_files(docx)) if isinstance(docx, bytes) and docx[:2] == b"PK" else set()
    ok = (isinstance(docx, bytes) and docx[:2] == b"PK"
          and {"[Content_Types].xml", "word/document.xml"} <= names)
    stamp("pass" if ok else "fail", "下载初始 DOCX（PK+结构）", f"{len(docx) if isinstance(docx, bytes) else 0}B")

    # W4 editor-config：结构 + pluginsData 前缀 + JWT 验签
    st, ec = s.req("GET", f"/api/projects/{pid}/word/editor-config")
    cfg = ec.get("config", {}) if isinstance(ec, dict) else {}
    plugins = (cfg.get("editorConfig", {}).get("plugins", {}) or {}).get("pluginsData", [])
    doc_url = (cfg.get("document", {}) or {}).get("url", "")
    cb_url = (cfg.get("editorConfig", {}) or {}).get("callbackUrl", "")
    doc_key_cfg = (cfg.get("document", {}) or {}).get("key", "")
    ok = (st == 200 and len(plugins) == 5
          and all(u.startswith(public_origin) for u in plugins)
          and doc_url.startswith(ds_public_url) and cb_url.startswith(ds_public_url)
          and doc_key_cfg == doc_key)
    stamp("pass" if ok else "fail", "editor-config 结构/pluginsData/回调地址",
          f"plugins={len(plugins)} doc_url前缀={doc_url[:24]}")
    if jwt_secret and isinstance(cfg, dict) and cfg.get("token"):
        ok = verify_jwt_hs256(cfg["token"], jwt_secret)
        stamp("pass" if ok else "fail", "editor-config JWT HS256 验签（与 DS 共享密钥）", "")
    elif jwt_secret:
        stamp("fail", "editor-config JWT HS256 验签（与 DS 共享密钥）", "config.token 缺失")

    # W5 导入含图 DOCX：字节级一致 + media 校验
    fixture = word_fixture_docx(f"E2E fixture {ts}")
    st, imp = s.multipart("/api/projects/word/import", "file", "e2e-fixture.docx", fixture,
                          fields=[("title", f"E2E Import {ts}")])
    pid_w = imp.get("id", "") if isinstance(imp, dict) else ""
    ok = st == 200 and bool(pid_w)
    stamp("pass" if ok else "fail", "导入含图 DOCX", pid_w)
    if pid_w:
        ctx["pid_imported"] = pid_w
        track_project(pid_w, email)
        st, dl = s.req("GET", f"/api/projects/{pid_w}/word/download")
        byte_ok = isinstance(dl, bytes) and dl == fixture
        stamp("pass" if byte_ok else "fail", "导入 DOCX 下载字节一致",
              f"{len(dl) if isinstance(dl, bytes) else 0}B")
        files = unzip_files(dl) if byte_ok else {}
        media_ok = files.get("word/media/image1.png") == TINY_PNG
        stamp("pass" if media_ok else "fail", "DOCX media/image1.png 字节一致", "")
        st, state_w = s.req("GET", f"/api/projects/{pid_w}/word/state")
        vid = (state_w.get("versions") or [{}])[-1].get("id", "") if isinstance(state_w, dict) else ""
        st, vdl = s.req("GET", f"/api/projects/{pid_w}/word/versions/{vid}/download")
        ok = st == 200 and isinstance(vdl, bytes) and vdl == fixture
        stamp("pass" if ok else "fail", "版本下载字节一致", vid)
        ctx["pid_imported_state"] = state_w if isinstance(state_w, dict) else {}

    # W6 插图 HTTP 面：渲染→入库→读取→word-image 摘要一致
    chart = {"type": "line", "name": f"E2E 图表 {ts}", "title": "Accuracy", "x_label": "Epoch",
             "y_label": "Acc", "categories": ["1", "2", "3"],
             "series": [{"name": "ours", "values": [0.5, 0.7, 0.9]},
                        {"name": "base", "values": [0.4, 0.5, 0.6]}]}
    st, rend = s.req("POST", "/api/charts/render", json_body=chart)
    png_ref = b""
    if st == 200 and isinstance(rend, dict):
        data_url = rend.get("data_url", "")
        png_ref = base64.b64decode(data_url.split(",", 1)[1]) if "," in data_url else b""
    ok = bool(png_ref) and png_ref[:8] == b"\x89PNG\r\n\x1a\n" and sha_of(png_ref) == rend.get("sha256")
    stamp("pass" if ok else "fail", "charts/render PNG+服务端摘要", f"{len(png_ref)}B")
    if pid_w and png_ref:
        st, fig = s.req("POST", f"/api/project-figures/{pid_w}", json_body=chart)
        fid = (fig.get("figure", {}) or {}).get("id", "") if isinstance(fig, dict) else ""
        ok = st == 200 and bool(fid)
        stamp("pass" if ok else "fail", "图表入库 project-figures", fid)
        if fid:
            st, fig_png = s.req("GET", f"/api/project-figures/{pid_w}/{fid}/png")
            ok = st == 200 and fig_png == png_ref
            stamp("pass" if ok else "fail", "图表 PNG 读取一致", f"{len(fig_png) if isinstance(fig_png, bytes) else 0}B")
            key = (ctx.get("pid_imported_state") or {}).get("doc_key", "")
            st, wi = s.req("GET", f"/api/project-figures/{pid_w}/{fid}/word-image?doc_key={key}")
            ok = st == 200 and isinstance(wi, dict) and wi.get("sha256") == sha_of(png_ref)
            stamp("pass" if ok else "fail", "word-image 会话绑定+摘要一致", f"sha={wi.get('sha256', '')[:12] if isinstance(wi, dict) else '?'}")
            st, wi_bad = s.req("GET", f"/api/project-figures/{pid_w}/{fid}/word-image?doc_key=wrongkey00")
            ok = st == 409
            stamp("pass" if ok else "fail", "word-image 错误 doc_key 拒绝", f"HTTP {st}")

    # W6b 方法图 HTTP 面：入库→场景真源读写→PUT 版本并发→word-image 对 diagram 生效→publish-latex
    scene_v1 = '{"type":"excalidraw","version":2,"source":"e2e","elements":[{"id":"e1","type":"rectangle"}],"files":{}}'
    scene_v2 = '{"type":"excalidraw","version":2,"source":"e2e","elements":[{"id":"e2","type":"ellipse"}],"files":{}}'
    png_url = "data:image/png;base64," + base64.b64encode(TINY_PNG).decode("ascii")
    st, fig = s.req("POST", f"/api/project-figures/{pid_w}",
                    json_body={"kind": "diagram", "name": f"E2E 方法图 {ts}", "scene": scene_v1, "png_data_url": png_url})
    did = (fig.get("figure", {}) or {}).get("id", "") if isinstance(fig, dict) else ""
    ok = st == 200 and bool(did) and (fig.get("figure", {}) or {}).get("version") == 1
    stamp("pass" if ok else "fail", "方法图入库（kind=diagram v1）", did)
    if did:
        st, sc = s.req("GET", f"/api/project-figures/{pid_w}/{did}/scene")
        ok = st == 200 and isinstance(sc, dict) and sc.get("scene") == scene_v1 and sc.get("version") == 1
        stamp("pass" if ok else "fail", "场景真源读取（重开恢复契约）", f"HTTP {st}")
        st, dpng = s.req("GET", f"/api/project-figures/{pid_w}/{did}/png")
        ok = st == 200 and dpng == TINY_PNG
        stamp("pass" if ok else "fail", "diagram PNG 读取（ETag 见单测）", f"HTTP {st}")
        bad = s.req("PUT", f"/api/project-figures/{pid_w}/{did}",
                    json_body={"scene": scene_v2, "png_data_url": png_url, "expected_version": 99})
        ok = bad[0] == 409 and (bad[1] or {}).get("detail", {}).get("kind") == "version_conflict"
        stamp("pass" if ok else "fail", "PUT 乐观并发 409（version_conflict）", f"HTTP {bad[0]}")
        st, upd = s.req("PUT", f"/api/project-figures/{pid_w}/{did}",
                        json_body={"scene": scene_v2, "png_data_url": png_url, "expected_version": 1})
        ok = st == 200 and (upd.get("figure", {}) or {}).get("version") == 2
        stamp("pass" if ok else "fail", "PUT 原地更新（version 2）", f"HTTP {st}")
        st, sc2 = s.req("GET", f"/api/project-figures/{pid_w}/{did}/scene")
        ok = st == 200 and (sc2 or {}).get("scene") == scene_v2
        stamp("pass" if ok else "fail", "场景已更新为 v2", f"HTTP {st}")
        st, wi = s.req("GET", f"/api/project-figures/{pid_w}/{did}/word-image?doc_key={(ctx.get('pid_imported_state') or {}).get('doc_key', '')}")
        ok = st == 200 and isinstance(wi, dict) and wi.get("sha256") == sha_of(TINY_PNG)
        stamp("pass" if ok else "fail", "word-image 对方法图生效（sha16 插件契约）", f"sha={wi.get('sha256', '')[:12] if isinstance(wi, dict) else '?'}")
        st, lx = s.req("POST", "/api/projects/latex-demo",
                       json_body={"template": "blank", "title": f"E2E 图表发布 {ts}"})
        lx_pid = lx.get("id", "") if isinstance(lx, dict) else ""
        if st == 200 and lx_pid:
            track_project(lx_pid, email)
            # publish-latex 只对 LaTeX 工程开放：在 lx_pid 上单独建图再发布
            # （pid_w 是 Word 工程，直接发布会 400）。
            st, lfig = s.req("POST", f"/api/project-figures/{lx_pid}",
                             json_body={"kind": "diagram", "name": "E2E 发布图",
                                        "scene": scene_v1, "png_data_url": png_url})
            lx_did = (lfig.get("figure", {}) or {}).get("id", "") if isinstance(lfig, dict) else ""
            if st == 200 and lx_did:
                stem = f"e2e-diagram-{ts}"
                st, pub = s.req("POST", f"/api/project-figures/{lx_pid}/{lx_did}/publish-latex",
                                json_body={"stem": stem, "overwrite": False})
                ok = st == 200 and (pub or {}).get("path") == f"figures/{stem}.png" and "includegraphics" in (pub or {}).get("snippet", "")
                stamp("pass" if ok else "fail", "publish-latex 首次发布", f"HTTP {st} {str(pub.get('detail', ''))[:60] if isinstance(pub, dict) else ''}")
                st, pub2 = s.req("POST", f"/api/project-figures/{lx_pid}/{lx_did}/publish-latex",
                                 json_body={"stem": stem, "overwrite": False})
                ok = st == 409
                stamp("pass" if ok else "fail", "publish-latex 重名拒绝", f"HTTP {st}")
                st, pub3 = s.req("POST", f"/api/project-figures/{lx_pid}/{lx_did}/publish-latex",
                                 json_body={"stem": stem, "overwrite": True})
                ok = st == 200
                stamp("pass" if ok else "fail", "publish-latex overwrite 覆盖", f"HTTP {st}")
            else:
                stamp("fail", "publish-latex 前置方法图创建（latex 工程）", f"HTTP {st}")
        else:
            stamp("fail", "publish-latex 前置 latex 工程创建", f"HTTP {st}")
        st, _ = s.req("DELETE", f"/api/project-figures/{pid_w}/{did}")
        ok = st == 200
        stamp("pass" if ok else "fail", "方法图删除（双文件清理）", f"HTTP {st}")

    # W7 真实 DS 转换回环：export/pdf → DS 拉文档 → 转换 → 取回 PDF
    if pid_w:
        st, ex = s.req("POST", f"/api/projects/{pid_w}/word/export/pdf")
        url = ex.get("url", "") if isinstance(ex, dict) else ""
        ok = st == 200 and bool(url)
        stamp("pass" if ok else "fail", "Word 导出 PDF（真实 DS 回环）",
              f"HTTP {st} {str(ex.get('detail', ''))[:80] if isinstance(ex, dict) else ''}")
        if url:
            st, pdf = s.req("GET", url)
            ok = st == 200 and isinstance(pdf, bytes) and pdf[:4] == b"%PDF"
            stamp("pass" if ok else "fail", "导出 PDF 下载", f"{len(pdf) if isinstance(pdf, bytes) else 0}B")

        # W8 forcesave 无会话语义：DS 没有该文档的编辑会话（无浏览器）时要么明确报错，
        # 要么 unchanged；两种情况都不得产生脏版本。
        st, state_pre = s.req("GET", f"/api/projects/{pid_w}/word/state")
        v_pre = state_pre.get("version") if isinstance(state_pre, dict) else None
        st, sv = s.req("POST", f"/api/projects/{pid_w}/word/save")
        no_session_ok = (st == 200 and isinstance(sv, dict)
                         and sv.get("pending") is False and sv.get("unchanged") is True) or (st >= 400)
        st, state_post = s.req("GET", f"/api/projects/{pid_w}/word/state")
        v_post = state_post.get("version") if isinstance(state_post, dict) else None
        ok = no_session_ok and v_pre == v_post
        stamp("pass" if ok else "fail", "forcesave 无会话语义（明确报错/unchanged，版本不变）",
              f"HTTP {st} v:{v_pre}->{v_post}")

    # W9 越权：outsider 不能下载/拿编辑器配置
    o = Client(base)
    oemail = f"e2e-out-{ts}@e2e.example.com"
    register(o, oemail, pw)
    login(o, oemail, pw)
    st, _ = o.req("GET", f"/api/projects/{pid}/word/download")
    ok = st in (403, 404)
    stamp("pass" if ok else "fail", "越权下载 DOCX 被拒", f"HTTP {st}")
    st, _ = o.req("GET", f"/api/projects/{pid}/word/editor-config")
    ok = st in (403, 404)
    stamp("pass" if ok else "fail", "越权取编辑器配置被拒", f"HTTP {st}")
    return ctx


# ---------------------------------------------------------------- Phase P P1 核心链 ----

def citation_fixture_docx() -> bytes:
    """含乱序引用 [2]/[1] 与完整托管参考文献块的最小 DOCX（stdlib 手写 OOXML，word_fixture_docx 同款容器）。

    正文两段分别引用 [2]、[1]（首现顺序与编号序倒挂：首现序 [2]→[1]、[1]→[2]）；
    托管块：头标记段 + 两条占位条目段 + 尾标记段——renumber-citations 按文献库重建条目文本，
    占位文本可区分条目 A/B，供下载后断言重建顺序。"""
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        "<w:p><w:r><w:t>引言部分引用了先前工作[2]。</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>方法部分沿用文献[1]。</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>[参考文献-平台生成]</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>[1] 占位条目甲（E2E 占位文本）</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>[2] 占位条目乙（E2E 占位文本）</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>[参考文献-平台生成]（完）</w:t></w:r></w:p>"
        "</w:body></w:document>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType='
                   '"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/_rels/document.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
        z.writestr("word/document.xml", document)
    return buf.getvalue()


def run_phase_p1(base: str, ds_url: str | None) -> dict:
    phase("Phase P P1 核心链")
    ts = datetime.now(timezone.utc).strftime("%H%M%S")
    email = f"e2e-p1-{ts}@e2e.example.com"
    pw = E2E_PW
    s = Client(base)
    ctx: dict = {}

    if register(s, email, pw) not in (200, 201) or login(s, email, pw) != 204:
        stamp("fail", "注册+登录（P1 链隔离账号）", email)
        return ctx

    # ---- P1-3 投稿前检查（LaTeX）：latex-general + double-blind（expired / digest_sha） ----
    engine = "pdflatex"
    st, demo = s.req("POST", "/api/projects/latex-demo", json_body={"template": "ieee"})
    if st != 200:
        st, demo = s.req("POST", "/api/projects/latex-demo", json_body={"template": "blank"})
        engine = "xelatex"
    pid = demo.get("id", "") if isinstance(demo, dict) else ""
    if st != 200 or not pid:
        stamp("fail", "模板建项（P1 链）", f"HTTP {st}")
        return ctx
    ctx["pid_latex"] = pid
    track_project(pid, email)

    st, m = s.req("POST", f"/api/projects/{pid}/latex/build", json_body={"engine": engine})
    ok = st == 200 and isinstance(m, dict) and m.get("status") == "ok"
    stamp("pass" if ok else "fail", "LaTeX 编译（公开链 PDF 前置）", f"{pid} engine={engine}")
    if not ok:
        return ctx

    st, rep = s.req("POST", f"/api/projects/{pid}/latex/preflight", json_body={"ruleset": "latex-general"})
    ok = (st == 200 and isinstance(rep, dict) and rep.get("report", {}).get("ruleset_id") == "latex-general"
          and rep.get("expired") is False and bool(rep.get("report", {}).get("digest_sha")))
    stamp("pass" if ok else "fail", "P1-3 LaTeX 投稿前检查 latex-general",
          f"HTTP {st} expired={rep.get('expired') if isinstance(rep, dict) else '?'} "
          f"digest={str((rep.get('report') or {}).get('digest_sha'))[:12] if isinstance(rep, dict) else '?'}")
    st, rep2 = s.req("POST", f"/api/projects/{pid}/latex/preflight",
                     json_body={"ruleset": "double-blind", "blind_terms": ["张三", "李四"]})
    ok = (st == 200 and isinstance(rep2, dict) and rep2.get("report", {}).get("ruleset_id") == "double-blind"
          and rep2.get("expired") is False)
    stamp("pass" if ok else "fail", "P1-3 LaTeX double-blind（自定义屏蔽词）",
          f"HTTP {st} expired={rep2.get('expired') if isinstance(rep2, dict) else '?'}")
    st, got = s.req("GET", f"/api/projects/{pid}/latex/preflight?ruleset=latex-general")
    ok = st == 200 and isinstance(got, dict) and got.get("expired") is False
    stamp("pass" if ok else "fail", "P1-3 GET 回读最近报告", f"HTTP {st}")

    # ---- P1-1 审稿回复信：拆条 → 回复+addressed → 导出 .md/.tex ----
    review_text = ("Reviewer 1\n\n1. 实验对比不足，缺少与主流方法的对照实验。\n\n"
                   "2. 部分图表分辨率偏低。\n")
    st, parsed = s.req("POST", f"/api/projects/{pid}/rebuttal/parse", json_body={"text": review_text})
    items = parsed.get("items", []) if isinstance(parsed, dict) else []
    ok = st == 200 and len(items) >= 1
    stamp("pass" if ok else "fail", "P1-1 审稿意见拆条", f"{len(items)} 条 warnings={len(parsed.get('warnings', []) or []) if isinstance(parsed, dict) else '?'}")
    if not ok:
        return ctx
    reply = "已补充与主流方法的对照实验（见表 2），并重绘全部图表为矢量图。"
    all_ok = True
    for item in items:
        st, _u = s.req("PUT", f"/api/projects/{pid}/rebuttal/items/{item['id']}",
                       json_body={"status": "addressed", "response": reply})
        all_ok = all_ok and st == 200
    stamp("pass" if all_ok else "fail", "P1-1 逐条回复+置 addressed", f"{len(items)} 条 HTTP {st}")
    for fmt in ("md", "tex"):
        st, letter = s.req("GET", f"/api/projects/{pid}/rebuttal/export?format={fmt}")
        ok = st == 200 and isinstance(letter, bytes) and len(letter) > 0 and reply.encode() in letter
        stamp("pass" if ok else "fail", f"P1-1 导出 Response Letter .{fmt}",
              f"{len(letter) if isinstance(letter, bytes) else 0}B 含回复正文={isinstance(letter, bytes) and reply.encode() in letter}")
    st, docx_letter = s.req("GET", f"/api/projects/{pid}/rebuttal/export?format=docx")
    ok = docx_contains(docx_letter, ("Response to Reviewers", "重绘全部图表为矢量图"))
    stamp("pass" if ok else "fail", "P1-1 导出 Response Letter .docx（PK+document.xml 含标题与回复正文）",
          f"{len(docx_letter) if isinstance(docx_letter, bytes) else 0}B")
    # ---- B3 多轮归档：二次 replace → rounds 归档 → 导出 Round 2 ----
    st, parsed2 = s.req("POST", f"/api/projects/{pid}/rebuttal/parse",
                        json_body={"text": review_text, "mode": "replace"})
    round2 = parsed2.get("round") if isinstance(parsed2, dict) else None
    ok = st == 200 and round2 == 2
    stamp("pass" if ok else "fail", "B3 二次 replace 进入第 2 轮", f"round={round2}")
    if ok:
        st, rounds = s.req("GET", f"/api/projects/{pid}/rebuttal/rounds")
        lst = (rounds or {}).get("rounds", []) if isinstance(rounds, dict) else []
        ok = st == 200 and len(lst) == 1 and lst[0].get("round") == 1 and lst[0].get("items", 0) >= 1
        stamp("pass" if ok else "fail", "B3 第 1 轮已归档（rounds 只读清单）", json.dumps(lst, ensure_ascii=False))
        st, rd = s.req("GET", f"/api/projects/{pid}/rebuttal/rounds/1")
        ok = st == 200 and isinstance(rd, dict) and len(rd.get("items", [])) >= 1
        stamp("pass" if ok else "fail", "B3 rounds/1 只读详情", f"HTTP {st}")
        # 先逐条回复第 2 轮条目（导出守卫：无任何回复/修改说明 ⇒ 409，是正确行为）
        for item in (parsed2.get("items") or []):
            st, _u = s.req("PUT", f"/api/projects/{pid}/rebuttal/items/{item['id']}",
                           json_body={"status": "addressed", "response": reply})
        st, md2 = s.req("GET", f"/api/projects/{pid}/rebuttal/export?format=md")
        ok = st == 200 and isinstance(md2, bytes) and b"Round 2" in md2 and b"Round 1" not in md2
        stamp("pass" if ok else "fail", "B3 导出信标注 Round 2", f"HTTP {st}")
        # 锚点白名单形态校验（非法 vid ⇒ 422）
        st2, _bad = s.req("PUT", f"/api/projects/{pid}/rebuttal/items/{(parsed2.get('items') or [{}])[0].get('id', '')}",
                          json_body={"snapshot": {"type": "word-version", "sha": "f" * 64, "vid": "bad"}})
        ok = st2 == 422
        stamp("pass" if ok else "fail", "B3 锚点白名单校验（非法 vid 422）", f"HTTP {st2}")


    # ---- P1-2 & P1-0-B Word 高级链：乱序引用上传 → 登记文献 → 重排 → preflight 联动 → 幂等 ----
    st, proj = s.req("POST", "/api/projects/word/create", json_body={"title": f"E2E P1 {ts}"})
    wpid = proj.get("id", "") if isinstance(proj, dict) else ""
    ok = st == 200 and bool(wpid)
    stamp("pass" if ok else "fail", "Word 建项（P1 链）", wpid)
    if not wpid:
        return ctx
    ctx["pid_word"] = wpid
    track_project(wpid, email)

    st, up = s.multipart(f"/api/projects/{wpid}/word/upload-version", "file", "e2e-citations.docx",
                         citation_fixture_docx())
    ok = st == 200 and isinstance(up, dict) and up.get("version", 0) >= 2
    stamp("pass" if ok else "fail", "upload-version 写入乱序引用 DOCX",
          f"HTTP {st} version={up.get('version') if isinstance(up, dict) else '?'}")
    if not ok:
        return ctx

    entries_body = {"entries": [
        {"citation_key": f"e2e-a-{ts}", "title": "甲的基础方法研究", "authors": ["张甲"], "year": "2024"},
        {"citation_key": f"e2e-b-{ts}", "title": "乙的扩展工作", "authors": ["李乙"], "year": "2025"},
    ]}
    st, committed = s.req("POST", f"/api/projects/{wpid}/library/commit", json_body=entries_body)
    rids = committed.get("reference_ids", []) if isinstance(committed, dict) else []
    ok = st == 200 and len(rids) == 2
    stamp("pass" if ok else "fail", "文献库登记 2 条（index 模式）", f"HTTP {st} rids={len(rids)}")
    if not ok:
        return ctx

    st, reg = s.req("POST", f"/api/projects/{wpid}/library/citations/register",
                    json_body={"append": rids})
    order = reg.get("order", []) if isinstance(reg, dict) else []
    ok = st == 200 and order == rids
    stamp("pass" if ok else "fail", "引用顺序表登记（编号=表位）", f"HTTP {st}")

    st, rn = s.req("POST", f"/api/projects/{wpid}/word/renumber-citations",
                   json_body={"style": "gb-t-7714-2015"})
    ok = (st == 200 and isinstance(rn, dict) and rn.get("changed") is True
          and rn.get("mapping") == {"2": "1", "1": "2"} and rn.get("order") == [rids[1], rids[0]])
    stamp("pass" if ok else "fail", "renumber-citations 首现序重排（[2]/[1]→[1]/[2]）",
          f"HTTP {st} mapping={rn.get('mapping') if isinstance(rn, dict) else '?'}")

    st, docx = s.req("GET", f"/api/projects/{wpid}/word/download")
    doc_text = ""
    if isinstance(docx, bytes) and docx[:2] == b"PK":
        doc_text = unzip_files(docx).get("word/document.xml", b"").decode("utf-8", "replace")
    ok = ("引言部分引用了先前工作[1]。" in doc_text and "方法部分沿用文献[2]。" in doc_text
          and 0 <= doc_text.find("乙的扩展工作") < doc_text.find("甲的基础方法研究"))
    stamp("pass" if ok else "fail", "下载 DOCX：正文编号与托管文献表顺序一致",
          f"{len(docx) if isinstance(docx, bytes) else 0}B")

    # 重排后的权威 DOCX 必须仍可被后续检查链消费（无 422）且绑定当前快照
    st, wf = s.req("POST", f"/api/projects/{wpid}/word/preflight",
                   json_body={"ruleset": "double-blind", "blind_terms": ["王隐名", "赵匿名"]})
    ok = (st == 200 and isinstance(wf, dict) and wf.get("report", {}).get("ruleset_id") == "double-blind"
          and wf.get("expired") is False)
    stamp("pass" if ok else "fail", "P1-3 Word double-blind（重排后联动无 422）",
          f"HTTP {st} expired={wf.get('expired') if isinstance(wf, dict) else '?'}")

    st, rn2 = s.req("POST", f"/api/projects/{wpid}/word/renumber-citations",
                    json_body={"style": "gb-t-7714-2015"})
    ok = st == 200 and isinstance(rn2, dict) and rn2.get("changed") is False
    stamp("pass" if ok else "fail", "幂等复跑 changed=False", f"HTTP {st} changed={rn2.get('changed') if isinstance(rn2, dict) else '?'}")
    # ---- B3 多引文样式：renumber 用 acm 全流程 + bibliography 三新样式 labels/形态闸门 ----
    st, rn_acm = s.req("POST", f"/api/projects/{wpid}/word/renumber-citations",
                       json_body={"style": "acm"})
    ok = st == 200 and isinstance(rn_acm, dict) and rn_acm.get("changed") is True and rn_acm.get("order")
    stamp("pass" if ok else "fail", "B3 renumber-citations acm（顺序制全流程）", f"HTTP {st} changed={rn_acm.get('changed') if isinstance(rn_acm, dict) else '?'}")
    st, rn_gb2 = s.req("POST", f"/api/projects/{wpid}/word/renumber-citations",
                       json_body={"style": "gb-t-7714-2015"})
    ok = st == 200 and isinstance(rn_gb2, dict)
    stamp("pass" if ok else "fail", "B3 切回 gb 样式重排", f"HTTP {st}")
    st, bib = s.req("POST", f"/api/projects/{wpid}/library/bibliography",
                    json_body={"order": list((rn_gb2.get("order") or []) if isinstance(rn_gb2, dict) else []), "style": "springer-lncs"})
    ok = st == 200 and isinstance(bib, dict) and len(bib.get("bibliography") or []) == 2 \
        and all(v.startswith("[") for v in (bib.get("labels") or {}).values())
    stamp("pass" if ok else "fail", "B3 bibliography springer-lncs（labels [n] + 长度一致）",
          f"HTTP {st} labels={json.dumps(bib.get('labels'), ensure_ascii=False) if isinstance(bib, dict) else '?'}")
    for style in ("acm", "elsevier-vancouver"):
        st, b2 = s.req("POST", f"/api/projects/{wpid}/library/bibliography",
                       json_body={"order": list((rn_gb2.get("order") or []) if isinstance(rn_gb2, dict) else []), "style": style})
        ok = st == 200 and isinstance(b2, dict) and len(b2.get("bibliography") or []) >= 1
        stamp("pass" if ok else "fail", f"B3 bibliography {style}", f"HTTP {st}")
    st, bad_style = s.req("POST", f"/api/projects/{wpid}/library/bibliography",
                          json_body={"order": list((rn_gb2.get("order") or []) if isinstance(rn_gb2, dict) else []), "style": "apa"})
    ok = st == 422
    stamp("pass" if ok else "fail", "B3 非顺序制样式 422 拒绝（apa）", f"HTTP {st}")


    # ---- P1-4 公开审阅（AUTH=on 栈可用；501 ⇒ SKIP，不算回归） ----
    def public_review_chain(link_pid: str, label: str) -> None:
        st, link = s.req("POST", f"/api/projects/{link_pid}/public-links",
                         json_body={"scope": "confirm", "ttl_days": 7, "allow_download": True})
        if st == 501:
            stamp("skip", f"P1-4 {label} 公开审阅（AUTH=off 栈未开放）", "")
            return
        token = link.get("token", "") if isinstance(link, dict) else ""
        ok = st == 201 and bool(token)
        stamp("pass" if ok else "fail", f"P1-4 {label} 创建公开审阅链接", f"HTTP {st}")
        if not ok:
            return
        CREATED_PUBLIC_TOKENS.append({"token": token, "pid": link_pid, "email": email})
        anon = Client(base)  # 匿名会话：不带任何 cookie
        st, meta = anon.req("GET", f"/api/public/{token}/meta")
        ok = (st == 200 and isinstance(meta, dict) and meta.get("layout_supported") is False
              and meta.get("pdf_ready") is True and meta.get("source_format") == ("latex" if label == "LaTeX" else "docx"))
        stamp("pass" if ok else "fail", f"P1-4 {label} 匿名 meta（仅 PDF 审阅）",
              f"layout={meta.get('layout_supported') if isinstance(meta, dict) else '?'} pdf={meta.get('pdf_ready') if isinstance(meta, dict) else '?'}")
        st, _ast = anon.req("GET", f"/api/public/{token}/layout-ast")
        stamp("pass" if st == 422 else "fail", f"P1-4 {label} layout-ast 422（版面不可用）", f"HTTP {st}")
        st, pdf = anon.req("GET", f"/api/public/{token}/pdf")
        ok = st == 200 and isinstance(pdf, bytes) and pdf[:4] == b"%PDF"
        stamp("pass" if ok else "fail", f"P1-4 {label} 匿名下载 PDF", f"{len(pdf) if isinstance(pdf, bytes) else 0}B")
        anchor = {"block_id": "page-1", "line": 1, "quote": ""}
        st, cmt = anon.req("POST", f"/api/public/{token}/comments",
                           json_body={"anchor": anchor, "body": "第 1 页图 2 建议放大。", "name": "审稿人丁"})
        stamp("pass" if st == 201 else "fail", f"P1-4 {label} 匿名页级锚点批注", f"HTTP {st}")
        st, cf = anon.req("POST", f"/api/public/{token}/confirm",
                          json_body={"name": "王审阅", "note": "同意定稿"})
        stamp("pass" if st in (200, 201) else "fail", f"P1-4 {label} 匿名确认定稿", f"HTTP {st}")
        st, meta2 = anon.req("GET", f"/api/public/{token}/meta")
        ok = st == 200 and isinstance(meta2, dict) and (meta2.get("confirmation") or {}).get("name") == "王审阅"
        stamp("pass" if ok else "fail", f"P1-4 {label} confirmation 持久化回读",
              f"name={((meta2.get('confirmation') or {}).get('name')) if isinstance(meta2, dict) else '?'}")

    public_review_chain(pid, "LaTeX")
    if ds_url:
        st, ex = s.req("POST", f"/api/projects/{wpid}/word/export/pdf")
        ok = st == 200 and isinstance(ex, dict) and bool(ex.get("url"))
        stamp("pass" if ok else "fail", "P1-4 Word 导出 PDF（真实 DS 回环）",
              f"HTTP {st} {str(ex.get('detail', ''))[:60] if isinstance(ex, dict) else ''}")
        if ok:
            public_review_chain(wpid, "Word")
    else:
        stamp("skip", "P1-4 Word 公开审阅（未提供 --ds-url，跳过 DS 导出前置）", "")
    return ctx


# ---------------------------------------------------------------- Phase F 修复闭环 ----

def run_phase_fixloop(base: str, ai_cfg: dict | None) -> None:
    phase("Phase F 编译错误修复闭环")
    ts = datetime.now(timezone.utc).strftime("%H%M%S")
    email = f"e2e-fix-{ts}@e2e.example.com"
    pw = E2E_PW
    s = Client(base)
    if register(s, email, pw) not in (200, 201) or login(s, email, pw) != 204:
        stamp("fail", "注册+登录（修复链隔离账号）", email)
        return

    # 可选：配置用户自建 AI（凭据由 run_e2e.py 写入服务器端 600 文件，不经命令行）
    if ai_cfg:
        st, _r = s.req("PUT", "/api/ai/my-provider", json_body=ai_cfg)
        if st != 200:
            stamp("skip", "配置用户自建 AI 失败（Phase F 转 SKIP）", f"HTTP {st}")
            return

    st, proj = s.req("POST", "/api/projects/latex-demo", json_body={"template": "blank"})
    pid = proj.get("id", "") if isinstance(proj, dict) else ""
    if st != 200 or not pid:
        stamp("fail", "建项（修复链）", f"HTTP {st}")
        return
    track_project(pid, email)

    bad_line = "本方法在基准数据集上的平均精度为 92.3%。\\e2eundefinedcommandX"
    st, f = s.req("GET", f"/api/projects/{pid}/latex/files/main.tex")
    broken = f["content"].replace("\\begin{document}", f"\\begin{{document}}\n{bad_line}", 1)
    st, _r = s.req("PUT", f"/api/projects/{pid}/latex/files/main.tex",
                   json_body={"content": broken, "base": f["sha"]})
    st, bm = s.req("POST", f"/api/projects/{pid}/latex/build", json_body={"engine": "pdflatex"})
    if st != 200 or not isinstance(bm, dict) or bm.get("status") == "ok" or not bm.get("diagnostics"):
        stamp("fail", "坏工程编译（修复链前置）", f"HTTP {st} status={bm.get('status') if isinstance(bm, dict) else '?'}")
        return
    diag = bm["diagnostics"][0]
    stamp("pass", "坏工程编译出诊断", f"{diag.get('file')}:{diag.get('line')} {str(diag.get('message'))[:60]}")

    # 关联 Issue（模拟从 Issues 页签发起）
    st, issue = s.req("POST", f"/api/projects/{pid}/latex/issues",
                      json_body={"message": str(diag.get("message"))[:500], "file": "main.tex", "line": diag.get("line")})
    issue_id = issue.get("id") if isinstance(issue, dict) else None

    # 生成修复提案（真实 AI；未配置时按 SKIP 收场）
    lines = broken.split("\n")
    ln = diag.get("line") or (lines.index(bad_line) + 1)
    st, gen = s.req("POST", f"/api/projects/{pid}/paper-proposals/generate", json_body={
        "mode": "latex", "file": "main.tex", "base_sha": f["sha"],
        "original_text": bad_line,
        "context_before": "\n".join(lines[max(0, ln - 3):ln - 1]),
        "context_after": "\n".join(lines[ln:ln + 2]),
        "action": "custom",
        "instruction": "这行 LaTeX 里混入了一个未定义命令导致编译失败（Undefined control sequence）。"
                       "请删除该未定义命令、保留其余中文文字原样输出整行。",
        "error_context": {"file": "main.tex", "line": diag.get("line"), "message": diag.get("message") or ""},
        **({"linked_issue_id": issue_id} if issue_id else {})})
    if st != 200:
        detail = str(gen.get("detail", {}).get("message", gen))[:120] if isinstance(gen, dict) else str(gen)[:120]
        if "未配置" in detail or "AI" in detail:
            stamp("skip", "修复闭环（AI 未配置——配置 PAPER_E2E_AI_* 后自动启用）", detail)
        else:
            stamp("fail", "生成修复提案", f"HTTP {st} {detail}")
        return
    prop = gen.get("proposal", {})
    ppid = prop.get("proposal_id", "")
    ok = bool(ppid) and bool(prop.get("error_context"))
    stamp("pass" if ok else "fail", "生成修复提案（真实 AI + 错误快照）", f"{ppid} model={prop.get('model')}")

    # 采纳（HTTP 等价：写回已知良好的修复 + status=applied；模型文本质量不在回归口径内）
    st, f2 = s.req("GET", f"/api/projects/{pid}/latex/files/main.tex")
    fixed = f2["content"].replace(bad_line + "\n", "")
    st, _r = s.req("PUT", f"/api/projects/{pid}/latex/files/main.tex",
                   json_body={"content": fixed, "base": f2["sha"]})
    st, _r = s.req("POST", f"/api/projects/{pid}/paper-proposals/{ppid}/status",
                   json_body={"status": "applied", "applied_text": fixed})
    stamp("pass" if st == 200 else "fail", "采纳修复（写回+applied）", f"HTTP {st}")

    # 验证闭环：重编译→确认错误消失→Issue 联动
    st, ver = s.req("POST", f"/api/projects/{pid}/paper-proposals/{ppid}/verify-fix", json_body={})
    if st == 404:
        stamp("skip", "verify-fix 端点不存在（部署为旧镜像）", "")
        return
    v = ver.get("verification", {}) if isinstance(ver, dict) else {}
    ok = st == 200 and v.get("resolved") is True and v.get("build_status") == "ok"
    stamp("pass" if ok else "fail", "verify-fix：重编译通过、目标错误消失",
          f"resolved={v.get('resolved')} after={len(v.get('after') or [])}")
    ok = ok and v.get("issue_resolved") is True and bool(issue_id)
    stamp("pass" if ok else "fail", "关联 Issue 自动置为已解决", f"issue={issue_id}")
    if issue_id:
        st, issues = s.req("GET", f"/api/projects/{pid}/latex/issues")
        hit = next((i for i in (issues.get("issues") or []) if i.get("id") == issue_id), {}) if isinstance(issues, dict) else {}
        stamp("pass" if hit.get("status") == "resolved" else "fail", "Issues 列表确认 resolved", hit.get("status"))
    st, props = s.req("GET", f"/api/projects/{pid}/paper-proposals")
    mine = next((p for p in (props.get("proposals") or []) if p.get("proposal_id") == ppid), {}) if isinstance(props, dict) else {}
    stamp("pass" if len(mine.get("verifications") or []) >= 1 else "fail",
          "验证记录持久化可回看", f"{len(mine.get('verifications') or [])} 条")


def run_phase_zotero(base: str, zotero_group: str) -> None:
    phase("Phase Z Zotero 公开群组导入")
    ts = datetime.now(timezone.utc).strftime("%H%M%S")
    email = f"e2e-zotero-{ts}@e2e.example.com"
    pw = E2E_PW
    s = Client(base)
    if register(s, email, pw) not in (200, 201) or login(s, email, pw) != 204:
        stamp("fail", "注册+登录（Zotero 链隔离账号）", email)
        return
    st, proj = s.req("POST", "/api/projects/latex-demo", json_body={"template": "blank"})
    pid = proj.get("id", "") if isinstance(proj, dict) else ""
    if st != 200 or not pid:
        stamp("fail", "建项（Zotero 链）", f"HTTP {st}")
        return
    track_project(pid, email)
    st, bib = s.req("POST", f"/api/projects/{pid}/library/bib-file", json_body={"name": "refs.bib"})
    if st not in (200, 201):
        stamp("fail", "新建 refs.bib", f"HTTP {st}")
        return

    # 群组发现 → 集合列表（外部 API 不可达/群组变动 → SKIP，不算回归）
    try:
        st, coll = s.req("POST", f"/api/projects/{pid}/library/zotero/collections",
                         json_body={"group_id": zotero_group}, timeout=60)
    except Exception as e:
        stamp("skip", "Zotero 出站不可达（外部依赖）", str(e)[:100])
        return
    if st == 404:
        stamp("skip", "部署不含 Zotero 端点（旧镜像）", "")
        return
    if st != 200:
        stamp("skip", "Zotero 群组不可用（外部依赖变动）", f"HTTP {st} {str(coll)[:80]}")
        return
    gname = (coll or {}).get("group", {}).get("name", "")
    ncollections = len((coll or {}).get("collections", []))
    stamp("pass", "公开群组可达+集合列表", f"{gname}（{ncollections} 个集合）")

    st, prev = s.req("POST", f"/api/projects/{pid}/library/zotero/preview",
                     json_body={"group_id": zotero_group}, timeout=120)
    entries = (prev or {}).get("entries", []) if isinstance(prev, dict) else []
    ok = st == 200 and len(entries) > 0
    stamp("pass" if ok else "fail", "拉取预览（解析+查重）",
          f"{len(entries)} 条 truncated={ (prev.get('source') or {}).get('truncated') if isinstance(prev, dict) else '?'}")
    if not ok:
        return
    ent = {k: v for k, v in entries[0].items()
           if k not in ("duplicates", "key_conflict", "suggested_key")}
    st, done = s.req("POST", f"/api/projects/{pid}/library/commit", json_body={
        "entries": [ent], "target_bib": "refs.bib", "base_sha": bib.get("sha"),
        "source": {"provider": "zotero", "group_id": int(zotero_group),
                   "collection_key": None, "group_name": gname}})
    ok = st == 200 and len((done or {}).get("reference_ids", [])) == 1
    stamp("pass" if ok else "fail", "确认导入落盘 .bib", f"HTTP {st}")
    st, lib = s.req("GET", f"/api/projects/{pid}/library")
    keys = [e.get("citation_key") for e in (lib or {}).get("entries", [])]
    ok = st == 200 and entries[0]["citation_key"] in keys
    stamp("pass" if ok else "fail", "文献列表可见（可 \\cite 引用）", str(keys[:3]))

    # B2 v2：凭据往返（纯平台功能，不依赖出站；旧镜像 SKIP）
    st, cred = s.req("PUT", "/api/zotero/credentials",
                     json_body={"api_key": f"e2e-key-{ts}", "zotero_user_id": "1"})
    if st == 404:
        stamp("skip", "部署不含凭据端点（旧镜像）", "")
    elif st != 200:
        stamp("fail", "凭据 PUT", f"HTTP {st}")
    else:
        body = (cred or {}).get("credentials", {})
        ok = body.get("has_api_key") is True and str(body.get("api_key_hint", "")).endswith(f"e2e-key-{ts}"[-4:])
        stamp("pass" if ok else "fail", "凭据 PUT（masked 尾号）", str(body.get("api_key_hint")))
        st, got = s.req("GET", "/api/zotero/credentials")
        ok = st == 200 and f"e2e-key-{ts}" not in str(got) and (got.get("credentials") or {}).get("has_api_key") is True
        stamp("pass" if ok else "fail", "凭据 GET 无 key 本体（masked）", f"HTTP {st}")
        st, cleared = s.req("DELETE", "/api/zotero/credentials")
        ok = st == 200 and (cleared.get("credentials") or {}).get("has_api_key") is False
        stamp("pass" if ok else "fail", "凭据 DELETE 清除", f"HTTP {st}")

    # B2 v2：一键刷新零基线（刚导入后 added/updated/removed 应全 0；外部依赖失败 SKIP）
    try:
        st, ref = s.req("POST", f"/api/projects/{pid}/library/zotero/refresh-preview",
                        json_body={"library_type": "group", "group_id": int(zotero_group)}, timeout=120)
    except Exception as e:
        stamp("skip", "刷新预览出站不可达（外部依赖）", str(e)[:100])
        ref = None
        st = 0
    if st == 404:
        stamp("skip", "部署不含刷新端点（旧镜像）", "")
    elif st != 200:
        stamp("skip", "刷新预览不可用（外部依赖变动）", f"HTTP {st} {str(ref)[:80]}")
    else:
        # 幂等基线：刚导入的 1 条保持 unchanged；远端其余条目是新增（非差异）；不得有 updated/removed
        counts = (ref or {}).get("counts", {})
        first_total = len(entries)
        ok = (counts.get("updated") == 0 and counts.get("removed") == 0
              and counts.get("unchanged") == 1 and counts.get("added") == first_total - 1)
        stamp("pass" if ok else "fail", "刷新基线（已导入条 unchanged、无 updated/removed）",
              json.dumps(counts, ensure_ascii=False) + f" 首次预览 {first_total} 条")


# ---------------------------------------------------------------- Phase C 自清理（--cleanup） ----

def run_cleanup(base: str) -> dict:
    """--cleanup：逐账号登录，把本次登记的项目经正规接口 回收站→永久删除，
    并对曾建过公开审阅链接的已删项目抽测匿名 meta=404（证明删除级联清链接）。
    返回清理摘要（写入报告 JSON 的 cleanup 字段）。"""
    phase("Phase C 自清理（--cleanup）")
    summary: dict = {"enabled": True, "requested": len(CREATED_PROJECTS), "deleted": [],
                     "failed": [], "public_link_meta404": []}
    if not CREATED_PROJECTS:
        stamp("skip", "自清理：本次运行未登记任何项目", "")
        summary["public_link_meta404"] = "no_projects"
        return summary
    by_email: dict[str, list[str]] = {}
    for item in CREATED_PROJECTS:
        by_email.setdefault(item["email"], []).append(item["pid"])
    for email, pids in by_email.items():
        c = Client(base)
        if login(c, email, E2E_PW) != 204:
            summary["failed"] += [{"pid": pid, "email": email, "stage": "login"} for pid in pids]
            for pid in pids:
                stamp("fail", f"自清理：清理账号登录失败（{email}）", pid)
            continue
        for pid in pids:
            st1, _r = c.req("POST", f"/api/projects/{pid}/list-state", json_body={"state": "trashed"})
            st2, _r = c.req("DELETE", f"/api/projects/{pid}")
            ok = st1 == 200 and st2 == 204
            stamp("pass" if ok else "fail", f"自清理：回收站→永久删除 {pid}",
                  f"trash={st1} delete={st2}")
            (summary["deleted"] if ok else summary["failed"]).append(
                {"pid": pid, "email": email, "trash": st1, "delete": st2})
    # 级联抽测：仅对「删除成功」的项目曾建的公开链接断言 meta=404
    tokens = [t for t in CREATED_PUBLIC_TOKENS
              if t["pid"] in {d["pid"] for d in summary["deleted"]}]
    if not tokens:
        stamp("skip", "公开链接级联抽测（本轮无已删项目成功创建过公开审阅链接）", "")
        summary["public_link_meta404"] = "no_links"
        return summary
    anon = Client(base)
    for t in tokens:
        st, _meta = anon.req("GET", f"/api/public/{t['token']}/meta")
        ok = st == 404
        stamp("pass" if ok else "fail", f"自清理：已删项目公开链接失效 meta=404（{t['pid']}）",
              f"HTTP {st}")
        if ok:
            summary["public_link_meta404"].append(t["pid"])
    return summary


# ---------------------------------------------------------------- 主流程 ----

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--public-origin", default="")
    ap.add_argument("--ds-url", default="")
    ap.add_argument("--ds-public-url", default="http://app:8000")
    ap.add_argument("--jwt-secret-file", default="")
    ap.add_argument("--skip-latex", action="store_true")
    ap.add_argument("--skip-word", action="store_true")
    ap.add_argument("--skip-p1", action="store_true")
    ap.add_argument("--skip-fixloop", action="store_true")
    ap.add_argument("--skip-zotero", action="store_true")
    ap.add_argument("--ai-config-file", default="",
                    help='含用户自建 AI 接入 JSON（{"base_url","api_key","model_interactive"}）的文件，'
                         "供 Phase F 真实 AI 修复链；缺省尝试生成，未配置则 SKIP")
    ap.add_argument("--zotero-group", default=os.environ.get("PAPER_E2E_ZOTERO_GROUP_ID", "315"),
                    help="Phase Z 用的公开群组 ID（默认 315=GNUmedia，长期公开群组）")
    ap.add_argument("--expect-frontend", default=os.environ.get("PAPER_E2E_FRONTEND_MARK", ""),
                    help="本次发版前端新增的标记串（P0 阶段断言线上 bundle 包含它，防镜像 tag 漏切）")
    ap.add_argument("--out", default="e2e-report.json")
    ap.add_argument("--cleanup", action="store_true",
                    help="运行结束后经正规接口删除本次创建的全部测试项目（回收站→永久删除），"
                         "并抽测已删项目公开链接 meta=404；报告恒含 created_accounts/created_projects")
    args = ap.parse_args()

    public_origin = args.public_origin or args.base
    jwt_secret = ""
    if args.jwt_secret_file:
        try:
            with open(args.jwt_secret_file, encoding="utf-8") as f:
                for line in f:
                    if line.startswith("E2E_JWT_SECRET="):
                        jwt_secret = line.split("=", 1)[1].strip()
                        break
        except OSError:
            pass

    t0 = time.time()
    run_phase0(args.base, public_origin, args.ds_url or None, args.expect_frontend)
    if not args.skip_latex:
        run_phase_latex(args.base)
    if not args.skip_word:
        run_phase_word(args.base, public_origin, args.ds_url or None, jwt_secret or None,
                       args.ds_public_url)
    if not args.skip_p1:
        run_phase_p1(args.base, args.ds_url or None)
    ai_cfg = None
    if args.ai_config_file:
        try:
            with open(args.ai_config_file, encoding="utf-8") as af:
                ai_cfg = json.load(af)
        except (OSError, ValueError) as e:
            print(f"[警告] AI 配置文件不可读：{e}")
    if not args.skip_fixloop:
        run_phase_fixloop(args.base, ai_cfg)
    if not args.skip_zotero:
        run_phase_zotero(args.base, args.zotero_group)
    cleanup_summary = run_cleanup(args.base) if args.cleanup else None

    passed = sum(1 for r in RESULTS if r["status"] == "pass")
    failed = sum(1 for r in RESULTS if r["status"] == "fail")
    skipped = sum(1 for r in RESULTS if r["status"] == "skip")
    report = {
        "schema": "paper-studio/e2e@1",
        "base": args.base,
        "public_origin": public_origin,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": {"pass": passed, "fail": failed, "skip": skipped, "total": len(RESULTS),
                    "duration_s": round(time.time() - t0, 1)},
        "results": RESULTS,
        "created_accounts": list(CREATED_ACCOUNTS),
        "created_projects": list(CREATED_PROJECTS),
    }
    if cleanup_summary is not None:
        report["cleanup"] = cleanup_summary
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n== E2E: {passed} 过 / {failed} 败 / {skipped} 跳过 / 共 {len(RESULTS)} 项 → {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
