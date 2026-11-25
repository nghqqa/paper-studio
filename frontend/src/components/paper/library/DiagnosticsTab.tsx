import { AlertTriangle, CircleAlert } from 'lucide-react'
import type { LibraryReply } from '@/lib/api/library'
import { diagCount } from './types'

export function DiagnosticsTab({ lib, onGoList }: { lib: LibraryReply | null; onGoList: (rid: string) => void }) {
  const d = lib?.diagnostics
  if (!d) return null
  const item = (n: number) => (n === 0 ? null : n)
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2 text-xs" data-testid="library-diagnostics">
      {item(d.duplicate_keys.length) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-warning">
            <AlertTriangle aria-hidden className="size-3.5" /> 重复 citation key（{d.duplicate_keys.length}）
          </h4>
          <ul className="space-y-0.5">
            {d.duplicate_keys.map((x) => (
              <li key={x.key}>
                「{x.key}」出现在 {x.bib_files.join('、') || '多处'}——请合并或改名（点击条目 → 合并）
              </li>
            ))}
          </ul>
        </section>
      )}
      {item(d.fuzzy_duplicates.length) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-warning">
            <AlertTriangle aria-hidden className="size-3.5" /> 疑似重复（标题+作者+年份）（{d.fuzzy_duplicates.length}）
          </h4>
          <ul className="space-y-0.5">
            {d.fuzzy_duplicates.map((x, i) => (
              <li key={i}>
                <button className="text-left hover:underline" onClick={() => onGoList(x.reference_ids[0])}>
                  {x.title || '（无标题）'}
                </button>
                <span className="ml-1 text-fg-muted">（{x.reference_ids.length} 条疑似同一文献）</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {item(d.undefined_in_tex.length) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-warning">
            <AlertTriangle aria-hidden className="size-3.5" /> 正文引用但库中不存在（{d.undefined_in_tex.length}）
          </h4>
          <ul className="space-y-0.5">
            {d.undefined_in_tex.map((k) => (
              <li key={k}>{`\\cite{${k}}`}——库内无此 key（编译会出 undefined citation）</li>
            ))}
          </ul>
        </section>
      )}
      {item(d.missing_fields.length) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-fg-muted">
            <AlertTriangle aria-hidden className="size-3.5" /> 缺字段（{d.missing_fields.length}）
          </h4>
          <ul className="space-y-0.5">
            {d.missing_fields.map((m) => (
              <li key={m.reference_id}>
                <button className="hover:underline" onClick={() => onGoList(m.reference_id)}>
                  {m.citation_key}
                </button>
                <span className="ml-1 text-fg-muted">缺 {m.missing.join('、')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {item(d.parse_errors?.length ?? 0) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-danger">
            <CircleAlert aria-hidden className="size-3.5" /> .bib 解析错误（{d.parse_errors.length}）
          </h4>
          <ul className="space-y-1">
            {d.parse_errors.map((e, i) => (
              <li key={i} className="rounded border border-danger/30 bg-danger/5 p-1">
                第 {e.line} 行：{e.error}
                <pre className="mt-0.5 max-h-14 overflow-auto whitespace-pre-wrap text-2xs opacity-80">{e.raw}</pre>
              </li>
            ))}
          </ul>
        </section>
      )}
      {diagCount(lib) === 0 && <div className="text-fg-muted">未发现重复 key、缺字段或解析错误。</div>}
      <p className="mt-2 text-2xs text-fg-muted">说明：「未验证」仅表示尚未经外部来源或人工确认，不代表文献不存在。</p>
    </div>
  )
}
