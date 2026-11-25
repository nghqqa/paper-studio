import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { LoginPage } from '@/components/auth/LoginPage'
import { LandingPage } from '@/components/auth/LandingPage'
import { MetaBootstrap, StoreBootstrap } from '@/components/shell/StoreBootstrap'
import { PaperDashboard } from '@/components/dashboard/PaperDashboard'
import { useMediaQuery } from '@/hooks/useMisc'
import { watchDupTab } from '@/lib/dupTab'
import { AppErrorBoundary } from '@/components/ui/error-boundary'
import { useStudio } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parseHash, type HashRoute } from '@/lib/hash'

const PaperShell = lazy(() => import('@/components/shell/PaperShell').then((m) => ({ default: m.PaperShell })))
const LegalPage = lazy(() => import('@/components/auth/LegalPage').then((m) => ({ default: m.LegalPage })))
const ManualPage = lazy(() => import('@/components/auth/ManualPage').then((m) => ({ default: m.ManualPage })))
const ChangelogPage = lazy(() => import('@/components/auth/ChangelogPage').then((m) => ({ default: m.ChangelogPage })))
const ShareAccept = lazy(() => import('@/components/share/ShareAccept').then((m) => ({ default: m.ShareAccept })))
const AccountPage = lazy(() => import('@/components/account/AccountPage').then((m) => ({ default: m.AccountPage })))
const AdminPage = lazy(() => import('@/components/admin/AdminPage').then((m) => ({ default: m.AdminPage })))
const ClientReviewPage = lazy(() => import('@/components/client/ClientReviewPage').then((m) => ({ default: m.ClientReviewPage })))
const CommandPalette = lazy(() => import('@/components/shell/CommandPalette').then((m) => ({ default: m.CommandPalette })))
const NewPaperProjectDialog = lazy(() => import('@/components/shell/NewPaperProjectDialog').then((m) => ({ default: m.NewPaperProjectDialog })))
const ShortcutsDialog = lazy(() => import('@/components/shell/ShortcutsDialog').then((m) => ({ default: m.ShortcutsDialog })))

function WorkbenchFallback() {
  return (
    <div className="flex h-dvh items-center justify-center bg-app" data-testid="workbench-loading">
      <LoaderCircle className="size-6 animate-spin text-fg-muted" aria-label="加载工作台" />
    </div>
  )
}

function DensitySync() {
  const density = useStudio((s) => s.density)
  const mobile = useMediaQuery('(max-width: 767px)')
  useEffect(() => {
    document.documentElement.dataset.density = mobile ? 'touch' : density
  }, [density, mobile])
  return null
}

function DupTabWatch({ route }: { route: HashRoute }) {
  const workbenchPid = route.kind === 'project' ? route.pid : null
  const dup = useStudio((s) => s.dupTabOther)
  const setDupTabOther = useStudio((s) => s.setDupTabOther)
  const toast = useStudio((s) => s.toast)
  const toasted = useRef(false)
  useEffect(() => watchDupTab(workbenchPid, setDupTabOther), [workbenchPid, setDupTabOther])
  useEffect(() => {
    if (!dup) {
      toasted.current = false
      return
    }
    if (!toasted.current) {
      toasted.current = true
      toast('此项目在另一页签打开，请避免同时保存覆盖', 'error')
    }
  }, [dup, toast])
  return null
}

function useHashRoute(): HashRoute {
  const [route, setRoute] = useState(() => parseHash())
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

export default function App() {
  const route = useHashRoute()
  const authStatus = useStudio((s) => s.authStatus)
  const product = useStudio((s) => s.product)
  const metaError = useStudio((s) => s.metaError)
  const dialog = useStudio((s) => s.dialog)
  const closeDialog = useStudio((s) => s.closeDialog)
  const showLogin = route.kind === 'login'
  const showLanding = authStatus === 'anon' && !showLogin
  return (
    <TooltipProvider delayDuration={300}>
      <AppErrorBoundary>
        <MetaBootstrap />
        {product === 'unknown' ? (
          <div role="status" className="grid min-h-dvh place-items-center bg-app text-sm text-fg-muted">
            <div className="grid justify-items-center gap-3">
              <p>{metaError || '正在加载工作区…'}</p>
              {metaError && (
                <button className="rounded-md border border-border px-4 py-2" onClick={() => void useStudio.getState().fetchMeta()}>
                  重试
                </button>
              )}
            </div>
          </div>
        ) : route.kind === 'unsupported' ? (
          <div role="alert" className="grid min-h-dvh place-items-center bg-app px-4" data-testid="patent-page-unavailable">
            <div className="max-w-md text-center">
              <p className="text-base font-semibold text-fg-strong">该页面在论文工作区不可用</p>
              <p className="mt-2 text-sm text-fg-muted">
                请从项目列表进入论文编辑、投稿计划或团队协作。
              </p>
              <a href="#/" className="mt-4 inline-block rounded-md border border-border px-3 py-1.5 text-sm hover:bg-hover">
                返回项目列表
              </a>
            </div>
          </div>
        ) : (
          <>
            <StoreBootstrap />
            <DensitySync />
            <DupTabWatch route={route} />
            {dialog === 'palette' && (
              <Suspense fallback={null}>
                <CommandPalette />
              </Suspense>
            )}
            {dialog === 'shortcuts' && (
              <Suspense fallback={null}>
                <ShortcutsDialog />
              </Suspense>
            )}
            {dialog === 'create' && route.kind !== 'dashboard' && (
              <Suspense fallback={null}>
                <NewPaperProjectDialog open onOpenChange={(v) => { if (!v) closeDialog() }} />
              </Suspense>
            )}
            <Suspense fallback={<WorkbenchFallback />}>
              {route.kind === 'share' ? (
                <ShareAccept />
              ) : route.kind === 'client' ? (
                <ClientReviewPage token={route.token} />
              ) : route.kind === 'legal' ? (
                <LegalPage page={route.page} />
              ) : route.kind === 'manual' ? (
                <ManualPage />
              ) : route.kind === 'changelog' ? (
                <ChangelogPage />
              ) : showLogin ? (
                <LoginPage />
              ) : showLanding ? (
                <LandingPage />
              ) : route.kind === 'dashboard' ? (
                <PaperDashboard />
              ) : route.kind === 'account' ? (
                <AccountPage />
              ) : route.kind === 'admin' ? (
                <AdminPage />
              ) : (
                <PaperShell />
              )}
            </Suspense>
          </>
        )}
      </AppErrorBoundary>
    </TooltipProvider>
  )
}
