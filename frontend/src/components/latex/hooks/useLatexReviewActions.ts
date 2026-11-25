import { useCallback, useState } from 'react'
import { latexApi, type LatexBuildInfo, type LatexBuildOutcome, type LatexDiagnostic } from '@/lib/api/latex'
import { type FixVerification, paperProposalApi } from '@/lib/api/paperProposals'
import type { SaveBuildController } from '../saveBuild'
import { errText } from './useLatexSession'

export function useLatexReviewActions({
  pid,
  ctrl,
  active,
  canEdit,
  openFile,
  refreshBuilds,
  setPreviewBuildId,
  setPreviewIsOld,
  setOutcome,
  setLoadErr,
  onShowProposals,
}: {
  pid: string
  ctrl: SaveBuildController
  active: string | null
  canEdit: boolean
  openFile: (rel: string) => Promise<void>
  refreshBuilds: () => Promise<{ builds: LatexBuildInfo[]; latest_ok_build_id: string | null } | null>
  setPreviewBuildId: (id: string | null) => void
  setPreviewIsOld: (old: boolean) => void
  setOutcome: (o: LatexBuildOutcome | null) => void
  setLoadErr: (msg: string) => void
  onShowProposals: () => void
}) {
  const [proposalTick, setProposalTick] = useState(0)

  const aiReviewCurrentFile = useCallback(
    async (file: string): Promise<number> => {
      const content = ctrl.getContent()
      if (!content.trim()) {
        throw new Error(`「${file}」当前内容为空，无法进行 AI 审阅`)
      }
      if (
        !window.confirm(
          `AI 审阅将把「${file}」全文（约 ${content.length} 字符）发送给你配置的模型进行审稿，\n生成的问题清单会逐条加入 Issues。\n\n继续发送？`,
        )
      ) {
        return -1
      }
      const r = await latexApi.aiReview(pid, file, content)
      return r.added
    },
    [pid, ctrl],
  )

  const proposeFixFromDiag = useCallback(
    async (diag: LatexDiagnostic) => {
      if (!canEdit) return
      const file = diag.file.replace(/^\.\//, '')
      try {
        if (file !== active) {
          if (ctrl.isDirty() && !window.confirm('切换到错误所在文件会放弃当前未保存修改，继续？')) return
          await openFile(file)
          await new Promise((r) => setTimeout(r, 150))
        }
        if (ctrl.getPath() !== file) {
          setLoadErr(`无法打开 ${file}，请手动打开后再生成修复提案`)
          return
        }
        const lines = ctrl.getContent().split('\n')
        const pick = (n: number) => (n >= 1 && n <= lines.length ? lines[n - 1] : '')
        const ln = diag.line ?? 1
        let used = ln
        let lineText = pick(ln).trim()
        if (!lineText) {
          for (const d of [1, -1, 2, -2]) {
            if (pick(ln + d).trim()) {
              used = ln + d
              lineText = pick(ln + d).trim()
              break
            }
          }
        }
        if (!lineText) {
          setLoadErr('错误行附近没有可定位的文本——请手动选中相关代码后用「自定义修改」生成')
          return
        }
        const s = ctrl.snapshot()
        await paperProposalApi.generate(pid, {
          mode: 'latex',
          file,
          base_sha: s.savedSha || '0'.repeat(64),
          original_text: lineText.slice(0, 300),
          context_before: `${pick(used - 2)}\n${pick(used - 1)}`,
          context_after: `${pick(used + 1)}\n${pick(used + 2)}`,
          action: 'custom',
          instruction: `修复这行 LaTeX 的编译错误：${diag.message.slice(0, 300)}`,
          error_context: { file, line: diag.line, message: diag.message },
        })
        onShowProposals()
        setProposalTick((t) => t + 1)
      } catch (e) {
        setLoadErr(errText(e))
      }
    },
    [pid, ctrl, active, canEdit, openFile, setLoadErr, onShowProposals],
  )

  const verifyProposalFix = useCallback(
    async (proposalId: string): Promise<FixVerification> => {
      let s = ctrl.snapshot()
      if (s.dirty || s.saving) {
        ctrl.saveNow()
        const deadline = Date.now() + 20000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
          s = ctrl.snapshot()
          if (s.conflict || s.permLost) {
            throw new Error(s.conflict ? '保存冲突，请先解决冲突再验证' : '保存失败（无写入权限），无法验证')
          }
          if (!s.dirty && !s.saving) break
        }
        if (s.dirty || s.saving) throw new Error('保存未在限时内完成，无法验证')
      }
      const r = await paperProposalApi.verifyFix(pid, proposalId)
      setPreviewBuildId(r.verification.build_id)
      setPreviewIsOld(r.verification.build_status !== 'ok')
      void refreshBuilds().then((reply) => {
        const latest = reply?.builds[0]
        if (latest) setOutcome({ ...latest, pdf_url: null, log_url: '' } as LatexBuildOutcome)
      })
      return r.verification
    },
    [ctrl, pid, refreshBuilds, setPreviewBuildId, setPreviewIsOld, setOutcome],
  )

  return {
    proposalTick,
    aiReviewCurrentFile,
    proposeFixFromDiag,
    verifyProposalFix,
  }
}
