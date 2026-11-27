import {
  BarChart3,
  BookOpen,
  Eye,
  EyeOff,
  MessageSquarePlus,
  Play,
  RefreshCw,
  Reply,
  Settings2,
  Sparkles,
  SquareFunction,
  Users,
  X,
} from 'lucide-react'
import { NotificationBell } from '@/components/shell/NotificationBell'
import { PresenceAvatars } from '@/components/shell/PresenceAvatars'
import { Button } from '@/components/ui/button'
import type { LatexFileInfo } from '@/lib/api/latex'
import type { PresencePeer } from '@/lib/api/presence'
import { BRAND_NAME } from '@/lib/brand'

export type LatexSideTab = 'comments' | 'library' | 'proposals' | 'rebuttal' | null

export function LatexTopBar({
  title,
  engine,
  main,
  canEdit,
  dirty,
  saving,
  building,
  permLost,
  autoBuild,
  sideTab,
  settingsOpen,
  files,
  onShare,
  onToggleSideTab,
  onToggleAutoBuild,
  onSaveNow,
  onBuildNow,
  onCancelBuild,
  onToggleSettings,
  onApplySettings,
  onOpenFigures,
  peers = [],
  selfClientId,
}: {
  title: string
  engine: string
  main: string
  canEdit: boolean
  dirty: boolean
  saving: boolean
  building: boolean
  permLost: boolean
  autoBuild: boolean
  sideTab: LatexSideTab
  settingsOpen: boolean
  files: LatexFileInfo[]
  onShare: () => void
  onToggleSideTab: (tab: Exclude<LatexSideTab, null>) => void
  onToggleAutoBuild: () => void
  onSaveNow: () => void
  onBuildNow: () => void
  onCancelBuild: () => void
  onToggleSettings: () => void
  onApplySettings: (nextMain: string, nextEngine: string) => Promise<void>
  onOpenFigures?: () => void
  peers?: PresencePeer[]
  selfClientId?: string
}) {
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2" data-testid="latex-topbar">
      <a className="latex-brand" href="#/" aria-label="返回项目列表">
        <img src="/logo-mark.svg" alt="" />
        {BRAND_NAME}
      </a>
      <SquareFunction aria-hidden className="size-4 text-fg-muted" />
      <h1 className="min-w-0 truncate text-sm font-semibold text-fg-strong" title={title}>
        {title}
      </h1>
      <span className="shrink-0 rounded bg-panel px-1.5 py-0.5 text-xs font-normal text-fg-muted">
        LaTeX · {engine} · {main}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <PresenceAvatars peers={peers} selfClientId={selfClientId} />
        {onOpenFigures && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenFigures}
            data-testid="latex-figures-toggle"
            title="科研绘图与方法图"
          >
            <BarChart3 aria-hidden className="size-4" />
            图表
          </Button>
        )}
        <NotificationBell />
        <Button
          variant="ghost"
          size="sm"
          onClick={onShare}
          data-testid="latex-share"
          title="邀请导师与协作者（导师按行批注，学生回复；抽屉内按角色显示可执行操作）"
        >
          <Users aria-hidden className="size-4" />
          分享
        </Button>
        <Button
          variant={sideTab === 'comments' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onToggleSideTab('comments')}
          aria-pressed={sideTab === 'comments'}
          data-testid="latex-comments-toggle"
          title="批注侧栏"
        >
          <MessageSquarePlus aria-hidden className="size-4" />
          批注
        </Button>
        <Button
          variant={sideTab === 'library' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onToggleSideTab('library')}
          aria-pressed={sideTab === 'library'}
          data-testid="latex-library-toggle"
          title="文献管理（导入 / DOI·arXiv 查询 / 引用插入 / 去重）"
        >
          <BookOpen aria-hidden className="size-4" />
          文献
        </Button>
        <Button
          variant={sideTab === 'proposals' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onToggleSideTab('proposals')}
          aria-pressed={sideTab === 'proposals'}
          data-testid="latex-proposals-toggle"
          title="论文助手（精读 / 写作 / 润色 / 去AI味 → 差异审阅 → 安全采纳）"
        >
          <Sparkles aria-hidden className="size-4" />
          论文助手
        </Button>
        <Button
          variant={sideTab === 'rebuttal' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onToggleSideTab('rebuttal')}
          aria-pressed={sideTab === 'rebuttal'}
          data-testid="latex-rebuttal-toggle"
          title="审稿回复信（意见拆条 / 进度跟踪 / AI 草稿 / 导出 Response Letter）"
        >
          <Reply aria-hidden className="size-4" />
          回复信
        </Button>
        {canEdit && (
          <Button
            variant={autoBuild ? 'secondary' : 'ghost'}
            size="sm"
            onClick={onToggleAutoBuild}
            aria-pressed={autoBuild}
            data-testid="latex-auto-toggle"
            title={
              autoBuild
                ? '自动保存与自动编译均开启；点击仅关闭自动编译（自动保存保持开启）'
                : '自动编译已关（自动保存仍会在停顿后进行）；点击重新开启'
            }
          >
            {autoBuild ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />}
            自动编译
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => window.location.assign('#/')} data-testid="latex-back">
          所有项目
        </Button>
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSaveNow}
            disabled={!dirty || saving || permLost}
            data-testid="latex-save"
            title={permLost ? '当前账号无写入权限' : undefined}
          >
            保存{dirty ? ' *' : ''}
          </Button>
        )}
        <Button size="sm" onClick={onBuildNow} disabled={building} data-testid="latex-build">
          {building ? <RefreshCw aria-hidden className="size-4 animate-spin" /> : <Play aria-hidden className="size-4" />}
          编译
        </Button>
        {building && canEdit && (
          <Button variant="ghost" size="sm" onClick={onCancelBuild} data-testid="latex-build-cancel" title="终止编译进程，保留已有产物">
            <X aria-hidden className="size-4" />
            取消
          </Button>
        )}
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleSettings}
            data-testid="latex-settings-toggle"
            title="主文件与编译引擎"
          >
            <Settings2 aria-hidden className="size-4" />
            编译设置
          </Button>
        )}
      </div>
      {settingsOpen && (
        <div className="flex w-full flex-wrap items-center gap-3 border-t border-border bg-panel px-4 py-3 text-sm" data-testid="latex-settings">
          <label className="flex items-center gap-2">
            <span className="text-xs text-fg-muted">主文件</span>
            <select
              className="rounded-sm border border-border bg-app px-2 py-1 text-xs"
              value={main}
              onChange={(e) => void onApplySettings(e.target.value, engine)}
              data-testid="latex-settings-main"
            >
              {files
                .filter((f) => f.path.toLowerCase().endsWith('.tex'))
                .map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-fg-muted">引擎</span>
            <select
              className="rounded-sm border border-border bg-app px-2 py-1 text-xs"
              value={engine}
              onChange={(e) => void onApplySettings(main, e.target.value)}
              data-testid="latex-settings-engine"
            >
              <option value="pdflatex">pdfLaTeX</option>
              <option value="xelatex">XeLaTeX（中文推荐）</option>
              <option value="lualatex">LuaLaTeX</option>
            </select>
          </label>
          <span className="text-2xs text-fg-muted">
            保存后立即持久化；旧构建将标记为「旧配置」。中文工程建议 XeLaTeX。
          </span>
        </div>
      )}
    </header>
  )
}
