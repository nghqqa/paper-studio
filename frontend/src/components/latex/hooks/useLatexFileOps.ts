import { useCallback, useEffect, useRef, useState } from 'react'
import { latexApi, type LatexFileInfo } from '@/lib/api/latex'
import { errText } from './useLatexSession'

export function useLatexFileOps({
  pid,
  active,
  files,
  openFile,
  switchFile,
  reloadFiles,
  refreshIndex,
  onUploadedZip,
}: {
  pid: string
  active: string | null
  files: LatexFileInfo[]
  openFile: (rel: string) => Promise<void>
  switchFile: (rel: string) => void
  reloadFiles: () => Promise<void>
  refreshIndex: () => void
  onUploadedZip?: () => void
}) {
  const [panelNote, setPanelNote] = useState('')
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const zipRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!panelNote) return
    const t = window.setTimeout(() => setPanelNote(''), 8000)
    return () => window.clearTimeout(t)
  }, [panelNote])

  const activeDir = active && active.includes('/') ? active.slice(0, active.lastIndexOf('/')) : ''

  const onNewFile = useCallback(async () => {
    const raw = window.prompt('新建文件：输入 ZIP 内相对路径（如 sections/method.tex）')
    if (!raw) return
    const rel = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '')
    if (!rel) return
    try {
      await latexApi.createFile(pid, rel)
      await reloadFiles()
      refreshIndex()
      setPanelNote(`已创建 ${rel}`)
      void switchFile(rel)
    } catch (e) {
      setPanelNote(`新建失败：${errText(e)}`)
    }
  }, [pid, reloadFiles, switchFile, refreshIndex])

  const onUploadFiles = useCallback(
    async (list: FileList) => {
      const failures: string[] = []
      let ok = 0
      for (const f of Array.from(list)) {
        const rel = activeDir ? `${activeDir}/${f.name}` : f.name
        try {
          await latexApi.uploadFile(pid, rel, f)
          ok += 1
        } catch (e) {
          failures.push(`${rel}（${errText(e)}）`)
        }
      }
      await reloadFiles()
      refreshIndex()
      setPanelNote(`已上传 ${ok} 个文件${failures.length ? `；失败 ${failures.length} 个：${failures.join('；')}` : ''}`)
    },
    [activeDir, pid, reloadFiles, refreshIndex],
  )

  const onUploadZip = useCallback(
    async (f: File) => {
      try {
        const r = await latexApi.uploadZipMerge(pid, f)
        const parts = [`新增 ${r.added.length} 个文件`]
        if (r.skipped_existing.length) parts.push(`跳过已存在 ${r.skipped_existing.length} 个`)
        if (r.skipped_rejected.length) parts.push(`忽略不支持 ${r.skipped_rejected.length} 个`)
        setPanelNote(parts.join('；'))
        onUploadedZip?.()
        await reloadFiles()
        refreshIndex()
      } catch (e) {
        setPanelNote(`ZIP 合并失败：${errText(e)}`)
      }
    },
    [pid, reloadFiles, refreshIndex, onUploadedZip],
  )

  const onRenameFile = useCallback(
    async (rel: string) => {
      const raw = window.prompt(`重命名/移动文件\n当前：${rel}\n输入新路径（含目录）：`, rel)
      if (!raw || raw.trim() === rel) return
      const newPath = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '')
      if (!newPath) return
      try {
        const r = await latexApi.renameFile(pid, rel, newPath)
        await reloadFiles()
        refreshIndex()
        setPanelNote(`已重命名为 ${r.path}${r.main_updated ? '（编译主文件已同步更新）' : ''}`)
        if (active === rel) await openFile(r.path)
      } catch (e) {
        setPanelNote(`重命名失败：${errText(e)}`)
      }
    },
    [pid, active, reloadFiles, openFile, refreshIndex],
  )

  const onDeleteFile = useCallback(
    async (rel: string) => {
      if (!window.confirm(`删除文件「${rel}」？\n此操作不可恢复（不影响已构建的 PDF 与提案历史）。`)) return
      try {
        await latexApi.deleteFile(pid, rel)
        await reloadFiles()
        refreshIndex()
        setPanelNote(`已删除 ${rel}`)
        if (active === rel) {
          const next = files.find((f) => f.editable && f.path !== rel)
          if (next) await openFile(next.path)
        }
      } catch (e) {
        setPanelNote(`删除失败：${errText(e)}`)
      }
    },
    [pid, active, files, reloadFiles, openFile, refreshIndex],
  )

  return {
    panelNote,
    uploadRef,
    zipRef,
    onNewFile,
    onUploadFiles,
    onUploadZip,
    onRenameFile,
    onDeleteFile,
  }
}
