export interface ErrorDetail {
  kind: string
  message: string
  line: number | null
  detail: string | null
}

const isErrorDetail = (d: unknown): d is ErrorDetail =>
  typeof d === 'object' && d !== null && typeof (d as ErrorDetail).message === 'string'

export class ApiError extends Error {
  status: number
  detail: ErrorDetail | null
  constructor(status: number, message: string, detail: ErrorDetail | null = null) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

/** 后端错误码（backend/app/errors.py ErrorKind）；前端按 kind 选文案 */
export type W5ErrorKind =
  | 'not_implemented'
  | 'ai_disabled_by_org'
  | 'ai_disabled'
  | 'budget'
  | 'share.expired'
  | 'share.revoked'
  | 'oa.pdf_no_text'
  | 'not_found'
  | 'forbidden'

export const errorKind = (e: unknown): W5ErrorKind | string | null => (e instanceof ApiError ? (e.detail?.kind ?? null) : null)
export const isNotImplemented = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 501
export const isAiDisabledByOrg = (e: unknown): boolean => errorKind(e) === 'ai_disabled_by_org'
export const isBudgetExceeded = (e: unknown): boolean => e instanceof ApiError && e.status === 429 && errorKind(e) === 'budget'
export const isShareExpired = (e: unknown): boolean => errorKind(e) === 'share.expired' || errorKind(e) === 'share.revoked'
export const isShareNotFound = (e: unknown): boolean => e instanceof ApiError && e.status === 404

type QueryValue = string | number | boolean | null | undefined
export const qs = <T extends object>(params: T) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params) as [string, QueryValue][]) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

let lastNetToastAt = 0
function toastNetFailure() {
  const now = Date.now()
  if (now - lastNetToastAt < 3000) return
  lastNetToastAt = now
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  void import('@/store').then((m) => m.useStudio.getState().toast(offline ? '网络已离线，操作未发送' : '网络不可用，请检查连接', 'error'))
}

export async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (e) {
    if (e instanceof TypeError) toastNetFailure()
    throw e
  }
}

export const REQ_TIMEOUT_MS = 120_000
type ReqInit = RequestInit & { timeout?: number | false; expireOn401?: boolean }

export function withFetchTimeout(caller: AbortSignal | undefined, ms: number = REQ_TIMEOUT_MS): AbortSignal | undefined {
  return reqSignal(caller, ms)
}

export function reqSignal(caller: AbortSignal | undefined, ms: number | false): AbortSignal | undefined {
  if (ms === false) return caller
  const t = AbortSignal.timeout(ms)
  return caller ? AbortSignal.any([caller, t]) : t
}

export async function req<T>(url: string, init?: ReqInit): Promise<T> {
  const { timeout, expireOn401, ...rest } = init ?? {}
  const form = rest.body instanceof FormData
  try {
    const r = await netFetch(url, {
      ...rest,
      signal: reqSignal(rest.signal ?? undefined, form ? false : (timeout ?? REQ_TIMEOUT_MS)),
      headers: form ? rest.headers : { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
    })
    return await handle<T>(r, { expireOn401 })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new ApiError(0, '请求超时，请检查网络后重试')
    }
    throw e
  }
}

const STATUS_ZH: Record<number, string> = {
  400: '请求不合法',
  401: '未登录或登录已过期',
  403: '没有权限执行此操作',
  404: '资源不存在',
  405: '请求方法不允许',
  409: '操作冲突，请刷新后重试',
  410: '链接已过期或已撤销',
  413: '请求体过大',
  422: '参数校验失败',
  429: '请求过于频繁，请稍后再试',
  500: '服务端错误',
  502: '网关错误，请稍后再试',
  503: '服务暂不可用，请稍后再试',
}

function pydanticDetailText(detail: unknown[]): string | null {
  const parts = detail.map((d) => {
    if (typeof d !== 'object' || d === null) return null
    const msg = (d as { msg?: unknown }).msg
    if (typeof msg !== 'string' || !msg) return null
    const loc = (d as { loc?: unknown }).loc
    const field = Array.isArray(loc) && typeof loc.at(-1) === 'string' ? String(loc.at(-1)) : ''
    const zh = /not a valid email/i.test(msg)
      ? '邮箱格式无效'
      : /field required/i.test(msg)
        ? '缺少必填字段'
        : /at least (\d+) characters?/i.test(msg)
          ? `至少 ${msg.match(/at least (\d+) characters?/i)?.[1]} 个字符`
          : msg
    return field && field !== 'body' ? `${field}：${zh}` : zh
  })
  const ok = parts.filter((p): p is string => Boolean(p))
  return ok.length ? ok.join('；') : null
}

export async function handle<T>(r: Response, opts?: { expireOn401?: boolean }): Promise<T> {
  if (!r.ok) {
    if (r.status === 401 && opts?.expireOn401 !== false) {
      void import('@/store').then((m) => m.useStudio.getState().expireSession())
    }
    let msg = STATUS_ZH[r.status] ?? r.statusText
    let detail: ErrorDetail | null = null
    try {
      const j = (await r.json()) as { detail?: unknown }
      if (typeof j.detail === 'string') msg = j.detail
      else if (isErrorDetail(j.detail)) {
        detail = j.detail
        msg = detail.message
      } else if (Array.isArray(j.detail)) {
        msg = pydanticDetailText(j.detail) ?? STATUS_ZH[r.status] ?? r.statusText
      } else if (j.detail) msg = JSON.stringify(j.detail)
    } catch {
      /* ignore */
    }
    throw new ApiError(r.status, msg, detail)
  }
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}

export const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`
export const PUB = (token: string) => `/api/public/${encodeURIComponent(token)}`

export interface SseOptions {
  onDelta?: (chunk: string) => void
  signal?: AbortSignal
  timeout?: number | false
  expireOn401?: boolean
}

/** POST 并消费 text/event-stream；若响应非流式（如单测 mock JSON），自动降级为 handle<T>()。 */
export async function postSse<T>(url: string, body: unknown, opts: SseOptions = {}): Promise<T> {
  const { onDelta, signal, timeout = REQ_TIMEOUT_MS, expireOn401 } = opts
  let r: Response
  try {
    r = await netFetch(url, {
      method: 'POST',
      signal: reqSignal(signal, timeout),
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body ?? {}),
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new ApiError(0, '请求超时，请检查网络后重试')
    }
    throw e
  }
  if (!r.ok) {
    return await handle<T>(r, { expireOn401 })
  }
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('text/event-stream') || !r.body) {
    return await handle<T>(r, { expireOn401 })
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let donePayload: T | undefined
  let errMsg = ''
  const processFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/)
    let evName = 'message'
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) evName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) return
    const raw = dataLines.join('\n')
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      parsed = null
    }
    if (evName === 'delta') {
      const chunk = typeof parsed?.text === 'string' ? parsed.text : raw
      if (chunk) onDelta?.(chunk)
    } else if (evName === 'done') {
      donePayload = (parsed ?? raw) as T
    } else if (evName === 'error') {
      errMsg = typeof parsed?.message === 'string' ? parsed.message : raw || '生成失败'
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split(/\r?\n\r?\n/)
    buf = frames.pop() ?? ''
    for (const f of frames) {
      if (f.trim()) processFrame(f)
      if (errMsg) throw new ApiError(502, errMsg)
    }
  }
  if (buf.trim()) {
    processFrame(buf)
    if (errMsg) throw new ApiError(502, errMsg)
  }
  if (donePayload === undefined) {
    throw new ApiError(502, '流式响应未完整结束')
  }
  return donePayload
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
