import { useEffect, useState } from 'react'
import { ArrowRight, BookOpenCheck, CheckCircle2, FileText, GraduationCap, Landmark, Mail, MessageSquare, RefreshCw, Server, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/auth/AuthFrame'
import { BRAND_CAPABILITIES, BRAND_NAME_FULL, BRAND_TAGLINE, brandCopyright } from '@/lib/brand'
import { enterWorkspace } from '@/components/auth/session'
import { useStudio } from '@/store'
import paperLatexImg from '@/assets/lp/paper-latex.webp'
import paperWordImg from '@/assets/lp/paper-word.webp'
import paperProjectsImg from '@/assets/lp/paper-projects.webp'

/**
 * 产品落地页（anon 访客入口）：顶栏 + hero + 数字带 + 能力卡 + 深介栏 + 适用角色 + FAQ + 收尾 CTA + 页脚。
 * 登录态用户直接进工作台，#/login 深链仍直达登录框——本页只面向未登录访客。
 * 文案与截图反映论文项目、Word 模板、LaTeX 工程与科研图表能力。
 */

const FEATURE_ICONS = [FileText, BookOpenCheck, RefreshCw, MessageSquare, Users, Server]
const FEATURES = BRAND_CAPABILITIES.map((f, i) => ({ ...f, icon: FEATURE_ICONS[i] ?? FileText }))

const STATS = [
  ['一个项目', '正文 · 编译 · 批注 · 回复同处'],
  ['两种写作方式', 'Word 模板 · LaTeX 工程'],
  ['开源', 'Apache-2.0 可自托管'],
  ['原格式导出', 'Word 下载 DOCX · LaTeX 下载 PDF'],
]

const VIEW_POINTS = [
  '内置开源中文学术 Word 模板，并支持管理员上传任意期刊原件',
  'LaTeX 输入转换为可编辑的 Word 数学公式',
  '支持公式居中、编号靠右与文档保存版本',
  '下载标准 DOCX，保留正文、公式、页眉与分栏',
]

const REVIEW_POINTS = [
  '区分 Word 与 LaTeX，按项目查找和继续写作',
  '记录期刊、会议、学科与投稿截止日期',
  '为合作者分配编辑、审阅或只读权限',
  '归档已完成论文，回收站保留恢复入口',
]

const PERSONAS = [
  { icon: FileText, title: '学生 / 研究生', desc: '在熟悉的分栏里写作：自动保存与实时预览减少打断，编译错误直接定位到行' },
  { icon: GraduationCap, title: '导师', desc: '只读审阅不干扰写作：按行批注、查看学生回复，处理完成标记已解决' },
  { icon: Users, title: '科研团队', desc: '论文工程、编译产物与批注记录同处一个项目，本地部署数据自持' },
  { icon: Server, title: '自部署爱好者', desc: 'Apache-2.0 可自托管；编译与数据都在自己的机器上，不依赖外部服务' },
]

const FAQ = [
  ['研稿是做什么的？', '研稿面向科研团队，支持 Word 期刊模板、原生数学公式、LaTeX 源码与 PDF 预览，并统一管理论文项目、投稿计划和团队协作。'],
  ['哪些人适合用研稿？', '研究生、导师、个人作者与科研团队。作者负责写作和修订，合作者可按项目权限编辑、审阅或只读，共同完成投稿前的迭代。'],
  ['能保证论文录用吗？', '不能。研稿只提供写作、编译与批注协作工具，不构成学术评价或录用保证；论文质量与投稿决策由作者与导师把握。'],
  ['我的论文数据安全吗？', '论文与批注数据存于部署方自有存储，项目按成员角色授权。需要注意：编译在本机或部署方配置的引擎上完成，若启用远端服务，相关材料会发送到对应服务商——通道由部署方决定。'],
  ['支持哪些内容？', '可以导入 DOCX 或 LaTeX ZIP 工程，也可以选择内置中文学术 Word 模板、ACL、ICLR、IEEE 等 LaTeX 示例，并支持科研数据图表、方法图绘制、Zotero 文献库与多轮审稿回复管理。管理员可上传和管理团队模板。'],
]

function LoginLink() {
  return <a href="#/login" className="text-sm text-fg-muted hover:text-fg transition-colors">登录</a>
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-center text-xl font-semibold text-fg-strong md:text-2xl">{children}</h2>
}

export function LandingPage() {
  const siteContact = useStudio((s) => s.siteContact)
  const demoMode = useStudio((s) => s.demoMode)
  const [demoBusy, setDemoBusy] = useState(false)
  const contactEmail = siteContact.email || import.meta.env.VITE_CONTACT_EMAIL || ''
  const contactWechat = siteContact.wechat || ''
  const contactNote = siteContact.note || ''
  useEffect(() => {
    document.title = `${BRAND_NAME_FULL} — 论文写作与审阅工作空间`
  }, [])
  const onDemoEnter = async () => {
    setDemoBusy(true)
    try {
      const ok = await useStudio.getState().demoLogin()
      if (ok) await enterWorkspace('showcase-demo')
    } finally {
      setDemoBusy(false)
    }
  }
  return (
    <main className="min-h-dvh bg-app">
      {/* 顶栏 */}
      <header className="sticky top-0 z-sticky border-b border-border bg-panel/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-5xl items-center gap-2.5 px-4">
          <BrandMark size="sm" />
          <span className="text-sm font-semibold text-fg-strong">研稿</span>
          <span className="text-xs text-fg-muted max-sm:hidden">· Paper Studio</span>
          <nav className="ml-auto flex items-center gap-4">
            <a href="#features" className="text-sm text-fg-muted hover:text-fg transition-colors max-md:hidden">功能</a>
            <a href="#scenes" className="text-sm text-fg-muted hover:text-fg transition-colors max-md:hidden">场景</a>
            <a href="#faq" className="text-sm text-fg-muted hover:text-fg transition-colors max-md:hidden">FAQ</a>
            <a href="#/changelog" className="text-sm text-fg-muted hover:text-fg transition-colors max-md:hidden" data-testid="landing-nav-changelog">更新日志</a>
            <a href="https://github.com/nghqqa/paper-studio" target="_blank" rel="noreferrer" className="text-sm text-fg-muted hover:text-fg transition-colors max-sm:hidden">GitHub</a>
            <LoginLink />
            <Button asChild size="sm">
              <a href="#/login">进入工作台</a>
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="brand-hero border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-col items-center px-4 py-14 text-center md:py-20">
          <BrandMark className="size-12 rounded-lg shadow-md" />
          <h1 className="mt-5 text-balance text-3xl font-semibold text-fg-strong md:text-4xl">
            研稿 · Paper Studio
          </h1>
          <p className="mt-4 max-w-[56ch] text-base text-fg-muted md:text-lg">
            {BRAND_TAGLINE}。Word 沿用期刊模板，LaTeX 保留原生工程；公式、批注、投稿计划和保存版本都围绕同一篇论文管理。
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <a href="#/login">开始使用 <ArrowRight className="size-4" aria-hidden /></a>
            </Button>
            {demoMode && (
              <Button variant="secondary" size="lg" loading={demoBusy} loadingLabel="进入体验中…" onClick={() => void onDemoEnter()} data-testid="landing-demo-btn">
                <Sparkles className="size-4" aria-hidden /> 免注册一键体验
              </Button>
            )}
            <Button asChild variant="secondary" size="lg">
              <a href="#features">了解功能</a>
            </Button>
          </div>
          <p className="mt-3 text-xs text-fg-muted">开源自托管 · 自动化产出为辅助，最终内容由作者确认</p>
          <img
            src={paperLatexImg}
            alt="研稿 LaTeX 论文工作台：工程文件、源码和论文 PDF 预览"
            width={1280}
            height={720}
            className="mt-10 aspect-video w-full max-w-3xl rounded-xl border border-border/60 bg-panel shadow-md dark:ring-1 dark:ring-white/10 dark:shadow-2xl"
            loading="eager"
            fetchPriority="high"
            decoding="async"
          />
          <p className="mt-3 text-xs text-fg-muted">LaTeX 论文工作台 · 官方会议模板与 PDF 编译预览</p>
        </div>
      </section>

      {/* 数字带 */}
      <section className="border-b border-border">
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-6 px-4 py-10 text-center md:grid-cols-4">
          {STATS.map(([num, label]) => (
            <div key={label}>
              <div className="text-xl font-semibold text-fg-strong tabular-nums">{num}</div>
              <div className="mt-1 text-xs text-fg-muted">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 功能 */}
      <section id="features" className="mx-auto max-w-5xl scroll-mt-14 px-4 py-14 md:py-20">
        <SectionTitle>写作、编译、批注，一个项目收拢</SectionTitle>
        <p className="mx-auto mt-3 max-w-[60ch] text-center text-sm text-fg-muted">
          从打开示例工程到导师批注闭环——自动保存、实时预览、错误定位、草稿恢复环环相扣；少一次打断，多一段专注。
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-panel p-5 shadow-sm">
              <f.icon className="size-5 text-primary" aria-hidden />
              <h3 className="mt-3 text-sm font-semibold text-fg-strong">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-fg-muted">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 深介 A：实时编译 */}
      <section className="border-y border-border bg-sunken/50">
        <div className="mx-auto grid max-w-5xl items-center gap-8 px-4 py-14 md:grid-cols-2 md:py-18">
          <img
            src={paperWordImg}
            alt="研稿 Word 论文工作台：中文期刊模板与原生文档编辑"
            width={1280}
            height={720}
            className="aspect-video w-full rounded-xl border border-border/60 bg-panel shadow-sm dark:ring-1 dark:ring-white/10"
            loading="lazy"
            decoding="async"
          />
          <div>
            <h3 className="text-lg font-semibold text-fg-strong md:text-xl">熟悉的 Word，完整的期刊模板</h3>
            <p className="mt-2 text-sm leading-6 text-fg-muted">
              从期刊原件开始写作，公式、标题和分栏留在标准 DOCX 中。
            </p>
            <ul className="mt-4 space-y-2.5">
              {VIEW_POINTS.map((p) => (
                <li key={p} className="flex gap-2 text-sm leading-6 text-fg-muted">
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* 深介 B：批注闭环 */}
      <section>
        <div className="mx-auto grid max-w-5xl items-center gap-8 px-4 py-14 md:grid-cols-2 md:py-18">
          <div className="md:order-2">
            <img
              src={paperProjectsImg}
              alt="研稿论文项目列表：文档类型、所有者、投稿目标与截止日期"
              width={1280}
              height={720}
              className="aspect-video w-full rounded-xl border border-border/60 bg-panel shadow-sm dark:ring-1 dark:ring-white/10"
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="md:order-1">
            <h3 className="text-lg font-semibold text-fg-strong md:text-xl">论文与投稿计划，一处管理</h3>
            <p className="mt-2 text-sm leading-6 text-fg-muted">
              项目列表保留清楚的文档类型和投稿目标，团队可以继续写作、审阅并准备下一轮投稿。
            </p>
            <ul className="mt-4 space-y-2.5">
              {REVIEW_POINTS.map((p) => (
                <li key={p} className="flex gap-2 text-sm leading-6 text-fg-muted">
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* 角色场景 */}
      <section id="scenes" className="mx-auto max-w-5xl scroll-mt-14 px-4 py-14 md:py-20">
        <SectionTitle>写作与审阅，各归其位</SectionTitle>
        <p className="mx-auto mt-3 max-w-[60ch] text-center text-sm text-fg-muted">
          学生专注写作不被打断，导师只读审阅不惧误改；批注与回复让每一轮迭代有迹可循。
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PERSONAS.map((p) => (
            <div key={p.title} className="rounded-xl border border-border bg-panel p-5 text-center shadow-sm">
              <p.icon className="mx-auto size-6 text-primary" aria-hidden />
              <h3 className="mt-3 text-sm font-semibold text-fg-strong">{p.title}</h3>
              <p className="mt-1.5 text-xs leading-5 text-fg-muted">{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 合规/安全 */}
      <section className="border-y border-border bg-sunken/50">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 px-4 py-12 text-center md:flex-row md:text-left">
          <ShieldCheck className="size-10 shrink-0 text-primary" aria-hidden />
          <div>
            <h3 className="text-base font-semibold text-fg-strong">私有部署，边界清晰</h3>
            <p className="mt-1.5 max-w-[62ch] text-sm leading-6 text-fg-muted">
              论文、编译产物与批注记录留存在部署方自有存储；项目按成员角色授权、会话失效即收权。编译在本机或部署方配置的引擎上完成——数据边界由部署方掌控。
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-14 px-4 py-14 md:py-20">
        <SectionTitle>常见问题</SectionTitle>
        <div className="mt-8 space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group rounded-xl border border-border bg-panel px-5 py-4 shadow-sm">
              <summary className="cursor-pointer list-none text-sm font-semibold text-fg-strong marker:hidden [&::-webkit-details-marker]:hidden">
                <span className="inline-flex w-full items-center justify-between gap-3">
                  {q}
                  <ArrowRight className="size-4 shrink-0 rotate-90 text-fg-muted transition-transform group-open:-rotate-90" aria-hidden />
                </span>
              </summary>
              <p className="mt-3 text-sm leading-6 text-fg-muted">{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* 收尾 CTA */}
      <section className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col items-center px-4 py-14 text-center md:py-20">
          <GraduationCap className="size-8 text-primary" aria-hidden />
          <h2 className="mt-4 text-xl font-semibold text-fg-strong md:text-2xl">现在开始你的论文项目</h2>
          <p className="mt-3 max-w-[46ch] text-sm text-fg-muted">登录进入工作台，从内置示例工程开始写作与审阅。</p>
          <Button asChild size="lg" className="mt-6">
            <a href="#/login">进入工作台 <ArrowRight className="size-4" aria-hidden /></a>
          </Button>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-8 gap-y-3 px-4 py-6 text-xs text-fg-muted">
          <span className="flex items-center gap-2"><BrandMark size="sm" className="size-5" />{brandCopyright()}</span>
          <span className="flex items-center gap-5">
            <a href="#features" className="hover:text-fg transition-colors">功能</a>
            <a href="#scenes" className="hover:text-fg transition-colors">场景</a>
            <a href="#faq" className="hover:text-fg transition-colors">FAQ</a>
            <a href="#/manual" className="hover:text-fg transition-colors" data-testid="landing-manual">使用手册</a>
            <a href="#/changelog" className="hover:text-fg transition-colors" data-testid="landing-changelog">更新日志</a>
            <a href="#/login" className="hover:text-fg transition-colors">登录</a>
          </span>
          <span className="flex items-center gap-4">
            <a href="#/legal/terms" className="hover:text-fg transition-colors">用户协议</a>
            <a href="#/legal/privacy" className="hover:text-fg transition-colors">隐私政策</a>
            <a href="#/legal/copyright" className="hover:text-fg transition-colors">版权与免责声明</a>
          </span>
          <span className="flex flex-wrap items-center gap-4">
            <a href="https://github.com/nghqqa/paper-studio" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-fg transition-colors">GitHub</a>
            <a href="https://github.com/nghqqa/paper-studio/issues" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-fg transition-colors">反馈与讨论</a>
            {contactEmail && (
              <a href={`mailto:${contactEmail}`} className="flex items-center gap-1.5 hover:text-fg transition-colors"><Mail className="size-3.5" aria-hidden />{contactEmail}</a>
            )}
            {contactWechat && (
              <span className="flex items-center gap-1.5" title="微信号"><MessageSquare className="size-3.5" aria-hidden />微信 {contactWechat}</span>
            )}
            <span className="flex items-center gap-1.5"><Landmark className="size-3.5" aria-hidden />{contactNote || 'Apache-2.0 开源可自托管'}</span>
          </span>
        </div>
      </footer>
    </main>
  )
}
