import { useEffect, useMemo, useRef, useState } from 'react'
import { presenceApi, type PresencePeer } from '@/lib/api/presence'

const HEARTBEAT_MS = 15000

function makeClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().slice(0, 16)
    }
  } catch {
    /* ignore */
  }
  return `cli-${Math.random().toString(36).slice(2, 10)}`
}

export function useProjectPresence({
  pid,
  file,
  line,
  mode,
  enabled = true,
}: {
  pid: string
  file?: string | null
  line?: number | null
  mode: 'latex' | 'word'
  enabled?: boolean
}) {
  const clientId = useMemo(() => makeClientId(), [])
  const [peers, setPeers] = useState<PresencePeer[]>([])
  const latestRef = useRef({ file, line })
  latestRef.current = { file, line }

  useEffect(() => {
    if (!enabled || !pid || typeof fetch !== 'function') return
    let cancelled = false

    const beat = async () => {
      try {
        const res = await presenceApi.heartbeat(pid, {
          client_id: clientId,
          file: latestRef.current.file ?? null,
          line: latestRef.current.line ?? null,
          mode,
        })
        if (!cancelled && res && Array.isArray(res.peers)) {
          setPeers(res.peers)
        }
      } catch {
        // 测试环境或离线状态静默降级
      }
    }

    void beat()
    const timer = window.setInterval(() => void beat(), HEARTBEAT_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      try {
        void presenceApi.leave(pid, clientId).catch(() => undefined)
      } catch {
        /* ignore */
      }
    }
  }, [clientId, enabled, mode, pid, file])

  return { clientId, peers }
}
