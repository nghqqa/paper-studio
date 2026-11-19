import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { BRAND_FLOW, BRAND_NAME, brandCopyright } from '@/lib/brand'
import { cn } from '@/lib/utils'

/**
 * 匿名页外壳（S8 s8-login.html）：≥ md 两栏 —— 左品牌区 bg-sunken（logo · 产品名 · 一句价值 · 四步流程 · 白纸样张），右表单卡 max 400 r-xl sh-md bg-panel；
 * < md 单栏 —— 品牌区压成 120 高一行（logo 不隐藏），表单直接铺在 bg-app 上无卡。
 * 仅展示层；登录页 / 分享领取页共用。
 */
const FLOW = [...BRAND_FLOW]

export function BrandMark({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' }) {
  return (
    <img
      src="/logo-mark.svg"
      alt=""
      aria-hidden
      className={cn('shrink-0 rounded-md', size === 'md' ? 'size-8' : 'size-7 rounded-sm', className)}
    />
  )
}

function PaperSample() {
  return (
    <div aria-hidden className="mt-auto hidden overflow-hidden rounded-md bg-panel shadow-md lg:block">
      <div className="flex h-7 items-center gap-2 border-b border-border bg-app px-2.5 text-2xs text-fg-muted">
        <span className="size-1.5 rounded-full bg-ok-dot" />
        论文工作区 · Word / LaTeX
      </div>
      <div className="grid h-38 grid-cols-2">
        <pre className="m-0 overflow-hidden border-r border-border px-3 py-2.5 font-mono text-2xs leading-4 text-fg-muted">
          {'\\section{引言}\n研究问题、方法与实验结果。\n\n\\begin{equation}\n  E = mc^2\n  \\label{eq:energy}\n\\end{equation}'}
        </pre>
        <div className="flex items-center justify-center bg-paper-canvas">
          <div className="h-30 w-23 space-y-1 bg-paper p-2 text-paper-fg shadow-paper">
            <div className="mx-auto h-1 w-6 rounded-full bg-fg-subtle/40" />
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className={cn('h-0.5 rounded-full bg-fg-subtle/30', i % 4 === 3 ? 'w-2/3' : 'w-full')} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function AuthBrand() {
  return (
    <section aria-label="产品介绍" className="brand-hero flex flex-col border-b border-border px-4 py-3 md:border-r md:border-b-0 md:p-8">
      <div className="flex items-center gap-2 md:gap-2.5">
        <BrandMark size="sm" className="md:hidden" />
        <BrandMark className="max-md:hidden" />
        <span className="text-base font-semibold text-fg-strong">{BRAND_NAME}</span>
        <span className="text-xs text-fg-muted">· Paper Studio</span>
      </div>
      <p className="mt-1 text-xs text-fg-muted md:hidden">论文写作与审阅工作空间</p>
      <p className="mt-8 max-w-[26ch] text-2xl font-semibold text-fg-strong max-md:hidden">论文写作与审阅工作空间</p>
      <p className="mt-2 max-w-[44ch] text-base text-fg-muted max-md:hidden">
        中文期刊沿用 Word 模板，数学公式保持可编辑；LaTeX 工程保留源码与 PDF 编译预览。论文、投稿计划、协作批注与保存版本，收进同一个项目。
      </p>
      <ol className="mt-6 max-md:hidden">
        {FLOW.map((t, i) => (
          <li key={t} className="flex h-8 items-center gap-3 text-sm text-fg">
            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-panel text-2xs text-fg-muted tabular-nums shadow-sm">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
      <PaperSample />
      <p className="mt-6 flex items-center gap-1.5 text-xs text-fg-muted max-md:hidden">
        <ShieldCheck className="size-3.5" aria-hidden />
        支持私有化部署 · {brandCopyright()}
      </p>
    </section>
  )
}

export function AuthFrame({ children, ...props }: { children: ReactNode } & Omit<React.ComponentProps<'main'>, 'children'>) {
  return (
    <main {...props} className={cn('grid min-h-dvh grid-rows-[auto_1fr] bg-app md:grid-cols-2 md:grid-rows-1', props.className)}>
      <AuthBrand />
      <section className="flex items-start justify-center px-4 py-6 md:items-center md:p-6">
        <div className="w-full max-w-form-col md:rounded-xl md:bg-panel md:p-8 md:shadow-md">{children}</div>
      </section>
    </main>
  )
}
