// @vitest-environment jsdom
/**
 * 文案回归：落地页与 index.html 元信息统一为「研稿 · Paper Studio」论文写作与审阅定位。
 * 防旧品牌（「知撰」「专利撰写与协同平台」「协作办案」）与专利业务文案
 * （代理师/说明书/技术领域/本发明/权利要求/WK 案号）在主入口复现；
 * 防宣传未实现能力（AI 提案、任意模板导入、实时协同等）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import indexHtml from '../../../../index.html?raw'
import { AuthBrand } from '../AuthFrame'
import { LoginPage } from '../LoginPage'
import { LandingPage } from '../LandingPage'
import { LegalPage } from '../LegalPage'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

async function renderLoginPage(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host)
    root.render(<LoginPage />)
  })
  return host
}

async function renderLanding(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host)
    root.render(<LandingPage />)
  })
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
})

function ldBlocks(): Record<string, unknown>[] {
  return [...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => JSON.parse(m[1]) as Record<string, unknown>,
  )
}

describe('产品文案统一（研稿 · Paper Studio）', () => {
  it('index.html 元信息：正式名 + 论文工作空间定位，无旧品牌与旧定位', () => {
    expect(indexHtml).toContain('<title>研稿 · Paper Studio')
    expect(indexHtml).toContain('论文写作与审阅工作空间')
    expect(indexHtml).not.toContain('知撰')
    expect(indexHtml).not.toContain('专利撰写')
    expect(indexHtml).not.toContain('协作办案')
    expect(indexHtml).toContain('LaTeX')
  })

  it('JSON-LD：SoftwareApplication / FAQ 可解析，页面 FAQ 全部问答与 JSON-LD 一致', async () => {
    const blocks = ldBlocks()
    const app = blocks.find((b) => b['@type'] === 'SoftwareApplication') as Record<string, string>
    const faq = blocks.find((b) => b['@type'] === 'FAQPage') as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[]
    }
    expect(app?.name).toBe('研稿 · Paper Studio')
    expect(app?.description).toContain('论文')
    expect(Array.isArray(faq?.mainEntity)).toBe(true)
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(4)
    const el = await renderLanding()
    const pageFaq = [...el.querySelectorAll('#faq details')].map((d) => ({
      name: d.querySelector('summary')?.textContent?.trim() ?? '',
      text: d.querySelector('summary + p')?.textContent?.trim() ?? '',
    }))
    const ldFaq = faq.mainEntity.map((e) => ({ name: e.name, text: e.acceptedAnswer?.text ?? '' }))
    expect(pageFaq).toEqual(ldFaq)
    // 落地页文案不得宣传未实现能力
    const allFaqText = pageFaq.map((f) => f.name + f.text).join()
    for (const banned of ['AI 提案', '实时协同编辑', '模板市场']) {
      expect(allFaqText).not.toContain(banned)
    }
  })

  it('登录/注册页装饰样张与占位符：论文视角，无专利业务文案（E2E 实测缺陷回归）', async () => {
    // 装饰样张（AuthBrand 内 PaperSample）：应为 LaTeX 论文形态，非「WK 案号·说明书·技术领域」
    const brand = document.createElement('div')
    document.body.appendChild(brand)
    await act(async () => {
      root = createRoot(brand)
      root.render(<AuthBrand />)
    })
    try {
      const brandText = brand.textContent ?? ''
      expect(brandText).toContain('Word / LaTeX')
      expect(brand.querySelector('img[src="/auth-scroll.webp"]')).toBeNull()
      expect(brandText).toContain('引言')
      for (const banned of ['WK2026', '说明书', '技术领域', '背景技术', '本发明', '权利要求', '代理师']) {
        expect(brandText).not.toContain(banned)
      }
    } finally {
      await act(async () => root?.unmount())
      brand.remove()
      root = null
    }
    // 登录/注册页：注册显示名占位符应为论文用户视角
    const el = await renderLoginPage()
    const text = el.textContent ?? ''
    for (const banned of ['代理师', '说明书', '本发明', '权利要求', 'WK2026']) {
      expect(text).not.toContain(banned)
    }
    const placeholder = el.querySelector('input[placeholder^="如："]')?.getAttribute('placeholder') ?? ''
    expect(placeholder).not.toContain('代理师')
  })

  it('落地页：正式名 + 论文定位 + 师生角色，如实能力描述，无旧品牌', async () => {
    const el = await renderLanding()
    const text = el.textContent ?? ''
    expect(text).toContain('研稿 · Paper Studio')
    expect(text).toContain('批注与协作')
    expect(text).toContain('自动保存')
    for (const s of ['学生 / 研究生', '导师']) expect(text).toContain(s)
    // 旧品牌与未实现能力不得出现
    expect(text).not.toContain('知撰')
    expect(text).not.toContain('专利')
    expect(text).not.toContain('协作办案')
    expect(text).not.toContain('AI 办案成员')
    // 如实标注当前面向场景
    expect(text).toContain('按项目权限')
    const imgSrcs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')
    expect(imgSrcs.some((s) => s.includes('paper-latex'))).toBe(true)
    expect(imgSrcs.some((s) => s.includes('paper-word'))).toBe(true)
    expect(imgSrcs.some((s) => s.includes('paper-projects'))).toBe(true)
  })

  it.each(['terms', 'privacy', 'copyright'])('公开说明页面 %s 使用论文场景且不含旧业务描述', async (page) => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => root!.render(<LegalPage page={page} />))
    expect(host.textContent).toContain('论文')
    expect(host.textContent).not.toMatch(/专利|发明人|代理师|案卷|权利要求|说明书|CNIPA/)
  })
})
