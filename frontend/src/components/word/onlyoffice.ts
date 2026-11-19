export interface OnlyOfficeEditor {
  destroyEditor(): void
}

export interface OnlyOfficeApi {
  DocEditor: new (id: string, config: Record<string, unknown>) => OnlyOfficeEditor
}

declare global {
  interface Window { DocsAPI?: OnlyOfficeApi }
}

const loading = new Map<string, Promise<OnlyOfficeApi>>()
let loadedFrom: string | null = null

/** 同一文档服务共用一次脚本加载；失败可重试，路由卸载不破坏其他工作台。 */
export function loadOnlyOffice(documentServerUrl: string): Promise<OnlyOfficeApi> {
  const server = new URL(documentServerUrl, window.location.origin)
  if (server.protocol !== 'https:' && server.protocol !== 'http:') return Promise.reject(new Error('Word 文档服务地址无效'))
  const src = `${server.href.replace(/\/$/, '')}/web-apps/apps/api/documents/api.js`
  if (window.DocsAPI && (!loadedFrom || loadedFrom === src)) return Promise.resolve(window.DocsAPI)
  if (window.DocsAPI && loadedFrom !== src) return Promise.reject(new Error('文档服务地址已变更，请刷新页面后重试'))
  const current = loading.get(src)
  if (current) return current
  const promise = new Promise<OnlyOfficeApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.dataset.onlyoffice = 'true'
    const fail = () => {
      window.clearTimeout(timer)
      loading.delete(src)
      script.remove()
      reject(new Error('Word 编辑器加载失败，请检查文档服务连接后重试'))
    }
    const timer = window.setTimeout(fail, 30_000)
    script.onerror = fail
    script.onload = () => {
      window.clearTimeout(timer)
      if (!window.DocsAPI) { fail(); return }
      loadedFrom = src
      resolve(window.DocsAPI)
    }
    document.head.appendChild(script)
  })
  loading.set(src, promise)
  return promise
}
