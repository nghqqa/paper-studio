/**
 * 历史版本的提交摘要（domain/latex_history.py 等）→ 面板人话。
 * 后端保持机器串不变，只在展示层翻译；未知串原样返回。
 */
export function versionLabel(message: string): string {
  if (message === 'save') return '保存'
  if (message === 'figures') return '附图更新'
  if (message === 'build') return '编译快照'
  const sv = /^save (.+)$/.exec(message)
  if (sv) return `保存 · ${sv[1]}`
  const cr = /^create (.+)$/.exec(message)
  if (cr) return `新建 · ${cr[1]}`
  const up = /^upload (.+)$/.exec(message)
  if (up) return `上传 · ${up[1]}`
  const zm = /^zip-merge \+(\d+)$/.exec(message)
  if (zm) return `ZIP 合并 · +${zm[1]} 个文件`
  const rn = /^rename (.+) -> (.+)$/.exec(message)
  if (rn) return `重命名 ${rn[1]} → ${rn[2]}`
  const dl = /^delete (.+)$/.exec(message)
  if (dl) return `删除 · ${dl[1]}`
  const lib = /^library (.+)$/.exec(message)
  if (lib) return `文献写回 · ${lib[1]}`
  const rb = /^(restore|backup) (.+)$/.exec(message)
  if (rb) return `${rb[1] === 'restore' ? '恢复自' : '旧备份'} ${rb[2]}`
  return message
}
