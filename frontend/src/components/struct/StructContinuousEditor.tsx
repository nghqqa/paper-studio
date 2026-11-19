import { useEffect, useRef } from 'react'
import { EditorState, Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { baseKeymap } from 'prosemirror-commands'
import { Node as PMNode } from 'prosemirror-model'
import { structSchema } from './pm/schema'
import { contentToPM, pmToContent } from './pm/adapters'
import { ktHtml, formulaWarn } from './kt'
import type { StructContent } from '@/lib/api/struct'

/**
 * 结构化连续编辑器（v0.2）：单一连续画布直接写标题/段落/公式/引用，
 * 底层仍为 StructContent JSON 协议（contentToPM/pmToContent 纯函数互转，往返深度相等）。
 * 契约：
 * - content 仅在挂载时读取一次（外部内容变化由父层 key 重挂载；保存成功不回灌）；
 * - 每次事务后经 pmToContent 上抛 onChange（父层持有唯一草稿，卡片回退视图共用）；
 * - 中文 IME：composition 期间绝不重置 EditorState（PM 原生处理）。
 */

const editorSchema = structSchema

export type ContinuousObjects = { kind: 'eq' | 'fig' | 'tab'; id: string; label: string }[]

export type ContinuousProps = {
  content: StructContent
  canEdit: boolean
  pid: string
  numbering: Record<string, string>
  objects: ContinuousObjects
  onChange: (c: StructContent) => void
  onNotice?: (text: string) => void
  onUploadFigure?: (objectId: string, file: File) => Promise<string | null>
}

function newObjectId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

/** 公式编辑浮层（确认/取消语义明确） */
function formulaPopover(dom: HTMLElement, initial: string, onDone: (latex: string | null) => void): () => void {
  const wrap = document.createElement('div')
  wrap.className = 'struct-fx-popover'
  wrap.innerHTML = `
    <textarea class="struct-fx-input" rows="3"></textarea>
    <div class="struct-fx-preview"></div>
    <div class="struct-fx-warn"></div>
    <div class="flex gap-1 justify-end mt-1">
      <button type="button" data-act="cancel" class="struct-fx-btn">取消</button>
      <button type="button" data-act="ok" class="struct-fx-btn struct-fx-btn-primary">确认</button>
    </div>`
  const ta = wrap.querySelector('textarea') as HTMLTextAreaElement
  const prev = wrap.querySelector('.struct-fx-preview') as HTMLElement
  const warn = wrap.querySelector('.struct-fx-warn') as HTMLElement
  ta.value = initial
  const render = () => {
    prev.innerHTML = ktHtml(ta.value, true)
    const bad = formulaWarn(ta.value)
    warn.textContent = bad.length ? `导出将被阻断：不支持 ${bad.join('、')}` : ''
  }
  ta.addEventListener('input', render)
  render()
  wrap.querySelector('[data-act="ok"]')!.addEventListener('mousedown', (e) => { e.preventDefault(); onDone(ta.value) })
  wrap.querySelector('[data-act="cancel"]')!.addEventListener('mousedown', (e) => { e.preventDefault(); onDone(null) })
  dom.appendChild(wrap)
  ta.focus()
  return () => { wrap.remove() }
}

type NV = {
  dom: HTMLElement
  update?: (node: PMNode) => boolean
  stopEvent?: (ev: Event) => boolean
  ignoreMutation?: () => boolean
  destroy?: () => void
}

class FormulaNodeView implements NV {
  dom: HTMLElement
  private node: PMNode
  private view: EditorView
  private getPos: () => number | undefined
  private display: boolean
  private close: (() => void) | null = null

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, display: boolean) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.display = display
    this.dom = document.createElement(display ? 'div' : 'span')
    this.dom.className = display ? 'struct-formula-block' : 'struct-formula-inline'
    this.render()
  }

  private render(): void {
    const body = document.createElement('span')
    body.className = 'struct-fx-body'
    body.innerHTML = ktHtml(this.node.attrs.latex as string, this.display)
    body.addEventListener('mousedown', (e) => {
      if (!this.view.editable) return
      e.preventDefault()
      if (this.close) return
      const pos = this.getPos()
      if (pos == null) return
      this.close = formulaPopover(this.dom, this.node.attrs.latex as string, (latex) => {
        this.close?.()
        this.close = null
        if (latex == null) return
        this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'latex', latex))
      })
    })
    this.dom.replaceChildren(body)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    const changed = node.attrs.latex !== this.node.attrs.latex
    this.node = node
    if (changed) this.render()
    return true
  }

  ignoreMutation(): boolean { return true }
  stopEvent(): boolean { return this.close != null }
  destroy(): void { this.close?.() }
}

