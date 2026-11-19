#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""研稿 · 浏览器冒烟套件：Playwright(chromium) 驱动真实 ONLYOFFICE DS 编辑器。

对隔离栈（--base，默认 http://127.0.0.1:8011，独立数据卷）逐链冒烟，
每链独立 PASS/FAIL，一条失败不影响后续链：

  1. editor-opens        编辑器加载完成：工作台就绪 + DS 编辑器 iframe（源=document_server_url）
                         + 工具栏「插件」页签可见。
  2. formula-insert-save 「LaTeX公式」插件输入 E=mc^2#(1) → 独立公式（带编号）插入 →
                         平台 forcesave 等 DS 回传 → 下载 DOCX → 断言 word/document.xml
                         含 OMML（m:oMath/m:sSup）且含 E/mc/2 与编号 (1)。
  3. chart-insert-save   API 先建项目图表（POST /api/project-figures/{pid}）→「科研图表」插件
                         图表库刷新/选择/插入 → forcesave → 下载 DOCX → 断言 word/media/ 出现 PNG。
  4. word-upload-renumber DS 打开原生 Word 文档就绪 → API upload-version 上传乱序引用 DOCX
                         （[2]/[1] + 托管文献块标记）→ doc_key 轮换 → 页面用新 doc_key 重新就绪
                         （word-loading 消失）→ 登记文献 + 引用顺序 → renumber-citations 再次轮换
                         → 重开 → 下载 DOCX 断言正文 [1]/[2] 与文献表顺序一致。
                         （不对未改新文档强跑空 forcesave：DS 会拒 409。）

已知自动化事实（历史验收教训，实现已遵守）：
  - DS 文档正文渲染在 canvas 里，DOM 无文字：正文断言一律「平台保存 → 下载 DOCX →
    解包 word/document.xml 断言」，禁止对 canvas 断言文本；
  - DS 工具栏/页签/插件按钮是 DOM（a#plugins 页签、button.btn-toolbar 插件按钮）；
  - 编辑器 iframe 很深：page.frames 按 name/url 定位（frameEditor=编辑器、
    pluginFrameEditor=右侧插件面板，后者复用同一 iframe 且 src 短暂为 about:blank，
    必须以「面板内元素出现 + 就绪状态文案」为准）；
  - 插件就绪事件：公式面板 #submit 由 disabled→enabled、状态 #status 文案；图表面板
    #charts-library-refresh/#charts-library-insert 同理；
  - 截图偶发挂起：诊断截图一律限时 8s 并 try/except，失败必存 browser-smoke-*.png + DOM 摘要。

账号/项目准备走平台 API（httpx）：注册 e2e-smoke-<ts>-<链>@e2e.example.com → cookie 登录 →
POST /api/projects/word/create（原生 Word，source_format=docx）→ GET editor-config；
浏览器侧用 API 拿到的 studio_session cookie 直接种子（SPA 启动即探 /users/me，无需 UI 登录）。

保存口径（与前端 saveWordAndWait 一致）：POST /api/projects/{pid}/word/save 取 request_id，
轮询 word/state 直到 saving=false 且 last_saved_request_id==request_id；409（NotModified）
短等后重试，最多 3 次。

用法：
  python browser_smoke.py --base http://127.0.0.1:8011 [--out reports/browser-smoke-report.json]
退出码：0=全过；1=有失败（含 Playwright/Chromium 启动失败等基础设施崩溃——此时报告
  run_status=infra_error 并带 crash_reason，与链级业务失败区分；含全局 8 分钟预算耗尽后未执行的链）。
报告可靠性：运行前先落 run_status=running 占位（硬杀不残留上一轮旧报告）；浏览器生命周期
  整体包裹在 try/except/finally 里，任何崩溃都强制落盘合法 JSON 报告。
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import httpx
from playwright.sync_api import sync_playwright

PW = "e2e-Passw0rd!"          # 与 e2e_suite.py 同一口径
FORMULA = "E=mc^2#(1)"         # 带编号公式：居中公式 + 右侧 (1)
BUDGET_S = 480                 # 总超时预算 8 分钟
REPORT_SCHEMA = "paper-studio/browser-smoke@1"

REPORTS_DIR = Path(__file__).resolve().parent / "reports"


# ---------------------------------------------------------------- 平台 API（账号/项目准备与保存回环） ----

