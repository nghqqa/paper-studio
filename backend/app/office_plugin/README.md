# Paper Studio LaTeX formula plugin

This is a public ONLYOFFICE Community plugin for **Docs 10.0 or later**. It uses native Word math objects through `Api.CreateMath(text, "latex")` and `ApiMath.GetText("latex")`. It has no Automation API / `createConnector` dependency and never inserts a picture for a formula.

## Host integration

The backend mounts this directory at `/api/office-plugin/`. Its dynamic `/api/office-plugin/config.json` response retains the GUID below, sets `baseUrl` to the absolute browser-accessible plugin directory, and keeps `variations[0].url` relative as `index.html`:

```
baseUrl: https://paper.example/api/office-plugin/
variations[0].url: index.html
```

Set `PATENT_STUDIO_PUBLIC_ORIGIN` to the application's browser-facing origin (for example, `https://paper.example`). It supplies `pluginsData` URLs and the `baseUrl` of the formula, native numbering, AI and references plugins. It must be HTTPS when the editor is embedded on an HTTPS page. `PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL` is the separate address used by Document Server to fetch documents and send callbacks, and may be an internal URL such as `http://app:8000`. For existing deployments only, an unset `PATENT_STUDIO_PUBLIC_ORIGIN` falls back to that legacy setting; configure the two explicitly when browser and service addresses differ.

The page fetches the same-origin `settings.json` with credentials omitted, redirects rejected and cache disabled. The backend responds with `{"document_server_url":"https://docs.example"}` using its trusted **browser-facing Document Server URL**, including any deployment prefix. The plugin ignores all query parameters when selecting the SDK origin and loads `${document_server_url}/sdkjs-plugins/v1/plugins.js` only after this settings fetch succeeds. Do not derive this setting from incoming request parameters. Set `editorConfig.plugins.pluginsData` to the dynamic config URL and, in editing mode only, use this GUID in `autostart`:

```
asc.{A9E36E21-B3F6-4D8D-B19A-61CF0E853725}
```

The official plugin loader starts its config/`initialize` handshake from `window.onload`. Since the trusted-settings fetch makes SDK loading asynchronous, the plugin starts this SDK handler explicitly when the page has already loaded and wraps it to run once. `Asc.plugin.init` is registered before that handshake starts; the editor injects the actual `Editor.RunMacro`/`callCommand` bridge before invoking `init`.

For the preview, copy the project's installed `katex/dist` directory contents to `vendor/katex/`, retaining its `fonts` directory and license. All preview scripts/fonts are then served locally; there is no CDN request. This plugin page must be embeddable by the configured Document Server (do not apply the workbench's blanket `X-Frame-Options: DENY` header to its static route). The config response must be fetchable by the editor across the configured application/Document Server origins.

## Behavior and boundaries

