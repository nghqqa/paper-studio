// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useStudio } from '@/store'
import type { ProjectDetail } from '@/lib/types'

afterEach(() => {
  vi.restoreAllMocks()
  useStudio.getState().closeWorkspace()
})

describe('Word 项目隔离', () => {
  it('打开 DOCX 只加载项目元数据，不启动 Markdown 构建或正文解析', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(api, 'project').mockResolvedValue({
      id: 'word-project', title: '原稿', settings: { source_format: 'docx' }, content: '', figs: [], backups: [],
    } as unknown as ProjectDetail)
    useStudio.setState({ pid: null, project: null, content: '旧稿', saved: '旧稿' })
    await useStudio.getState().openProject('word-project')
    expect(useStudio.getState().project?.settings.source_format).toBe('docx')
    expect(useStudio.getState().content).toBe('')
    expect(useStudio.getState().phase).toBe('idle')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('通用 Markdown 保存与构建入口无法写入 DOCX 项目', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    useStudio.setState({ pid: 'word-project', project: { id: 'word-project', settings: { source_format: 'docx' } } as ProjectDetail, content: '', saved: '' })
    expect(await useStudio.getState().save()).toBe(false)
    useStudio.getState().enqueue('manual', true)
    expect(fetch).not.toHaveBeenCalled()
  })
})
