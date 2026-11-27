import { BookOpen, Loader2, PenLine, Sparkles, Wand2, X } from 'lucide-react'
import { PROPOSAL_ACTION_LABELS, type ProposalAction } from '@/lib/api/paperProposals'

function QuickTaskCard({
  testid,
  chip,
  icon,
  title,
  desc,
  loading,
  disabled,
  onClick,
}: {
  testid: string
  chip: string
  icon: React.ReactNode
  title: string
  desc: string
  loading: boolean
  disabled: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      className="group rounded-lg border border-line bg-panel p-2.5 text-left shadow-sm transition-colors hover:border-border-strong hover:bg-hover disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      data-testid={testid}
    >
      <span className={`mb-1.5 grid size-7 place-items-center rounded-md ${chip}`}>
        {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      </span>
      <span className="block text-xs font-semibold leading-4 text-fg-strong">{title}</span>
      <span className="mt-1 block text-2xs leading-4 text-fg-muted">{desc}</span>
    </button>
  )
}

function ReadingOutput({
  reading,
  readingBusy,
  readingError,
  onStop,
  onClear,
}: {
  reading: { answer: string; model: string } | null
  readingBusy: boolean
  readingError: string
  onStop(): void
  onClear(): void
}) {
  if (!reading && !readingError) return null
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-line bg-panel shadow-sm" data-testid="assistant-reading">
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5 text-xs">
        <span className="grid size-4.5 place-items-center rounded bg-info-bg text-info-fg">
          <BookOpen aria-hidden className="size-3" />
        </span>
        <span className="font-semibold text-fg-strong">精读分析</span>
        {reading && <span className="text-2xs text-fg-muted">· {reading.model}</span>}
        {readingBusy && (
          <button
            type="button"
            className="ml-auto rounded border border-line px-1.5 py-0.5 text-2xs text-fg-muted hover:bg-hover hover:text-fg"
            onClick={onStop}
            data-testid="assistant-reading-stop"
          >
            停止
          </button>
        )}
        <button
          className={`${readingBusy ? 'ml-1' : 'ml-auto'} rounded p-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg`}
          onClick={onClear}
          aria-label="收起精读"
        >
          <X aria-hidden className="size-3" />
        </button>
      </div>
      {readingError && <div role="alert" className="px-2 py-1.5 text-xs text-danger">{readingError}</div>}
      {reading && <div className="max-h-72 overflow-auto whitespace-pre-wrap px-2.5 py-2 text-xs leading-5">{reading.answer || '思考中…'}</div>}
    </div>
  )
}

export function AssistantQuickActions({
  showHeroTitle,
  canEdit,
  busy,
  readingBusy,
  activeTask,
  hideSectionOption,
  reading,
  readingError,
  onRunReading,
  onStopReading,
  onStartWriting,
  onGenerate,
  onClearReading,
}: {
  showHeroTitle: boolean
  canEdit: boolean
  busy: boolean
  readingBusy: boolean
  activeTask: string | null
  hideSectionOption: boolean
  reading: { answer: string; model: string } | null
  readingError: string
  onRunReading: () => void
  onStopReading: () => void
  onStartWriting: () => void
  onGenerate: (action: ProposalAction) => void
  onClearReading: () => void
}) {
  return (
    <div className="shrink-0 border-b border-line px-2.5 pb-2.5 pt-2" data-testid="proposal-generate">
      {showHeroTitle && (
        <div className="mb-2 flex items-center justify-center gap-1.5 text-sm font-medium text-fg-strong" data-testid="assistant-hero-title">
          <Sparkles aria-hidden className="size-4 text-primary" />
          从一个快捷任务开始
        </div>
      )}
      <div className="grid grid-cols-2 gap-2" data-testid="assistant-hero">
        <QuickTaskCard
          testid="assistant-card-read"
          chip="bg-info-bg text-info-fg"
          icon={<BookOpen aria-hidden className="size-4" />}
          title="论文精读"
          desc="解读选中文段并给出分析建议"
          loading={activeTask === 'read'}
          disabled={busy || readingBusy}
          onClick={onRunReading}
        />
        <QuickTaskCard
          testid="assistant-card-writing"
          chip="bg-violet-bg text-violet-fg"
          icon={<PenLine aria-hidden className="size-4" />}
          title="论文写作"
          desc="起草段落或规划论证结构"
          loading={false}
          disabled={busy || !canEdit}
          onClick={onStartWriting}
        />
        <QuickTaskCard
          testid="assistant-card-polish"
          chip="bg-primary-soft text-primary"
          icon={<Sparkles aria-hidden className="size-4" />}
          title="论文润色"
          desc="润色选中文本，保留原意"
          loading={activeTask === 'polish'}
          disabled={busy || readingBusy}
          onClick={() => onGenerate('polish')}
        />
        <QuickTaskCard
          testid="assistant-card-deai"
          chip="bg-orange-bg text-orange-fg"
          icon={<Wand2 aria-hidden className="size-4" />}
          title="去 AI 味"
          desc="让选中的学术表达更自然"
          loading={activeTask === 'deai'}
          disabled={busy || readingBusy}
          onClick={() => onGenerate('deai')}
        />
      </div>
      {!hideSectionOption && (
        <div className="mt-1.5 space-y-1 px-0.5 text-2xs text-fg-muted">
          <div className="flex flex-wrap items-center gap-1">
            <span className="shrink-0">学术改写</span>
            {(['academic', 'condense', 'expand'] as ProposalAction[]).map((a) => (
              <button
                key={a}
                type="button"
                className="rounded px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:bg-hover hover:text-fg-strong disabled:opacity-50"
                disabled={busy || readingBusy}
                onClick={() => onGenerate(a)}
                data-testid={`proposal-gen-${a}`}
              >
                {activeTask === a && <Loader2 aria-hidden className="mr-0.5 inline size-3 animate-spin" />}
                {PROPOSAL_ACTION_LABELS[a]}
              </button>
            ))}
            <span className="mx-0.5 text-line">|</span>
            <span className="shrink-0">双语互译</span>
            {(['translate_en', 'translate_zh'] as ProposalAction[]).map((a) => (
              <button
                key={a}
                type="button"
                className="rounded px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:bg-hover hover:text-fg-strong disabled:opacity-50"
                disabled={busy || readingBusy}
                onClick={() => onGenerate(a)}
                data-testid={`proposal-gen-${a}`}
              >
                {activeTask === a && <Loader2 aria-hidden className="mr-0.5 inline size-3 animate-spin" />}
                {PROPOSAL_ACTION_LABELS[a]}
              </button>
            ))}
          </div>
        </div>
      )}
      <ReadingOutput
        reading={reading}
        readingBusy={readingBusy}
        readingError={readingError}
        onStop={onStopReading}
        onClear={onClearReading}
      />
    </div>
  )
}