class InlineRefNodeView implements NV {
  dom: HTMLElement
  private node: PMNode
  private numbering: Record<string, string>
  private lastNumbering: Record<string, string> | null = null

  constructor(node: PMNode, numbering: Record<string, string>) {
    this.node = node
    this.numbering = numbering
    this.dom = document.createElement('span')
    this.render()
  }

  private render(): void {
    const { kind, targetId } = this.node.attrs as { kind: string; targetId: string }
    const label = this.numbering[`${kind}:${targetId}`]
    this.dom.className = label ? 'struct-ref-chip' : 'struct-ref-chip struct-ref-broken'
    this.dom.textContent = label ?? `【失效引用 ${kind}:${targetId}】`
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    const changed = node.attrs.targetId !== this.node.attrs.targetId
      || node.attrs.kind !== this.node.attrs.kind
      || this.numbering !== this.lastNumbering
    this.node = node
    if (changed || !this.dom.textContent) this.render()
    this.lastNumbering = this.numbering
    return true
  }

  ignoreMutation(): boolean { return true }
}

function titleBlockNodeView(node: PMNode, canEdit: boolean, onTitle: (key: string, value: string) => void): NV {
  const wrap = document.createElement('div')
  wrap.className = 'struct-titleblock'
  wrap.setAttribute('contenteditable', 'false')
  const fields: [string, string][] = [
    ['title', '中文标题'], ['title_en', '英文标题'], ['authors', '作者'], ['affil', '单位'], ['keywords', '关键词'],
  ]
  for (const [key, label] of fields) {
    const row = document.createElement('div')
    row.className = 'grid grid-cols-[64px_minmax(0,1fr)] gap-2 items-center'
    const lab = document.createElement('span')
    lab.className = 'text-xs text-fg-muted'
    lab.textContent = label
    const input = document.createElement('input')
    input.className = 'struct-meta-input'
    input.value = (node.attrs as Record<string, string>)[key] ?? ''
    input.disabled = !canEdit
    input.addEventListener('input', () => onTitle(key, input.value))
    row.append(lab, input)
    wrap.append(row)
  }
  return { dom: wrap }
}

function figureNodeView(node: PMNode, view: EditorView, getPos: () => number | undefined, pid: string, canEdit: boolean, onUploadFigure?: ContinuousProps['onUploadFigure']): NV {
  const wrap = document.createElement('figure')
  wrap.className = 'struct-figure'
  const render = (): void => {
    const rid = node.attrs.resource as string
    wrap.replaceChildren()
    if (rid) {
      const img = document.createElement('img')
      img.src = `/api/projects/${encodeURIComponent(pid)}/struct/resources/${encodeURIComponent(rid)}`
      img.className = 'max-h-48 rounded-sm border border-border'
      img.alt = '图'
      wrap.append(img)
    } else {
      const tip = document.createElement('p')
      tip.className = 'text-2xs text-red-600'
      tip.textContent = '未上传图片（导出门禁将阻断）'
      wrap.append(tip)
    }
    if (canEdit && onUploadFigure) {
      const file = document.createElement('input')
      file.type = 'file'
      file.accept = 'image/png,image/jpeg,image/gif'
      file.className = 'text-xs mt-1'
      file.addEventListener('change', () => {
        const f = file.files?.[0]
        if (!f) return
        const pos = getPos()
        if (pos == null) return
        void onUploadFigure(node.attrs.objectId as string, f).then((rid) => {
          if (rid) view.dispatch(view.state.tr.setNodeAttribute(pos, 'resource', rid))
        })
      })
      wrap.append(file)
    }
    const cap = document.createElement('input')
    cap.className = 'struct-caption-input'
    cap.placeholder = '图题（编号自动；可含 [[eq:id]] 与 $…$）'
    cap.value = node.attrs.caption as string
    cap.disabled = !canEdit
    cap.addEventListener('input', () => {
      const pos = getPos()
      if (pos == null) return
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'caption', cap.value))
    })
    wrap.append(cap)
  }
  render()
  return {
    dom: wrap,
    update(n: PMNode): boolean {
      if (n.type !== node.type) return false
      const changed = JSON.stringify(n.attrs) !== JSON.stringify(node.attrs)
      node = n
      if (changed) render()
      return true
    },
  }
}

