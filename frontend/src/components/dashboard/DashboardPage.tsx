import { useStudio } from '@/store'
import { LegacyDashboardPage } from './LegacyDashboardPage'
import { PaperDashboard } from './PaperDashboard'

/**
 * 首页 `#/` 台账统一门面（供单测与复用入口同步挂载；生产路由层 App.tsx 对 LegacyDashboardPage 走按需 lazy 分包）：
 * - `product === 'paper'`：渲染论文工作台首页 `PaperDashboard`；
 * - 其余（专利产品线）：渲染 `LegacyDashboardPage`。
 */
export function DashboardPage() {
  const product = useStudio((s) => s.product)
  return product === 'paper' ? <PaperDashboard /> : <LegacyDashboardPage />
}