- Insert an inline formula at the caret using the public `ApiDocument.AddMathEquation(latex, "latex")` operation, or a centered standalone paragraph after the current paragraph using `ApiParagraph.InsertParagraph`. Generic `InsertContent` can promote a math-only paragraph to a display block or merge into an existing equation when the caret is inside a math run in Docs 10.0.0-169. The editor owns DOCX persistence and undo.
- Read formulas from all paragraphs returned by `GetAllParagraphs()`, including table-cell paragraphs, and recurse through inline content controls.
- Choose a formula from the list to read its normalized LaTeX, move the caret to its paragraph, and update that specific object. This first version makes no double-click editing claim.
- Every write compares an exact document-content snapshot plus paragraph internal ID, nested child path and original LaTeX in the same macro transaction. Any intervening text/formula edit rejects the write and preserves the typed expression. Refresh and reselect to proceed. No fuzzy matching or global text replacement is used.
- Updating replaces the math object in its existing paragraph/container and retains neighboring content and paragraph layout. A locked/unsupported parent is rejected. Both mutations use one macro; the plugin explicitly removes a newly inserted replacement if removal of the old object fails. `RunMacro` propagates errors and reports editor-initiated rollback; the plugin does not assume every thrown error automatically rolls back. The legacy `callCommand` transport is provided for embedded hosts exposing the same Docs 10 Office API.
- Numbered equations now use a regular paragraph with center/right tab stops and native OMML, without tables. The measured section column width determines both stops. This is not Word's stretching `eqArr` numbering structure: fractions and n-ary operators follow inline math layout, and long equations/numbers can wrap. Unnumbered standalone math retains display layout.
- Panel insertion uses the effective insertion-point font size, with paragraph/style/default fallbacks, rather than letting a detached paragraph reset to the document default. Font sizes use the Office API's half-point units (e.g. 21 = 10.5 pt). Equation runs keep Cambria Math. Keyboard numbering retains existing math formatting and sizes the new plain-text label from the caret. Updating a uniformly sized paragraph preserves its size independently of the current caret; mixed-size paragraphs are not normalized.
- For wrapped equations, “编号另起一行” adds a standard line break and a tab before the existing number tab, placing the label on its own right-aligned line. It does not clone the paragraph or equation, preserves annotations, and is idempotent. Without this explicit adjustment, a tab after wrapped math can reach the center stop rather than the right stop.
- “移除当前公式表格” converts only the selected legacy borderless fixed-layout formula table after validating every row. It preserves equation JSON and labels, and rolls back prepared sibling insertions on failure. Documents with comments, revisions or bookmarks are excluded because the JSON API omits range anchors; even hidden `_Ref` bookmarks are checked through a guarded Docs 10.0.0-169 adapter. `_GoBack` is only a navigation mark. No automatic document-wide migration runs on load.
- Imported native OMML equations can be read. Formula images and MathType/OLE objects are excluded. LaTeX returned by Word's math engine may differ from the source's spelling.
- KaTeX validates/renders input locally. Word's math parser has a different command subset; verify the inserted result. A terminal `#(2)` / `#（2）` creates a centered native equation with a right-aligned manual label. Automatic counters and cross-references remain separate features.
- Formula-list navigation uses `ApiParagraph.GetRange().MoveCursorToPos(0)` to place a caret, rather than selecting an entire paragraph, so a later insertion cannot inadvertently replace prose selected by navigation. `ApiParagraph.MoveCursorToStart` is not exported in the deployed 10.0.0-169 SDK. Hosts without range navigation can still read and update the verified formula without moving the caret.
- The panel keeps a consistent light theme, including input foreground/background colors, when the surrounding ONLYOFFICE editor uses dark chrome.

## Chart tab

Scientific charts live in the separate `backend/app/office_charts/` plugin since 6926de2 (project-library pick, direct data-to-image insert, and library-vs-document update). The formula panel no longer hosts a chart tab. Chart insertion and update acceptance is covered by that plugin's tests and the E2E suite, not by this plugin's formula verification.

## Numbering, references and double-click locate (panel actions)

- **自动编号**（新建模式下可用）：读取文中最后一个编号，沿用其前缀组给出下一个编号并写回输入框（`E=mc^2#(2-3)`）。带尾字母的编号（如 `1a` 子图序列）不参与自动递增，面板会提示手动输入。
- **全文重编号**：一次宏内按文档顺序为全部编号公式重编——同前缀（`(1)(2)` 与 `(2-1)(2-2)` 视为不同组）各自连续，首条作为组基号保持不变，其后依次 +1；括号风格（半角/全角）逐条保留。结构不识别（编号拆在多个 run、内容控件内公式）的条目跳过并在结果中列出；任一硬失败抛错由编辑器整体回滚。重编不改变公式本体与周围文本。
- **引用核对**（只读）：扫描全文 `式(n)` 引用与实际编号比对，报告为带标题的分组框（问题条目红底、附处理方式引导），缺失引用条目可点击把光标定位到所在段落；重复编号与未被引用的编号单独列出。DS 10.0 社区版不支持公式交叉引用域，引用文本按平台既定策略是静态文本，核对由插件完成。公式条目在独立公式段落时不再重复展示与公式本体相同的上下文行，编号以徽标展示。
- **复制引用**：编号公式条目上「复制引用」把 `式(n)` 复制到剪贴板（Clipboard API 失败时降级 execCommand）。
- **双击回编**（尽力而为）：后台插件在钉版 SDK 形态校验通过后挂 `asc_onDoubleClick` 内部事件，把双击段落的 LaTeX/编号经 BroadcastChannel（localStorage 降级）广播给面板自动刷新并选中对应公式。事件名不被部署版本（10.0.0-169）支持时静默无操作；该路径只读文档、绝不改变编辑器默认双击行为。真实编辑器验收仍需在 DS 上复核事件是否存在。

