export interface SelectionSnapshot {
  text: string
  doc: string
  from: number
  to: number
}

export function errText(e: unknown): string {
  const anyErr = e as { message?: string; detail?: { message?: string } }
  return anyErr?.detail?.message || anyErr?.message || String(e)
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function truncate(s: string, n = 40): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

export function payloadFor(
  doc: string,
  text: string,
): { original_text: string; context_before: string; context_after: string } {
  const from = doc.indexOf(text)
  if (from === -1) return { original_text: text, context_before: '', context_after: '' }
  return {
    original_text: text,
    context_before: doc.slice(Math.max(0, from - 400), from),
    context_after: doc.slice(from + text.length, from + text.length + 400),
  }
}

export function sectionRangeOf(doc: string, pos: number): { from: number; to: number } | null {
  const lines = doc.split('\n')
  let offset = 0
  let start = -1
  let startOffset = 0
  let endOffset = doc.length
  let level = -1
  for (const line of lines) {
    const m = /^\\(section|subsection)\*?\{/.exec(line)
    if (m) {
      const lvl = m[1] === 'subsection' ? 2 : 1
      if (start === -1 && offset <= pos) {
        start = offset
        startOffset = offset
        level = lvl
      } else if (start !== -1 && lvl <= level) {
        endOffset = offset
        break
      }
    }
    offset += line.length + 1
  }
  if (start === -1) return null
  return { from: startOffset, to: endOffset }
}
