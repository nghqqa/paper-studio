// -*- coding: utf-8 -*-
/**
 * LaTeX 工作台本地草稿存储（w21：保存失败/409 冲突时刷新不丢本地修改）。
 *
 * 定位：同一浏览器、同一站点范围内的未保存草稿恢复；不是服务器备份或跨设备同步。
 * - 键：patent-studio:latex-draft:<userScope>:<pid>:<path>——用户/项目/文件三段隔离，不串稿。
 * - 写入：组件在编辑停顿时短延迟合并写入（非逐键）；保存成功且服务器内容与本地一致时删除。
 * - 丢弃保护：markDiscarded(key) 后该 key 的写入被忽略，直到下一次 markEdited(key)——
 *   防止晚到的防抖写入把用户已显式丢弃的草稿重新生成。
 * - 存储（localStorage）被禁用/写失败：available=false，saveDraft 静默失败返回 false，
 *   由 UI 明示「本地恢复不可用」，编辑器本身不受影响。
 */

const KEY_PREFIX = 'patent-studio:latex-draft'
export interface LatexDraftRecord {
  /** 记录版本，便于将来迁移 */
  v: 1
  content: string
  /** 编辑开始时的服务器版本标识（base），恢复后用于版本冲突机制 */
  serverSha: string | null
  savedAt: number
}

export function draftKey(userScope: string, pid: string, path: string): string {
  return [KEY_PREFIX, userScope, pid, path].map((seg) => encodeURIComponent(seg)).join(':')
}

export interface DraftStore {
  available(): boolean
  /** 合并写入（调用方负责防抖）；被丢弃的 key 写入被忽略。返回是否真的写入。 */
  saveDraft(userScope: string, pid: string, path: string, content: string, serverSha: string | null): boolean
  loadDraft(userScope: string, pid: string, path: string): LatexDraftRecord | null
  removeDraft(userScope: string, pid: string, path: string): void
  /** 显式丢弃：该 key 进入丢弃名单（此后写入被忽略）。 */
  markDiscarded(userScope: string, pid: string, path: string): void
  /** 新的真实编辑：解除该 key 的丢弃名单。 */
  markEdited(userScope: string, pid: string, path: string): void
}

export function createDraftStore(storage: Storage | null): DraftStore {
  // 丢弃名单：会话内有效（刷新后名单消失，但彼时草稿也已删除/或仍在——刷新后走打开时的恢复检查）
  const discarded = new Set<string>()

  const read = (key: string): LatexDraftRecord | null => {
    if (!storage) return null
    try {
      const raw = storage.getItem(key)
      if (!raw) return null
      const parsed = JSON.parse(raw) as LatexDraftRecord
      if (parsed?.v !== 1 || typeof parsed.content !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  return {
    available: () => {
      if (!storage) return false
      try {
        const probe = `${KEY_PREFIX}:__probe__`
        storage.setItem(probe, '1')
        storage.removeItem(probe)
        return true
      } catch {
        return false
      }
    },

    saveDraft(userScope, pid, path, content, serverSha) {
      const key = draftKey(userScope, pid, path)
      if (discarded.has(key)) return false
      if (!storage) return false
      const record: LatexDraftRecord = { v: 1, content, serverSha, savedAt: Date.now() }
      try {
        storage.setItem(key, JSON.stringify(record))
        return true
      } catch {
        return false
      }
    },

    loadDraft(userScope, pid, path) {
      return read(draftKey(userScope, pid, path))
    },

    removeDraft(userScope, pid, path) {
      const key = draftKey(userScope, pid, path)
      discarded.delete(key)
      try {
        storage?.removeItem(key)
      } catch {
        /* 存储不可用：草稿本就不存在 */
      }
    },

    markDiscarded(userScope, pid, path) {
      const key = draftKey(userScope, pid, path)
      discarded.add(key)
      try {
        storage?.removeItem(key)
      } catch {
        /* 同上 */
      }
    },

    markEdited(userScope, pid, path) {
      discarded.delete(draftKey(userScope, pid, path))
    },
  }
}
