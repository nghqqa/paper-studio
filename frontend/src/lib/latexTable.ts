export type ColumnHighlightMode = 'none' | 'max' | 'min'

export interface ParsedDelimitedTable {
  headers: string[]
  rows: string[][]
}

export const SAMPLE_ABLATION_TSV = [
  'Method\tAcc (%)\tF1 (%)\tLatency (ms)',
  'Baseline\t84.2 ± 0.4\t82.9 ± 0.5\t42.5',
  'Method-A\t88.7 ± 0.3\t87.4 ± 0.2\t31.2',
  'Ours (Full)\t91.4 ± 0.2\t90.8 ± 0.3\t24.8',
].join('\n')

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

/**
 * 解析 Excel/Sheets 粘贴的 TSV（制表符分隔）或标准 CSV 文本为表头与数据行。
 */
export function parseDelimitedTable(raw: string): ParsedDelimitedTable {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }

  const useTab = lines[0]!.includes('\t')
  const parsed = lines.map((line) => (useTab ? line.split('\t').map((c) => c.trim()) : splitCsvLine(line)))
  const width = Math.max(...parsed.map((r) => r.length), 0)
  const pad = (r: string[]) => [...r, ...Array<string>(Math.max(0, width - r.length)).fill('')]

  const headers = pad(parsed[0]!)
  const rows = parsed.slice(1).map(pad)
  return { headers, rows }
}

/**
 * 从实验表格单元格提取主数值，支持 "91.4 ± 0.2"、"85.2%"、"1,234.5"、"91.4 (+1.2)" 等写法。
 */
export function extractNumericValue(cell: string): number | null {
  const s = cell.trim()
  if (!s) return null
  const m = /^([+-]?\d[\d,]*(?:\.\d+)?)(?:\s*(?:±|\+\/-|\(|\s|%|$))/.exec(s)
  if (!m) return null
  const num = Number(m[1]!.replace(/,/g, ''))
  return Number.isFinite(num) ? num : null
}

/**
 * 转义 LaTeX 表格单元格特殊字符；若单元格本身完整由 `$...$` 包裹则保留行内公式。
 */
export function escapeLatexCell(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('$') && trimmed.endsWith('$')) {
    return trimmed
  }
  return trimmed
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%&#_{}$])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

export interface ColumnRanks {
  best: Set<number>
  second: Set<number>
}

export function computeColumnRanks(rows: string[][], modes: ColumnHighlightMode[]): ColumnRanks[] {
  return modes.map((mode, colIdx) => {
    const best = new Set<number>()
    const second = new Set<number>()
    if (mode === 'none') return { best, second }

    const entries: { row: number; val: number }[] = []
    rows.forEach((r, rowIdx) => {
      const v = extractNumericValue(r[colIdx] ?? '')
      if (v !== null) entries.push({ row: rowIdx, val: v })
    })
    if (entries.length === 0) return { best, second }

    const sortedVals = Array.from(new Set(entries.map((e) => e.val))).sort((a, b) => (mode === 'max' ? b - a : a - b))
    const topVal = sortedVals[0]!
    const secondVal = sortedVals[1]
    for (const e of entries) {
      if (e.val === topVal) best.add(e.row)
      else if (secondVal !== undefined && e.val === secondVal) second.add(e.row)
    }
    return { best, second }
  })
}

export interface BooktabsOptions {
  headers: string[]
  rows: string[][]
  modes?: ColumnHighlightMode[]
  caption?: string
  label?: string
  boldBest?: boolean
  underlineSecond?: boolean
  twoColumn?: boolean
  resizeToWidth?: boolean
}

/**
 * 生成符合顶会/期刊排版规范的 LaTeX booktabs 三线表代码（需在导言区引入 \usepackage{booktabs}）。
 */
export function generateBooktabsLatex(opts: BooktabsOptions): string {
  const {
    headers,
    rows,
    modes = headers.map(() => 'none' as ColumnHighlightMode),
    caption = '实验结果对比（最优加粗，次优下划线）。',
    label = 'tab:results',
    boldBest = true,
    underlineSecond = true,
    twoColumn = false,
    resizeToWidth = false,
  } = opts

  if (headers.length === 0) return ''

  const env = twoColumn ? 'table*' : 'table'
  const ranks = computeColumnRanks(rows, modes)
  const colSpec = headers.map((_, idx) => (idx === 0 ? 'l' : 'c')).join('')

  const formatCell = (raw: string, rowIdx: number, colIdx: number): string => {
    const escaped = escapeLatexCell(raw)
    if (!escaped) return '--'
    const rank = ranks[colIdx]
    if (boldBest && rank?.best.has(rowIdx)) return `\\textbf{${escaped}}`
    if (underlineSecond && rank?.second.has(rowIdx)) return `\\underline{${escaped}}`
    return escaped
  }

  const headerLine = `  ${headers.map((h) => escapeLatexCell(h) || ' ').join(' & ')} \\\\`
  const bodyLines = rows.map(
    (r, rIdx) => `  ${headers.map((_, cIdx) => formatCell(r[cIdx] ?? '', rIdx, cIdx)).join(' & ')} \\\\`,
  )

  const tabular = [
    `\\begin{tabular}{${colSpec}}`,
    '  \\toprule',
    headerLine,
    '  \\midrule',
    ...bodyLines,
    '  \\bottomrule',
    '\\end{tabular}',
  ]

  const wrappedTabular = resizeToWidth
    ? [`\\resizebox{\\linewidth}{!}{%`, ...tabular.map((l) => `  ${l}`), '}']
    : tabular

  const lines = [
    `\\begin{${env}}[htbp]`,
    '  \\centering',
    ...(caption.trim() ? [`  \\caption{${escapeLatexCell(caption)}}`] : []),
    ...(label.trim() ? [`  \\label{${label.trim()}}`] : []),
    ...wrappedTabular.map((l) => `  ${l}`),
    `\\end{${env}}`,
  ]
  return lines.join('\n')
}
