import { useMemo, useState } from 'react'
import { BookMarked, CheckCheck, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { libraryApi, type LibraryEntry } from '@/lib/api/library'
import type { FixVerification } from '@/lib/api/paperProposals'
import { cn } from '@/lib/utils'
import { AiDisclosurePanel } from './proposal/AiDisclosurePanel'
import { type SelectionSnapshot } from './proposal/anchorUtils'
import { AssistantQuickActions } from './proposal/AssistantQuickActions'
import { InstructionBar } from './proposal/InstructionBar'
import { ProcessedProposalList } from './proposal/ProcessedProposalList'
import { ProposalCard } from './proposal/ProposalCard'
import { useProposalActions } from './proposal/useProposalActions'
import type { AnchorLike, ApplyOutcome } from './proposalApply'

export type { SelectionSnapshot }

interface Props {
  pid: string
  canEdit: boolean
  activePath: string | null
  dirty: boolean
  saving: boolean
  getSelection: () => SelectionSnapshot | null
  applyProposal: (anchor: AnchorLike, suggested: string) => ApplyOutcome | Promise<ApplyOutcome>
  revertProposal: (anchor: AnchorLike, appliedText: string) => ApplyOutcome | Promise<ApplyOutcome>
  locateProposal: (anchor: AnchorLike & { file: string }) => void
  reloadSignal?: number
  headerNote?: string
  mode?: 'latex' | 'word'
  hideSectionOption?: boolean
  verifyFix?: (proposalId: string) => Promise<FixVerification>
}

export function ProposalPanel({
  pid,
  canEdit,
  activePath,
  dirty,
  saving,
  getSelection,
  applyProposal,
  revertProposal,
  locateProposal,
  reloadSignal = 0,
  headerNote,
  mode = 'latex',
  hideSectionOption = false,
  verifyFix,
}: Props) {
  const [scopeAll, setScopeAll] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editedText, setEditedText] = useState('')
  const [bottomMode, setBottomMode] = useState<'custom' | 'writing'>('custom')
  const [writingFocus, setWritingFocus] = useState(0)
  const [disclosureOpen, setDisclosureOpen] = useState(false)
  const [useSection, setUseSection] = useState(false)
  const [useGlossary, setUseGlossary] = useState(false)
  const [citeKeys, setCiteKeys] = useState<string[]>([])
  const [citePickerOpen, setCitePickerOpen] = useState(false)
  const [libEntries, setLibEntries] = useState<LibraryEntry[] | null>(null)

  const toggleCitePicker = () => {
    const next = !citePickerOpen
    setCitePickerOpen(next)
    if (next && libEntries === null) {
      void libraryApi
        .get(pid)
        .then((r) => setLibEntries(r.entries))
        .catch(() => setLibEntries([]))
    }
  }

  const toggleCiteKey = (key: string) => {
    setCiteKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : prev.length < 6 ? [...prev, key] : prev,
    )
  }

  const act = useProposalActions({
    pid,
    activePath,
    reloadSignal,
    mode,
    getSelection,
    applyProposal,
    revertProposal,
    verifyFix,
  })

  const visible = useMemo(() => {
    const all = act.proposals ?? []
    return scopeAll ? all : all.filter((p) => p.anchor.file === activePath)
  }, [act.proposals, scopeAll, activePath])

  const pending = visible.filter((p) => p.status === 'pending')
  const processed = visible.filter((p) => ['applied', 'rejected', 'undone', 'stale', 'failed'].includes(p.status))

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="proposal-panel">
      <div className="flex h-panel-header shrink-0 items-center gap-2 border-b border-line bg-panel px-2.5 text-xs">
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-primary-soft text-primary">
          <Sparkles aria-hidden className="size-3" />
        </span>
        <span className="font-semibold text-fg-strong">论文助手</span>
        {pending.length > 0 && (
          <span className="rounded-full bg-primary-soft px-1.5 py-px text-2xs font-medium text-primary">
            {pending.length} 待审阅
          </span>
        )}
        <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={() => void act.refresh()} aria-label="刷新提案" data-testid="proposal-refresh">
          <RotateCcw aria-hidden className="size-3" />
        </Button>
      </div>
      {headerNote && (
        <div className="shrink-0 border-b border-line px-2.5 py-1.5 text-2xs leading-4 text-fg-muted">{headerNote}</div>
      )}

      <AssistantQuickActions
        showHeroTitle={pending.length === 0 && processed.length === 0}
        canEdit={canEdit}
        busy={act.busy}
        readingBusy={act.readingBusy}
        activeTask={act.activeTask}
        hideSectionOption={hideSectionOption}
        reading={act.reading}
        readingError={act.readingError}
        onRunReading={() => void act.runReading()}
        onStopReading={act.cancelReading}
        onStartWriting={() => {
          setBottomMode('writing')
          setWritingFocus((v) => v + 1)
        }}
        onGenerate={(a) => void act.generate(a, undefined, useSection, { useGlossary, citeKeys })}
        onClearReading={() => act.setReading(null)}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-2.5 py-1 text-2xs text-fg-muted">
        <label className="flex cursor-pointer items-center gap-1" title="勾选后注入项目术语与符号表约定">
          <input
            type="checkbox"
            className="accent-primary"
            checked={useGlossary}
            disabled={act.busy}
            onChange={(e) => setUseGlossary(e.target.checked)}
            data-testid="proposal-use-glossary"
          />
          遵循术语表
        </label>
        <button
          type="button"
          onClick={toggleCitePicker}
          className={cn(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs transition-colors',
            citeKeys.length > 0 ? 'border-primary/40 bg-primary/10 text-primary' : 'border-line bg-app text-fg-muted hover:text-fg',
          )}
          data-testid="proposal-cite-picker-toggle"
        >
          <BookMarked aria-hidden className="size-3" /> 引用文献 ({citeKeys.length}/6)
        </button>
      </div>
      {citePickerOpen && (
        <div className="max-h-32 shrink-0 overflow-auto border-b border-line bg-sunken p-2 text-2xs" data-testid="proposal-cite-picker">
          {libEntries === null ? (
            <span className="text-fg-muted">正在加载文献库…</span>
          ) : libEntries.length === 0 ? (
            <span className="text-fg-muted">当前项目文献库为空，请先在「文献」面板导入。</span>
          ) : (
            <ul className="space-y-1">
              {libEntries.slice(0, 30).map((e) => (
                <li key={e.reference_id}>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={citeKeys.includes(e.citation_key)}
                      onChange={() => toggleCiteKey(e.citation_key)}
                    />
                    <code className="font-mono text-primary">{e.citation_key}</code>
                    <span className="truncate text-fg-muted">{e.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {act.busy && act.streamingPreview !== null && (
        <div className="shrink-0 border-b border-line bg-sunken px-2.5 py-2 text-xs" data-testid="proposal-streaming">
          <div className="mb-1 flex items-center justify-between gap-2 text-2xs text-fg-muted">
            <span className="font-medium text-primary">AI 正在生成建议…</span>
            <button
              type="button"
              className="rounded border border-line bg-panel px-1.5 py-0.5 text-2xs text-fg-muted hover:bg-hover hover:text-fg"
              onClick={act.cancelGenerate}
              data-testid="proposal-stream-stop"
            >
              停止
            </button>
          </div>
          <div className="max-h-28 overflow-auto whitespace-pre-wrap text-xs leading-5 text-fg">
            {act.streamingPreview || '正在组织学术表述…'}
          </div>
        </div>
      )}

      {act.error && (
        <div role="alert" className="shrink-0 border-b border-line px-2.5 py-1.5 text-xs text-danger" data-testid="proposal-error">
          {act.error}
        </div>
      )}
      {act.notice && (
        <div role="status" className="shrink-0 border-b border-line px-2.5 py-1.5 text-xs text-fg-muted" data-testid="proposal-notice">
          {act.notice}
        </div>
      )}

      <div className="flex shrink-0 items-center border-b border-line px-2.5 py-1.5">
        <div className="inline-flex rounded-md bg-sunken p-0.5" role="group" aria-label="提案范围">
          <button
            type="button"
            className={cn('rounded-sm px-2 py-0.5 text-2xs transition-colors', !scopeAll ? 'bg-panel font-medium text-fg-strong shadow-sm' : 'text-fg-muted hover:text-fg')}
            onClick={() => setScopeAll(false)}
          >
            当前文件
          </button>
          <button
            type="button"
            className={cn('rounded-sm px-2 py-0.5 text-2xs transition-colors', scopeAll ? 'bg-panel font-medium text-fg-strong shadow-sm' : 'text-fg-muted hover:text-fg')}
            onClick={() => setScopeAll(true)}
          >
            全部文件
          </button>
        </div>
        {saving && <span className="ml-auto text-2xs text-fg-muted">保存中…</span>}
        {!saving && dirty && <span className="ml-auto text-2xs text-warning">待保存</span>}
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs transition-colors',
            !saving && !dirty ? 'ml-auto' : 'ml-2',
            disclosureOpen ? 'border-primary/40 bg-primary/10 font-medium text-primary' : 'border-line bg-panel text-fg-muted hover:text-fg-strong',
          )}
          onClick={() => setDisclosureOpen((v) => !v)}
          data-testid="ai-disclosure-btn"
          title="基于提案审计台账生成可投稿的 AI 使用披露声明"
        >
          <ShieldCheck aria-hidden className="size-3" /> AI 披露声明
        </button>
      </div>

      <AiDisclosurePanel
        pid={pid}
        open={disclosureOpen}
        proposals={act.proposals}
        onClose={() => setDisclosureOpen(false)}
        onError={act.setError}
      />

      <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="proposal-list">
        {act.proposals === null && <div className="p-2 text-xs text-fg-muted">加载中…</div>}
        {act.proposals !== null && pending.length === 0 && processed.length === 0 && (
          <div className="p-2 text-xs leading-5 text-fg-muted">
            暂无提案——在编辑器选中一段文字，点上方能力卡或底部输入指令生成。
            {dirty && '（当前文件有未保存修改，生成锚点以编辑器当前内容为准）'}
          </div>
        )}
        {pending.length > 1 && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-xs">
            <input
              type="checkbox"
              className="accent-primary"
              checked={act.batchSel.size === pending.length && act.batchSel.size > 0}
              onChange={(e) => act.setBatchSel(e.target.checked ? new Set(pending.map((p) => p.proposal_id)) : new Set())}
              aria-label="全选待审阅"
            />
            <span>
              全选（{act.batchSel.size}/{pending.length}）
            </span>
            <Button
              size="xs"
              className="ml-auto"
              disabled={act.busy || !canEdit || act.batchSel.size === 0}
              onClick={() => void act.doBatch(pending)}
              data-testid="proposal-batch"
            >
              <CheckCheck aria-hidden className="size-3" /> 批量采纳（自动跳过冲突）
            </Button>
          </div>
        )}
        <ul className="space-y-1.5">
          {pending.map((p) => (
            <ProposalCard
              key={p.proposal_id}
              p={p}
              expanded={act.expanded === p.proposal_id}
              onToggle={() => act.setExpanded(act.expanded === p.proposal_id ? null : p.proposal_id)}
              canEdit={canEdit}
              busy={act.busy}
              acked={act.protectedAck.has(p.proposal_id)}
              onAck={() => act.setProtectedAck((prev) => new Set(prev).add(p.proposal_id))}
              batchChecked={act.batchSel.has(p.proposal_id)}
              onBatchCheck={() =>
                act.setBatchSel((prev) => {
                  const next = new Set(prev)
                  if (next.has(p.proposal_id)) next.delete(p.proposal_id)
                  else next.add(p.proposal_id)
                  return next
                })
              }
              showBatch={pending.length > 1}
              onLocate={() =>
                locateProposal({
                  file: p.anchor.file,
                  original_text: p.anchor.original_text,
                  context_before: p.anchor.context_before,
                  context_after: p.anchor.context_after,
                })
              }
              onApply={() => void act.doApply(p)}
              onReject={() => void act.doReject(p)}
              onRefine={(inst) => void act.refine(p, inst)}
              editing={editingId === p.proposal_id}
              onStartEdit={() => {
                setEditingId(p.proposal_id)
                setEditedText(p.suggested_text)
              }}
              editedText={editedText}
              onEditedText={setEditedText}
              onCancelEdit={() => setEditingId(null)}
              onApplyEdited={() => {
                void act.doApply(p, editedText)
                setEditingId(null)
              }}
            />
          ))}
        </ul>
        <ProcessedProposalList
          processed={processed}
          canEdit={canEdit}
          mode={mode}
          verifyingId={act.verifyingId}
          hasVerifyFix={Boolean(verifyFix)}
          onUndo={(p) => void act.doUndo(p)}
          onVerify={(id) => void act.runVerify(id)}
        />
      </div>

      <InstructionBar
        busy={act.busy}
        canEdit={canEdit}
        mode={bottomMode}
        onMode={setBottomMode}
        focusSignal={writingFocus}
        section={
          !hideSectionOption ? (
            <label
              className="flex cursor-pointer items-center gap-1 text-2xs text-fg-muted"
              title="开启后，所有改写/互译动作将自动作用于光标所在章节（≤8000 字）"
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={useSection}
                disabled={act.busy}
                onChange={(e) => setUseSection(e.target.checked)}
                data-testid="proposal-gen-section"
              />
              作用于当前章节
            </label>
          ) : null
        }
        onSend={(text, m) => void act.generate(m === 'writing' ? 'writing' : 'custom', text, useSection, { useGlossary, citeKeys })}
      />
    </div>
  )
}
