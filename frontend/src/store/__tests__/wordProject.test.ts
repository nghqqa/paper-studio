// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useStudio } from '@/store'

afterEach(() => {
  vi.restoreAllMocks()
  useStudio.getState().closeWorkspace()
})

describe('Word 项目隔离', () => {
  it('打开 DOCX 只加载项目元数据，不额外触发前端构建或正文请求', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(api, 'project').mockResolvedValue({
      id: 'word-project', title: '原稿', mtime: 1, settings: { source_format: 'docx' },
    })
    useStudio.setState({ pid: null, project: null })
    await useStudio.getState().openProject('word-project')
    expect(useStudio.getState().project?.settings.source_format).toBe('docx')
    expect(fetch).not.toHaveBeenCalled()
    useStudio.getState().closeWorkspace()
    expect(useStudio.getState().pid).toBeNull()
    expect(useStudio.getState().project).toBeNull()
  })
})
