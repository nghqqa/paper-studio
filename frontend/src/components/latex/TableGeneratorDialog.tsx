import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Check, Copy, FileUp, Sparkles, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  SAMPLE_ABLATION_TSV,
  computeColumnRanks,
  generateBooktabsLatex,
  parseDelimitedTable,
  type ColumnHighlightMode,
} from '@/lib/latexTable'
import { cn } from '@/lib/utils'

const MODE_CYCLE: ColumnHighlightMode[] = ['none', 'max', 'min']
const MODE_LABEL: Record<ColumnHighlightMode, string> = {
  none: '不标',
  max: '↑ 最大优',
  min: '↓ 最小优',
}

export interface TableGeneratorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInsert: (latex: string) => void
}

/**
 * CSV / TSV → LaTeX booktabs 三线表生成器：支持自动最优加粗、次优下划线与一键插入编辑器。
 */
export function TableGeneratorDialog({ open, onOpenChange, onInsert }: TableGeneratorDialogProps) {
  const [rawText, setRawText] = useState(SAMPLE_ABLATION_TSV)
  const [modesMap, setModesMap] = useState<Record<number, ColumnHighlightMode>>({ 1: 'max', 2: 'max', 3: 'min' })
  const [caption, setCaption] = useState('消融实验对比结果（最优指标加粗，次优指标加下划线）。')
  const [label, setLabel] = useState('tab:ablation')
  const [boldBest, setBoldBest] = useState(true)
  const [underlineSecond, setUnderlineSecond] = useState(true)
  const [twoColumn, setTwoColumn] = useState(false)
  const [resizeToWidth, setResizeToWidth] = useState(false)
  const [copied, setCopied] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const parsed = useMemo(() => parseDelimitedTable(rawText), [rawText])
  const modes = useMemo(
    () => parsed.headers.map((_, idx) => modesMap[idx] ?? 'none'),
    [parsed.headers, modesMap],
  )
  const ranks = useMemo(() => computeColumnRanks(parsed.rows, modes), [parsed.rows, modes])

  const latexCode = useMemo(
    () =>
      generateBooktabsLatex({
        headers: parsed.headers,
        rows: parsed.rows,
        modes,
        caption,
        label,
        boldBest,
        underlineSecond,
        twoColumn,
        resizeToWidth,
      }),
    [parsed, modes, caption, label, boldBest, underlineSecond, twoColumn, resizeToWidth],
  )

  const cycleMode = (colIdx: number) => {
    const cur = modesMap[colIdx] ?? 'none'
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(cur) + 1) % MODE_CYCLE.length]!
    setModesMap((prev) => ({ ...prev, [colIdx]: next }))
  }

  const onFilePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    setRawText(text)
    setModesMap({})
  }

  const onCopy = async () => {
    if (!latexCode) return
    try {
      await navigator.clipboard.writeText(latexCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* ignore */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" data-testid="table-generator-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="size-4 text-primary" aria-hidden />
            CSV / Excel → LaTeX 三线表生成器
          </DialogTitle>
          <DialogDescription>
            从 Excel / Google Sheets 直接粘贴表格或导入 CSV/TSV，自动生成标准 <code className="font-mono">booktabs</code> 三线表代码。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="table-gen-raw">粘贴表格数据（Tab 或逗号分隔）</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setRawText(SAMPLE_ABLATION_TSV)
                    setModesMap({ 1: 'max', 2: 'max', 3: 'min' })
                  }}
                  data-testid="table-gen-sample"
                >
                  <Sparkles className="size-3" aria-hidden /> 填入示例
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                  data-testid="table-gen-upload"
                >
                  <FileUp className="size-3" aria-hidden /> 导入 .csv/.tsv
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                  aria-label="选择 CSV 或 TSV 文件"
                  className="sr-only"
                  onChange={(e) => void onFilePick(e)}
                />
              </div>
            </div>
            <Textarea
              id="table-gen-raw"
              rows={4}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="直接粘贴 Excel / Sheets 选区或 CSV 文本…"
              className="font-mono text-xs"
              data-testid="table-gen-raw"
            />
          </div>

          {parsed.headers.length > 0 && (
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-fg">实时预览与列指标方向（点击表头切换 ↑ / ↓）</span>
              <div className="max-h-44 overflow-auto rounded-md border border-border bg-panel">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border bg-sunken/70">
                      {parsed.headers.map((h, colIdx) => {
                        const m = modes[colIdx] ?? 'none'
                        return (
                          <th key={colIdx} className="px-2.5 py-1.5 text-left font-medium text-fg-strong">
                            <div className="flex flex-col gap-1">
                              <span>{h || `列 ${colIdx + 1}`}</span>
                              <button
                                type="button"
                                onClick={() => cycleMode(colIdx)}
                                data-testid={`table-gen-col-mode-${colIdx}`}
                                className={cn(
                                  'w-fit rounded border px-1.5 py-0.5 text-2xs transition-colors',
                                  m === 'none'
                                    ? 'border-border bg-panel text-fg-muted hover:text-fg'
                                    : 'border-primary bg-primary-soft font-medium text-link',
                                )}
                              >
                                {MODE_LABEL[m]}
                              </button>
                            </div>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {parsed.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {parsed.headers.map((_, cIdx) => {
                          const isBest = boldBest && ranks[cIdx]?.best.has(rIdx)
                          const isSecond = underlineSecond && ranks[cIdx]?.second.has(rIdx)
                          return (
                            <td
                              key={cIdx}
                              className={cn(
                                'px-2.5 py-1.5 text-fg',
                                isBest && 'font-bold text-primary',
                                !isBest && isSecond && 'underline decoration-primary underline-offset-2',
                              )}
                            >
                              {row[cIdx] || '—'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="table-gen-caption">表题（caption）</Label>
              <Input
                id="table-gen-caption"
                size="sm"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                data-testid="table-gen-caption"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="table-gen-label">引用标签（label）</Label>
              <Input
                id="table-gen-label"
                size="sm"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                data-testid="table-gen-label"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-fg">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <Checkbox checked={boldBest} onCheckedChange={(v) => setBoldBest(v === true)} />
              <span>最优值加粗（\textbf）</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <Checkbox checked={underlineSecond} onCheckedChange={(v) => setUnderlineSecond(v === true)} />
              <span>次优值下划线（\underline）</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <Checkbox checked={twoColumn} onCheckedChange={(v) => setTwoColumn(v === true)} />
              <span>跨双栏（table*）</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <Checkbox checked={resizeToWidth} onCheckedChange={(v) => setResizeToWidth(v === true)} />
              <span>自适应栏宽（\resizebox）</span>
            </label>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="table-gen-preview">LaTeX 源码预览（需导言区 {'\\usepackage{booktabs}'}）</Label>
            <pre
              id="table-gen-preview"
              data-testid="table-gen-code"
              className="max-h-40 overflow-auto rounded-md border border-border bg-sunken p-2.5 font-mono text-2xs leading-relaxed text-fg"
            >
              {latexCode || '% 请输入至少一行表头'}
            </pre>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!latexCode} onClick={() => void onCopy()} data-testid="table-gen-copy">
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? '已复制' : '复制代码'}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!latexCode}
            onClick={() => {
              onInsert(`\n${latexCode}\n`)
              onOpenChange(false)
            }}
            data-testid="table-gen-insert"
          >
            插入到光标处
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
