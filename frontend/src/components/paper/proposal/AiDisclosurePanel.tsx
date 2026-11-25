import { useCallback, useEffect, useState } from 'react'
import { Copy, Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type AiDisclosureResponse, type PaperProposal, paperProposalApi } from '@/lib/api/paperProposals'
import { cn } from '@/lib/utils'
import { errText } from './anchorUtils'

export function AiDisclosurePanel({
  pid,
  open,
  proposals,
  onClose,
  onError,
}: {
  pid: string
  open: boolean
  proposals: PaperProposal[] | null
  onClose: () => void
  onError: (msg: string) => void
}) {
  const [disclosureLang, setDisclosureLang] = useState<'zh' | 'en'>('zh')
  const [disclosureFmt, setDisclosureFmt] = useState<'markdown' | 'latex'>('markdown')
  const [disclosure, setDisclosure] = useState<AiDisclosureResponse | null>(null)
  const [disclosureBusy, setDisclosureBusy] = useState(false)
  const [disclosureCopied, setDisclosureCopied] = useState(false)

  const loadDisclosure = useCallback(
    async (lang: 'zh' | 'en', fmt: 'markdown' | 'latex') => {
      setDisclosureBusy(true)
      try {
        const r = await paperProposalApi.disclosure(pid, { lang, format: fmt })
        setDisclosure(r)
      } catch (e) {
        onError(errText(e))
      } finally {
        setDisclosureBusy(false)
      }
    },
    [pid, onError],
  )

  useEffect(() => {
    if (open) {
      void loadDisclosure(disclosureLang, disclosureFmt)
    }
  }, [open, disclosureLang, disclosureFmt, loadDisclosure, proposals])

  if (!open) return null

  return (
    <div className="shrink-0 border-b border-line bg-sunken/40 p-2.5 text-xs" data-testid="ai-disclosure-panel">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-fg-strong">AI 使用披露声明</span>
        <div className="inline-flex rounded border border-line bg-panel p-0.5">
          {(['zh', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setDisclosureLang(l)}
              className={cn('rounded px-1.5 py-0.5 text-2xs', disclosureLang === l ? 'bg-primary text-primary-fg' : 'text-fg-muted hover:text-fg')}
              data-testid={`ai-disclosure-lang-${l}`}
            >
              {l === 'zh' ? '中文' : 'English'}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded border border-line bg-panel p-0.5">
          {(['markdown', 'latex'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setDisclosureFmt(f)}
              className={cn('rounded px-1.5 py-0.5 text-2xs', disclosureFmt === f ? 'bg-primary text-primary-fg' : 'text-fg-muted hover:text-fg')}
              data-testid={`ai-disclosure-fmt-${f}`}
            >
              {f === 'markdown' ? 'Markdown' : 'LaTeX'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-fg-muted hover:bg-hover hover:text-fg"
          onClick={onClose}
          aria-label="关闭 AI 披露声明"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
      {disclosureBusy && !disclosure && <div className="mt-2 text-2xs text-fg-muted">汇总提案台账中…</div>}
      {disclosure && (
        <>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-2xs text-fg-muted">
            <span className="rounded border border-line bg-panel px-1.5 py-0.5">
              已采纳 {disclosure.summary.applied_count}/{disclosure.summary.total_proposals}
            </span>
            <span className="rounded border border-line bg-panel px-1.5 py-0.5">
              人工改写 {disclosure.summary.human_edited_count}
            </span>
            <span className="rounded border border-line bg-panel px-1.5 py-0.5">
              保护项复核 {disclosure.summary.protected_applied_count}
            </span>
          </div>
          <pre
            className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-line bg-panel p-2 font-mono text-2xs leading-4 text-fg"
            data-testid="ai-disclosure-content"
          >
            {disclosure.content}
          </pre>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(disclosure.content)
                setDisclosureCopied(true)
                setTimeout(() => setDisclosureCopied(false), 1800)
              }}
              data-testid="ai-disclosure-copy"
            >
              <Copy aria-hidden className="size-3" /> {disclosureCopied ? '已复制' : '复制声明'}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                const blob = new Blob([disclosure.content], { type: 'text/plain;charset=utf-8' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = disclosure.filename
                a.click()
                URL.revokeObjectURL(url)
              }}
              data-testid="ai-disclosure-download"
            >
              <Download aria-hidden className="size-3" /> 下载 {disclosure.filename}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
