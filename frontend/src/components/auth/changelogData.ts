import type { BadgeTone } from '@/components/ui/badge'

export type ChangeCategory = 'feature' | 'improvement' | 'fix'

export interface ChangeItem {
  category: ChangeCategory
  text: string
}

export interface ReleaseEntry {
  id: string
  version: string
  date: string
  title: string
  summary: string
  badge?: string
  changes: ChangeItem[]
}

export const CHANGE_CATEGORY_META: Record<ChangeCategory, { label: string; tone: BadgeTone }> = {
  feature: { label: '新功能', tone: 'brand' },
  improvement: { label: '体验优化', tone: 'info' },
  fix: { label: '问题修复', tone: 'ok' },
}

export const LATEST_RELEASE_VERSION = 'v1.4.1'

/**
 * 面向科研用户的版本演进记录（按发布时间倒序）。
 */
export const CHANGELOG_RELEASES: ReleaseEntry[] = [
  {
    id: 'v1.4.1',
    version: 'v1.4.1',
    date: '2026-11-27',
    title: '全链路安全加固、流式配额结算与工作台稳定性修复',
    summary: '针对 v1.4.0 开展全面代码复审，修复认证与归档边界、AI 流式配额与并发竞争、LaTeX/Word 工作台交互及跨模块数据一致性等系列问题。',
    badge: '最新',
    changes: [
      { category: 'fix', text: '修复 AI SSE 流式请求的组织配额延迟结算、流连接关闭与异常处理，隔离章节改写与 Rebuttal 草稿多路并发流状态。' },
      { category: 'fix', text: '加固 OIDC 邮箱验证与 state Cookie 绑定、PAT 路由与作用域边界、MCP Server 请求校验及便携归档 .zip/管理端 SQLite 热备安全检查。' },
      { category: 'fix', text: '修复投稿日历与在线协同头像请求路径、SSE 中断清理、鉴权保护下的文件下载及 OIDC 登录后前端引导状态同步。' },
      { category: 'fix', text: '修复 Word 版本恢复重载与 Diff 竞态，以及 LaTeX 冲突对比、标签页状态、术语悬停与跨文件体检跳转、共享资产、PDF 阅读器及科研图表等边界问题。' },
    ],
  },
  {
    id: 'v1.4.0',
    version: 'v1.4.0',
    date: '2026-11-27',
    title: '全链路 AI 流式协同、MCP 接入与科研生产力大版本',
    summary: '围绕科研写作全生命周期上线流式 AI 助手与跨多轮微调、项目术语/符号一致性体系、文献 PDF 归档与分栏阅读器、PAT + 原生 MCP Server、跨项目资产库、截稿月历与 .ics 订阅、10 类科研图表及 Vision 识图还原、OIDC 单点登录、便携整档迁移与中英双语界面。',
    changes: [
      { category: 'feature', text: 'AI 助手支持 SSE 实时流式生成、中英学术互译（translate_en/zh）、基于上轮建议的多轮微调（refine）、文献精读问答流与审稿回复信流式起草，并新增 Citation-Aware 真实文献卡片引用注入。' },
      { category: 'feature', text: '新增项目术语表与符号规范（Glossary & Notation）：支持从 .tex 自动扫描缩略语与自定义宏、投稿体检一致性拦截及编辑器自动补全/悬停定义；文献库新增 PDF 原文归档与对照分栏阅读器。' },
      { category: 'feature', text: '开放个人访问令牌（PAT）与原生 MCP Server（POST /api/mcp JSON-RPC 2.0），严格遵循 Proposal-Only 安全契约（外部智能体改写提案仅进人工 Diff 队列）；新增跨项目共享文献库与 LaTeX 常用片段库。' },
      { category: 'feature', text: '外部审阅批注支持一键转为待办 Issue 或纳入审稿回复信，公开审阅链接支持查看脱敏版本差异摘要；投稿计划上线截稿月历、RFC 5545 .ics 导出及站内截稿提醒，编辑器顶栏展示轻量协同在线头像。' },
      { category: 'feature', text: '科研图表扩展雷达图、小提琴图、森林图与水平分组柱状图（共 10 类），新增多模态 Vision 图片识别数据一键还原；支持企业 OIDC / OAuth 2.0 单点登录、便携项目整档 .zip 导出导入、管理员数据健康体检/SQLite 热备及轻量中英双语界面切换。' },
      { category: 'improvement', text: 'LaTeX 工作台新增 Ctrl+/ 注释切换、环境折叠、全工程字数统计、已打开 Tab 栏、Ctrl+P 快速切文件、可拖拽侧栏及 409 冲突对比合并弹窗；Word 工作台新增里程碑标签、段落级 Diff、非破坏式版本恢复与返修包 ZIP，看板支持跨阶段拖拽调整。' },
    ],
  },
  {
    id: 'v1.3.0',
    version: 'v1.3.0',
    date: '2026-11-26',
    title: 'LaTeX 沉浸式编辑增强、投稿与返修闭环及科研图表升级',
    summary: '全面升级 LaTeX 实时公式/悬停/行内诊断与插图流，补齐干净投稿源码打包、投稿就绪度体检与返修三件套一键打包，并支持 PDF 文献拖拽自动抽取与科研热力图/箱线图矢量发布。',
    changes: [
      { category: 'feature', text: 'LaTeX 编辑器支持剪贴板粘贴/拖放/工具栏上传插图，光标进入数学环境即触发 KaTeX 实时预览，新增 Ctrl/Cmd+B/I 快捷键、\\cite/\\ref/\\includegraphics 悬停预览及行内编译诊断波浪线与 AI 修复提案入口。' },
      { category: 'feature', text: '新增「投稿打包」干净源码 ZIP 导出（安全移除 % 注释且保留 \\% 与代码环境、自动附带 .bbl、裁剪未引用图片与 50 MB 体积预警）及历史面板「返修包」三件套打包（终稿 PDF + 高亮 Diff PDF + 多格式回复信）。' },
      { category: 'feature', text: '投稿前检查新增未使用图片/图表标签与缩略语连字符一致性规则，并上线「投稿就绪度体检」规则集（核对 PDF 页数与新鲜度、.bbl 就绪度及未引用文献）。' },
      { category: 'feature', text: '文献库支持直接上传/拖拽论文 PDF 自动抽取 DOI / arXiv / 标题并联网补全题录；科研图表新增热力图（heatmap）、箱线图（boxplot）、误差棒（errors）、数值标注及矢量 PDF 发布到 LaTeX。' },
      { category: 'fix', text: '补齐工作台 KaTeX 样式表消除公式重复文本，修复 \\ref 悬停跨块误匹配、插图/打包弹窗响应式尺寸与跨平台 Matplotlib 中文字体回落问题。' },
    ],
  },
  {
    id: 'v1.2.2',
    version: 'v1.2.2',
    date: '2026-11-26',
    title: '架构精简、PDF 预览器与后端路由模块化',
    summary: '下线早期实验性结构化写作遗留模块并移除冗余依赖，将 LaTeX PDF 预览器与核心后端模块拆解为独立子模块，进一步提升可维护性与接口权限一致性。',
    changes: [
      { category: 'improvement', text: '下线默认关闭的早期实验性结构化写作模块及 ProseMirror 冗余依赖，进一步收口纯学术 LaTeX / Word 双主线。' },
      { category: 'improvement', text: '拆解 LaTeX PDF 预览器、文献管理路由、LaTeX 路由与 Word 导出后处理模块，降低单文件复杂度并保持接口与交互零破坏。' },
      { category: 'fix', text: '修复路由拆分后子路由前缀在权限矩阵匹配中的边界问题，确保全部受保护接口权限校验一致生效。' },
    ],
  },
  {
    id: 'v1.2.1',
    version: 'v1.2.1',
    date: '2026-11-25',
    title: 'Word 编辑器加载稳定性与 LaTeX 侧栏排版优化',
    summary: '优化 ONLYOFFICE 静态资源命中与冷加载超时容错，拓宽 LaTeX 工作台左侧栏以完整展示全部功能页签。',
    changes: [
      { category: 'fix', text: '优化 Word 文档编辑器静态资源版本路由匹配与冷加载等待时长，消除服务重启后偶发打开超时问题。' },
      { category: 'improvement', text: '拓宽 LaTeX 左侧栏并精简页签布局，完整展示「文件 / 大纲 / Issues / 检查 / 历史 / 同步」6 个页签，消除底部横向滚动条。' },
    ],
  },
  {
    id: 'v1.2.0',
    version: 'v1.2.0',
    date: '2026-11-25',
    title: '科研写作效率套件、返修差异 PDF 与自托管治理升级',
    summary: '围绕科研投稿全链路新增三线表生成、命名里程碑与 latexdiff 返修高亮 PDF、300/600 DPI 与矢量科研图表导出、arXiv 预印本一键升级，以及公网注册管控与站内通知铃铛。',
    changes: [
      { category: 'feature', text: '新增公网自托管注册管控（支持开放注册 / 邀请码 / 关闭注册与高校邮箱域名白名单，支持环境变量预设与平台后台实时调整）。' },
      { category: 'feature', text: '工作空间顶栏上线轻量站内通知铃铛，实时提醒成员邀请、角色变更、批注 @ 提及与外部审阅确认定稿。' },
      { category: 'feature', text: 'LaTeX 历史面板支持命名版本里程碑（如「初稿投稿」「一审返修」）与 latexdiff 返修高亮 PDF 一键生成（红删蓝增对比当前工作区）。' },
      { category: 'feature', text: 'LaTeX 工具栏内置 CSV/TSV 三线表（booktabs）生成器，支持粘贴/上传数据及列最大/最小值自动加粗与下划线标注。' },
      { category: 'feature', text: '科研图表升级投稿级导出，支持 300/600 DPI 高清 PNG、矢量 PDF/SVG、学术/色盲友好/灰度配色方案及 CSV/TSV 数据粘贴导入。' },
      { category: 'feature', text: '文献库新增 arXiv 预印本「升级正式版」入口，自动检索正式发表 DOI 元数据并预览合并差异。' },
      { category: 'improvement', text: '同步更新在线用户手册（#/manual）至 v1.2.0，补齐各项新功能操作说明。' },
    ],
  },
  {
    id: 'v1.1.1',
    version: 'v1.1.1',
    date: '2026-11-25',
    title: '官网上线公开更新日志页面',
    summary: '官网新增公开可访问的更新日志页（#/changelog），支持按变更类型筛选与版本目录快速跳转，便于科研用户持续追踪功能迭代。',
    changes: [
      { category: 'feature', text: '新增公开更新日志页（#/changelog），匿名访客与已登录用户均可按时间倒序浏览版本演进与详情。' },
      { category: 'feature', text: '支持按「新功能 / 体验优化 / 问题修复」分类筛选条目，并提供版本目录快速定位锚点。' },
      { category: 'improvement', text: '官网顶栏、页脚与在线用户手册同步接入「更新日志」直达入口。' },
    ],
  },
  {
    id: 'v1.1.0',
    version: 'v1.1.0',
    date: '2026-11-25',
    title: '新版 LaTeX PDF 预览器与核心工作台重构',
    summary: '全面升级在线 PDF 阅读器交互体验，并完成前后端架构纯化与模块拆解，提升加载与渲染稳定性。',
    changes: [
      { category: 'feature', text: '升级 LaTeX PDF 预览器，优化缩放控制、全文检索、目录大纲与 SyncTeX 双向定位体验。' },
      { category: 'improvement', text: '完成 LaTeX 与 Word 核心工作台模块化拆解，精简前后端冗余依赖与部署镜像体积。' },
      { category: 'fix', text: '修复生产构建下编辑器样式模块偶发循环依赖导致的加载异常，提升工作台冷启动稳定性。' },
    ],
  },
  {
    id: 'v1.0.14-16',
    version: 'v1.0.14 – v1.0.16',
    date: '2026-11-24',
    title: '中文学位论文 LaTeX 转 Word 版式精修',
    summary: '持续打磨学位论文一键导出 Word 的封面字体、下划线占位、公式编号与分页表现。',
    changes: [
      { category: 'improvement', text: '完整映射学位论文封面黑体、楷体、仿宋与宋体字族，保留信息下划线、无框居中并自动隐藏封面页码。' },
      { category: 'improvement', text: '学术公式自动居中并采用右对齐编号；保留中英文双语摘要结构，并将参考文献对齐至正文章节末尾。' },
      { category: 'fix', text: '修复章节分节符在 Word 中产生多余空白页及页眉错位的问题。' },
    ],
  },
  {
    id: 'v1.0.10-12',
    version: 'v1.0.10 – v1.0.12',
    date: '2026-11-24',
    title: '中文硕博学位论文模板与按章编号支持',
    summary: '引入标准中文硕博学位论文多文件工程模板，同步升级跨文件大纲与按章编号导出。',
    changes: [
      { category: 'feature', text: '新增 cn_thesis 中文硕博学位论文多文件模板，支持 LuaLaTeX 编译引擎与 Biber 文献编译链路。' },
      { category: 'feature', text: 'LaTeX 大纲导航支持跨文件树状解析，自动展开与定位 \\input / \\include 子文件章节。' },
      { category: 'improvement', text: '导出 Word 支持多行公式拆行编号，以及「图 1-1 / 表 3-1 / (2-1)」按章独立编号。' },
    ],
  },
  {
    id: 'v1.0.8-9',
    version: 'v1.0.8 – v1.0.9',
    date: '2026-11-21 ~ 11-24',
    title: '在线用户手册与学术单栏 Word 导出',
    summary: '上线完整在线使用指南，并统一学术论文 Word 导出样式与引用格式体验。',
    changes: [
      { category: 'feature', text: '上线公开在线用户手册（#/manual），涵盖五分钟上手、工作台操作、文献核验、投稿体检与协作说明。' },
      { category: 'feature', text: '新增 A4 单栏标准学术论文模板与统一 Word 导出入口，自动识别中英文并默认应用 GB/T 7714 参考文献样式。' },
    ],
  },
  {
    id: 'v1.0.5-7',
    version: 'v1.0.5 – v1.0.7',
    date: '2026-11-21',
    title: 'LaTeX 写作效率与投稿计划增强',
    summary: '聚焦长文写作高频交互与多论文投稿排期管理。',
    changes: [
      { category: 'feature', text: 'LaTeX 左侧栏新增大纲视图（点击直达章节），编辑器顶栏实时显示中文字数、英文词数与行数。' },
      { category: 'improvement', text: '工具栏新增当前文件「查找替换」快捷入口；投稿计划视图按截止日期自动排序，并支持学科领域与等级列筛选。' },
      { category: 'fix', text: '修复项目编辑弹窗中无法一键清空投稿截止日期的问题。' },
    ],
  },
  {
    id: 'v1.0.1-4',
    version: 'v1.0.1 – v1.0.4',
    date: '2026-11-20',
    title: 'v1.0 开源正式版（GA）',
    summary: 'Paper Studio 面向科研团队正式开源发布，完善免登录体验、文献防幻觉核验与合规披露闭环。',
    changes: [
      { category: 'feature', text: '支持官网「免注册一键体验」与内置全功能演示论文，打开网页即可试用 Word 与 LaTeX 协同写作。' },
      { category: 'feature', text: '文献库上线「真实性核验」（基于 Crossref / OpenAlex / arXiv 校验标题、作者与撤稿状态）及 Word「一键引用」。' },
      { category: 'feature', text: '支持基于 AI 提案台账一键生成中英双语 AI 使用披露声明；管理员后台新增系统诊断面板（Doctor）。' },
      { category: 'improvement', text: '优化中文期刊投稿前体检规则与新手三步引导流程。' },
    ],
  },
  {
    id: 'v0.8.0-2',
    version: 'v0.8.0 – v0.8.2',
    date: '2026-11-17 ~ 11-18',
    title: '科研方法图、Zotero 同步与模板库管理',
    summary: '打通绘图、外部文献库与自定义期刊模板闭环，并对前端资源加载进行全面瘦身。',
    changes: [
      { category: 'feature', text: '集成 Excalidraw 科研方法图画布（支持导入 Mermaid 自动生成可编辑矢量图）与 Zotero 私有文献库同步。' },
      { category: 'feature', text: '扩展引文样式库（Springer LNCS / ACM / Elsevier / GB/T 7714）与多轮审稿回复信（Rebuttal）归档。' },
      { category: 'feature', text: '管理员后台支持上传自定义期刊或学位模板，并自动编译验收与生成封面缩略图。' },
      { category: 'improvement', text: '前端全面引入路由与编辑器按需懒加载，显著降低首屏资源下载体积。' },
    ],
  },
  {
    id: 'v0.6.0-7.1',
    version: 'v0.6.0 – v0.7.1',
    date: '2026-10-24 ~ 11-17',
    title: '协同论文写作核心闭环',
    summary: '确立 Word + LaTeX 双引擎协作基础，补全编译、检索、审阅与版本同步关键能力。',
    changes: [
      { category: 'feature', text: 'LaTeX 工作台上线 \\cite / \\ref 智能补全、跨文件搜索（Ctrl+Shift+F）、124 项 KaTeX 符号面板与版本历史 Diff/恢复。' },
      { category: 'feature', text: '支持运行中中止 LaTeX 编译，以及按项目绑定远端 Git 仓库（HTTPS + PAT）进行推拉同步。' },
      { category: 'feature', text: '新增 Word .docx 导入转为 LaTeX 工程、ONLYOFFICE 科研图表插入插件、投稿前体检与审稿回复信导出。' },
      { category: 'feature', text: '上线可配置有效期与下载权限的公开免登录 PDF 审阅链接，以及细粒度成员角色授权。' },
    ],
  },
]
