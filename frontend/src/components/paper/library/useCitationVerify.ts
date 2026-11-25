import { useCallback, useMemo, useState } from 'react'
import { libraryApi, type CitationVerifyItem, type CitationVerifyReport, type LibraryEntry } from '@/lib/api/library'
import { errText } from './types'

export function useCitationVerify({
  pid,
  entries,
  selected,
  onNotice,
  onError,
}: {
  pid: string
  entries: LibraryEntry[]
  selected: Set<string>
  onNotice: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [verifyReport, setVerifyReport] = useState<CitationVerifyReport | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)

  const verifyMap = useMemo(() => {
    const m = new Map<string, CitationVerifyItem>()
    for (const it of verifyReport?.items ?? []) m.set(it.reference_id, it)
    return m
  }, [verifyReport])

  const loadVerifyCache = useCallback(async () => {
    try {
      const r = await libraryApi.getVerify(pid)
      if (r.total > 0) setVerifyReport(r)
    } catch {
      /* 旧接口无缓存时静默忽略 */
    }
  }, [pid])

  const runFactCheck = useCallback(async () => {
    const allIds = entries.map((e) => e.reference_id)
    const ids = selected.size > 0 ? Array.from(selected) : allIds
    if (ids.length === 0) {
      onNotice('文献库为空，暂无可核验条目')
      return
    }
    setVerifyBusy(true)
    onError('')
    const CHUNK = 25
    try {
      let latest: CitationVerifyReport | null = null
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK)
        if (ids.length > CHUNK) {
          onNotice(`正在核验参考文献（${Math.min(i + chunk.length, ids.length)} / ${ids.length}）…`)
        }
        latest = await libraryApi.runVerify(pid, chunk)
        setVerifyReport(latest)
      }
      if (latest) {
        onNotice(
          `真实性核验完成（共核验 ${ids.length} 条）：已核验 ${latest.counts.verified} · 偏差 ${latest.counts.mismatch} · 未检出 ${latest.counts.unverified}` +
            (latest.counts.retracted ? ` · 已撤稿 ${latest.counts.retracted}` : ''),
        )
      }
    } catch (e) {
      onError(errText(e))
    } finally {
      setVerifyBusy(false)
    }
  }, [entries, selected, pid, onNotice, onError])

  return { verifyMap, verifyBusy, loadVerifyCache, runFactCheck }
}
