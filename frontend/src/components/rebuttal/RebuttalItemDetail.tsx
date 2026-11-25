import { ArrowLeft, Loader2, LocateFixed, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RebuttalItem, RebuttalStatus } from '@/lib/api/rebuttal'
import { cn } from '@/lib/utils'
import { RebuttalAnchorPicker } from './RebuttalAnchorPicker'
import { RebuttalPill } from './RebuttalArchiveView'
import { CATEGORY_ZH, FIELD_CLS, type ItemForm, STATUSES, STATUS_ZH } from './rebuttalHelpers'

export function RebuttalItemDetail({
  pid,
  mode,
  selected,
  form,
  canEdit,
  activeFile,
  cursorLine,
  aiEnabled,
  aiBusy,
  dirty,
  saving,
  onBack,
  onJump,
  onPatchForm,
  onSwitchStatus,
  onLinkCursor,
  onRunDraft,
  onAdoptDraft,
  onSaveItem,
  onReload,
}: {
  pid: string
  mode: 'latex' | 'word'
  selected: RebuttalItem
  form: ItemForm
  canEdit: boolean
  activeFile: string | null
  cursorLine: number | null
  aiEnabled: boolean
  aiBusy: boolean
  dirty: boolean
  saving: boolean
  onBack: () => void
  onJump: (file: string, line: number) => void
  onPatchForm: (patch: Partial<ItemForm>) => void
  onSwitchStatus: (st: RebuttalStatus) => void
  onLinkCursor: () => void
  onRunDraft: () => void
  onAdoptDraft: () => void
  onSaveItem: () => void
  onReload: () => void
}) {
  return (
    <div className="space-y-2" data-testid="rebuttal-detail">
      <button type="button" className="flex items-center gap-1 text-2xs text-fg-muted hover:text-fg" onClick={onBack} data-testid="rebuttal-back">
        <ArrowLeft aria-hidden className="size-3" /> 返回列表
      </button>
      <p className="flex items-center gap-1.5">
        <span className="rounded bg-primary-soft px-1.5 py-0.5 text-2xs text-primary">{selected.reviewer}</span>
        <span className="rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">
          {CATEGORY_ZH[selected.category] ?? selected.category}
        </span>
        <span className="ml-auto text-2xs text-fg-muted">{selected.id}</span>
      </p>
      <blockquote className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken p-2 leading-5 text-fg-muted">
        {selected.text}
      </blockquote>

      <div className="flex items-center gap-1">
        <span className="text-2xs text-fg-muted">状态</span>
        {STATUSES.map((st) => (
          <RebuttalPill key={st} active={form.status === st} onClick={() => onSwitchStatus(st)} testid={`rebuttal-status-${st}`}>
            {STATUS_ZH[st]}
          </RebuttalPill>
        ))}
      </div>

      <label className="block space-y-1">
        <span className="text-2xs text-fg-muted">作者回复</span>
        <textarea
          className={cn(FIELD_CLS, 'max-h-56 min-h-24 resize-y')}
          value={form.response}
          disabled={!canEdit}
          placeholder="针对该条意见的回复（礼貌、逐点、可核查）…"
          onChange={(e) => onPatchForm({ response: e.target.value })}
          data-testid="rebuttal-response-input"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-2xs text-fg-muted">修改摘要</span>
        <input
          className={FIELD_CLS}
          value={form.editsSummary}
          disabled={!canEdit}
          placeholder="对应修改了什么（用于导出信中的 Changes）"
          onChange={(e) => onPatchForm({ editsSummary: e.target.value })}
          data-testid="rebuttal-edits-input"
        />
      </label>

      <div className="space-y-1">
        <span className="text-2xs text-fg-muted">修改位置</span>
        <div className="grid grid-cols-2 gap-1">
          <input
            className={FIELD_CLS}
            value={form.location.file ?? ''}
            disabled={!canEdit}
            placeholder="位置（如 main.tex 或 第2节）"
            onChange={(e) => onPatchForm({ location: { ...form.location, file: e.target.value || null } })}
            data-testid="rebuttal-loc-file"
          />
          <input
            className={FIELD_CLS}
            type="number"
            min={1}
            value={form.location.line ?? ''}
            disabled={!canEdit}
            placeholder="行号"
            onChange={(e) => onPatchForm({ location: { ...form.location, line: e.target.value ? Number(e.target.value) : null } })}
            data-testid="rebuttal-loc-line"
          />
          <input
            className={FIELD_CLS}
            value={form.location.section ?? ''}
            disabled={!canEdit}
            placeholder="章节 / 小节"
            onChange={(e) => onPatchForm({ location: { ...form.location, section: e.target.value || null } })}
            data-testid="rebuttal-loc-section"
          />
          <input
            className={FIELD_CLS}
            value={form.location.label ?? ''}
            disabled={!canEdit}
            placeholder="图表 / 公式标记"
            onChange={(e) => onPatchForm({ location: { ...form.location, label: e.target.value || null } })}
            data-testid="rebuttal-loc-label"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="xs"
            disabled={!canEdit || !activeFile || cursorLine == null}
            onClick={onLinkCursor}
            title={activeFile ? `关联当前光标：${activeFile} 第 ${cursorLine} 行` : '先在编辑器中打开文件'}
            data-testid="rebuttal-link-cursor"
          >
            <LocateFixed aria-hidden className="size-3.5" />
            关联当前光标位置
          </Button>
          {form.location.file && form.location.line ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onJump(form.location.file as string, form.location.line as number)}
              data-testid="rebuttal-jump"
            >
              跳转
            </Button>
          ) : null}
        </div>
      </div>

      <RebuttalAnchorPicker pid={pid} mode={mode} item={selected} canEdit={canEdit} onChanged={onReload} />

      <div className="space-y-1 rounded-md border border-line p-2" data-testid="rebuttal-ai-area">
        <div className="flex items-center gap-1">
          <Button
            variant="soft"
            size="xs"
            disabled={!canEdit || !aiEnabled || aiBusy}
            onClick={onRunDraft}
            title={aiEnabled ? '生成 AI 回复建议（仅写入草稿建议，不改动你的回复）' : '团队已禁用 AI 功能'}
            data-testid="rebuttal-ai-draft"
          >
            {aiBusy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Sparkles aria-hidden className="size-3.5" />}
            AI 起草回复
          </Button>
          {!aiEnabled && <span className="text-2xs text-fg-muted">团队已禁用 AI</span>}
        </div>
        {selected.ai_draft && (
          <div className="space-y-1">
            <p className="whitespace-pre-wrap rounded-md bg-sunken p-2 leading-5 text-fg-muted" data-testid="rebuttal-ai-preview">
              {selected.ai_draft.response_draft}
              {selected.ai_draft.edits_summary_draft ? (
                <>
                  {'\n'}
                  <span className="text-2xs">修改摘要建议：{selected.ai_draft.edits_summary_draft}</span>
                </>
              ) : null}
            </p>
            <Button
              variant="outline"
              size="xs"
              disabled={!canEdit}
              onClick={onAdoptDraft}
              title="把 AI 草稿填入上方回复框，确认修改后再保存"
              data-testid="rebuttal-adopt-ai"
            >
              采纳 AI 草稿填入回复框
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-1">
        {dirty && <span className="text-2xs text-fg-muted">未保存</span>}
        <Button variant="primary" size="xs" disabled={!canEdit || !dirty || saving} onClick={onSaveItem} data-testid="rebuttal-save">
          {saving ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
          保存回复
        </Button>
      </div>
    </div>
  )
}
