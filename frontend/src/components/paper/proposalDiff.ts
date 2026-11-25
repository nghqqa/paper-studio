/**
 * 轻量字符级 diff（提案差异展示用）：先掐头去尾，再对中段做 LCS；
 * 中段规模超限（n*m > 250k）时降级为「整段替换」两块显示——不做近似糊弄。
 */

export type DiffPart = { type: 'same' | 'del' | 'add'; text: string }

const MAX_CELLS = 250_000

export function computeDiff(a: string, b: string): DiffPart[] {
  // 公共前缀
  let pre = 0
  const minLen = Math.min(a.length, b.length)
  while (pre < minLen && a[pre] === b[pre]) pre += 1
  // 公共后缀
  let suf = 0
  while (suf < minLen - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1
  const midA = a.slice(pre, a.length - suf)
  const midB = b.slice(pre, b.length - suf)
  const parts: DiffPart[] = []
  if (pre > 0) parts.push({ type: 'same', text: a.slice(0, pre) })
  if (!midA && !midB) {
    // 完全一致
  } else if (!midA) {
    parts.push({ type: 'add', text: midB })
  } else if (!midB) {
    parts.push({ type: 'del', text: midA })
  } else if (midA.length * midB.length > MAX_CELLS) {
    parts.push({ type: 'del', text: midA })
    parts.push({ type: 'add', text: midB })
  } else {
    parts.push(...lcsDiff(midA, midB))
  }
  if (suf > 0) parts.push({ type: 'same', text: a.slice(a.length - suf) })
  return mergeRuns(parts)
}

function lcsDiff(a: string, b: string): DiffPart[] {
  const n = a.length
  const m = b.length
  // DP 表（Int32 行滚动不可回溯路径——直接全量 n*m，规模受 MAX_CELLS 保护）
  const dp = new Int32Array((n + 1) * (m + 1))
  const w = m + 1
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out: DiffPart[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      out.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j] })
    j += 1
  }
  return mergeRuns(out)
}

function mergeRuns(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last && last.type === p.type) last.text += p.text
    else out.push({ ...p })
  }
  return out
}