function tableNodeView(node: PMNode, canEdit: boolean): NV {
  const wrap = document.createElement('div')
  wrap.className = 'struct-table'
  const render = (): void => {
    wrap.replaceChildren()
    const table = document.createElement('table')
    table.className = 'w-full border-collapse text-xs'
    const { caption, header, rows } = node.attrs as { caption: string; header: string[]; rows: string[][] }
    if (header.length) {
      const tr = table.insertRow()
      for (const h of header) {
        const th = document.createElement('th')
        th.className = 'border border-border p-1 font-semibold'
        th.textContent = h
        tr.append(th)
      }
    }
    for (const row of rows) {
      const tr = table.insertRow()
      for (const cell of row) {
        const td = tr.insertCell()
        td.className = 'border border-border p-1'
        td.textContent = cell
      }
    }
    wrap.append(table)
    const cap = document.createElement('input')
    cap.className = 'struct-caption-input mt-1'
    cap.placeholder = '表题（编号自动）'
    cap.value = caption
    cap.disabled = !canEdit
    wrap.append(cap)
    if (canEdit) {
      const bar = document.createElement('div')
      bar.className = 'flex gap-1 mt-1'
      for (const label of ['加行', '加列']) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'struct-fx-btn'
        b.textContent = label
        b.addEventListener('click', () => {
          wrap.dispatchEvent(new CustomEvent('struct-table-edit', { detail: label }))
        })
        bar.append(b)
      }
      wrap.append(bar)
    }
  }
  render()
  return {
    dom: wrap,
    update(n: PMNode): boolean {
      if (n.type !== node.type) return false
      const changed = JSON.stringify(n.attrs) !== JSON.stringify(node.attrs)
      node = n
      if (changed) render()
      return true
    },
  }
}

function unknownNodeView(node: PMNode): NV {
  const box = document.createElement('div')
  box.className = 'struct-unknown'
  const a = node.attrs as { blockType: string; payload: string }
  const p = document.createElement('p')
  p.className = 'font-semibold'
  p.textContent = `未知块（${a.blockType}）· 原样保留`
  const pre = document.createElement('pre')
  pre.className = 'text-2xs whitespace-pre-wrap'
  try {
    pre.textContent = JSON.stringify(JSON.parse(a.payload))
  } catch {
    pre.textContent = a.payload
  }
  box.append(p, pre)
  return { dom: box }
}

