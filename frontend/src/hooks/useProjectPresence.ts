import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/lib/api/net'
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
  const beatRef = useRef<(() => void) | null>(null)
  const prevFileRef = useRef(file)

  useEffect(() => {
    if (!enabled || !pid || typeof fetch !== 'function') {
      setPeers([])
      beatRef.current = null
      return
    }
    let cancelled = false
    let stopped = false

    const beat = async () => {
      if (cancelled || stopped) return
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
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) {
          stopped = true
          if (!cancelled) setPeers([])
        }
        // 测试环境或离线状态静默降级
      }
    }

    beatRef.current = () => {
      if (!cancelled && !stopped && !(typeof document !== 'undefined' && document.hidden)) {
        void beat()
      }
    }

    const onVisibility = () => {
      if (!document.hidden) beatRef.current?.()
    }
    const onPageHide = () => {
      try {
        void fetch(
          `/api/projects/${encodeURIComponent(pid)}/presence?client_id=${encodeURIComponent(clientId)}`,
          { method: 'DELETE', keepalive: true, credentials: 'same-origin' },
        ).catch(() => undefined)
      } catch {
        /* ignore */
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    window.addEventListener('pagehide', onPageHide)

    if (typeof document === 'undefined' || !document.hidden) {
      void beat()
    }
    const timer = window.setInterval(() => {
      if (!stopped && (typeof document === 'undefined' || !document.hidden)) {
        void beat()
      }
    }, HEARTBEAT_MS)
    return () => {
      cancelled = true
      beatRef.current = null
      window.clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      window.removeEventListener('pagehide', onPageHide)
      setPeers([])
      try {
        void presenceApi.leave(pid, clientId).catch(() => undefined)
      } catch {
        /* ignore */
      }
    }
  }, [clientId, enabled, mode, pid])

  useEffect(() => {
    if (prevFileRef.current === file) return
    prevFileRef.current = file
    beatRef.current?.()
  }, [file])

  return { clientId, peers }
}
