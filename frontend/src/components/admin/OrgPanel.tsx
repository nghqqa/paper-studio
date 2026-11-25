import type { Org } from '@/types/account'
import { OrgForm } from './OrgForm'

export interface OrgPanelProps {
  org: Org | null
  orgUnavailable: boolean
  onSaveName(name: string): Promise<boolean>
}

export function OrgPanel({ org, orgUnavailable, onSaveName }: OrgPanelProps) {
  return (
    <div className="grid gap-6" data-testid="admin-org-panel">
      <section className="grid gap-2">
        <h3 className="text-sm font-semibold">团队或机构名称</h3>
        <OrgForm key={org?.name ?? ''} org={org} unavailable={orgUnavailable} onSave={onSaveName} />
      </section>
      <p className="text-sm leading-6 text-fg-muted">论文项目可分别邀请合作者，并设置编辑、审阅或只读权限。成员的展示头衔不会自动改变项目权限。</p>
    </div>
  )
}