export function StructContinuousEditor(props: ContinuousProps & {
  onEditTick?: () => void
  onInsertReady?: (api: ContinuousInsertApi) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const viewRef = useRef<EditorView | null>(null)
  const pendingTitle = useRef(new Map<string, string>())

  useEffect(() => {
    if (!host.current) return
    const doc = editorSchema.nodeFromJSON(contentToPM(props.content) as never)
    let destroyed = false

    const nodeViews: Record<string, (node: PMNode, view: EditorView, getPos: () => number | undefined) => NV> = {
      formula: (node, v, getPos) => new FormulaNodeView(node, v, getPos, true),
      equation_inline: (node, v, getPos) => new FormulaNodeView(node, v, getPos, false),
      ref_inline: (node) => new InlineRefNodeView(node, propsRef.current.numbering),
      title_block: (node) => titleBlockNodeView(node, propsRef.current.canEdit, (key, value) => {
        pendingTitle.current.set(key, value)
      }),
      figure: (node, v, getPos) => figureNodeView(node, v, getPos, propsRef.current.pid, propsRef.current.canEdit, propsRef.current.onUploadFigure),
      struct_table: (node) => tableNodeView(node, propsRef.current.canEdit),
      unknown_block: (node) => unknownNodeView(node),
    }

    const state = EditorState.create({
      doc,
      plugins: [
        history(),
        keymap({
          'Mod-z': () => {
            const v = viewRef.current
            return v && propsRef.current.canEdit ? undo(v.state, v.dispatch) : true
          },
          'Mod-y': () => {
            const v = viewRef.current
            return v && propsRef.current.canEdit ? redo(v.state, v.dispatch) : true
          },
          'Shift-Mod-z': () => {
            const v = viewRef.current
            return v && propsRef.current.canEdit ? redo(v.state, v.dispatch) : true
          },
          ...baseKeymap,
        }),
      ],
    })

    const view = new EditorView(host.current, {
      state,
      editable: () => propsRef.current.canEdit,
      attributes: { class: 'struct-continuous', spellcheck: 'false' },
      nodeViews: nodeViews as never,
      dispatchTransaction(tr: Transaction): void {
        const self = viewRef.current
        if (!self) return
        const next = self.state.apply(tr)
        self.updateState(next)
        if (tr.docChanged) {
          const content = pmToContent(self.state.doc.toJSON() as never)
          propsRef.current.onChange(content)
          propsRef.current.onEditTick?.()
        }
      },
      transformPastedHTML(html: string): string {
        const rich = /<(table|img|ol|ul|h[1-6])\b/i.test(html)
        if (rich) propsRef.current.onNotice?.('富文本已按纯文本粘贴（表格/图片等无法表示的内容不会保留）')
        const div = document.createElement('div')
        div.innerHTML = html
        return div.textContent ?? ''
      },
    })
    viewRef.current = view
    // 诊断/验收钩子：自动化环境合成键盘事件与 PM 不兼容，事务注入用于链路验证
    ;(window as unknown as Record<string, unknown>).__structPMView = view

    // title_block 输入：经队列在 view 就绪后落为事务（title_block 恒为首块）
    const flush = window.setInterval(() => {
      const v = viewRef.current
      if (!v || pendingTitle.current.size === 0) return
      const first = v.state.doc.child(0)
      if (first.type.name !== 'title_block') return
      for (const [key, value] of pendingTitle.current) {
        if ((first.attrs as Record<string, string>)[key] === value) continue
        v.dispatch(v.state.tr.setNodeAttribute(1, key, value))
      }
      pendingTitle.current.clear()
    }, 250)

    props.onInsertReady?.({
      insertFormula: () => insertBlock('formula', { objectId: newObjectId('eq'), latex: '' }),
      insertInlineFormula: () => insertBlock('equation_inline', { latex: '' }),
      insertFigure: () => insertBlock('figure', { objectId: newObjectId('fig'), resource: '', caption: '' }),
      insertTable: () => insertBlock('struct_table', { objectId: newObjectId('tab'), caption: '', header: ['', ''], rows: [['', ''], ['', '']] }),
      insertRef: (kind, id) => insertBlock('ref_inline', { kind, targetId: id }),
      hasFocus: () => viewRef.current?.hasFocus() ?? false,
    })

    return () => {
      destroyed = true
      void destroyed
      window.clearInterval(flush)
      view.destroy()
      viewRef.current = null
    }
    // content 仅在挂载时读取；外部内容变化由父层 key 重挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pid])

  function insertBlock(type: 'formula' | 'figure' | 'struct_table' | 'equation_inline' | 'ref_inline', attrs: Record<string, unknown>): void {
    const v = viewRef.current
    if (!v || !propsRef.current.canEdit) return
    const node = editorSchema.nodes[type].create(attrs)
    const { $from } = v.state.selection
    if (type === 'equation_inline' || type === 'ref_inline') {
      v.dispatch(v.state.tr.replaceSelectionWith(node).scrollIntoView())
    } else {
      const pos = $from.depth > 0 ? $from.after($from.depth) : v.state.doc.content.size
      v.dispatch(v.state.tr.insert(pos, node).scrollIntoView())
    }
    propsRef.current.onEditTick?.()
  }

  return <div ref={host} data-testid="struct-continuous" className="struct-continuous-host" />
}

export interface ContinuousInsertApi {
  insertFormula(): void
  insertInlineFormula(): void
  insertFigure(): void
  insertTable(): void
  insertRef(kind: 'eq' | 'fig' | 'tab', id: string): void
  hasFocus(): boolean
}
