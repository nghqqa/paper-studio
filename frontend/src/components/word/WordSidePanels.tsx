import { BookA, BookOpen, Loader2, MessageSquareQuote, MessageSquareText, Plug, ShieldCheck, Sparkles, X } from 'lucide-react'
import { GlossaryPanel } from '@/components/paper/GlossaryPanel'
import { LibraryPanel, type CitationStyle } from '@/components/paper/LibraryPanel'
import { ProposalPanel } from '@/components/paper/ProposalPanel'
import { RebuttalPanel } from '@/components/rebuttal/RebuttalPanel'
import type { WordRenumberResult } from '@/lib/api/word'
import { compressCitationNumbers, mergeCitationBrackets } from './citationBrackets'
import { useWordRefsBridge } from './useWordRefsBridge'
import { WordCommentsPanel } from './WordCommentsPanel'
import { WordPreflightPanel } from './WordPreflightPanel'

export { compressCitationNumbers, mergeCitationBrackets }

type Tab = 'library' | 'glossary' | 'proposals' | 'preflight' | 'rebuttal' | 'comments'

interface Props {
  pid: string
  docKey: string | null
  canEdit: boolean
  saving: boolean
  stateSha: string | null
  stateVersion: number | null
  open: Tab | null
  onClose: () => void
  onRenumberCitations?: (style?: CitationStyle) => Promise<WordRenumberResult | null>
  renumberBusy?: boolean
}

export function WordSidePanels({
  pid,
  docKey: docKeyProp,
  canEdit,
  saving,
  stateSha,
  stateVersion,
  open,
  onClose,
  onRenumberCitations,
  renumberBusy = false,
}: Props) {
  const br = useWordRefsBridge({ pid, docKeyProp, onRenumberCitations })

  return (
    <aside className="flex w-96 max-w-[90vw] min-h-0 flex-col border-l border-border bg-panel" data-testid="word-side-panel">
      <div className="flex h-panel-header shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-strong" data-testid="word-panel-title">
          {open === 'library' ? (
            <><BookOpen aria-hidden className="size-3.5" />文献</>
          ) : open === 'glossary' ? (
            <><BookA aria-hidden className="size-3.5" />术语表</>
          ) : open === 'preflight' ? (
            <><ShieldCheck aria-hidden className="size-3.5" />投稿检查</>
          ) : open === 'rebuttal' ? (
            <><MessageSquareQuote aria-hidden className="size-3.5" />回复信</>
          ) : open === 'comments' ? (
            <><MessageSquareText aria-hidden className="size-3.5" />批注</>
          ) : (
            <><Sparkles aria-hidden className="size-3.5" />论文助手</>
          )}
        </span>
        <button className="ml-auto rounded p-1 text-fg-muted hover:bg-hover" onClick={onClose} aria-label="收起面板" data-testid="word-panel-close">
          <X aria-hidden className="size-4" />
        </button>
      </div>

      {open === 'library' && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs" data-testid="word-bridge-status">
          {br.ready ? (
            <span className="inline-flex items-center gap-1 text-ok">
              <Plug aria-hidden className="size-3" />文献桥已就绪
            </span>
          ) : br.checking ? (
            <span className="inline-flex items-center gap-1 text-fg-muted">
              <Loader2 aria-hidden className="size-3 animate-spin" />探测插件…
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-warning">
              <Plug aria-hidden className="size-3" />文献桥未就绪——插入/更新不可用
              <button className="rounded border border-line px-1 hover:bg-hover" onClick={br.retryBridge} data-testid="word-bridge-retry">
                重试探测
              </button>
            </span>
          )}
        </div>
      )}

      {br.bridgeError && (
        <div role="alert" className="shrink-0 border-b border-border px-2 py-1 text-xs text-danger-fg" data-testid="word-bridge-error">
          {br.bridgeError}
        </div>
      )}

      {br.bibWarnings.length > 0 && (
        <div role="alert" className="shrink-0 space-y-1.5 border-b border-border px-2 py-1.5 text-xs text-warning" data-testid="word-bib-warnings">
          {br.bibWarnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
          {onRenumberCitations && canEdit && (
            <button
              type="button"
              className="inline-flex items-center rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning hover:bg-warning/20 disabled:opacity-50"
              disabled={renumberBusy}
              onClick={() => void br.renumberCitations(br.citationStyle)}
              data-testid="word-warning-renumber-btn"
            >
              {renumberBusy ? '正在重排…' : '一键按正文出现顺序重排编号'}
            </button>
          )}
        </div>
      )}

      {br.bibMessage && (
        <div role="status" className="shrink-0 border-b border-border px-2 py-1.5 text-xs text-ok" data-testid="word-bib-message">
          {br.bibMessage}
        </div>
      )}

      {br.mode === 'plain' && (
        <div role="status" className="shrink-0 border-b border-border px-2 py-1.5 text-xs text-fg-muted">
          当前文档服务不支持引用内容控件——已插入静态文本标签（未绑定引用对象；重编号需删除后重新插入）。如实提示，非自动管理闭环。
        </div>
      )}

      {open === 'library' && (
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs text-fg-muted"
          data-testid="word-ref-superscript-row"
          title="勾选后插入的引用为上标格式，多个引用合并为一个编号（GB/T 7714 惯例）"
        >
          <input
            className="size-4"
            type="checkbox"
            checked={br.superscript}
            onChange={(e) => br.setSuperscript(e.target.checked)}
            data-testid="word-ref-superscript"
          />
          上标引用（[1-3] 连号压缩，GB/T 7714）
        </label>
      )}

      {open === 'library' && (
        <LibraryPanel
          pid={pid}
          canEdit={canEdit}
          activePath={null}
          onInsertCitations={(keys) => void br.insertCitations(keys)}
          onUpdateBibliography={() => void br.refreshBibliography()}
          bibliographyBusy={br.bibBusy}
          citationStyle={br.citationStyle}
          onCitationStyleChange={br.setCitationStyle}
          onStripBibMarkers={() => void br.stripBibMarkers()}
          stripBibMarkersBusy={br.stripBusy}
          onRenumberCitations={br.renumberCitations}
          renumberBusy={renumberBusy}
        />
      )}

      {open === 'glossary' && <GlossaryPanel pid={pid} canEdit={canEdit} />}

      {open === 'preflight' && <WordPreflightPanel pid={pid} canEdit={canEdit} saving={saving} stateSha={stateSha} stateVersion={stateVersion} />}

      {open === 'rebuttal' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <RebuttalPanel pid={pid} canEdit={canEdit} activeFile={null} cursorLine={null} onJump={() => {}} mode="word" />
        </div>
      )}

      {open === 'comments' && <WordCommentsPanel pid={pid} canEdit={canEdit} />}

      {open === 'proposals' && (
        <ProposalPanel
          pid={pid}
          canEdit={canEdit}
          activePath="document.docx"
          dirty={false}
          saving={false}
          mode="word"
          hideSectionOption
          getSelection={br.getWordSelection}
          applyProposal={br.applyWordProposal}
          revertProposal={br.revertWordProposal}
          locateProposal={() => {}}
          headerNote={`Word 采纳为「原文全文精确检索 + 纯文本替换」（与采纳时的选区无关；保留段落样式，字符级格式不保留）；原文变化/多处命中/跨段一律阻断。${br.selection.trim() ? `已捕获选区 ${br.selection.trim().length} 字。` : '在左侧正文选中文字后生成。'}`}
        />
      )}
    </aside>
  )
}
