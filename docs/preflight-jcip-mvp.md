# 中文信息学报投稿前检查 MVP（设计 + 验收矩阵）

状态：设计定稿，随实现提交。范围仅中文信息学报（jcip 模板）；只读报告，不改稿、不自动接受修订、不调外部 AI。

## 1. 背景与目标

- 现状：`GET/POST /api/projects/{pid}/preflight` 是专利线（37 条专利语义规则），`document_type=paper` 时**直接返回空报告**（w20 批 A1 注记：学术投稿检查属后续批次）——即审阅者指出的"返回空报告"缺口。
- 目标：对**已保存的 DOCX 快照**生成只读检查报告，报告绑定项目/保存版本/文件 SHA/规则集版本；文档更新后旧报告明确显示已过期。

## 2. 规则集 jcip-preflight v1（每条含 ID/版本/来源；无依据不设阈值）

规则集版本：`jcip-preflight/1`。来源统一为仓库内模板 `backend/app/word_templates/jcip/template.docx` 的实际文本（下表"依据"列引用其原文片段）；批注/修订两条为通用投稿规范（模板未明示），来源如实标注"通用投稿规范（模板未明示）"。

| rule_id | 检查 | 判定 | 依据（模板原文片段） |
| --- | --- | --- | --- |
| jcip-abstract-cn | 存在以「摘要：」开头的段落且非模板占位原文 | 无 → warn | 「摘要：中文摘要100-300字，用"该文"不用"本文"。…」 |
| jcip-keywords-cn | 存在以「关键词：」开头的段落且非占位 | 无 → warn | 「关键词：三个左右为宜，用分号；分开」 |
| jcip-abstract-en | 存在含「Abstract」的英文摘要段且非占位 | 无 → warn | 「Abstract :与中文文摘相对应，英文文摘应符合英文语法…」 |
| jcip-keywords-en | 存在含「Key words」或「Keywords」的段且非占位 | 无 → warn | 「Key words:三个左右为宜，用分号；分开  Key words五号」 |
| jcip-sections | 存在编号章节段（`^\d+\s+\S`，模板体例 0/1/1.1） | 无 → warn | 「0  标题一级标题小四黑体，引言、前言、概论等以"0"为章节编号」「1  标题」 |
| jcip-placeholder | 仍残留已知模板占位段（文章编号占位/中文标题题目三号/Author1 , author1,2/摘要占位/Abstract 占位/Key words 占位） | 有 → warn | 占位文本本身即模板原文 |
| jcip-revision | document.xml 存在 `w:ins`/`w:del` 修订标记 | 有 → warn | 通用投稿规范（模板未明示）——不在报告中猜测字数阈值类规则 |
| jcip-comment | word/comments.xml 存在批注 | 有 → warn | 通用投稿规范（模板未明示） |
| jcip-citation-integrity | 正文引用 `[n]`（出现顺序）与文献表条目（标记后/「参考文献」标题后 `^\[\d+\]` 段）比对：顺序标引破坏、引用缺失条目、条目缺号/重复/最大号>条目数 | 异常 → warn；无法定位文献表 → unknown | 「篇幅在10000字左右为宜，参考文献按文中出现顺序引用。[1] 参考文献顺序标引」 |

状态语义：`pass`（检测到应有内容且无异常）/ `warn`（缺失、异常、占位残留、存在修订/批注）/ `unknown`（无法判断：无文献表可定位、该子项解析失败）。**解析失败或部分不支持时，相关条目一律 unknown，顶层附 `parse_error`，绝不显示全部通过。**

## 3. 接口与存储

- `POST /api/projects/{pid}/word/preflight`（editor 权限）：
  - `word/state.saving == true` → 409「文档服务正在回传文件，请等保存完成后再运行检查」；
  - 读 `{project_dir}/document.docx`（当前已保存快照）→ 生成报告；
  - 报告结构：`{schema, project_id, version, sha256, ruleset_id, ruleset_version, generated_at, items:[{rule_id,status,evidence,source}], parse_error?}`；
  - 落盘 `{project_dir}/.studio/word/preflight-report.json`（只读检查本身不改 document.docx）；
  - DOCX 非法/解析失败 → HTTP 200 + 报告（items 全 unknown + parse_error），仅当文件不是合法 zip/pyx 结构到无法读出任何段落时 → 422。
- `GET /api/projects/{pid}/word/preflight`（editor 权限，与执行一致）：返回 `{report, expired, current:{version,sha256}, saving}`；`expired = 当前 sha256 != 报告.sha256 或 version != 报告.version`。无历史报告 → 404（前端显示"未运行"）。

## 4. 前端（Word 工作台）

- header 新增「投稿检查」按钮（与文献/论文助手同排，`sidePanel==='preflight'`）；`WordSidePanels` 新增 preflight 视图：
  - 打开面板即 GET 最近报告（404 显示"尚未运行"）；
  - 「运行检查」按钮（仅 canSave/editor 可见）→ POST → 渲染 items；
  - 每项：状态徽章（通过/告警/无法判断）+ rule_id + 证据片段 + 来源；
  - 顶部元信息：保存版本、文件 SHA 前缀、规则集版本；`expired=true` 时醒目提示"文档已更新，以下报告对应旧快照"；
  - saving=true 时按钮禁用并提示先完成保存。

## 5. 验收矩阵

| # | 场景 | 期望 |
| --- | --- | --- |
| V1 | 合格样稿（含摘要/关键词/Abstract/Key words/编号章节/顺序文献表） | 相关项 pass；无 warn |
| V2 | 缺英文摘要与英文关键词 | jcip-abstract-en / jcip-keywords-en = warn，其余 pass |
| V3 | 缺中文摘要/关键词 | 对应项 warn |
| V4 | 缺编号章节段 | jcip-sections = warn |
| V5 | 残留模板占位段 | jcip-placeholder = warn 并列出占位片段 |
| V6 | 含批注（word/comments.xml） | jcip-comment = warn |
| V7 | 含历史修订（w:ins/w:del） | jcip-revision = warn |
| V8 | 文献编号异常（引用 [1][3] 缺 [2]；顺序倒引） | jcip-citation-integrity = warn + 证据 |
| V9 | 无文献表可定位 | jcip-citation-integrity = unknown |
| V10 | 非法 DOCX（伪 zip） | 422 或 items 全 unknown + parse_error，绝不全 pass |
| V11 | 无权限账号（viewer） | POST/GET 均 403 |
| V12 | 保存中（saving=true） | POST 409 提示先完成保存 |
| V13 | 报告过期：检查后文档再保存（版本+SHA 变化） | GET 返回 expired=true，报告内容仍为旧快照结果 |
| V14 | 只读性：检查前后 document.docx 字节与 SHA 完全不变 | sha256 前后相等 |
| V15 | 真实 DS 完整流程（隔离栈）：编辑器打开→真实保存→POST 检查→下载 DOCX | 报告版本/SHA 与下载一致，字节不变 |
| V16 | 非中文信息学报项目（其他 docx） | 仍可运行（规则集固定 jcip，缺失项如实 warn）——MVP 边界，不做模板路由 |

## 6. 能力边界（MVP 不做）

- 不做字数阈值类检查（摘要"100-300字"等——占位文本虽提及，但实际稿的合规判断需语义理解，MVP 不猜阈值）；
- 不做图片/公式/基金脚注/中图分类号正确性检查；
- 不自动修改稿件、不自动接受修订；
- 不做模板版本管理与多期刊路由（后续批次）。
