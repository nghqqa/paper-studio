# 浏览器冒烟套件（browser_smoke.py）

Playwright（python sync API + chromium）驱动**真实 ONLYOFFICE DS 编辑器**，对隔离栈逐链冒烟。
只读产品代码、不改产品代码；发现链路失败证据指向产品缺陷时，证据记入报告 `findings` 并跳过该链。

## 用法

```bash
# 依赖（本机 Windows，一次即可）
backend/.venv/Scripts/python.exe -m pip install playwright -i https://pypi.org/simple
backend/.venv/Scripts/python.exe -m playwright install chromium

# 跑（被测 = 隔离栈，独立数据卷，可任意注册账号）
backend/.venv/Scripts/python.exe deploy/e2e/browser_smoke.py \
    --base http://127.0.0.1:8011 \
    --out  deploy/e2e/reports/browser-smoke-report.json
```

- 退出码：`0` = 全过；`1` = 有失败（含 Playwright/Chromium 崩溃等基础设施错误；含 8 分钟
  全局预算耗尽后未执行的链）。
- 报告：`--out` 指向 JSON（`chains` / `failures` / `findings`）；每链含逐步 `steps` 证据。
  崩溃也必有报告：运行前先落 `run_status: "running"` 占位（进程被硬杀不残留上一轮旧报告）；
  浏览器生命周期整体包在 try/except/finally 里，任何崩溃都强制落盘合法 JSON——
  `run_status: "infra_error"` + `infra_error.stage`（playwright-start / chromium-launch /
  browser-context / smoke-chains / browser-close）+ `crash_reason`，与链级业务失败
  （`run_status: "completed"`）明确区分。配套编排器分诊见 `run_e2e.py`
  `[冒烟-崩溃]` / `[冒烟-断言失败]` 前缀与兜底崩溃摘要（2026-11-16 第十二轮加固）。
- 失败必存诊断截图 `deploy/e2e/reports/browser-smoke-<链名>-<ts>.png` + `dom_summary`
  （frames 清单 / 页面文本尾 / DOM 摘要）。截图限时 8s，偶发挂起不拖垮整链。

## 覆盖链路

| # | 链名 | 内容 | 通过判据 |
|---|------|------|----------|
| 1 | `editor-opens` | 注册时间戳账号 → 建原生 Word 项目（`POST /api/projects/word/create`）→ 取 `editor-config` → 浏览器种 `studio_session` cookie 后打开平台工作台页 `#/p/<pid>`（平台用 editor-config 的 `document_server_url` 加载 DS api.js 并 `new DocEditor`） | `word-workbench` 出现、`word-loading` 覆盖层摘除（=DS `onDocumentReady`）、DS 编辑器 iframe 出现且 URL 以 editor-config 的 `document_server_url` 开头、工具栏「插件」页签 `a#plugins` 可见 |
| 2 | `formula-insert-save` | 打开「LaTeX公式」插件面板 → 输入 `E=mc^2#(1)`（独立公式·编号 (1) 靠右）→ 插件回执「已插入…」→ 平台 forcesave | 保存回执 `request_id` 与 `word/state.last_saved_request_id` 对上；下载 DOCX 后 `word/document.xml` 含 `m:oMath`≥1、`m:sSup`≥1，`m:t` 拼接含 `E=`/`mc`/`2`，且含编号 `(1)` |
| 3 | `chart-insert-save` | API 建项目图表（`POST /api/project-figures/{pid}`，payload 同 e2e_suite W6）→ 打开「科研图表」插件 → 图表库刷新/选择/插入 → 平台 forcesave | 保存回执同上；下载 DOCX 后 `word/media/` 出现非空 PNG（`\x89PNG` 魔数） |

## 已知自动化事实（脚本已按此实现）

- **DS 正文在 canvas 里，DOM 无文字**：正文断言一律「平台保存 → 下载 DOCX → 解包
  `word/document.xml`」，禁止对 canvas 断言文本。工具栏/页签/插件按钮是 DOM，可 locator。
- **iframe 很深**：编辑器=`frameEditor`；右侧插件面板复用同一个 `pluginFrameEditor`
  iframe，其 src 短暂为 `about:blank`——以「面板内元素出现 + 就绪状态」为准，不拼 URL。
- **插件就绪事件**：公式面板等 `#submit` 从 disabled→enabled（一次性 `fill` 的事件可能落在
  插件初始化窗口里，脚本会退化为逐键输入再等）；图表面板等 `#charts-library-refresh` 可用、
  `#charts-library-insert` 随选择启用。插入成功回执分别是
  「已插入可编辑的 Word 公式…」「图表已插入。请点击平台"保存"…」。
- **保存口径**（与前端 `saveWordAndWait` 一致）：`POST /api/projects/{pid}/word/save` 取
  `request_id`，轮询 `word/state` 直到 `saving=false && last_saved_request_id==request_id`；
  `409`（DS NotModified）短等后重试，最多 3 次。
- **图表面板插图前置条件**：光标必须在正文空白段落——脚本点画布后 `Ctrl+End` 到文末空段。

## 与 e2e_suite.py 的关系

`e2e_suite.py` 是 HTTP 级固化回归（不开浏览器）；本脚本是浏览器级冒烟，账号/建项/
editor-config/图表/forcesave 的接口口径与其 word/charts 阶段一致（`e2e-smoke-<ts>-<链>@e2e.example.com`、
`POST /api/projects/word/create`、`GET /api/projects/{pid}/word/editor-config`、
`POST /api/project-figures/{pid}`）。
