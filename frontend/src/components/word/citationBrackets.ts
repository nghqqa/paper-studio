/** GB/T 7714-2015 连号压缩：升序去重后仅 ≥3 连续整数压为起止范围（1-3）；2 连号保持 1,2。 */
export function compressCitationNumbers(nums: number[]): string {
  const uniq = [...new Set(nums)].sort((a, b) => a - b)
  const parts: string[] = []
  let start = 0
  while (start < uniq.length) {
    let end = start
    while (end + 1 < uniq.length && uniq[end + 1] === uniq[end] + 1) end += 1
    if (end - start + 1 >= 3) parts.push(`${uniq[start]}-${uniq[end]}`)
    else for (let i = start; i <= end; i += 1) parts.push(String(uniq[i]))
    start = end + 1
  }
  return parts.join(',')
}

/** 上标引用惯例（GB/T 7714）：[1], [2], [3] 合并为单个上标 [1-3]。 */
export function mergeCitationBrackets(label: string): string {
  const parts = label
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length > 1 && parts.every((p) => /^\[\d+\]$/.test(p))) {
    const nums = parts.map((p) => parseInt(p.slice(1, -1), 10))
    return `[${compressCitationNumbers(nums)}]`
  }
  return label
}
