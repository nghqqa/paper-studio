import { describe, expect, it } from 'vitest'
import {
  SAMPLE_ABLATION_TSV,
  escapeLatexCell,
  extractNumericValue,
  generateBooktabsLatex,
  parseDelimitedTable,
} from '../latexTable'

describe('latexTable（CSV/TSV → booktabs 三线表）', () => {
  it('正确解析 TSV 与带引号逗号的 CSV', () => {
    const tsv = parseDelimitedTable(SAMPLE_ABLATION_TSV)
    expect(tsv.headers).toEqual(['Method', 'Acc (%)', 'F1 (%)', 'Latency (ms)'])
    expect(tsv.rows).toHaveLength(3)

    const csv = parseDelimitedTable('Name,"Score, Top-1",Note\n"A, B",91.5,"good %"')
    expect(csv.headers).toEqual(['Name', 'Score, Top-1', 'Note'])
    expect(csv.rows[0]).toEqual(['A, B', '91.5', 'good %'])
  })

  it('准确提取带 ± / 百分号 / 千分位的实验主数值，忽略非数字文本', () => {
    expect(extractNumericValue('91.4 ± 0.2')).toBeCloseTo(91.4)
    expect(extractNumericValue('85.2%')).toBeCloseTo(85.2)
    expect(extractNumericValue('1,234.5')).toBeCloseTo(1234.5)
    expect(extractNumericValue('-0.42 (+0.1)')).toBeCloseTo(-0.42)
    expect(extractNumericValue('ResNet-50')).toBeNull()
    expect(extractNumericValue('—')).toBeNull()
  })

  it('保留完整行内公式并转义特殊字符', () => {
    expect(escapeLatexCell('$\\mathcal{L}_1$')).toBe('$\\mathcal{L}_1$')
    expect(escapeLatexCell('Acc (%) & F1_1')).toBe('Acc (\\%) \\& F1\\_1')
  })

  it('生成带最优 \\textbf 与次优 \\underline 的 booktabs 三线表（支持 min/max、table*、resizebox）', () => {
    const { headers, rows } = parseDelimitedTable(SAMPLE_ABLATION_TSV)
    const tex = generateBooktabsLatex({
      headers,
      rows,
      modes: ['none', 'max', 'max', 'min'],
      caption: '消融实验结果 100%',
      label: 'tab:exp',
      twoColumn: true,
      resizeToWidth: true,
    })
    expect(tex).toContain('\\begin{table*}[htbp]')
    expect(tex).toContain('\\resizebox{\\linewidth}{!}{%')
    expect(tex).toContain('\\toprule')
    expect(tex).toContain('\\midrule')
    expect(tex).toContain('\\bottomrule')
    expect(tex).toContain('\\caption{消融实验结果 100\\%}')
    expect(tex).toContain('\\textbf{91.4 ± 0.2}')
    expect(tex).toContain('\\underline{88.7 ± 0.3}')
    // Latency 越小越好：24.8 最优加粗，31.2 次优下划线
    expect(tex).toContain('\\textbf{24.8}')
    expect(tex).toContain('\\underline{31.2}')
  })
})
