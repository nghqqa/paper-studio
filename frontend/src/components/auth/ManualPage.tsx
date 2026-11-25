import { ArrowLeft, BookOpen } from 'lucide-react'
import { BrandMark } from '@/components/auth/AuthFrame'
import { BRAND_NAME } from '@/lib/brand'

/**
 * 在线用户手册页（#/manual）：匿名与登录态均可达，落地页与工作空间页脚可直达。
 * 内容与 docs/user-manual.md 保持同步（对应线上 v1.0.7+）。
 */

const DOC_VERSION = 'v1.0.7'

const SECTIONS: { id: string; title: string; items: string[] }[] = [
  {
    id: 'overview',
    title: '1. 平台定位与五分钟上手',
    items: [
      '研稿（Paper Studio）是面向科研团队与高校师生的 Word + LaTeX 协同论文写作平台，将正文写作、编译预览、投稿检查、文献核验、回复信与审阅协作整合在同一个工作空间。',
      '1）登录或免注册体验：访问首页点击「免注册一键体验」即可直接进入演示工作区（或使用邮箱账号登录）。',
      '2）创建或打开项目：点击右上角「新建项目」，选择 Word 论文（中文期刊模板或上传 .docx）或 LaTeX 工程（空白/期刊模板/ZIP 导入），也可直接打开内置全功能演示论文。',
      '3）撰写与预览：LaTeX 支持左侧文件树与大纲导航、实时字数统计、查找替换、符号面板与右侧实时 PDF 预览；Word 支持 OnlyOffice 原生在线协同编辑、公式与分栏排版。',
      '4）导出与分享：LaTeX 支持「下载 PDF」与「导出 Word」；Word 支持导出「PDF」与「保存并下载 Word」；点击顶栏「分享」可邀请成员或生成免登录审阅链接。',
    ],
  },
  {
    id: 'projects',
    title: '2. 项目管理与投稿计划',
    items: [
      '列表与看板：支持表格列表与按写作阶段分列的看板视图；点击「列」可自定义显示写作阶段、负责人、投稿目标、学科领域、等级分区、投稿截止、标签与最后修改时间。',
      '检索与筛选：按 / 快捷键聚焦搜索框，支持按论文名称、投稿目标、学科领域、等级分区与标签快速过滤，并支持导出 CSV 项目清单。',
      '投稿计划：切换到顶部「投稿计划」自动按投稿截止日期排序，顶部高亮「已过截止」「7 天内截止」「待补投稿目标」关注条；编辑弹窗支持一键清除截止日期。',
    ],
  },
  {
    id: 'latex',
    title: '3. LaTeX 论文工作台',
    items: [
      '大纲与实时统计：左侧「大纲」自动解析 \\part / \\chapter / \\section / \\subsection 并点击跳行；编辑器头部实时显示中文字符数、英文词数、行数与保存状态。',
      '查找替换与符号：工具栏提供跨文件「搜索」、当前文件「查找替换」（Ctrl+F / Ctrl+H）与 124 个常用 LaTeX 符号面板，选中公式底部自动呈现 KaTeX 预览。',
      '编译与 SyncTeX：支持 xelatex / pdflatex 切换；编译报错时保留上次成功 PDF 并给出可点击跳行的诊断列表；支持源码与 PDF 双向定位。',
      '历史快照与 Git 同步：支持版本历史 Diff 对比与恢复，以及通过 HTTPS + PAT 令牌绑定远端 Git 仓库。',
    ],
  },
  {
    id: 'word',
    title: '4. Word 论文工作台',
    items: [
      '在线协同编辑：保留期刊模板页眉、分栏与可编辑数学公式，支持字数统计与修订跟踪。',
      '版本快照与导出：点击「保存」生成服务端版本，在「版本」抽屉可下载任意历史已保存 .docx，顶部支持一键导出 PDF 与保存并下载 Word。',
    ],
  },
  {
    id: 'library-preflight',
    title: '5. 文献核验、投稿体检与回复信',
    items: [
      '文献管理与真实性核验：支持 BibTeX / DOI / arXiv 导入与一键插入引用；点击「真实性核验」通过 Crossref / OpenAlex / arXiv 校验标题、作者与撤稿状态，防止 AI 幻觉。',
      '投稿前体检（Preflight）：LaTeX 支持 latex-general / double-blind，Word 支持 jcip-preflight 等规则集，自动检查未定义引用、占位符与格式规范。',
      '审稿回复信（Rebuttal）：支持审稿意见拆条管理、填写作者回复与修改位置，并一键导出 DOCX / TeX / MD 三种格式。',
    ],
  },
  {
    id: 'ai-collab',
    title: '6. AI 论文助手、科研图表与协作',
    items: [
      'AI 论文助手（提案制）：润色、扩写、去 AI 味等建议均以 Diff 提案呈现，经作者审阅采纳才写入正文；支持基于真实提案台账一键生成中英双语 AI 使用披露声明。',
      '科研图表：支持通过数据预览保存统计图表，以及使用 Excalidraw 画布（支持导入 Mermaid）绘制科研方法架构图。',
      '协同与权限：支持所有者、编辑者、审阅者（按行批注）、只读访客分级授权，以及可设置有效期和下载权限的免登录审阅链接。',
      '账户与 MCP 集成：在「账户」页（#/account）可修改资料、密码（#/account?tab=security）、配置个人 AI 接口及生成个人访问令牌（PAT）供外部智能体接入。',
    ],
  },
]

