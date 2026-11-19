import { useEffect, useRef, useState } from 'react'
import '@excalidraw/excalidraw/index.css'
import { Excalidraw } from '@excalidraw/excalidraw'
import { Loader2, Wand2 } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { figuresApi, type ProjectFigure } from '@/lib/api/projectFigures'
import { applyScene, blobToDataUrl, exportPng, mermaidToScene, restoreScene, serializeScene,
         type DiagramApi, type SceneData } from './diagramBridge'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 方法图编辑器弹窗：@excalidraw/* 唯一挂载点（本组件只经 ScientificFigures 的 React.lazy 按需加载）。
 *  编辑真源 = .excalidraw 场景 JSON（重开完整恢复节点位置与内嵌资源）；保存时同步导出高清 PNG。 */
export function DiagramEditor({ pid, figure, onClose, onSaved }: {
  pid: string
  figure: ProjectFigure | null
  onClose: () => void
  onSaved: (figure: ProjectFigure) => void
}) {
  const apiRef = useRef<DiagramApi | null>(null)
  // 冷载竞态：场景请求先于 excalidrawAPI 回调就绪时暂存，API 挂上后再应用（BoardPage 同款兜底）
  const pendingRef = useRef<SceneData | null>(null)
  const [name, setName] = useState(figure?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!!figure)
  const [err, setErr] = useState('')
  const [mermaidOpen, setMermaidOpen] = useState(false)
  const [mermaidCode, setMermaidCode] = useState('')

  useEffect(() => {
    if (!figure) return
    let alive = true
    figuresApi.getScene(pid, figure.id).then(async (reply) => {
      const data = await restoreScene(reply.scene)
      if (!alive) return
      const api = apiRef.current
      if (api) applyScene(api, data)
      else pendingRef.current = data
    }).catch((error: unknown) => {
      if (alive) setErr(`场景加载失败：${errorText(error)}`)
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [pid, figure])

  function onApi(api: DiagramApi) {
    apiRef.current = api
    if (pendingRef.current) {
      applyScene(api, pendingRef.current)
      pendingRef.current = null
    }
  }

  async function save() {
    const api = apiRef.current
    if (!api || busy) return
    setBusy(true); setErr('')
    try {
      const scene = serializeScene(api)
      const { blob } = await exportPng(api)
      const png_data_url = await blobToDataUrl(blob)
      const reply = figure
        ? await figuresApi.updateDiagram(pid, figure.id, {
            name: name || figure.name, scene, png_data_url,
            expected_version: figure.version ?? 1,
          })
        : await figuresApi.createDiagram(pid, { name: name || '未命名方法图', scene, png_data_url })
      onSaved(reply.figure)
    } catch (error) {
      setErr(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function applyMermaid() {
    const api = apiRef.current
    const code = mermaidCode.trim()
    if (!api || !code || busy) return
    // 已有内容的画布被 Mermaid 覆盖必须显式确认：保存过的 .excalidraw 布局不可静默丢失。
    if (api.getSceneElements().length > 0
      && !confirm('应用 Mermaid 将覆盖当前画布布局与内容，确认继续？')) return
    setBusy(true); setErr('')
    try {
      applyScene(api, await mermaidToScene(code))
      setMermaidOpen(false); setMermaidCode('')
    } catch (error) {
      setErr(`Mermaid 解析失败：${errorText(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="diagram-editor-dialog" size="lg" data-testid="diagram-editor">
        <DialogHeader>
          <DialogTitle>{figure ? `编辑方法图 · v${figure.version ?? 1}` : '新建方法图'}</DialogTitle>
          <div className="diagram-editor-toolbar">
            <label htmlFor="diagram-editor-name" className="sr-only">方法图名称</label>
            <input id="diagram-editor-name" data-testid="diagram-editor-name" value={name}
              onChange={(e) => setName(e.target.value)} placeholder="例如：模型总体架构" maxLength={120} />
            <button type="button" className="paper-secondary" data-testid="diagram-editor-mermaid"
              onClick={() => setMermaidOpen((v) => !v)} disabled={busy}>
              <Wand2 aria-hidden /> {mermaidOpen ? '收起 Mermaid' : 'Mermaid 导入'}
            </button>
          </div>
          {mermaidOpen && (
            <div className="diagram-editor-mermaid">
              <textarea data-testid="diagram-editor-mermaid-code" rows={4} value={mermaidCode}
                onChange={(e) => setMermaidCode(e.target.value)}
                placeholder={'graph TD\n  A[数据] --> B[模型] --> C[输出]'} />
              <button type="button" className="paper-secondary" data-testid="diagram-editor-mermaid-apply"
                onClick={() => void applyMermaid()} disabled={busy || !mermaidCode.trim()}>
                应用到画布
              </button>
            </div>
          )}
        </DialogHeader>
        {err && <p className="paper-figures-error" role="alert">{err}</p>}
        <div className="diagram-editor-canvas" data-testid="diagram-editor-canvas">
          {loading && <p role="status"><Loader2 className="paper-figures-loading" aria-hidden />正在加载场景…</p>}
          <Excalidraw excalidrawAPI={onApi} theme="light" />
        </div>
        <DialogFooter>
          <button type="button" className="paper-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="paper-primary" data-testid="diagram-editor-save"
            onClick={() => void save()} disabled={busy || loading}>
            {busy && <Loader2 className="paper-figures-loading-inline" aria-hidden />}
            {figure ? '保存更新' : '保存到图表库'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DiagramEditor
