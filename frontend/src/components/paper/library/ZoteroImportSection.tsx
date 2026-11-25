import { useEffect, useState } from 'react'
import { Loader2, Plus, RotateCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { latexApi } from '@/lib/api/latex'
import {
  libraryApi,
  type ImportReply,
  type ZoteroCollection,
  type ZoteroCredentials,
  type ZoteroGroup,
  type ZoteroImportSource,
  type ZoteroLibraryType,
  type ZoteroRefreshPreview,
} from '@/lib/api/library'
import { errText } from './types'

export function ZoteroImportSection({
  pid,
  open,
  targetBib,
  zotSource,
  onSetZotSource,
  onPreviewEntries,
  onDone,
  onError,
}: {
  pid: string
  open: boolean
  targetBib: string
  zotSource: ZoteroImportSource | null
  onSetZotSource: (src: ZoteroImportSource | null) => void
  onPreviewEntries: (r: ImportReply, src: ZoteroImportSource) => void
  onDone: (msg: string) => Promise<void>
  onError: (s: string) => void
}) {
  const [zotGroupInput, setZotGroupInput] = useState('')
  const [zotGroup, setZotGroup] = useState<ZoteroGroup | null>(null)
  const [zotCollections, setZotCollections] = useState<ZoteroCollection[]>([])
  const [zotCollectionKey, setZotCollectionKey] = useState('')
  const [zotBusy, setZotBusy] = useState(false)
  const [zotLibType, setZotLibType] = useState<ZoteroLibraryType>('group')
  const [zotUserId, setZotUserId] = useState('')
  const [zotCredOpen, setZotCredOpen] = useState(false)
  const [zotCred, setZotCred] = useState<ZoteroCredentials | null>(null)
  const [zotCredKey, setZotCredKey] = useState('')
  const [zotCredUid, setZotCredUid] = useState('')
  const [zotCredBusy, setZotCredBusy] = useState(false)
  const [refresh, setRefresh] = useState<ZoteroRefreshPreview | null>(null)
  const [refreshSel, setRefreshSel] = useState<{
    additions: Set<number>
    updates: Set<number>
    removals: Set<string>
    removeFromOrder: boolean
  }>(() => ({ additions: new Set(), updates: new Set(), removals: new Set(), removeFromOrder: false }))

  // 挂载即恢复最近一次可刷新来源
  useEffect(() => {
    if (!zotSource) {
      libraryApi
        .zoteroImports(pid)
        .then((r) => {
          const latest = r.latest_refreshable
          if (!latest) return
          onSetZotSource({
            provider: 'zotero',
            group_id: (latest.group_id as number | null) ?? null,
            collection_key: (latest.collection_key as string | null) ?? null,
            group_name: (latest.group_name as string) || '',
            library_type: (latest.library_type as ZoteroLibraryType) || 'group',
            zotero_user_id: (latest.zotero_user_id as string | null) ?? null,
          })
        })
        .catch(() => {
          /* 回显失败静默 */
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])

  const zotLoadCollections = async () => {
    const raw = zotGroupInput.trim()
    if (zotBusy) return
    if (zotLibType === 'group' ? !raw : !zotUserId.trim()) return
    setZotBusy(true)
    try {
      const r = await libraryApi.zoteroCollections(pid, raw, zotLibType, zotUserId.trim() || null)
      setZotGroup(r.group)
      setZotCollections(r.collections)
      setZotCollectionKey('')
      onError('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotBusy(false)
    }
  }

  const zotPreview = async () => {
    if (!zotGroup || zotBusy) return
    setZotBusy(true)
    try {
      const r = await libraryApi.zoteroPreview(
        pid,
        String(zotGroup.id),
        zotCollectionKey || null,
        zotLibType,
        zotUserId.trim() || null,
      )
      const src: ZoteroImportSource = {
        provider: 'zotero',
        group_id: r.source.group_id,
        collection_key: r.source.collection_key,
        group_name: r.group.name,
        library_type: r.source.library_type,
        zotero_user_id: r.source.zotero_user_id,
      }
      setRefresh(null)
      onPreviewEntries(r, src)
      onError('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotBusy(false)
    }
  }

  const zotLoadCreds = async () => {
    setZotCredOpen((v) => !v)
    try {
      const r = await libraryApi.zoteroCredentials()
      setZotCred(r.credentials)
      setZotCredUid(r.credentials.zotero_user_id ?? '')
      setZotCredKey('')
    } catch (e) {
      onError(errText(e))
    }
  }

  const zotSaveCreds = async () => {
    if (zotCredBusy) return
    setZotCredBusy(true)
    try {
      const r = await libraryApi.saveZoteroCredentials(zotCredKey.trim(), zotCredUid.trim())
      setZotCred(r.credentials)
      setZotCredUid(r.credentials.zotero_user_id ?? '')
      setZotCredKey('')
      onError('')
      await onDone('Zotero API Key 已保存（明文不再显示）')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotCredBusy(false)
    }
  }

  const zotClearCreds = async () => {
    if (zotCredBusy || !confirm('确认清除已保存的 Zotero API Key？')) return
    setZotCredBusy(true)
    try {
      const r = await libraryApi.clearZoteroCredentials()
      setZotCred(r.credentials)
      setZotCredUid('')
      setZotCredKey('')
      onError('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotCredBusy(false)
    }
  }

  const zotRefreshPreview = async () => {
    const src = zotSource
    if (!src || zotBusy) return
    setZotBusy(true)
    try {
      const r = await libraryApi.zoteroRefreshPreview(pid, src)
      setRefresh(r)
      setRefreshSel({
        additions: new Set(r.added.map((_e, i) => i)),
        updates: new Set<number>(),
        removals: new Set<string>(),
        removeFromOrder: false,
      })
      onError('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotBusy(false)
    }
  }

  const zotRefreshCommit = async () => {
    const src = zotSource
    const data = refresh
    if (!src || !data || zotBusy) return
    setZotBusy(true)
    try {
      let baseSha: string | null = null
      if (data.mode === 'bib') {
        const f = await latexApi.read(pid, targetBib)
        baseSha = f.sha
      }
      const r = await libraryApi.zoteroRefreshCommit(pid, src, {
        additions: data.added.filter((_e, i) => refreshSel.additions.has(i)),
        updates: data.updated
          .filter((_u, i) => refreshSel.updates.has(i))
          .map((u) => ({ reference_id: u.reference_id, entry: u.entry })),
        removals: [...refreshSel.removals],
        remove_from_citation_order: refreshSel.removeFromOrder,
        target_bib: data.mode === 'bib' ? targetBib : null,
        base_sha: baseSha,
      })
      await onDone(`刷新已提交：新增 ${r.applied.added}、更新 ${r.applied.updated}、移除 ${r.applied.removed}`)
      setRefresh(null)
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotBusy(false)
    }
  }

  return (
    <>
      {open && (
        <div className="mt-1 rounded border border-line bg-panel p-2" data-testid="library-zotero">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className="rounded border border-line bg-app px-1 py-0.5"
              value={zotLibType}
              onChange={(e) => {
                setZotLibType(e.target.value as ZoteroLibraryType)
                setZotGroup(null)
                setZotCollections([])
                setRefresh(null)
              }}
              data-testid="library-zotero-libtype"
            >
              <option value="group">公开群组</option>
              <option value="user">个人库（需 API Key）</option>
            </select>
            {zotLibType === 'group' ? (
              <input
                className="w-56 rounded border border-line bg-app px-1.5 py-0.5"
                placeholder="群组 ID 或 zotero.org/groups/<id> 链接"
                value={zotGroupInput}
                onChange={(e) => setZotGroupInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void zotLoadCollections()
                }}
                data-testid="library-zotero-group"
              />
            ) : (
              <input
                className="w-40 rounded border border-line bg-app px-1.5 py-0.5"
                placeholder="Zotero userID（数字）"
                value={zotUserId}
                onChange={(e) => setZotUserId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void zotLoadCollections()
                }}
                data-testid="library-zotero-userid"
              />
            )}
            <Button
              size="sm"
              variant="secondary"
              className="h-6 px-2"
              disabled={zotBusy || (zotLibType === 'group' ? !zotGroupInput.trim() : !zotUserId.trim())}
              onClick={() => void zotLoadCollections()}
              data-testid="library-zotero-fetch"
            >
              {zotBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <RotateCw aria-hidden className="size-3" />} 拉取
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-6 px-2"
              onClick={() => void zotLoadCreds()}
              aria-expanded={zotCredOpen}
              data-testid="library-zotero-cred-toggle"
            >
              <ShieldAlert aria-hidden className="size-3" /> 私有库授权
            </Button>
            {zotGroup && <span className="text-fg-muted">「{zotGroup.name}」</span>}
          </div>
          {zotCredOpen && (
            <div className="mt-1.5 rounded border border-line bg-app p-2" data-testid="library-zotero-cred">
              {zotCred?.has_api_key ? (
                <p className="text-2xs text-fg-muted">已保存 Key（{zotCred.api_key_hint}）——留空表示保留原值</p>
              ) : (
                <p className="text-2xs text-fg-muted">在 zotero.org/settings/keys 创建只读 Key 并填入；明文只提交一次，不再显示</p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <input
                  type="password"
                  autoComplete="new-password"
                  className="w-56 rounded border border-line bg-app px-1.5 py-0.5"
                  placeholder="Zotero API Key（留空 = 保留已存）"
                  value={zotCredKey}
                  onChange={(e) => setZotCredKey(e.target.value)}
                  data-testid="library-zotero-cred-key"
                />
                <input
                  className="w-32 rounded border border-line bg-app px-1.5 py-0.5"
                  placeholder="userID（数字）"
                  value={zotCredUid}
                  onChange={(e) => setZotCredUid(e.target.value)}
                  data-testid="library-zotero-cred-uid"
                />
                <Button size="sm" className="h-6 px-2" disabled={zotCredBusy} onClick={() => void zotSaveCreds()} data-testid="library-zotero-cred-save">
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-6 px-2"
                  disabled={zotCredBusy || !zotCred?.has_api_key}
                  onClick={() => void zotClearCreds()}
                  data-testid="library-zotero-cred-clear"
                >
                  清除
                </Button>
              </div>
            </div>
          )}
          {zotGroup && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <select
                className="rounded border border-line bg-app px-1 py-0.5"
                value={zotCollectionKey}
                onChange={(e) => setZotCollectionKey(e.target.value)}
                data-testid="library-zotero-collection"
              >
                <option value="">全部条目（顶层）</option>
                {zotCollections.map((col) => (
                  <option key={col.key} value={col.key}>
                    {col.parent ? `└ ${col.name}` : col.name}
                  </option>
                ))}
              </select>
              <Button size="sm" className="h-6 px-2" disabled={zotBusy} onClick={() => void zotPreview()} data-testid="library-zotero-preview">
                {zotBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Plus aria-hidden className="size-3" />} 预览条目
              </Button>
              <span className="text-2xs text-fg-muted">公开群组免授权；私有库在「私有库授权」配置 Key。导入或刷新走下方流程。</span>
            </div>
          )}
          {zotSource && (
            <div className="mt-1.5">
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2"
                disabled={zotBusy}
                onClick={() => void zotRefreshPreview()}
                data-testid="library-zotero-refresh-run"
              >
                {zotBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <RotateCw aria-hidden className="size-3" />} 刷新此来源
              </Button>
            </div>
          )}
        </div>
      )}

      {refresh && (
        <div className="mt-1 rounded border border-line bg-panel p-2" data-testid="library-zotero-refresh">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <strong className="text-2xs">
              一键刷新 · 新增 {refresh.counts.added} / 更新 {refresh.counts.updated} / 移除 {refresh.counts.removed} / 不变{' '}
              {refresh.counts.unchanged}
              {refresh.truncated ? ' · 远端拉取被截断' : ''}
            </strong>
            <Button
              size="sm"
              className="h-6 px-2"
              disabled={zotBusy || (!refreshSel.additions.size && !refreshSel.updates.size && !refreshSel.removals.size)}
              onClick={() => void zotRefreshCommit()}
              data-testid="library-zotero-refresh-commit"
            >
              提交勾选
            </Button>
          </div>
          {refresh.notice && (
            <p className="mt-1 text-2xs text-fg-muted" role="note">
              {refresh.notice}
            </p>
          )}
          {refresh.added.length > 0 && (
            <div className="mt-1" data-testid="library-zotero-refresh-added">
              <p className="text-2xs text-fg-muted">新增（勾选导入）</p>
              {refresh.added.map((e, i) => (
                <label key={`a${i}`} className="flex items-center gap-1 py-0.5">
                  <input
                    type="checkbox"
                    checked={refreshSel.additions.has(i)}
                    onChange={() =>
                      setRefreshSel((s) => {
                        const n = new Set(s.additions)
                        if (n.has(i)) n.delete(i)
                        else n.add(i)
                        return { ...s, additions: n }
                      })
                    }
                  />
                  <span className="font-mono text-2xs">{String(e.citation_key ?? '')}</span>
                  <span className="truncate text-2xs">{String(e.title ?? '')}</span>
                </label>
              ))}
            </div>
          )}
          {refresh.updated.length > 0 && (
            <div className="mt-1" data-testid="library-zotero-refresh-updated">
              <p className="text-2xs text-fg-muted">更新（默认不勾选；本地已改字段不会被覆盖）</p>
              {refresh.updated.map((u, i) => (
                <label key={`u${i}`} className="flex items-center gap-1 py-0.5">
                  <input
                    type="checkbox"
                    checked={refreshSel.updates.has(i)}
                    onChange={() =>
                      setRefreshSel((s) => {
                        const n = new Set(s.updates)
                        if (n.has(i)) n.delete(i)
                        else n.add(i)
                        return { ...s, updates: n }
                      })
                    }
                  />
                  <span className="font-mono text-2xs">{u.citation_key}</span>
                  <span className="truncate text-2xs">
                    {Object.keys(u.new)
                      .filter((k) => (u.old[k] ?? '') !== (u.new[k] ?? ''))
                      .slice(0, 3)
                      .map((k) => `${k}: ${u.old[k] || '空'} → ${u.new[k] || '空'}`)
                      .join('；')}
                  </span>
                </label>
              ))}
            </div>
          )}
          {refresh.removed.length > 0 && (
            <div className="mt-1" data-testid="library-zotero-refresh-removed">
              <p className="text-2xs text-fg-muted">远端已移除（勾选确认删除）</p>
              {refresh.removed.map((r) => (
                <label key={r.reference_id} className="flex items-center gap-1 py-0.5">
                  <input
                    type="checkbox"
                    checked={refreshSel.removals.has(r.reference_id)}
                    onChange={() =>
                      setRefreshSel((s) => {
                        const n = new Set(s.removals)
                        if (n.has(r.reference_id)) n.delete(r.reference_id)
                        else n.add(r.reference_id)
                        return { ...s, removals: n }
                      })
                    }
                  />
                  <span className="font-mono text-2xs">{r.citation_key}</span>
                  {r.in_citation_order && <span className="text-2xs text-danger-fg">在引用顺序表中</span>}
                </label>
              ))}
              {refresh.mode === 'index' &&
                refresh.removed.some((r) => r.in_citation_order && refreshSel.removals.has(r.reference_id)) && (
                  <label className="mt-0.5 flex items-center gap-1 text-2xs text-danger-fg">
                    <input
                      type="checkbox"
                      checked={refreshSel.removeFromOrder}
                      onChange={(e) => setRefreshSel((s) => ({ ...s, removeFromOrder: e.target.checked }))}
                    />
                    同时从引用顺序表移除（否则提交会被拒绝）
                  </label>
                )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
