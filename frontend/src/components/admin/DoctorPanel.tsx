import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleMinus, Database, Download, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { accountApi, type DataHealthReport, type DoctorCheck, type DoctorReport } from '@/lib/api/account'
import { downloadFile } from '@/lib/download'
import { cn } from '@/lib/utils'

function fmtMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const STATUS_META: Record<DoctorCheck['status'], { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: '正常', cls: 'bg-ok/10 text-ok border-ok/20', Icon: CheckCircle2 },
  warn: { label: '建议优化', cls: 'bg-warning/15 text-warning border-warning/30', Icon: AlertTriangle },
  error: { label: '需处理', cls: 'bg-danger/10 text-danger border-danger/30', Icon: XCircle },
  off: { label: '未启用', cls: 'bg-sunken text-fg-muted border-border', Icon: CircleMinus },
}

export function DoctorPanel() {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [dataHealth, setDataHealth] = useState<DataHealthReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [r, dh] = await Promise.all([
        accountApi.doctor(),
        accountApi.dataHealth().catch(() => null),
      ])
      setReport(r)
      setDataHealth(dh)
    } catch (e) {
      setError((e as Error).message || '系统诊断执行失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  const downloadBackup = async (includeProjects: boolean) => {
    if (backupBusy) return
    setBackupBusy(true)
    setError('')
    try {
      await downloadFile(
        accountApi.dataBackupUrl(includeProjects),
        includeProjects ? 'paper-studio-full-backup.zip' : 'paper-studio-backup.zip',
      )
    } catch (e) {
      setError((e as Error).message || '导出备份失败')
    } finally {
      setBackupBusy(false)
    }
  }

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

      {dataHealth && (
        <section className="space-y-3 rounded-lg border border-border bg-panel p-4" data-testid="admin-data-health">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
              <Database className="size-4 text-primary" aria-hidden />
              数据存储健康与平台备份
              <span className={cn('rounded border px-1.5 py-0.5 text-xs font-normal', dataHealth.db.ok ? 'border-ok/20 bg-ok/10 text-ok' : 'border-danger/30 bg-danger/10 text-danger')}>
                SQLite: {dataHealth.db.ok ? '完整正常' : dataHealth.db.message}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={backupBusy}
                onClick={() => void downloadBackup(false)}
                data-testid="admin-data-backup-btn"
              >
                <Download aria-hidden className="size-3.5" /> 下载核心备份 (.zip)
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={backupBusy}
                onClick={() => void downloadBackup(true)}
                data-testid="admin-data-full-backup-btn"
              >
                <Download aria-hidden className="size-3.5" /> 全量备份（含项目）
              </Button>
            </div>
          </div>
          <div className="grid gap-2 text-xs text-fg sm:grid-cols-4">
            <div className="rounded border border-border bg-app p-2">
              <div className="text-fg-muted">项目总数</div>
              <div className="mt-0.5 font-semibold text-fg-strong">
                {dataHealth.project_count} 篇
                <span className="ml-1 font-normal text-fg-muted">
                  (LaTeX {dataHealth.formats.latex ?? 0} / Word {dataHealth.formats.docx ?? 0})
                </span>
              </div>
            </div>
            <div className="rounded border border-border bg-app p-2">
              <div className="text-fg-muted">总占用空间</div>
              <div className="mt-0.5 font-semibold text-fg-strong">{fmtMb(dataHealth.storage.total_bytes)}</div>
            </div>
            <div className="rounded border border-border bg-app p-2">
              <div className="text-fg-muted">编译与预览缓存</div>
              <div className="mt-0.5 font-semibold text-fg-strong">{fmtMb(dataHealth.storage.build_cache_bytes)}</div>
            </div>
            <div className="rounded border border-border bg-app p-2">
              <div className="text-fg-muted">磁盘剩余空间</div>
              <div className="mt-0.5 font-semibold text-fg-strong">{fmtMb(dataHealth.disk.free_bytes)}</div>
            </div>
          </div>
          {dataHealth.top_projects.length > 0 && (
            <div className="text-xs text-fg-muted">
              占用前五项目：
              {dataHealth.top_projects.slice(0, 5).map((p) => `${p.title} (${fmtMb(p.total_bytes)})`).join(' · ')}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
