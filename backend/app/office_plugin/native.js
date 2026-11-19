/* Native input adapter pinned to ONLYOFFICE Docs 10.0.0-169.
 * Construction uses public Office API objects, OMML and Word paragraph tabs. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaperStudioNativeNumbering = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function numberingCommand(payload) {
    "use strict";
    if (!payload && typeof Asc !== "undefined" && Asc.scope) payload = Asc.scope.paperStudioMathPayload;
    payload = payload || {};
    var revision = "numbering-9";
    function parseInput(value) {
      var text = String(value || "").trim();
      var match = /#(\(|（)\s*([0-9]+(?:[.\-][0-9]+)*[a-zA-Z]?)\s*(\)|）)$/.exec(text);
      if (!match || (match[1] === "(" ? match[3] !== ")" : match[3] !== "）")) return {formula: text, label: null};
      var slashes = 0;
      for (var p = match.index - 1; p >= 0 && text[p] === "\\"; p--) slashes++;
      if (slashes % 2 || match[2].length > 24) return {formula: text, label: null};
      var depth = 0;
      for (var i = 0; i < match.index; i++) {
        if (text[i] === "\\") {i++; continue;}
        if (text[i] === "{") depth++;
        if (text[i] === "}") depth--;
      }
      if (depth !== 0) return {formula: text, label: null};
      var formula = text.slice(0, match.index).trim();
      return formula ? {formula: formula, label: match[1] + match[2] + match[3]} : {formula: text, label: null};
    }
    function clone(value) {return JSON.parse(JSON.stringify(value));}
    function kind(value) {return value && typeof value.GetClassType === "function" ? value.GetClassType() : "";}
    function jsonOf(p) {var j = p.ToJSON(false, false); return typeof j === "string" ? JSON.parse(j) : j;}
    function plainMath(nodes) {
      var result = "";
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.type === "mathRun") {
          if (n.mathPr && n.mathPr.nor) return null;
          for (var t = 0; t < n.content.length; t++) {
            if (n.content[t].type !== "mathTxt") return null;
            result += String.fromCodePoint(n.content[t].value);
          }
        } else if (n.type === "delimiter" && n.e && n.e.length === 1) {
          var inner = plainMath(n.e[0]);
          if (inner === null) return null;
          result += String.fromCodePoint(n.dPr.begChr) + inner + String.fromCodePoint(n.dPr.endChr);
        } else return null;
      }
      return result;
    }
    function cleanJson(json) {
      var pending = [json], visited = 0;
      while (pending.length) {
        var value = pending.pop();
        if (!value || typeof value !== "object") continue;
        if (++visited > 50000 || value.reviewType && value.reviewType !== "common" || value.changes && value.changes.length || value.prChange || value.pPrChange || value.rPrChange) return false;
        Object.keys(value).forEach(function (key) {if (value[key] && typeof value[key] === "object") pending.push(value[key]);});
      }
      return true;
    }
    function numberedParagraph(json) {
      if (!json || json.type !== "paragraph" || json.sectPr || json.pPr && (json.pPr.sectPr || json.pPr.numPr) || !cleanJson(json)) return null;
      var math = null;
      for (var i = 0; i < json.content.length; i++) {
        var item = json.content[i];
        if (item.reviewType && item.reviewType !== "common") return null;
        if (item.type === "paraMath" && !math) math = item;
        else if ((item.type !== "run" && item.type !== "endRun") || item.content.length || (item.footnotes || []).length || (item.endnotes || []).length) return null;
      }
      if (!math) return null;
      // A terminal label must start in a top-level math run. Hashes in fractions,
      // matrices, text groups and arbitrary prose are never numbering commands.
      for (var n = math.content.length - 1; n >= 0; n--) {
        var run = math.content[n];
        if (run.type !== "mathRun" || run.mathPr && run.mathPr.nor) continue;
        for (var c = run.content.length - 1; c >= 0; c--) {
          if (run.content[c].type !== "mathTxt" || run.content[c].value !== 35) continue;
          if (c && run.content[c - 1].value === 92) continue;
          var tailRun = clone(run); tailRun.content = tailRun.content.slice(c);
          var tail = plainMath([tailRun].concat(math.content.slice(n + 1)));
          if (tail === null) continue;
          var parsed = parseInput("x" + tail);
          if (!parsed.label || parsed.formula !== "x") continue;
          var pure = clone(json);
          var pureMath = pure.content.filter(function (e) {return e.type === "paraMath";})[0];
          pureMath.content = pureMath.content.slice(0, n + 1);
          pureMath.content[n].content = pureMath.content[n].content.slice(0, c);
          if (!pureMath.content.some(function (e) {return e.type !== "mathRun" || e.content.some(function (t) {return t.value !== 32;});})) return null;
          return {paragraph: pure, label: parsed.label};
        }
      }
      return null;
    }
    if (payload.action === "parse") return {ok: true, input: parseInput(payload.value)};
    if (payload.action === "parse-paragraph") return {ok: true, input: numberedParagraph(payload.value)};
    if (typeof Api === "undefined" || typeof Api.CreateMath !== "function" || typeof Api.FromJSON !== "function") return {ok: true, enabled: false};
    var doc = Api.GetDocument();
    if (payload.action === "status") {
      var saved = Api.paperStudioNumbering;
      return {ok: true, enabled: !!saved, count: saved && saved.count || 0, lastError: saved && saved.lastError || "", dblClick: !!Api.paperStudioMathLocate};
    }
    function usableWidth(p, fromTable) {
      if (!fromTable && p.GetParentTable && p.GetParentTable()) throw new Error("请在正文独立段落中插入编号公式。");
      if (!fromTable && kind(p.GetParent()) !== "document") throw new Error("此位置暂不支持编号公式，请使用正文独立段落。");
      var section = p.GetSection();
      if (!section) throw new Error("无法读取当前节的版心宽度。");
      var widths = section.GetColumnsWidths();
      if (!widths || !widths.length || widths.some(function (w) {return Math.abs(w - widths[0]) > 2;})) throw new Error("不等宽分栏暂不支持自动编号，请先使用等宽栏。");
      var width = Math.round(widths[0]);
      if (!Number.isFinite(width) || width < 1440 || width > 32000) throw new Error("当前栏宽不适合插入编号公式。");
      return width;
    }
    function insertionFontSize(anchor) {
      // Paragraph.GetTextPr is only the paragraph-end mark's direct properties.
      // Read the effective caret formatting first; do not assume 11 or 12 pt.
      var readers = [
        function () {return doc.GetRangeBySelect().GetTextPr();},
        function () {return anchor.GetTextPr();},
        function () {return anchor.GetRange().GetTextPr();},
        function () {return anchor.GetStyle().GetTextPr();},
        function () {return doc.GetDefaultTextPr();}
      ];
      for (var i = 0; i < readers.length; i++) {
        try {
          var size = readers[i]().GetFontSize();
          if (Number.isFinite(size) && size > 0 && size <= 3276) return size; // half-points
        } catch (error) { /* Try the next public formatting source. */ }
      }
      return null;
    }
    function buildLine(center, label, width, numberFontSize) {
      var pr = center.GetParaPr();
      if (!pr || typeof pr.SetTabs !== "function" || typeof Api.CreateRun !== "function") throw new Error("当前文档服务缺少公式编号所需的段落接口。");
      // Word's ordinary center/right tab stops, not a table or floating object.
      // Keep the equation intact: do not flatten, resize, or rasterize its OMML.
      if (!pr.SetTabs([width / 2, width], ["center", "right"])) throw new Error("无法设置公式编号的对齐位置。");
      center.SetJc("left"); center.SetIndFirstLine(0); center.SetIndLeft(0); center.SetIndRight(0);
      var tab = Api.CreateRun();
      tab.AddTabStop();
      if (center.AddElement(tab, 0) === false) throw new Error("无法创建公式编号行。");
      center.AddTabStop();
      var number = center.AddText(label);
      if (numberFontSize) number.GetTextPr().SetFontSize(numberFontSize);
      return center;
    }
    function continuation(json) {
      var next = clone(json);
      next.content = next.content.filter(function (e) {return e.type === "endRun";});
      if (next.pPr) {delete next.pPr.pageBreakBefore; delete next.pPr.keepNext;}
      return Api.FromJSON(JSON.stringify(next));
    }
    if (payload.action === "number-next-line") {
      var current = doc.GetCurrentParagraph();
      usableWidth(current);
      var tabs = current.GetParaPr().GetTabs();
      if (tabs.length !== 2 || tabs[0].Val !== "center" || tabs[1].Val !== "right") throw new Error("请把光标放在无表格的编号公式段落中。");
      var mathIndex = -1, before = "", after = "";
      for (var i = 0; i < current.GetElementsCount(); i++) {
        var element = current.GetElement(i);
        if (kind(element) === "math" && mathIndex === -1) mathIndex = i;
        else if (kind(element) !== "run" || typeof element.GetText !== "function") throw new Error("此段落含有其他内容，未修改编号位置。");
        else if (mathIndex === -1) before += element.GetText();
        else after += element.GetText();
      }
      var input = parseInput("x#" + after.trim());
      if (mathIndex === -1 || before !== "\t" || !input.label || input.formula !== "x" || !/^\s/.test(after)) throw new Error("请把光标放在无表格的编号公式段落中。");
      if (/^\s*[\r\n]/.test(after)) return {ok: true, numberNextLine: true, changed: false};
      var breakRun = Api.CreateRun();
      // At the next line's start, skip the center stop; the existing trailing
      // tab then reaches the right stop even after a long equation wraps.
      breakRun.AddLineBreak(); breakRun.AddTabStop();
      if (current.AddElement(breakRun, mathIndex + 1) === false) throw new Error("当前段落不可修改，原编号已保留。");
      return {ok: true, numberNextLine: true, changed: true};
    }
    if (payload.action === "convert-current") {
      var current = doc.GetCurrentParagraph();
      var oldTable = current && current.GetParentTable && current.GetParentTable();
      if (!oldTable || kind(oldTable.GetParent()) !== "document") throw new Error("请先把光标放在旧版编号公式表格中。");
      if (doc.IsTrackRevisions && doc.IsTrackRevisions()) throw new Error("请先关闭修订，再转换旧公式表格。");
      // ToJSON omits comment anchors and bookmarks. Until the API can move
      // these ranges losslessly, do not clone table contents in annotated docs.
      // The pinned manager includes hidden _Ref bookmarks, unlike the public
      // GetAllBookmarksNames API. _GoBack is only Word's navigation position.
      var bookmarks = doc.Document && doc.Document.Ru;
      if (typeof doc.GetAllComments !== "function" || !bookmarks || typeof bookmarks.We !== "function" || typeof bookmarks.u_ !== "function" || typeof bookmarks.Eo !== "function") throw new Error("当前编辑器无法完整检查批注和书签，原表格已保留。");
      if (doc.GetAllComments().length) throw new Error("文档含有批注，暂不转换旧公式表格，以保留审阅内容。");
      bookmarks.We();
      for (var b = 0; b < bookmarks.u_(); b++) if (bookmarks.Eo(b) !== "_GoBack") throw new Error("文档含有书签或交叉引用，暂不转换旧公式表格，以保留引用位置。");
      var tableJson = jsonOf(oldTable), tablePr = tableJson.tblPr || {}, rows = tableJson.content || [];
      var borders = tablePr.tblBorders || {}, borderNames = ["top", "bottom", "start", "end", "insideH", "insideV"];
      if (!cleanJson(tableJson) || !tablePr.inline || tablePr.tblLayout !== "fixed" || !rows.length || rows.length > 1000 || borderNames.some(function (name) {return !borders[name] || !/^(none|nil)$/.test(borders[name].value);})) throw new Error("仅支持转换旧版无边框编号公式表格，原表格已保留。");
      var lines = [];
      rows.forEach(function (row, rowIndex) {
        if (!row.content || row.content.length !== 3) throw new Error("此表格含有合并单元格或额外内容，未进行转换。");
        var cellJson = row.content.map(function (cell) {
          var pr = cell.tcPr || {}, content = cell.content && cell.content.content;
          if (pr.vMerge || Object.keys(pr.tcBorders || {}).some(function (name) {return !/^(none|nil)$/.test(pr.tcBorders[name].value);}) || !content || content.length !== 1 || content[0].type !== "paragraph") throw new Error("此表格含有合并单元格或额外内容，未进行转换。");
          return content[0];
        });
        var widths = row.content.map(function (cell) {return cell.tcPr && cell.tcPr.tcW && cell.tcPr.tcW.w;});
        if (!widths.every(function (w) {return Number.isFinite(w) && w > 0;}) || Math.abs(widths[0] - widths[2]) > 2) throw new Error("此表格不符合旧版公式布局，未进行转换。");
        // Reuse the strict native parser to reject prose, controls and revisions.
        var pure = clone(cellJson[1]);
        var labelText = "";
        [0, 2].forEach(function (index) {
          var j = cellJson[index];
          if (j.sectPr || j.pPr && (j.pPr.sectPr || j.pPr.numPr)) throw new Error("此表格含有额外格式，未进行转换。");
          j.content.forEach(function (item) {
            if ((item.type !== "run" && item.type !== "endRun") || (item.footnotes || []).length || (item.endnotes || []).length) throw new Error("此表格含有额外内容，未进行转换。");
            item.content.forEach(function (text) {
              if (typeof text !== "string" || index === 0) throw new Error("此表格含有额外内容，未进行转换。");
              labelText += text;
            });
          });
        });
        var parsedLabel = parseInput("x#" + labelText.trim());
        if (!parsedLabel.label || parsedLabel.formula !== "x") throw new Error("此表格不是可识别的编号公式，未进行转换。");
        var mathJson = pure.content.filter(function (e) {return e.type === "paraMath";});
        if (mathJson.length !== 1) throw new Error("此表格不是可识别的编号公式，未进行转换。");
        mathJson[0].content.push({type: "mathRun", mathPr: {}, rPr: {}, content: Array.from("#" + parsedLabel.label, function (letter) {return {type: "mathTxt", value: letter.codePointAt(0)};})});
        var parsedTable = numberedParagraph(pure);
        if (!parsedTable) throw new Error("此公式含有额外内容，未进行转换。");
        // The synthetic label only validates the old cell contents. Never send
        // its incomplete run properties to the Office JSON deserializer.
        parsedTable.paragraph.content.filter(function (e) {return e.type === "paraMath";})[0].content.pop();
        lines.push(buildLine(Api.FromJSON(JSON.stringify(parsedTable.paragraph)), parsedLabel.label, usableWidth(oldTable.GetCell(rowIndex, 1).GetContent().GetElement(0), true)));
      });
      var tableParent = oldTable.GetParent(), tableIndex = oldTable.GetPosInParent(), inserted = 0;
      try {
        for (var rowIndex = 1; rowIndex < lines.length; rowIndex++) {
          if (!tableParent.AddElement(tableIndex + rowIndex, lines[rowIndex])) throw new Error("无法插入转换后的公式，原表格已保留。");
          inserted++;
        }
        if (!oldTable.ReplaceByElement(lines[0])) throw new Error("当前表格不可修改，原公式已保留。");
      } catch (error) {
        while (inserted) tableParent.RemoveElement(tableIndex + inserted--);
        throw error;
      }
      lines[0].GetRange().MoveCursorToPos(0);
      return {ok: true, converted: true, count: lines.length};
    }
    if (payload.action === "insert") {
      var input = parseInput(payload.value);
      if (!input.label) throw new Error("请输入公式及末尾编号，例如 E=mc^2#(2)。");
      if (input.formula.length > 20000 || /\u0000/.test(input.formula)) throw new Error("公式过长或包含无效字符。");
      var anchor = doc.GetCurrentParagraph();
      var width = usableWidth(anchor);
      var fontSize = insertionFontSize(anchor);
      var p = Api.CreateParagraph();
      if (anchor.GetStyle()) p.SetStyle(anchor.GetStyle());
      p.AddElement(Api.CreateMath(input.formula, "latex"));
      var line = buildLine(p, input.label, width);
      if (fontSize) line.SetFontSize(fontSize);
      var after = continuation(jsonOf(anchor));
      var parent = anchor.GetParent();
      if (!parent.AddElement(anchor.GetPosInParent() + 1, line)) throw new Error("编号公式插入失败。");
      if (!parent.AddElement(line.GetPosInParent() + 1, after)) {
        parent.RemoveElement(line.GetPosInParent());
        throw new Error("无法插入公式后的正文段落，原稿已保留。");
      }
      after.GetRange().MoveCursorToPos(0);
      return {ok: true, numbered: true, label: input.label};
    }
    if (payload.action !== "install" || typeof Api.attachEvent !== "function") return {ok: true, enabled: false};
    var installedLogic = doc.Document;
    if (payload.sdkVersion !== "10.0.0" || !installedLogic || typeof installedLogic.mk !== "function" || typeof installedLogic.lf !== "function" || typeof installedLogic.pd !== "function" || typeof installedLogic.ld !== "function" || !installedLogic.sb || !installedLogic.sb.wa || installedLogic.sb.wa.La !== installedLogic) return {ok: true, enabled: false};
    /* 双击回编（尽力而为）：编辑器若提供原生双击内部事件，则把含公式段落的
     * LaTeX/编号广播给公式面板自动定位选中。事件名不被部署版本支持时静默无操作，
     * 绝不改变编辑器默认的双击行为；仅用公开 API 读取，不依赖键盘适配的内部形态。 */
    if (!Api.paperStudioMathLocate || Api.paperStudioMathLocate.revision !== revision) {
      var locateRuntime = {revision: revision, hits: 0};
      Api.paperStudioMathLocate = locateRuntime;
      Api.attachEvent("asc_onDoubleClick", function () {
        try {
          if (Api.paperStudioMathLocate !== locateRuntime) return;
          var locateDoc = Api.GetDocument();
          if (!locateDoc || typeof locateDoc.GetCurrentParagraph !== "function") return;
          var locateParagraph = locateDoc.GetCurrentParagraph();
          if (!locateParagraph || typeof locateParagraph.GetElementsCount !== "function") return;
          var locateCount = locateParagraph.GetElementsCount(), latex = "", mathIndex = -1, mathTotal = 0;
          for (var li = 0; li < locateCount; li++) {
            var le = locateParagraph.GetElement(li);
            if (le && typeof le.GetClassType === "function" && le.GetClassType() === "math" && typeof le.GetText === "function") {
              mathTotal += 1;
              if (mathIndex === -1) { mathIndex = li; latex = String(le.GetText("latex") || ""); }
            }
          }
          // 同段多条公式时，事件层拿不到真实双击命中的是哪一条——发首个必然可能选错。
          // 拒绝定位（静默保留编辑器默认双击行为），由用户在面板清单里选择。
          if (mathIndex === -1 || mathTotal > 1) return;
          var tail = "";
          for (var lj = mathIndex + 1; lj < locateCount; lj++) {
            var lr = locateParagraph.GetElement(lj);
            if (lr && typeof lr.GetText === "function") tail += String(lr.GetText() || "");
          }
          var lm = /^\s*[（(]\s*([0-9][0-9.、\-]*[a-zA-Z]?)\s*[）)]\s*$/.exec(tail);
          // 段落内部 ID 随消息带上：面板优先按段落匹配——重复内容（如两条相同公式
          // 分别编号 (1)(2)）不能只靠 LaTeX 文本区分，否则永远命中第一条。
          var locateParaId = "";
          try { locateParaId = typeof locateParagraph.GetInternalId === "function" ? String(locateParagraph.GetInternalId()) : ""; } catch (e) { /* 旧形态无 ID 时退回文本匹配 */ }
          locateRuntime.hits += 1;
          var locateMessage = {type: "paper-studio-math-locate", at: new Date().getTime(), latex: latex, label: lm ? lm[1] : null, paraId: locateParaId, mathIndex: mathIndex};
          if (typeof BroadcastChannel === "function") {
            try { new BroadcastChannel("paper-studio-math").postMessage(locateMessage); } catch (e) { /* 通道不可达时降级 localStorage */ }
          }
          try { localStorage.setItem("paper-studio-math-locate", JSON.stringify(locateMessage)); } catch (e) { /* 无存储则跳过降级通道 */ }
        } catch (e) { /* 定位失败绝不影响编辑器默认双击行为 */ }
      });
    }
    if (Api.paperStudioNumbering && Api.paperStudioNumbering.revision === revision) return {ok: true, enabled: true};
    var runtime = {revision: revision, count: 0, lastError: ""};
    Api.paperStudioNumbering = runtime;
    Api.attachEvent("asc_onBeforeKeyDown", function (event) {
      try {
        // An already registered older revision becomes inert after an upgrade.
        if (Api.paperStudioNumbering !== runtime) return;
        // Pinned adapter: same native locks/history action as Enter. An unsupported
        // SDK shape fails closed; ordinary editing retains the editor's behavior.
        if (!event || event.iq !== 13 || event.Tk || event.eH || event.vl || event.mnd) return;
        var currentDoc = Api.GetDocument();
        var logic = currentDoc.Document;
        if (!logic || !this.wa || logic !== this.wa.La || typeof logic.mk !== "function" || typeof logic.lf !== "function" || typeof logic.pd !== "function" || typeof logic.ld !== "function" || typeof this.Undo !== "function") return;
        var selected = logic.mk();
        var math = selected && selected.AT;
        if (!math || typeof math.Ola !== "function" || typeof math.Te !== "function" || typeof math.S1 !== "function" || !math.Ola() || math.Te() || math.S1().aa !== math.Lf) return;
        var paragraph = currentDoc.GetCurrentParagraph();
        if (!paragraph) return;
        var source = jsonOf(paragraph);
        var parsed = numberedParagraph(source);
        if (!parsed) return;
        if (typeof this.asc_GetLocalTrackRevisions === "function" && this.asc_GetLocalTrackRevisions()) {runtime.lastError = "修订模式下请先关闭修订，再插入编号公式。"; return;}
        var width;
        try {width = usableWidth(paragraph);} catch (error) {runtime.lastError = error.message; return;}
        var numberFontSize = insertionFontSize(paragraph);
        // 1/2: paragraph contents/properties; 11: adding document contents.
        if (logic.lf(1, null, false, false) || logic.lf(2, null, false, false) || logic.lf(11, null, false, false)) return;
        var started = false, attached = false;
        try {
          logic.pd(0x0136); // historydescription_Document_ApiBuilder
          started = true;
          var center = Api.FromJSON(JSON.stringify(parsed.paragraph));
          var equation = null;
          for (var i = 0; i < center.GetElementsCount(); i++) if (kind(center.GetElement(i)) === "math") equation = center.GetElement(i);
          if (!equation || !equation.dk || typeof equation.dk.IEb !== "function") throw new Error("当前编辑器的公式接口不兼容，原公式已保留。");
          // Convert a detached copy after stripping the label, retaining math styles.
          equation.dk.IEb(false, this.Emb);
          var originalMathIndex = -1;
          for (var i = 0; i < paragraph.GetElementsCount(); i++) if (kind(paragraph.GetElement(i)) === "math") originalMathIndex = i;
          if (originalMathIndex === -1) throw new Error("无法定位原公式，原段落已保留。");
          var next = continuation(source);
          var parent = paragraph.GetParent();
          var index = paragraph.GetPosInParent();
          if (!parent.AddElement(index + 1, next)) throw new Error("无法创建公式后的正文段落。");
          attached = true;
          // Keep the original paragraph and its comment/bookmark anchors.
          // Replacing only its math follows the same insert/remove semantics
          // as the verified LaTeX update command, inside this one undo action.
          if (paragraph.AddElement(equation, originalMathIndex) === false || paragraph.RemoveElement(originalMathIndex + 1) === false) throw new Error("无法替换原公式。");
          buildLine(paragraph, parsed.label, width, numberFontSize);
          next.GetRange().MoveCursorToPos(0);
          logic.Ec(); logic.Le(); logic.Xf(); logic.ld(); started = false;
          event.iq = 0;
          runtime.count++; runtime.lastError = "";
        } catch (error) {
          if (started) logic.ld();
          if (attached) this.Undo();
          runtime.lastError = error.message || "公式编号失败，原公式已保留。";
        }
      } catch (error) {
        // Read-only inspection must not break the editor's original key handler.
        runtime.lastError = error.message || "当前公式暂不支持自动编号。";
      }
    });
    return {ok: true, enabled: true};
  }
  return {
    numberingCommand: numberingCommand,
    installCommand: numberingCommand,
    parseInput: function (value) {return numberingCommand({action: "parse", value: value}).input;}
  };
});