class Api:
    """httpx cookie 会话：注册/登录/建项/editor-config/图表/forcesave/下载。"""

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.c = httpx.Client(base_url=self.base, timeout=60.0)

    def register(self, email: str) -> int:
        return self.c.post("/api/auth/register", json={"email": email, "password": PW}).status_code

    def login(self, email: str) -> int:
        st = self.c.post("/api/auth/cookie/login",
                         data={"username": email, "password": PW}).status_code
        return st

    def session_cookie(self) -> str:
        v = self.c.cookies.get("studio_session")
        if not v:
            raise RuntimeError("登录后未取得 studio_session cookie")
        return v

    def create_word_project(self, title: str) -> str:
        r = self.c.post("/api/projects/word/create", json={"title": title})
        body = r.json() if "json" in r.headers.get("content-type", "") else {}
        if r.status_code != 200 or not body.get("id") or body.get("source_format") != "docx":
            raise RuntimeError(f"建 Word 项目失败 HTTP {r.status_code} {str(body)[:160]}")
        return body["id"]

    def editor_config(self, pid: str) -> dict:
        r = self.c.get(f"/api/projects/{pid}/word/editor-config")
        if r.status_code != 200 or not isinstance(r.json(), dict):
            raise RuntimeError(f"editor-config HTTP {r.status_code}")
        return r.json()

    def create_figure(self, pid: str, chart: dict) -> str:
        r = self.c.post(f"/api/project-figures/{pid}", json=chart)
        fid = (r.json().get("figure") or {}).get("id", "") if r.status_code == 200 else ""
        if not fid:
            raise RuntimeError(f"图表入库失败 HTTP {r.status_code} {r.text[:160]}")
        return fid

    def save(self, pid: str):
        r = self.c.post(f"/api/projects/{pid}/word/save")
        body = r.json() if "json" in r.headers.get("content-type", "") else {}
        return r.status_code, body

    def state(self, pid: str) -> dict:
        return self.c.get(f"/api/projects/{pid}/word/state").json()

    def download(self, pid: str) -> bytes:
        r = self.c.get(f"/api/projects/{pid}/word/download")
        if r.status_code != 200 or r.content[:2] != b"PK":
            raise RuntimeError(f"下载 DOCX 异常 HTTP {r.status_code} {len(r.content)}B")
        return r.content

    def upload_version(self, pid: str, data: bytes) -> int:
        r = self.c.post(f"/api/projects/{pid}/word/upload-version",
                        files={"file": ("e2e-renumber.docx", data, "application/octet-stream")})
        return r.status_code

    def commit_entries(self, pid: str, ts: str) -> list[str]:
        """登记 2 条文献（index 模式直写索引），返回 reference_ids。"""
        body = {"entries": [
            {"citation_key": f"smoke-a-{ts}", "title": "甲的基础方法研究", "authors": ["张甲"], "year": "2024"},
            {"citation_key": f"smoke-b-{ts}", "title": "乙的扩展工作", "authors": ["李乙"], "year": "2025"},
        ]}
        r = self.c.post(f"/api/projects/{pid}/library/commit", json=body)
        if r.status_code != 200:
            raise RuntimeError(f"文献登记失败 HTTP {r.status_code} {r.text[:160]}")
        rids = r.json().get("reference_ids", [])
        if len(rids) != 2:
            raise RuntimeError(f"文献登记数量异常：{rids}")
        return rids

    def register_citations(self, pid: str, rids: list[str]) -> None:
        r = self.c.post(f"/api/projects/{pid}/library/citations/register", json={"append": rids})
        if r.status_code != 200:
            raise RuntimeError(f"引用顺序登记失败 HTTP {r.status_code} {r.text[:160]}")

    def renumber(self, pid: str) -> dict:
        r = self.c.post(f"/api/projects/{pid}/word/renumber-citations",
                        json={"style": "gb-t-7714-2015"})
        if r.status_code != 200:
            raise RuntimeError(f"renumber-citations HTTP {r.status_code} {r.text[:200]}")
        return r.json()


def forcesave_and_confirm(api: Api, pid: str, steps: list, budget_s: float,
                          attempts: int = 3) -> dict:
    """与前端 saveWordAndWait 同口径：request_id → 轮询 last_saved_request_id。"""
    deadline = time.monotonic() + min(budget_s, 120)
    for attempt in range(1, attempts + 1):
        st, body = api.save(pid)
        steps.append(f"POST word/save #{attempt} → HTTP {st} {str(body)[:120]}")
        rid = body.get("request_id") if isinstance(body, dict) else None
        if st == 200 and rid:
            while time.monotonic() < deadline:
                state = api.state(pid)
                if state.get("last_error"):
                    raise RuntimeError(f"保存回传失败：{state['last_error']}")
                if not state.get("saving") and state.get("last_saved_request_id") == rid:
                    steps.append(f"保存确认：version={state.get('version')} sha={str(state.get('sha'))[:12]}")
                    return state
                time.sleep(0.75)
        elif st == 409:
            time.sleep(3)  # NotModified：DS 尚未受理新保存任务，短等重试
            continue
        else:
            raise RuntimeError(f"forcesave 受理失败 HTTP {st} {str(body)[:160]}")
    raise RuntimeError("保存确认超时：未收到带本次 request_id 的成功回调")