export function ManualPage() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh bg-app text-fg" data-testid="manual-page">
      <header className="sticky top-0 z-sticky border-b border-border bg-panel/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-4xl items-center justify-between px-4">
          <a href="#/" className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
            <BrandMark size="sm" className="size-6" />
            {BRAND_NAME}
          </a>
          <div className="flex items-center gap-4 text-xs">
            <a href="#/changelog" className="text-fg-muted hover:text-fg">
              更新日志
            </a>
            <a
              href="https://github.com/nghqqa/paper-studio/blob/main/docs/user-manual.md"
              target="_blank"
              rel="noreferrer"
              className="text-fg-muted hover:text-fg"
            >
              GitHub 原文
            </a>
            <a href="#/" className="inline-flex items-center gap-1 text-fg-muted hover:text-fg">
              <ArrowLeft className="size-3.5" aria-hidden />
              返回
            </a>
          </div>
        </div>
      </header>
      <article className="mx-auto max-w-4xl px-4 py-10">
        <div className="flex items-center gap-2.5">
          <BookOpen className="size-6 text-primary" aria-hidden />
          <h1 className="text-2xl font-semibold text-fg-strong">研稿（Paper Studio）用户手册</h1>
        </div>
        <p className="mt-2 text-xs text-fg-muted">适用版本 {DOC_VERSION} · Word + LaTeX 协同论文写作平台</p>
        <nav aria-label="手册目录" className="mt-5 flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#manual-${s.id}`}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(`manual-${s.id}`)?.scrollIntoView({ behavior: 'smooth' })
              }}
              className="rounded-md border border-border bg-panel px-2.5 py-1 text-xs text-fg-muted hover:text-fg"
            >
              {s.title}
            </a>
          ))}
        </nav>
        <div className="mt-8 space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.id} id={`manual-${s.id}`} className="scroll-mt-16 rounded-xl border border-border bg-panel p-5">
              <h2 className="text-base font-semibold text-fg-strong">{s.title}</h2>
              <ul className="mt-3 space-y-2">
                {s.items.map((p, i) => (
                  <li key={i} className="text-sm leading-7 text-fg-muted">
                    {p}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-10 border-t border-border pt-4 text-xs text-fg-muted">
          完整 Markdown 版本同步维护于仓库 <code className="font-mono">docs/user-manual.md</code>。
        </p>
      </article>
    </main>
  )
}
