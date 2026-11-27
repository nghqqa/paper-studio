import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, StreamLanguage, type StreamParser, syntaxHighlighting } from '@codemirror/language'
import { stexMath } from '@codemirror/legacy-modes/mode/stex'
import { search, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { drawSelection, EditorView as EV, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { applyToView, type AnchorLike, locateAnchor, revertInView } from '@/components/paper/proposalApply'
import type { GlossaryEntry } from '@/lib/api/glossary'
import type { LatexDiagnostic, LatexFileInfo } from '@/lib/api/latex'
import { type CiteCandidate, makeCiteSource, makeRefSource } from '../citeCompletions'
import {
  computeWholeDocStats,
  diagnosticsField,
  diagnosticsHoverExtension,
  extractMathAtCursor,
  latexFoldService,
  latexHighlightStyle,
  latexHoverTooltipExtension,
  makeGlossarySource,
  makeLatexCommandSource,
  type MathPreview,
  setDiagnosticsEffect,
  toggleLatexComment,
  wrapSelectionCommand,
} from '../editorEnhancements'
import type { ProjectContentIndex } from '../editorSearch'
import type { SaveBuildController } from '../saveBuild'

export function useLatexEditorState({
  pid,
  ctrl,
  active,
  reloadTick,
  canEdit,
  main,
  files,
  diagList,
  openFile,
  citeDataRef,
  glossaryRef,
  contentIndex,
  indexStamp = 0,
  onSearchOpen,
  onLocateFlash,
  onProposeFixFromDiag,
}: {
  pid: string
  ctrl: SaveBuildController
  active: string | null
  reloadTick: number
  canEdit: boolean
  main: string
  files: LatexFileInfo[]
  diagList: LatexDiagnostic[]
  openFile: (rel: string) => Promise<void>
  citeDataRef: MutableRefObject<{ cites: CiteCandidate[] }>
  glossaryRef?: MutableRefObject<GlossaryEntry[]>
  contentIndex: ProjectContentIndex
  indexStamp?: number
  onSearchOpen: () => void
  onLocateFlash: (msg: string) => void
  onProposeFixFromDiag?: (diag: LatexDiagnostic) => void
}) {
  const viewRef = useRef<EditorView | null>(null)
  const onSearchOpenRef = useRef(onSearchOpen)
  onSearchOpenRef.current = onSearchOpen
  const onLocateFlashRef = useRef(onLocateFlash)
  onLocateFlashRef.current = onLocateFlash
  const onProposeFixRef = useRef(onProposeFixFromDiag)
  onProposeFixRef.current = onProposeFixFromDiag
  const activeRef = useRef(active)
  activeRef.current = active
  const filesRef = useRef(files)
  filesRef.current = files

  const [cursorLine, setCursorLine] = useState<number | null>(null)
  const [mathPreview, setMathPreview] = useState<MathPreview | null>(null)
  const [docRev, setDocRev] = useState<{ key: string; rev: number }>({ key: '', rev: 0 })

  const stateKey = `${active ?? ''}:${reloadTick}:${canEdit ? '1' : '0'}`

  const st = useMemo(
    () =>
      EditorState.create({
        doc: ctrl.getContent(),
        extensions: [
          lineNumbers(),
          foldGutter(),
          latexFoldService,
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          EV.lineWrapping,
          StreamLanguage.define(stexMath as unknown as StreamParser<unknown>),
          syntaxHighlighting(latexHighlightStyle),
          keymap.of([
            {
              key: 'Mod-Shift-f',
              run: () => {
                onSearchOpenRef.current()
                return true
              },
            },
            { key: 'Mod-/', run: toggleLatexComment },
            { key: 'Mod-b', run: wrapSelectionCommand('\\textbf{', '}') },
            { key: 'Mod-i', run: wrapSelectionCommand('\\textit{', '}') },
            ...closeBracketsKeymap,
            ...foldKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          search({ top: true }),
          diagnosticsField,
          diagnosticsHoverExtension(canEdit, onProposeFixRef),
          latexHoverTooltipExtension({ pid, activeRef, citeDataRef, contentIndex, filesRef, glossaryRef }),
          ...(canEdit
            ? [
                autocompletion({
                  override: [
                    (ctx: CompletionContext) => makeCiteSource(citeDataRef.current.cites)(ctx),
                    (ctx: CompletionContext) =>
                      makeRefSource(contentIndex.ready ? contentIndex.collectLabels() : [])(ctx),
                    makeLatexCommandSource(),
                    ...(glossaryRef ? [makeGlossarySource(glossaryRef)] : []),
                  ],
                  icons: false,
                }),
              ]
            : []),
          ...(canEdit ? [] : [EditorState.readOnly.of(true), EV.editable.of(false)]),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
          }),
          EV.updateListener.of((u) => {
            if (u.docChanged) {
              ctrl.edit(u.state.doc.toString())
              setDocRev((cur) => ({ key: stateKey, rev: cur.key === stateKey ? cur.rev + 1 : 1 }))
            }
            if (u.selectionSet || u.docChanged) {
              const sel = u.state.selection.main
              setCursorLine(u.state.doc.lineAt(sel.head).number)
              setMathPreview(extractMathAtCursor(u.state.doc.toString(), sel.from, sel.to))
            }
          }),
        ],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, reloadTick, canEdit],
  )

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const normActive = (active ?? '').replace(/^\.\//, '')
    const activeDiags = active
      ? diagList.filter((d) => d.file.replace(/^\.\//, '') === normActive && d.line != null)
      : []
    view.dispatch({ effects: setDiagnosticsEffect.of(activeDiags) })
  }, [diagList, active, st])

  useEffect(() => {
    setMathPreview(null)
  }, [stateKey])

  const jumpTo = useCallback(
    (file: string, line: number | null) => {
      const view = viewRef.current
      if (!view || file !== ctrl.getPath() || line == null) return
      const total = view.state.doc.lines
      const ln = Math.min(Math.max(1, line), total)
      const pos = view.state.doc.line(ln).from
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    },
    [ctrl],
  )

  const jumpToSearchHit = useCallback(
    (path: string, line: number) => {
      if (path !== active) {
        void openFile(path).then(() => {
          window.setTimeout(() => jumpTo(path, line), 200)
        })
      } else {
        jumpTo(path, line)
      }
    },
    [active, openFile, jumpTo],
  )

  const insertAtCursor = useCallback(
    (text: string) => {
      const view = viewRef.current
      if (!view || !canEdit) return
      const sel = view.state.selection.main
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        scrollIntoView: true,
      })
      view.focus()
    },
    [canEdit],
  )

  const insertCitations = useCallback(
    (entries: { citation_key: string }[], command: string) => {
      const keys = entries.map((e) => e.citation_key)
      const view = viewRef.current
      if (!view || !active) return
      const sel = view.state.selection.main
      const ins = `\\${command}{${keys.join(',')}}`
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: ins },
        selection: { anchor: sel.from + ins.length },
        scrollIntoView: true,
        userEvent: 'input.cite',
      })
      view.focus()
    },
    [active],
  )

  const getSelection = useCallback(() => {
    const view = viewRef.current
    if (!view || !active) return null
    const { from, to } = view.state.selection.main
    const doc = view.state.doc.toString()
    return { text: doc.slice(from, to), doc, from, to }
  }, [active])

  const doApplyProposal = useCallback(
    (anchor: AnchorLike, suggested: string) =>
      applyToView(viewRef.current, anchor, suggested, active, active ?? ''),
    [active],
  )

  const doRevertProposal = useCallback(
    (anchor: AnchorLike, appliedText: string) =>
      revertInView(viewRef.current, anchor, appliedText, active, active ?? ''),
    [active],
  )

  const locateProposal = useCallback(
    (anchor: AnchorLike & { file: string }) => {
      const go = () => {
        const view = viewRef.current
        if (!view) return
        const doc = view.state.doc.toString()
        const loc = locateAnchor(doc, anchor)
        if (loc.ok) {
          view.dispatch({ selection: { anchor: loc.start, head: loc.end }, scrollIntoView: true })
          view.focus()
          onLocateFlashRef.current('')
        } else {
          onLocateFlashRef.current(
            loc.reason === 'ambiguous' ? '定位：原文出现多处且无法消歧' : '定位：原文已变化（找不到该段）',
          )
        }
      }
      if (anchor.file !== ctrl.getPath()) void openFile(anchor.file).then(go)
      else go()
    },
    [ctrl, openFile],
  )

  const activeRev = docRev.key === stateKey ? docRev.rev : 0

  const docStats = useMemo(() => {
    const doc = activeRev > 0 ? (viewRef.current?.state.doc ?? st?.doc) : st?.doc
    if (!doc) return null
    const text = doc.toString()
    const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
    const words = (text.match(/[A-Za-z0-9]+/g) ?? []).length
    return { cjk, words, lines: doc.lines }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, activeRev])

  const wholeDocStats = useMemo(() => {
    const doc = activeRev > 0 ? (viewRef.current?.state.doc ?? st?.doc) : st?.doc
    if (!doc || !main) return null
    return computeWholeDocStats(main, contentIndex, active, doc.toString())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, active, main, activeRev, files, indexStamp])

  const outlineItems = useMemo(() => {
    const doc = activeRev > 0 ? (viewRef.current?.state.doc ?? st?.doc) : st?.doc
    const liveOverrides: Record<string, string> = {}
    if (active && doc) liveOverrides[active] = doc.toString()
    if (main && contentIndex.ready) {
      const full = contentIndex.collectOutline(main, liveOverrides)
      if (full.length > 0) return full
    }
    if (!doc || !active || !/\.(tex|ltx)$/i.test(active)) return []
    const levels: Record<string, number> = {
      part: 0,
      chapter: 0,
      section: 1,
      subsection: 2,
      subsubsection: 3,
      paragraph: 4,
    }
    const out: { file: string; level: number; title: string; line: number }[] = []
    for (let i = 1; i <= doc.lines; i++) {
      const lineText = doc.line(i).text
      if (/^\s*%/.test(lineText)) continue
      const m = lineText.match(/\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{([^}]+)\}/)
      if (m) out.push({ file: active, level: levels[m[1]] ?? 1, title: m[2].trim(), line: i })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, active, main, activeRev, files, indexStamp])

  return {
    viewRef,
    cursorLine,
    mathPreview,
    st,
    jumpTo,
    jumpToSearchHit,
    insertAtCursor,
    insertCitations,
    getSelection,
    doApplyProposal,
    doRevertProposal,
    locateProposal,
    docStats,
    wholeDocStats,
    outlineItems,
  }
}
