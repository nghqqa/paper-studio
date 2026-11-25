// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commentsApi } from '@/lib/api/comments'
import { CommentsSidebar } from '../CommentsSidebar'

vi.mock('@/lib/api/comments', () => ({
  commentsApi: {
    comments: vi.fn(),
    addComment: vi.fn(),
    replyComment: vi.fn(),
    resolveComment: vi.fn(),
  },
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  vi.resetAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root?.unmount()); root = null; host?.remove() })

describe('CommentsSidebar 外部导师页级批注展示与跳页', () => {
  it('默认当前文件视图也展示免登录外部审阅 pdf:page-N 批注并可跳页', async () => {
    vi.mocked(commentsApi.comments).mockResolvedValue([
      {
        id: 'cm-ext',
        body: '公式 (3) 符号未定义',
        resolved: false,
        anchor: { block_id: 'pdf:page-2', line: 2, quote: '第 2 页' },
        author: { id: null, name: '张导师' },
        created_at: 1700000000,
        updated_at: 1700000000,
        replies: [],
        source: 'client',
      },
    ])
    const onJump = vi.fn()
    const onJumpPage = vi.fn()
    await act(async () => {
      root!.render(
        <CommentsSidebar
          pid="p1"
          activePath="main.tex"
          savedSha="sha1"
          dirty={false}
          currentLine={1}
          onJump={onJump}
          onJumpPage={onJumpPage}
          reloadSignal={0}
        />,
      )
    })
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toContain('外部审阅')
    expect(host.textContent).toContain('公式 (3) 符号未定义')
    const jumpBtn = host.querySelector<HTMLButtonElement>('[data-testid="latex-comment-jump-page-cm-ext"]')!
    expect(jumpBtn.textContent).toContain('PDF 第 2 页')
    await act(async () => jumpBtn.click())
    expect(onJumpPage).toHaveBeenCalledWith(2)
  })
})