## Native Word-style numbering

The hidden background plugin `asc.{684716C2-40E8-4F30-9B97-28321F0D7E84}` installs once for editable documents; the visible LaTeX panel is optional. In an empty body paragraph, press Alt+=, enter a formula followed by `#(2)`, then press Enter at the far right of the equation. The result is one undoable native edit and a following body paragraph. `#（2）`, `#(2-1)` and `#(2.1a)` are also supported. Modified Enter keys retain their native behavior.

Unlike the public-API-only formula panel, this keyboard adapter in `native.js` is pinned to **Docs 10.0.0-169**. It uses the synchronous `asc_onBeforeKeyDown` event and explicitly checked internal names for lock checks, the editor's action/history transaction, math caret state, conversion, recalculation and consuming Enter. `GetVersion` must return `10.0.0`; a different version or SDK shape disables interception. Revalidate the adapter before upgrading the pinned image. It does not modify Document Server bundles or expose an Automation API.

The current engine stores `maxDist`/`objDist` but does not apply Word's equation-array stretching. Numbered layout therefore uses an ordinary DOCX paragraph with a center tab stop at half the current column width and a right tab stop at its edge. Native OMML follows the first tab; the ordinary-text label follows the second. No table is created. Width follows the actual equal-width section columns, not a hard-coded page size. DOCX export has no postprocessing, macro, private equation object or raster fallback; editing remains possible without this plugin. Legacy table-based formulas can be converted explicitly through the panel subject to the annotation checks above.

Interception is limited to a sole equation in an ordinary body paragraph, at its final root-level caret, with no selection, prose, fields, bookmarks, content controls or section boundary. Nested hashes and escaped/normal-text hashes are not labels. Unsupported positions, revisions, read-only/protected content and unequal columns retain normal editing. Manual labels do not automatically increment.

Run `node --test backend/app/office_plugin/tests/*.test.cjs`. The native tests cover parser boundaries, preserving math structures/styles, native locks, selections, modifier keys, rollback, symmetric columns and the isolated serialized execution boundary. Real document-server acceptance is still required for layout and DOCX readback.

## Verification

Production verification on 2026-10-23 covered journal-template creation, a manually inserted `\frac{a+b}{c}` with label `(1)`, a successful platform save to version 2 and user-triggered DOCX download. The downloaded document contained native OMML and no tables; both sections, headers/footers and three original template images were retained. This establishes the tested DOCX structure, not desktop Word/WPS visual fidelity or a desktop edit/re-upload round trip. Browser Ctrl+S followed by repeated platform saves also remains a separate integration check.

Run the meaningful boundary/safety tests with:

```
node --test backend/app/office_plugin/tests/core.test.cjs
```

The tests execute the serialized command in an isolated context, mock the documented Office API boundary, and check stale target rejection, identical-formula/reordered-paragraph safety, nested control traversal, preservation of surrounding text, locked-object failure, native inline/standalone insertion and fallback payload serialization. They do not substitute for real Document Server verification.

Manual integration acceptance with Docs 10.0:

