// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wordApi, type WordState } from '@/lib/api/word'
import { saveWordAndWait } from '../saveWord'

vi.mock('@/lib/api/word', () => ({ wordApi: { state: vi.fn(), save: vi.fn() } }))
const initial: WordState = { sha: 'old', version: 1, updated_at: '2026-10-21T00:00:00Z', saving: false, versions: [] }

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers() })
afterEach(() => vi.useRealTimers())

describe('Word 保存确认', () => {
  it('受理 forcesave 后只接受本次 request_id 的成功落盘回调', async () => {
    vi.mocked(wordApi.save).mockResolvedValue({ pending: true, request_id: 'my-save' })
    const saved = { ...initial, sha: 'new', version: 3, last_saved_request_id: 'my-save' }
    vi.mocked(wordApi.state).mockResolvedValueOnce({ ...initial, saving: true }).mockResolvedValueOnce({ ...initial, sha: 'other', version: 2, last_saved_request_id: 'other-save' }).mockResolvedValue(saved)
    const onState = vi.fn()
    const result = saveWordAndWait('p', { signal: new AbortController().signal, onState })
    await vi.advanceTimersByTimeAsync(1600)
    await expect(result).resolves.toEqual(saved)
    expect(wordApi.state).toHaveBeenCalledTimes(3)
    expect(onState).toHaveBeenCalledWith(saved)
  })

  it('相同 SHA 的保存也必须由匹配本次 request_id 的回调确认', async () => {
    vi.mocked(wordApi.save).mockResolvedValue({ pending: true, request_id: 'my-save' })
    vi.mocked(wordApi.state).mockResolvedValue({ ...initial, last_saved_request_id: 'my-save' })
    await expect(saveWordAndWait('p', { signal: new AbortController().signal, onState: vi.fn() })).resolves.toMatchObject({ sha: 'old', last_saved_request_id: 'my-save' })
  })

  it('缺少本次保存标识时拒绝伪装成功', async () => {
    vi.mocked(wordApi.save).mockResolvedValue({ pending: false })
    vi.mocked(wordApi.state).mockResolvedValue(initial)
    await expect(saveWordAndWait('p', { signal: new AbortController().signal, onState: vi.fn() })).rejects.toThrow('未返回本次保存标识')
  })

  it('没有回传确认时超时失败，不把已受理请求当保存成功', async () => {
    vi.mocked(wordApi.save).mockResolvedValue({ pending: true, request_id: 'my-save' })
    vi.mocked(wordApi.state).mockResolvedValue(initial)
    const result = saveWordAndWait('p', { signal: new AbortController().signal, onState: vi.fn(), timeoutMs: 1000 })
    const assertion = expect(result).rejects.toThrow('尚未收到文档保存确认')
    await vi.advanceTimersByTimeAsync(1600)
    await assertion
  })

  it('其他保存更新 SHA、版本与时间仍不能代替本次请求确认', async () => {
    vi.mocked(wordApi.save).mockResolvedValue({ pending: true, request_id: 'my-save' })
    vi.mocked(wordApi.state).mockResolvedValue({ ...initial, sha: 'changed', version: 99, updated_at: '2026-10-21T01:00:00Z', last_saved_request_id: 'other-save' })
    const result = saveWordAndWait('p', { signal: new AbortController().signal, onState: vi.fn(), timeoutMs: 1000 })
    const assertion = expect(result).rejects.toThrow('尚未收到文档保存确认')
    await vi.advanceTimersByTimeAsync(1600)
    await assertion
  })

  it('保存请求失败直接传递错误', async () => {
    vi.mocked(wordApi.state).mockResolvedValue(initial)
    vi.mocked(wordApi.save).mockRejectedValue(new Error('无法写入文档'))
    await expect(saveWordAndWait('p', { signal: new AbortController().signal, onState: vi.fn() })).rejects.toThrow('无法写入文档')
  })

  it('回调明确失败时立即报告，不等超时也不报成功', async () => {
    vi.mocked(wordApi.save).mockResolvedValue({ pending: true, request_id: 'my-save' })
    vi.mocked(wordApi.state).mockResolvedValue({ ...initial, last_error: 'ONLYOFFICE 保存失败' })
    await expect(saveWordAndWait('p', { signal: new AbortController().signal, onState: vi.fn() })).rejects.toThrow('ONLYOFFICE 保存失败')
  })
})
