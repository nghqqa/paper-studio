// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/attachments/AttachmentPdf', () => ({
  default: () => null,
  AttachmentPdf: () => null,
}))

import { StructPreviewPane, type PreviewState } from '../StructPreviewPane'

/** 预览面板纯组件合约：状态标签/同链路声明/SHA 与版本/stale 过期标记/失败诊断与重试。 */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => { vi.clearAllMocks() })

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
})

async function mount(el: ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(el))
  return host
}

const done: PreviewState = {
  phase: 'done', sha: 'abcd1234ef567890', vid: 'v003-abc123',
  pdfUrl: '/api/projects/p1/struct/preview/pdf/abcd1234ef567890.pdf',
  durationMs: 2350, cached: false,
}

describe('StructPreviewPane', () => {
  it('完成态：同链路声明 + SHA 前 8 位 + 版本号 + 耗时 + PDF 就绪', async () => {
    const h = await mount(
      <StructPreviewPane state={done} currentSha="abcd1234ef567890" canEdit onRetry={() => {}} />,
    )
    const text = h.textContent ?? ''
    expect(text).toContain('投稿版预览')
    expect(text).toContain('已完成')
    expect(text).toContain('同一转换链路')
    expect(text).toContain('SHA abcd1234')
    expect(text).toContain('v003-abc123')
    expect(text).toContain('2.4s')
    // stale 标记不出现（sha 与当前一致）
    expect(h.querySelector('[data-testid="struct-preview-stale"]')).toBeNull()
  })

  it('内容变化：显示预览过期（旧 SHA vs 当前 SHA）', async () => {
    const h = await mount(
      <StructPreviewPane state={done} currentSha="ffff000011112222" canEdit onRetry={() => {}} />,
    )
    const stale = h.querySelector('[data-testid="struct-preview-stale"]')
    expect(stale).not.toBeNull()
    expect(stale?.textContent).toContain('ffff0000')
    expect(stale?.textContent).toContain('abcd1234')
  })

  it('失败态：可读诊断 + 重试按钮；不渲染 PDF', async () => {
    const h = await mount(
      <StructPreviewPane state={{ phase: 'error', error: 'PDF 转换服务不可用：连接拒绝' }} currentSha="a1" canEdit onRetry={() => {}} />,
    )
    const errBox = h.querySelector('[data-testid="struct-preview-error"]')
    expect(errBox).not.toBeNull()
    expect(errBox?.textContent).toContain('未产生可下载产物')
    expect(errBox?.textContent).toContain('连接拒绝')
    expect(h.querySelector('[data-testid="struct-preview-placeholder"]')?.textContent).toContain('—')
  })

  it('生成中/排队态：phase 标签正确', async () => {
    const h = await mount(
      <StructPreviewPane state={{ phase: 'running' }} currentSha="a1" canEdit onRetry={() => {}} />,
    )
    expect(h.querySelector('[data-testid="struct-preview-phase"]')?.textContent).toBe('生成中…')
    const h2 = await mount(
      <StructPreviewPane state={{ phase: 'queued' }} currentSha="a1" canEdit onRetry={() => {}} />,
    )
    expect(h2.querySelector('[data-testid="struct-preview-phase"]')?.textContent).toBe('排队中…')
  })

  it('只读角色：不出现重试按钮（viewer/reviewer 不可生成）', async () => {
    const h = await mount(
      <StructPreviewPane state={{ phase: 'error', error: 'x' }} currentSha="a1" canEdit={false} onRetry={() => {}} />,
    )
    expect(h.querySelector('[data-testid="struct-preview-error"]')?.querySelector('button')).toBeNull()
  })
})