1. Upload a real Chinese journal DOCX template. Open it with plugin autostart; check local preview renders and no CDN request appears.
2. Place a caret between two words and insert `\frac{a+b}{c}` inline. Confirm the words stay in the same paragraph and formula is editable in the document.
3. Insert a standalone sum, integral, matrix and multiline aligned expression. Check visual conversion after insertion.
4. Refresh the list, choose a formula, change its LaTeX and update. Check neighboring runs, paragraph alignment and table-cell placement survive.
5. Press the editor's Undo once and confirm the original formula returns; Redo restores the new formula.
6. Choose a formula, then change text in the document before pressing Update. Confirm the stale warning and no formula modification. Refresh/reselect and update successfully.
7. Try identical formulas in different paragraphs and multiple formulas in one paragraph; edit each through its list row.
8. Save/download the DOCX, open in desktop Word, edit the formula, save it, then reopen/upload in the app and read it through the formula list. Confirm native OMML remains editable.

### Verified API semantics

The official `sdkjs` implementation was checked in addition to API reference pages:

- `word/apiBuilder.js`: `ApiMath.GetClassType()` returns `"math"`; `ApiParagraph.GetInternalId()` is a public API (since 9.2), returning the paragraph's internal ID.
- `ApiDocument.InsertContent(content, isInline, pr)` takes the **inline insertion flag as argument 2**. Formatting options such as `KeepTextOnly` belong in argument 3. It is no longer used for formula insertion: inline formulas use native `ApiDocument.AddMathEquation`, and standalone formulas directly insert a sibling paragraph with `ApiParagraph.InsertParagraph(paragraph, "after", true)`; this avoids the generic paste path's display/math-run conversion rules in the deployed build.
- `ApiDocumentContent.GetAllParagraphs()` delegates into the document; document traversal calls each element's `GetAllParagraphs`, and `CTable.GetAllParagraphs` traverses each row/cell. Inline content controls are handled by this plugin's additional child traversal.
- Display math is determined by document layout, not a public `ApiMath.SetDisplayMode` call. `Paragraph_Recalculate.js` calls `CheckMathPara` and then `Set_Inline` according to surrounding paragraph content. A paragraph containing only a formula and empty runs becomes display math during recalculation. A formula surrounded by body text remains inline. The plugin creates a separate centered paragraph for standalone insertion and does not access private math fields.

Sources: [Office API implementation](https://github.com/ONLYOFFICE/sdkjs/blob/master/word/apiBuilder.js), [table traversal](https://github.com/ONLYOFFICE/sdkjs/blob/master/word/Editor/Table.js), [math layout classification](https://github.com/ONLYOFFICE/sdkjs/blob/master/word/Editor/Paragraph_Recalculate.js). These implementation checks do not establish the visual result of a deployed build: manual acceptance must compare inline/standalone fractions and sum limits in the actual pinned Document Server image and the downloaded DOCX.

For reproducible engine verification, run `python backend/app/office_plugin/tests/verify_numbering.py --container <name>` from the repository root. It executes the production commands with the bundled Document Builder, saves/reopens/updates single-column, two-column and converted legacy samples, checks their DOCX XML and retains PDFs for visual inspection. An additional controlled caret/key event runs the native handler with real Office objects to verify paragraph identity and bookmark retention; selection/locks/history are simulated in that case. The tool only creates scratch files under `.e2e-downloads/` and a unique container `/tmp/paper-math-*` directory. Use `--fonts-dir` for additional container fonts. This check does not replace browser keyboard/undo or desktop Word/WPS acceptance.

Official API references used:

- <https://api.onlyoffice.com/docs/office-api/usage-api/document-api/Api/Methods/CreateMath>
- <https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiMath/Methods/GetText>
- <https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiParagraph/Methods/AddElement>
- <https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiParagraph/Methods/RemoveElement>
- <https://api.onlyoffice.com/docs/plugins/interacting-with-editors/overview/how-to-call-commands>
- <https://api.onlyoffice.com/docs/plugins/configuration>