def pw_ms(seconds_cap: float, budget_s: float) -> int:
    """playwright timeout 单位是毫秒：cap 与剩余预算取小后转 ms。"""
    return int(min(seconds_cap, max(budget_s, 1.0)) * 1000)


def unzip_docx(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {name: z.read(name) for name in z.namelist()}


def citation_fixture_docx() -> bytes:
    """含乱序引用 [2]/[1] 与完整托管参考文献块的最小 DOCX（stdlib 手写 OOXML，与 e2e_suite 同款）。

    正文两段分别引用 [2]、[1]（首现序倒挂）；托管块头尾标记 + 两条占位条目——
    renumber-citations 按文献库重建后占位文本被替换为 GB/T 条目，供下载断言重建顺序。"""
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        "<w:p><w:r><w:t>引言部分引用了先前工作[2]。</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>方法部分沿用文献[1]。</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>[参考文献-平台生成]</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>[1] 占位条目甲（冒烟占位文本）</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>[2] 占位条目乙（冒烟占位文本）</w:t></w:r></w:p>"
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


# ---------------------------------------------------------------- 浏览器公共步骤 ----

def open_word_page(page, api: Api, base: str, pid: str, budget_s: float) -> dict:
    """种子 cookie → 打开 #/p/<pid>（平台从 editor-config 组装 DS 编辑器）→ 等就绪。"""
    page.context.add_cookies(
        [{"name": "studio_session", "value": api.session_cookie(), "url": base}])
    page.goto(f"{base}/#/p/{pid}", wait_until="domcontentloaded")
    page.wait_for_selector('[data-testid="word-workbench"]', timeout=pw_ms(60, budget_s))
    # 平台 onDocumentReady 才摘掉 word-loading 覆盖层（phase=ready 的唯一来源）
    page.wait_for_selector('[data-testid="word-loading"]', state="detached",
                           timeout=pw_ms(120, budget_s))
    editor = next((f for f in page.frames
                   if re.search(r"web-apps/apps/documenteditor/main", f.url)), None)
    if editor is None:
        raise RuntimeError("DS 编辑器 iframe 未出现")
    return {"page": page, "editor": editor}


def dom_snapshot(page) -> dict:
    """失败诊断用的 DOM 摘要（frames / 平台覆盖层 / 控制台错误尾）。"""
    info: dict = {"url": page.url[:160], "frames": []}
    try:
        info["frames"] = [{"name": f.name, "url": f.url[:140]} for f in page.frames]
        info["body_tail"] = page.evaluate(
            "() => (document.body.innerText || '').slice(0, 300)")
    except Exception as e:
        info["eval_error"] = str(e)[:120]
    return info


def safe_screenshot(page, path: Path, steps: list) -> str:
    """截图偶发挂起：限时 8s，失败只记步骤不炸链。"""
    try:
        page.screenshot(path=str(path), timeout=8000)
        steps.append(f"诊断截图已存 {path.name}")
        return str(path)
    except Exception as e:
        steps.append(f"诊断截图失败（忽略）：{str(e)[:120]}")
        return ""


def open_plugin_panel(page, editor, button_text: str, probe_js: str, ready_fn,
                      budget_s: float, steps: list):
    """点「插件」页签 → 点插件按钮 → 等 pluginFrameEditor 面板就绪。"""
    editor.locator("a#plugins").click(timeout=pw_ms(15, budget_s))
    page.wait_for_timeout(600)
    editor.locator("button.btn-toolbar", has_text=button_text).first.click(
        timeout=pw_ms(15, budget_s))
    panel = None
    deadline = time.monotonic() + min(30, budget_s)
    while time.monotonic() < deadline and panel is None:
        panel = next((f for f in page.frames if f.name == "pluginFrameEditor"), None)
        if panel is None:
            time.sleep(0.3)
    if panel is None:
        raise RuntimeError(f"插件面板 iframe（pluginFrameEditor）未出现：{button_text}")
    deadline = time.monotonic() + min(60, budget_s)
    info: dict = {}
    while time.monotonic() < deadline:
        try:
            info = panel.evaluate(probe_js)
        except Exception:
            info = {}  # src 从 about:blank 切到插件 URL 期间 evaluate 可能失败
        if ready_fn(info):
            steps.append(f"插件面板就绪：{json.dumps(info, ensure_ascii=False)[:200]}")
            return panel
        time.sleep(0.5)
    raise RuntimeError(f"插件面板未就绪（60s）：{json.dumps(info, ensure_ascii=False)[:300]}")


# ---------------------------------------------------------------- 三条冒烟链 ----

def chain_editor_opens(ctx, api: Api, base: str, ts: str, budget_s: float,
                       shots: list) -> tuple[str, str, list, dict]:
    steps: list = []
    email = f"e2e-smoke-{ts}-editor@e2e.example.com"
    st = api.register(email)
    if st not in (200, 201):
        raise RuntimeError(f"注册失败 HTTP {st}")
    st = api.login(email)
    if st != 204:
        raise RuntimeError(f"登录失败 HTTP {st}")
    steps.append(f"注册+登录（隔离账号）{email}")

    pid = api.create_word_project(f"浏览器冒烟 editor-opens {ts}")
    steps.append(f"建原生 Word 项目 pid={pid}（source_format=docx）")

    ec = api.editor_config(pid)
    cfg = ec.get("config", {})
    ds_url = str(ec.get("document_server_url") or "")
    doc_key = (cfg.get("document") or {}).get("key", "")
    doc_url = (cfg.get("document") or {}).get("url", "")
    if not ds_url.startswith("http") or not doc_key or not doc_url.startswith("http"):
        raise RuntimeError(f"editor-config 结构异常 ds={ds_url[:48]} key={bool(doc_key)} doc={doc_url[:48]}")
    steps.append(f"editor-config：document_server_url={ds_url} doc_key={doc_key[:8]}…")

    page = ctx.new_page()
    got = open_word_page(page, api, base, pid, budget_s)
    editor = got["editor"]
    if not editor.url.startswith(ds_url):
        raise RuntimeError(f"DS 编辑器页面 URL 与 editor-config 不符：{editor.url[:100]} vs {ds_url}")
    steps.append(f"DS 编辑器 iframe 就绪：{editor.url[:110]}")

    editor.locator("a#plugins").wait_for(state="visible", timeout=pw_ms(20, budget_s))
    steps.append("DS 工具栏可见（「插件」页签 a#plugins）")
    page.close()
    return "pass", f"编辑器加载完成 pid={pid} ds={ds_url}", steps, {"pid": pid, "ds_url": ds_url}


def chain_formula_insert_save(ctx, api: Api, base: str, ts: str, budget_s: float,
                              shots: list) -> tuple[str, str, list, dict]:
    steps: list = []
    email = f"e2e-smoke-{ts}-formula@e2e.example.com"
    api.register(email)
    if api.login(email) != 204:
        raise RuntimeError("登录失败")
    pid = api.create_word_project(f"浏览器冒烟 formula {ts}")
    v_before = api.state(pid).get("version", 0)
    steps.append(f"隔离项目 pid={pid}（保存前 version={v_before}）")

    page = ctx.new_page()
    got = open_word_page(page, api, base, pid, budget_s)
    editor = got["editor"]

    panel = open_plugin_panel(
        page, editor, "LaTeX公式",
        """() => ({latex: !!document.getElementById('latex'),
                   status: document.getElementById('status')?.textContent})""",
        lambda i: bool(i.get("latex")),
        budget_s, steps)
    # 面板 DOM 出现即返回；真正可插入以 #submit 由 disabled→enabled 为准（下方等待）

    panel.locator("#latex").fill(FORMULA)
    enabled = False
    for wait_s in (8, 10):
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            if panel.evaluate("() => document.getElementById('submit').disabled") is False:
                enabled = True
                break
            time.sleep(0.4)
        if enabled:
            break
        # fill 的一次性 input 事件可能落在插件初始化窗口里：改逐键输入再等
        panel.locator("#latex").fill("")
        panel.locator("#latex").press_sequentially(FORMULA, delay=25)
    if not enabled:
        diag = panel.evaluate(
            """() => ({status: document.getElementById('status')?.textContent,
                       hint: document.getElementById('submit-hint')?.textContent,
                       previewError: document.getElementById('preview-error')?.textContent,
                       preview: document.getElementById('preview')?.textContent?.slice(0, 60)})""")
        raise RuntimeError(f"公式提交按钮始终未启用：{json.dumps(diag, ensure_ascii=False)}")
    steps.append(f"输入 {FORMULA}，提交按钮启用（独立公式·编号 (1) 靠右）")

    before_status = panel.evaluate("() => document.getElementById('status').textContent")
    panel.locator("#submit").click(timeout=pw_ms(10, budget_s))
    deadline = time.monotonic() + min(30, budget_s)
    after = {}
    while time.monotonic() < deadline:
        after = panel.evaluate(
            """() => ({t: document.getElementById('status').textContent,
                       lvl: document.getElementById('status').dataset.level})""")
        if "已插入" in str(after.get("t", "")) or after.get("lvl") == "error":
            break
        time.sleep(0.5)
    if after.get("lvl") == "error" or "已插入" not in str(after.get("t", "")):
        raise RuntimeError(f"公式插入未确认：{json.dumps(after, ensure_ascii=False)}（点击前状态：{before_status[:60]}）")
    steps.append(f"插件回执：{after.get('t')}")

    state = forcesave_and_confirm(api, pid, steps, budget_s)
    if not isinstance(state.get("version"), int) or state["version"] <= v_before:
        raise RuntimeError(f"版本未推进：{v_before} → {state.get('version')}")

    files = unzip_docx(api.download(pid))
    doc = files.get("word/document.xml", b"").decode("utf-8", "replace")
    omath = doc.count("<m:oMath")
    ssup = doc.count("<m:sSup")
    math_text = "".join(re.findall(r"<m:t[^>]*>([^<]*)</m:t>", doc))
    ok = (omath >= 1 and ssup >= 1 and "E=" in math_text and "mc" in math_text
          and "2" in math_text and "(1)" in doc)
    steps.append(f"document.xml：oMath={omath} sSup={ssup} m:t拼接={math_text[:40]!r} 含(1)={'(1)' in doc}")
    if not ok:
        raise RuntimeError(f"DOCX OMML 断言不通过（oMath={omath} sSup={ssup}）")
    page.close()
    return "pass", f"公式已插入并保存（version={state.get('version')}，oMath={omath} sSup={ssup}）", steps, {"pid": pid}


def chain_chart_insert_save(ctx, api: Api, base: str, ts: str, budget_s: float,
                            shots: list) -> tuple[str, str, list, dict]:
    steps: list = []
    email = f"e2e-smoke-{ts}-chart@e2e.example.com"
    api.register(email)
    if api.login(email) != 204:
        raise RuntimeError("登录失败")
    pid = api.create_word_project(f"浏览器冒烟 chart {ts}")
    # payload 口径 = e2e_suite.py W6（charts/render + project-figures）
    chart = {"type": "line", "name": f"冒烟图表 {ts}", "title": "Accuracy", "x_label": "Epoch",
             "y_label": "Acc", "categories": ["1", "2", "3"],
             "series": [{"name": "ours", "values": [0.5, 0.7, 0.9]}]}
    fid = api.create_figure(pid, chart)
    steps.append(f"项目图表已入库 pid={pid} fid={fid}")

    page = ctx.new_page()
    got = open_word_page(page, api, base, pid, budget_s)
    editor = got["editor"]

    # 插图宏要求光标在「正文空白段落」：点画布（canvas 无 DOM 文本）→ Ctrl+End 到文末空段
    el = editor.frame_element()
    box = el.bounding_box()
    if not box:
        raise RuntimeError("拿不到 DS 编辑器 iframe 的页面坐标（无法放置光标）")
    page.mouse.click(box["x"] + box["width"] * 0.55, box["y"] + box["height"] * 0.35)
    page.wait_for_timeout(400)
    editor.locator("body").press("Control+End")
    page.wait_for_timeout(300)
    steps.append("光标已置于文末空白段落（画布点击 + Ctrl+End）")

    panel = open_plugin_panel(
        page, editor, "科研图表",
        """() => ({select: !!document.getElementById('charts-library-select'),
                   refreshDisabled: document.getElementById('charts-library-refresh')?.disabled,
                   status: document.getElementById('charts-library-status')?.textContent})""",
        lambda i: bool(i.get("select")) and i.get("refreshDisabled") is False,
        budget_s, steps)
    panel.locator("#charts-library-refresh").click(timeout=pw_ms(10, budget_s))
    deadline = time.monotonic() + min(20, budget_s)
    lib = {}
    while time.monotonic() < deadline:
        lib = panel.evaluate(
            "() => ({options: [...document.getElementById('charts-library-select').options].map(o => o.value),"
            "        status: document.getElementById('charts-library-status').textContent})")
        if fid in (lib.get("options") or []):
            break
        time.sleep(0.5)
    if fid not in (lib.get("options") or []):
        raise RuntimeError(f"图表库未见本图表 {fid}：{json.dumps(lib, ensure_ascii=False)[:200]}")
    steps.append(f"图表库刷新完成：{len(lib['options']) - 1} 张图，含 {fid}")

    panel.locator("#charts-library-select").select_option(fid)
    deadline = time.monotonic() + min(20, budget_s)
    while time.monotonic() < deadline:
        if panel.evaluate("() => document.getElementById('charts-library-insert').disabled") is False:
            break
        time.sleep(0.4)
    panel.locator("#charts-library-insert").click(timeout=pw_ms(10, budget_s))
    deadline = time.monotonic() + min(40, budget_s)
    after = {}
    while time.monotonic() < deadline:
        after = panel.evaluate(
            """() => ({t: document.getElementById('charts-library-status').textContent,
                       lvl: document.getElementById('charts-library-status').dataset.level})""")
        if "已插入" in str(after.get("t", "")) or after.get("lvl") == "error":
            break
        time.sleep(0.5)
    if "已插入" not in str(after.get("t", "")):
        raise RuntimeError(f"图表插入未确认：{json.dumps(after, ensure_ascii=False)}")
    steps.append(f"插件回执：{after.get('t')}")

    state = forcesave_and_confirm(api, pid, steps, budget_s)

    files = unzip_docx(api.download(pid))
    media = {n: files[n] for n in files if n.startswith("word/media/") and len(files[n]) > 0}
    png_ok = any(v[:8] == b"\x89PNG\r\n\x1a\n" for v in media.values())
    steps.append(f"DOCX media：{[(n, len(v)) for n, v in media.items()]} version={state.get('version')}")
    if not media or not png_ok:
        raise RuntimeError(f"word/media/ 无 PNG 图片：{list(media)}")
    page.close()
    return "pass", f"图表已插入并保存（version={state.get('version')}，media={list(media)}）", steps, {"pid": pid, "fid": fid}


def chain_diagram_editor_lazy(ctx, api: Api, base: str, ts: str, budget_s: float,
                              shots: list) -> tuple[str, str, list, dict]:
    """方法图编辑器 lazy chunk 冒烟：dashboard → 科研图表 → 新建方法图 → 编辑器容器挂载 → 关闭。

    不做画布内交互（excalidraw canvas 操作易碎），只守住「@excalidraw/* 按需 chunk 可加载、
    不进首包」这条包体边界。"""
    steps: list = []
    email = f"e2e-smoke-{ts}-diagram@e2e.example.com"
    api.register(email)
    if api.login(email) != 204:
        raise RuntimeError("登录失败")
    pid = api.create_word_project(f"冒烟方法图 {ts}")
    page = ctx.new_page()
    page.context.add_cookies(
        [{"name": "studio_session", "value": api.session_cookie(), "url": base}])
    page.goto(f"{base}/#/", wait_until="domcontentloaded")
    page.wait_for_selector('[data-testid="paper-dashboard"]', timeout=pw_ms(60, budget_s))
    steps.append("论文工作台已加载")
    page.get_by_role("button", name="科研图表").click(timeout=pw_ms(10, budget_s))
    page.wait_for_selector('[data-testid="scientific-figures"]', timeout=pw_ms(10, budget_s))
    steps.append("科研图表区已打开")
    page.select_option("#figures-project", pid)
    page.wait_for_selector('[data-testid="figures-new-diagram"]', timeout=pw_ms(10, budget_s))
    page.click('[data-testid="figures-new-diagram"]')
    # 编辑器为 React.lazy 拆包：容器出现即证明 excalidraw 依赖图按需加载成功
    page.wait_for_selector('[data-testid="diagram-editor-canvas"]', timeout=pw_ms(60, budget_s))
    steps.append("方法图编辑器已挂载（lazy chunk + excalidraw 依赖加载成功）")
    page.get_by_role("button", name="取消").click(timeout=pw_ms(10, budget_s))
    page.wait_for_selector('[data-testid="diagram-editor-canvas"]', state="detached",
                           timeout=pw_ms(10, budget_s))
    page.close()
    return "pass", "方法图编辑器按需加载与开关正常", steps, {"pid": pid}


def chain_word_upload_renumber(ctx, api: Api, base: str, ts: str, budget_s: float,
                               shots: list) -> tuple[str, str, list, dict]:
    """第 4 链（P1-2 / P1-0-B）：上传轮换 doc_key → 重开 → 引用重排再轮换 → 下载断言。

    口径：不对未改新文档强跑空 forcesave（DS 拒 409）；DS 打开就绪后直接 API 上传乱序
    引用 DOCX（[2]/[1] + 托管块标记），断言 doc_key 轮换，页面 reload 用新 doc_key 重新
    就绪；登记文献 + 引用顺序后 renumber-citations，再次轮换并重开；下载 DOCX 验证正文
    编号与托管文献表顺序一致（GB/T 渲染器按首现序重建）。"""
    steps: list = []
    email = f"e2e-smoke-{ts}-renum@e2e.example.com"
    api.register(email)
    if api.login(email) != 204:
        raise RuntimeError("登录失败")
    pid = api.create_word_project(f"浏览器冒烟 renumber {ts}")
    steps.append(f"隔离项目 pid={pid}")

    page = ctx.new_page()
    open_word_page(page, api, base, pid, budget_s)
    steps.append("DS 打开初始文档就绪（word-loading 已摘除）")
    old_key = api.state(pid).get("doc_key", "")

    st = api.upload_version(pid, citation_fixture_docx())
    if st != 200:
        raise RuntimeError(f"upload-version HTTP {st}")
    new_key = api.state(pid).get("doc_key", "")
    if not new_key or new_key == old_key:
        raise RuntimeError(f"upload-version 后 doc_key 未轮换：{old_key[:8]}… → {new_key[:8]}…")
    steps.append(f"upload-version 完成：doc_key 轮换 {old_key[:8]}… → {new_key[:8]}…")

    # 页面用新 doc_key 重新就绪：重走 open_word_page（重种子 cookie + goto + 等 word-loading 摘除）
    open_word_page(page, api, base, pid, budget_s)
    steps.append("页面用新 doc_key 重新就绪（新文档正常打开）")

    rids = api.commit_entries(pid, ts)
    api.register_citations(pid, rids)
    steps.append(f"文献登记 2 条并登记引用顺序（编号=表位）：{rids}")
    body = api.renumber(pid)
    if not body.get("changed"):
        raise RuntimeError(f"renumber-citations 未产生变化：{str(body)[:160]}")
    steps.append(f"renumber-citations changed=True mapping={body.get('mapping')}")
    renum_key = api.state(pid).get("doc_key", "")
    if not renum_key or renum_key == new_key:
        raise RuntimeError(f"renumber 后 doc_key 未轮换：{new_key[:8]}… → {renum_key[:8]}…")
    steps.append(f"renumber 后 doc_key 再次轮换 {new_key[:8]}… → {renum_key[:8]}…")

    # 重排后的权威文档浏览器仍能用最新 doc_key 打开（重开闭环）
    open_word_page(page, api, base, pid, budget_s)
    steps.append("重排后页面再次就绪（重开闭环）")

    files = unzip_docx(api.download(pid))
    doc = files.get("word/document.xml", b"").decode("utf-8", "replace")
    ok = ("引言部分引用了先前工作[1]。" in doc and "方法部分沿用文献[2]。" in doc
          and 0 <= doc.find("乙的扩展工作") < doc.find("甲的基础方法研究"))
    steps.append(f"document.xml：正文编号 [1]/[2] 已按首现序重写，"
                 f"文献表乙条目先于甲条目={0 <= doc.find('乙的扩展工作') < doc.find('甲的基础方法研究')}")
    if not ok:
        raise RuntimeError("下载 DOCX 断言不通过：正文编号或文献表顺序与预期不符")
    page.close()
    return "pass", f"上传轮换 + 重排回环通过（doc_key={renum_key[:8]}…）", steps, {"pid": pid}


# ---------------------------------------------------------------- 主流程 ----

def main() -> int:
    ap = argparse.ArgumentParser(description="研稿 · 浏览器冒烟（真实 ONLYOFFICE DS）")
    ap.add_argument("--base", default="http://127.0.0.1:8011", help="隔离栈平台地址")
    ap.add_argument("--out", default=str(REPORTS_DIR / "browser-smoke-report.json"),
                    help="JSON 报告输出路径")
    args = ap.parse_args()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%H%M%S")
    deadline = time.monotonic() + BUDGET_S
    chains: list[dict] = []
    findings: list[str] = []

    registry = [
        ("editor-opens", chain_editor_opens),
        ("formula-insert-save", chain_formula_insert_save),
        ("chart-insert-save", chain_chart_insert_save),
        ("word-upload-renumber", chain_word_upload_renumber),
        ("diagram-editor-lazy", chain_diagram_editor_lazy),
    ]

    def write_report(run_status: str, infra_error: dict | None = None) -> None:
        """唯一落盘点：running 占位 / completed / infra_error 全走这里，保证磁盘上永远是合法 JSON。"""
        passed = sum(1 for c in chains if c["status"] == "pass")
        report = {
            "schema": REPORT_SCHEMA,
            "base": args.base,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            # running=进行中占位；completed=链级判定完成；infra_error=浏览器基础设施崩溃
            "run_status": run_status,
            "summary": {"pass": passed, "fail": len(chains) - passed, "total": len(chains),
                        "duration_s": round(BUDGET_S - (deadline - time.monotonic()), 1)},
            "chains": chains,
            "failures": [c["name"] for c in chains if c["status"] != "pass"],
            "findings": findings,
        }
        if infra_error:
            report["infra_error"] = infra_error
            report["crash_reason"] = (f"{infra_error.get('stage')}：{infra_error.get('type')}："
                                      f"{infra_error.get('message')}")
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # 运行前先落 running 占位：进程被硬杀/断电时不会残留上一轮旧报告误导分诊
    write_report("running")

    stage = {"name": "playwright-start"}  # 崩溃归因：except 时读最近一次推进到的阶段
    infra_error: dict | None = None
    completed = False  # 仅 try 块正常走完才置 True——SystemExit/KeyboardInterrupt 不得伪装成 completed
    try:
        with sync_playwright() as p:
            stage["name"] = "chromium-launch"
            browser = p.chromium.launch()
            try:
                stage["name"] = "browser-context"
                ctx = browser.new_context(viewport={"width": 1600, "height": 900})
                stage["name"] = "smoke-chains"
                for name, fn in registry:
                    left = deadline - time.monotonic()
                    entry: dict = {"name": name, "status": "fail", "detail": "", "steps": []}
                    if left <= 30:
                        entry["detail"] = f"全局预算耗尽（剩 {left:.0f}s），本链未执行"
                        chains.append(entry)
                        continue
                    api = Api(args.base)
                    t0 = time.monotonic()
                    try:
                        status, detail, steps, extra = fn(ctx, api, args.base, ts, left, [])
                        entry.update(status=status, detail=detail, steps=steps, **extra)
                    except Exception as e:
                        # 失败必存诊断截图 + DOM 摘要（截图限时，防挂起）
                        shot_path = REPORTS_DIR / f"browser-smoke-{name}-{ts}.png"
                        shot = ""
                        try:
                            page = ctx.pages[-1] if ctx.pages else None
                            if page is not None:
                                shot = safe_screenshot(page, shot_path, entry["steps"])
                                entry["dom_summary"] = dom_snapshot(page)
                                page.close()
                        except Exception as de:
                            entry["steps"].append(f"诊断信息采集失败：{str(de)[:120]}")
                        entry["detail"] = f"{type(e).__name__}: {e}"
                        entry["duration_s"] = round(time.monotonic() - t0, 1)
                        if shot:
                            entry["screenshot"] = shot
                        # 失败归因：把证据同步进 findings（供人工判定是否产品缺陷）
                        findings.append(f"[{name}] {entry['detail']}")
                        chains.append(entry)
                        print(f"[FAIL] {name} — {entry['detail']}", file=sys.stderr)
                        continue
                    entry["duration_s"] = round(time.monotonic() - t0, 1)
                    chains.append(entry)
                    print(f"[PASS] {name} — {detail}")
                stage["name"] = "browser-close"
            finally:
                try:
                    browser.close()
                except Exception as ce:  # noqa: BLE001 — close 失败不影响链级结果，如实记入 findings
                    findings.append(f"[browser-close] {type(ce).__name__}: {str(ce)[:200]}")
        completed = True  # with 正常退出（浏览器生命周期全程无异常）才到得了这里
    except Exception as e:  # noqa: BLE001 — 链级业务失败已在循环内消化；走到这里即基础设施崩溃
        infra_error = {"stage": stage["name"], "type": type(e).__name__, "message": str(e)[:400]}
    except BaseException as e:  # SystemExit/KeyboardInterrupt 等：落盘 infra_error 后原样上抛（非零退出）
        infra_error = {"stage": stage["name"], "type": type(e).__name__, "message": str(e)[:400]}
        raise
    finally:
        write_report("completed" if completed else "infra_error", infra_error)

    passed = sum(1 for c in chains if c["status"] == "pass")
    failed = len(chains) - passed
    if infra_error:
        print(f"\n== 浏览器冒烟：基础设施崩溃（{infra_error['stage']}：{infra_error['type']}）"
              f"——发版闸门不通过 → {out_path}")
        return 1
    print(f"\n== 浏览器冒烟：{passed} 过 / {failed} 败 / 共 {len(chains)} 链 → {out_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
