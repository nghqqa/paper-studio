// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DoctorPanel } from '@/components/admin/DoctorPanel'
import { LoginPage } from '@/components/auth/LoginPage'
import { ScientificFigures } from '@/components/figures/ScientificFigures'
import { LanguageToggle } from '@/components/shell/LanguageToggle'
import { accountApi } from '@/lib/api/account'
import { figuresApi } from '@/lib/api/projectFigures'
import * as downloadMod from '@/lib/download'
import { setLocale } from '@/lib/i18n'
import { useStudio } from '@/store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= (q: string) =>
    ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})

beforeEach(() => {
  localStorage.clear()
  setLocale('zh-CN')
  useStudio.setState({
    authStatus: 'anon',
    user: null,
    authError: null,
    demoMode: false,
    oidc: { enabled: false, label: '机构单点登录 (SSO)' },
    registrationPolicy: { mode: 'open', inviteCodeRequired: false, allowedDomains: [] },
    project: { id: 'p1', title: '测试论文', settings: { source_format: 'latex' } } as never,
    projects: [{ id: 'p1', title: '测试论文', mtime: 1, source_format: 'latex', my_role: 'owner' }],
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  setLocale('zh-CN')
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

describe('Wave 3 平台化与国际化前端回归', () => {
  it('LanguageToggle：支持中英文切换并持久化到 localStorage', async () => {
    await act(async () => {
      root!.render(<LanguageToggle />)
    })
    const btn = host!.querySelector<HTMLButtonElement>('[data-testid="locale-toggle"]')!
    expect(btn.textContent).toContain('EN')

    await act(async () => btn.click())
    expect(localStorage.getItem('paper-studio-locale')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(btn.textContent).toContain('中文')

    await act(async () => btn.click())
    expect(localStorage.getItem('paper-studio-locale')).toBe('zh-CN')
  })

  it('ScientificFigures：支持新图表类型并可通过 Vision 上传截图回填 JSON', async () => {
    useStudio.setState({ authStatus: 'off' })
    vi.spyOn(figuresApi, 'list').mockResolvedValue({ figures: [] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          chart: {
            type: 'radar',
            title: 'Vision Extracted Radar',
            x_label: '',
            y_label: '',
            categories: ['Acc', 'F1', 'FPS'],
            series: [{ name: 'Ours', values: [94, 92, 80] }],
          },
          model: 'm-vision',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await act(async () => {
      root!.render(<ScientificFigures pid="p1" embedded />)
    })
    await act(async () => { await Promise.resolve() })

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="figures-new"]')!.click())
    const sel = host!.querySelector<HTMLSelectElement>('#fig-type')!
    const opts = [...sel.options].map((o) => o.value)
    expect(opts).toEqual(expect.arrayContaining(['radar', 'violin', 'forest', 'grouped_bar']))

    const fileInput = host!.querySelector<HTMLInputElement>('[data-testid="figure-vision-input"]')!
    const imgFile = new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [imgFile] })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sel.value).toBe('radar')
    expect(host!.querySelector<HTMLTextAreaElement>('#fig-data')!.value).toContain('94')
  })

  it('LoginPage：按 meta.oidc.enabled 条件展示企业单点登录入口且保护唯一主按钮', async () => {
    await act(async () => {
      root!.render(<LoginPage />)
    })
    expect(host!.querySelector('[data-testid="login-oidc-btn"]')).toBeNull()

    await act(async () => {
      useStudio.setState({ oidc: { enabled: true, label: '校园统一认证' } })
    })
    const ssoBtn = host!.querySelector<HTMLButtonElement>('[data-testid="login-oidc-btn"]')!
    expect(ssoBtn).not.toBeNull()
    expect(ssoBtn.textContent).toBe('校园统一认证')
    expect(ssoBtn.className).not.toContain('h-touch')
  })

  it('DoctorPanel：加载并渲染数据存储健康概览与备份导出链接', async () => {
    vi.spyOn(accountApi, 'doctor').mockResolvedValue({
      overall: 'ok',
      checked_at: 1700000000,
      product: 'paper',
      demo_mode: false,
      checks: [{ id: 'auth', name: '鉴权配置', status: 'ok', summary: '正常', hint: '' }],
    })
    vi.spyOn(accountApi, 'dataHealth').mockResolvedValue({
      checked_at: 1700000000,
      project_count: 5,
      formats: { latex: 3, docx: 2, markdown: 0 },
      storage: { projects_bytes: 2048000, build_cache_bytes: 512000, shared_assets_bytes: 4096, db_bytes: 65536, total_bytes: 2629632 },
      db: { exists: true, ok: true, message: 'ok', bytes: 65536 },
      disk: { total_bytes: 100000000, used_bytes: 20000000, free_bytes: 80000000 },
      corrupt_settings: [],
      top_projects: [{ pid: 'p1', title: '测试论文', total_bytes: 1024000, cache_bytes: 128000 }],
    })

    const dlSpy = vi.spyOn(downloadMod, 'downloadFile').mockResolvedValue('paper-studio-backup.zip')

    await act(async () => {
      root!.render(<DoctorPanel />)
    })
    await act(async () => { await Promise.resolve() })

    const box = host!.querySelector('[data-testid="admin-data-health"]')!
    expect(box.textContent).toContain('SQLite: 完整正常')
    expect(box.textContent).toContain('5 篇')
    expect(box.textContent).toContain('LaTeX 3 / Word 2')
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="admin-data-backup-btn"]')!.click())
    expect(dlSpy).toHaveBeenCalledWith('/api/admin/data/backup?include_projects=false', 'paper-studio-backup.zip')
  })
})
