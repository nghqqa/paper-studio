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

export const LATEST_RELEASE_VERSION = 'v1.1.1'

/**
 * 面向科研用户的版本演进记录（按发布时间倒序）。
 */
export const CHANGELOG_RELEASES: ReleaseEntry[] = [
  {
    id: 'v1.1.1',
    version: 'v1.1.1',
    date: '2026-11-25',
    title: '官网上线公开更新日志页面',
    summary: '官网新增公开可访问的更新日志页（#/changelog），支持按变更类型筛选与版本目录快速跳转，便于科研用户持续追踪功能迭代。',
    badge: '最新',
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
