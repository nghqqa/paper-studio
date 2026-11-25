import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function InstructionBar({
  busy,
  canEdit,
  mode,
  onMode,
  focusSignal,
  section,
  onSend,
}: {
  busy: boolean
  canEdit: boolean
  mode: 'custom' | 'writing'
  onMode(m: 'custom' | 'writing'): void
  focusSignal: number
  section: React.ReactNode
  onSend(text: string, mode: 'custom' | 'writing'): void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus()
  }, [focusSignal])

  const send = () => {
    const t = text.trim()
    if (!t || busy || !canEdit) return
    onSend(t, mode)
    setText('')
  }

  return (
    <div className="shrink-0 border-t border-line bg-panel p-2" data-testid="assistant-bottombar">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            className={cn(
              'rounded-full border px-2 py-0.5 text-2xs transition-colors',
              mode === 'custom' ? 'border-primary/30 bg-primary-soft font-medium text-primary' : 'border-line text-fg-muted hover:bg-hover hover:text-fg',
            )}
            onClick={() => onMode('custom')}
            aria-pressed={mode === 'custom'}
            data-testid="assistant-mode-custom"
          >
            润色 / 修改指令
          </button>
          <button
            type="button"
            className={cn(
              'rounded-full border px-2 py-0.5 text-2xs transition-colors',
              mode === 'writing' ? 'border-primary/30 bg-primary-soft font-medium text-primary' : 'border-line text-fg-muted hover:bg-hover hover:text-fg',
            )}
            onClick={() => onMode('writing')}
            aria-pressed={mode === 'writing'}
            data-testid="assistant-mode-writing"
          >
            论文写作
          </button>
        </div>
        {section}
      </div>
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-app py-1 pl-2 pr-1 transition-colors focus-within:border-border-strong">
        <input
          ref={inputRef}
          className="h-6 min-w-0 flex-1 border-0 bg-transparent text-xs outline-none"
          placeholder={mode === 'writing' ? '想让 AI 写什么？（如：写一段引言的研究背景）' : '修改指令（如：把这段改成方法描述的语气）'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
          }}
          data-testid="proposal-custom-input"
        />
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover active:bg-primary-active disabled:bg-sunken disabled:text-fg-disabled"
          disabled={busy || !canEdit || !text.trim()}
          onClick={send}
          aria-label={mode === 'writing' ? '生成' : '执行'}
          data-testid="proposal-custom-go"
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ArrowUp aria-hidden className="size-4" />}
        </button>
      </div>
    </div>
  )
}
