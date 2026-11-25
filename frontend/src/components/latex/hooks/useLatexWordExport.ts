import { useCallback, useEffect, useRef, useState } from 'react'
import { latexApi, type WordExportManifest, type WordExportProfile } from '@/lib/api/latex'
import type { SaveBuildController } from '../saveBuild'

export function useLatexWordExport({
  pid,
  ctrl,
}: {
  pid: string
  ctrl: SaveBuildController
}) {
  const [wordProfile, setWordProfile] = useState<WordExportProfile>('academic')
  const wordProfileTouchedRef = useRef(false)
  const [wordExporting, setWordExporting] = useState(false)
  const [wordResult, setWordResult] = useState<WordExportManifest | null>(null)
  const [wordExportErr, setWordExportErr] = useState('')
  const [wordHistory, setWordHistory] = useState<WordExportManifest[]>([])

  const selectWordProfile = useCallback((p: WordExportProfile) => {
    wordProfileTouchedRef.current = true
    setWordProfile(p)
  }, [])

  const autoDetectThesis = useCallback((_rel: string, content: string) => {
    if (wordProfileTouchedRef.current) return
    if (/\\documentclass(?:\[[^\]]*\])?\{(?:ctexbook|book)\}|\\chapter\*?\{/.test(content)) {
      setWordProfile('thesis')
    }
  }, [])

  useEffect(() => {
    let alive = true
    latexApi
      .wordExports(pid)
      .then((r) => {
        if (alive) setWordHistory(r.exports.slice(0, 3))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [pid])

  const runWordExport = useCallback(async () => {
    if (wordExporting) return
    setWordExportErr('')
    setWordExporting(true)
    try {
      let s = ctrl.snapshot()
      if (s.dirty || s.saving) {
        ctrl.saveNow()
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
          s = ctrl.snapshot()
          if (s.conflict || s.permLost) {
            setWordExportErr(s.conflict ? '保存存在冲突，已取消导出（请先解决冲突）' : '保存失败（无写入权限），已取消导出')
            return
          }
          if (!s.dirty && !s.saving) break
        }
        if (s.dirty || s.saving) {
          setWordExportErr('保存未在限时内完成，已取消导出（请稍后重试）')
          return
        }
      }
      const m = await latexApi.exportWord(pid, { profile: wordProfile })
      setWordResult(m)
      void latexApi
        .wordExports(pid)
        .then((r) => setWordHistory(r.exports.slice(0, 3)))
        .catch(() => {})
    } catch (e) {
      setWordExportErr(e instanceof Error ? e.message : '导出失败')
    } finally {
      setWordExporting(false)
    }
  }, [wordExporting, ctrl, pid, wordProfile])

  return {
    wordProfile,
    selectWordProfile,
    autoDetectThesis,
    wordExporting,
    wordResult,
    setWordResult,
    wordExportErr,
    wordHistory,
    runWordExport,
  }
}
