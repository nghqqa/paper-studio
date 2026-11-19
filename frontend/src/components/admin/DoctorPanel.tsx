import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleMinus, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { accountApi, type DoctorCheck, type DoctorReport } from '@/lib/api/account'
import { cn } from '@/lib/utils'

const STATUS_META: Record<DoctorCheck['status'], { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: '正常', cls: 'bg-ok/10 text-ok border-ok/20', Icon: CheckCircle2 },
  warn: { label: '建议优化', cls: 'bg-warning/15 text-warning border-warning/30', Icon: AlertTriangle },
  error: { label: '需处理', cls: 'bg-danger/10 text-danger border-danger/30', Icon: XCircle },
  off: { label: '未启用', cls: 'bg-sunken text-fg-muted border-border', Icon: CircleMinus },
}

export function DoctorPanel() {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await accountApi.doctor()
      setReport(r)
    } catch (e) {
      setError((e as Error).message || '系统诊断执行失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  return (
    <div className="grid gap-4" data-testid="admin-doctor-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-panel p-4">
        <div>
          <div className="text-sm font-semibold text-fg-strong">
            部署环境实时体检
            {report && (
              <span className={cn('ml-2 inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium', STATUS_META[report.overall].cls)}>
                {STATUS_META[report.overall].label}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-fg-muted">
            检查鉴权、磁盘空间、TeXLive/Pandoc/Poppler 工具链、ONLYOFFICE 连通性与 AI 接入状态（所有密钥均脱敏不回传）。
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void run()} data-testid="doctor-refresh-btn">
          {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
          重新检测
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-xs text-danger">
          {error}
        </div>
      )}

      {loading && !report && (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden /> 正在检测部署环境…
        </div>
      )}

      {report && (
        <ul className="grid gap-3">
          {report.checks.map((c) => {
            const meta = STATUS_META[c.status]
            const Icon = meta.Icon
            return (
              <li key={c.id} className="rounded-lg border border-border bg-panel p-4" data-testid={`doctor-check-${c.id}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
                    <Icon className={cn('size-4 shrink-0', c.status === 'ok' ? 'text-ok' : c.status === 'warn' ? 'text-warning' : c.status === 'error' ? 'text-danger' : 'text-fg-muted')} aria-hidden />
                    {c.name}
                  </div>
                  <span className={cn('shrink-0 rounded border px-2 py-0.5 text-xs', meta.cls)}>{meta.label}</span>
                </div>
                <p className="mt-1.5 text-xs text-fg">{c.summary}</p>
                {c.hint && <p className="mt-1 text-xs text-fg-muted">建议：{c.hint}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
