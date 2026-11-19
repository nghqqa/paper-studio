import { req } from './net'

interface WordStateLike { doc_key?: string | null }

/**
 * Word 文献引用插件任务箱 API（v0.4.1）：任务按文档会话键（doc_key）绑定。
 * 页面从 editorConfig 取 document.key；插件以 Asc.plugin.info.documentId 轮询——
 * 两端 doc_key 一致才可见（关闭重开/会话重建后旧任务自然过期）。
 */

export interface RefsTaskResult<T = Record<string, unknown>> {
  request_id: string
  ok: boolean
  data: T | null
  error: string | null
}

const enc = encodeURIComponent

async function postTask(pid: string, docKey: string, kind: string, payload: Record<string, unknown>): Promise<string> {
  const r = await req<{ request_id: string }>(`/api/office-plugin-refs/task`, {
    method: 'POST',
    body: JSON.stringify({ pid, doc_key: docKey, kind, payload }),
  })
  return r.request_id
}

async function pollResult<T>(docKey: string, requestId: string, timeoutMs = 20000): Promise<RefsTaskResult<T>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 350))
    const r = await req<{ result: RefsTaskResult<T> | null }>(
      `/api/office-plugin-refs/result?request_id=${enc(requestId)}&doc_key=${enc(docKey)}`,
    )
    if (r.result) return r.result
  }
  throw new Error('插件任务超时（未收到编辑器回执）——请确认 Word 编辑器已打开且为可编辑账号')
}

/** 下发任务并等待插件回执（request_id 配对校验 + doc_key 会话绑定）。 */
export async function runRefsTask<T = Record<string, unknown>>(
  pid: string,
  docKey: string,
  kind: string,
  payload: Record<string, unknown>,
  timeoutMs = 45000,
): Promise<T> {
  const requestId = await postTask(pid, docKey, kind, payload)
  const result = await pollResult<T>(docKey, requestId, timeoutMs)
  if (result.request_id !== requestId) throw new Error('插件回执与请求不匹配，已丢弃')
  if (!result.ok) {
    const reason = (result.data as { reason?: string } | null)?.reason
    const err = new Error(result.error || '插件任务失败') as Error & { reason?: string }
    if (result.data && reason) err.reason = reason
    throw err
  }
  return (result.data ?? {}) as T
}

/** 插件就绪状态（轮询心跳；侧栏据此启用入口，不伪装可执行）。 */
export async function bridgeAlive(docKey: string): Promise<boolean> {
  try {
    const r = await req<{ alive: boolean }>(`/api/office-plugin-refs/bridge?doc_key=${enc(docKey)}`)
    return r.alive
  } catch {
    return false
  }
}

/** 文档会话键刷新（key 会随 DS 会话轮换；409 stale 时刷新重试一次）。 */
export async function refreshDocKey(pid: string): Promise<string | null> {
  try {
    const r = await req<WordStateLike>(`/api/projects/${enc(pid)}/word/state`)
    return r.doc_key ?? null
  } catch {
    return null
  }
}

/** 带会话键自愈的下发：doc_key 过期（409 stale）→ 刷新重试一次。 */
export async function runRefsTaskAuto<T = Record<string, unknown>>(
  pid: string,
  getDocKey: () => string | null,
  setDocKey: (k: string) => void,
  kind: string,
  payload: Record<string, unknown>,
  timeoutMs = 45000,
): Promise<T> {
  const first = getDocKey()
  if (!first) throw new Error('编辑器会话未就绪（缺少文档会话键）')
  try {
    return await runRefsTask<T>(pid, first, kind, payload, timeoutMs)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('会话已更新') && !msg.includes('stale')) throw e
    const fresh = await refreshDocKey(pid)
    if (!fresh) throw e
    setDocKey(fresh)
    return await runRefsTask<T>(pid, fresh, kind, payload, timeoutMs)
  }
}

export const refsPluginApi = { runRefsTask, runRefsTaskAuto, bridgeAlive, refreshDocKey }
