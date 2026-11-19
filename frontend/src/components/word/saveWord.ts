import { wordApi, type WordState } from '@/lib/api/word'

/** forcesave 受理不代表文件已回传；只在收到已持久化状态后允许下载。 */
export async function saveWordAndWait(pid: string, options: {
  signal: AbortSignal
  onState: (state: WordState) => void
  timeoutMs?: number
  pollMs?: number
}): Promise<WordState> {
  const check = () => options.signal.throwIfAborted()
  check()
  const result = await wordApi.save(pid)
  check()
  if (!result.request_id) throw new Error('文档服务未返回本次保存标识，请保留编辑器并重试。')
  const deadline = Date.now() + (options.timeoutMs ?? 45_000)
  while (Date.now() < deadline) {
    check()
    const state = await wordApi.state(pid)
    check()
    options.onState(state)
    if (state.last_error) throw new Error(state.last_error)
    // 其他协作者或自动保存也可能更新 SHA；只接受包含本次 request_id 的成功回调。
    if (!state.saving && state.last_saved_request_id === result.request_id) return state
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { window.clearTimeout(timer); reject(options.signal.reason) }
      const timer = window.setTimeout(() => { options.signal.removeEventListener('abort', cancel); resolve() }, options.pollMs ?? 750)
      options.signal.addEventListener('abort', cancel, { once: true })
    })
  }
  throw new Error('尚未收到文档保存确认。请保留此页面，稍后重试；此次未下载文件。')
}
