/* Shared with the Node tests. The document command is deliberately self-contained:
 * ONLYOFFICE serializes its function body into the editor's Office API context. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaperStudioMath = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalizeLatex(value) {
    var text = String(value || "").trim();
    var delimiters = [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]];
    for (var i = 0; i < delimiters.length; i += 1) {
      var pair = delimiters[i];
      if (text.length >= pair[0].length + pair[1].length && text.indexOf(pair[0]) === 0 && text.slice(-pair[1].length) === pair[1]) {
        text = text.slice(pair[0].length, -pair[1].length).trim();
        break;
      }
    }
    if (!text) throw new Error("请输入 LaTeX 表达式。");
    if (text.length > 20000) throw new Error("单条公式最多支持 20,000 个字符。");
    if (/\u0000/.test(text)) throw new Error("公式包含无效字符。");
    return text;
  }

  function serverScriptUrl(value) {
    var url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("文档服务地址无效，请检查 ONLYOFFICE 配置。");
    }
    return url.href.replace(/\/+$/, "") + "/sdkjs-plugins/v1/plugins.js";
  }

  async function configuredServerScriptUrl(fetcher, pageUrl) {
    // Never take an executable script origin from location.search. A visitor can
    // supply arbitrary query parameters, even though config.json normally does not.
    // Only the same-origin backend's fixed settings response can select the SDK.
    var page = new URL(pageUrl);
    var settings = new URL("settings.json", page);
    var response = await fetcher(settings.href, {credentials: "omit", cache: "no-store", redirect: "error"});
    if (!response.ok) throw new Error("无法读取公式插件设置，请检查文档服务配置。");
    var data = await response.json();
    if (!data || typeof data.document_server_url !== "string") throw new Error("公式插件缺少文档服务设置，请联系管理员。");
    return serverScriptUrl(data.document_server_url);
  }

  function startSdkHandshake(host, readyState) {
    // ONLYOFFICE's plugins.js installs a window.onload function that fetches
    // config.json and posts "initialize" to the editor. This SDK is loaded only
    // after our asynchronous settings fetch, so the page's load event may already
    // have happened. Preserve the SDK handler and run it once in either order.
    var sdkOnload = host.onload;
    if (typeof sdkOnload !== "function") return;
    var started = false;
    host.onload = function (event) {
      if (started) return;
      started = true;
      return sdkOnload.call(host, event);
    };
    if (readyState === "complete") host.onload();
  }

  /* No references to plugin-scope functions, DOM, network, or private SDK fields.
   * A write validates an exact content snapshot plus paragraph identity, path and
   * the previous formula text inside the SAME macro that performs the write.
   * Any intervening edit requires the user to refresh and select again. */
  function documentCommand(payload) {
    "use strict";
    if (!payload && typeof Asc !== "undefined" && Asc.scope) payload = Asc.scope.paperStudioMathPayload;
    payload = payload || {};
    if (typeof Api === "undefined" || typeof Api.CreateMath !== "function") {
      return {ok: false, code: "unsupported", message: "公式编辑需要 ONLYOFFICE Docs 10.0 或更高版本。"};
    }
    var doc = Api.GetDocument();
    if (!doc || typeof doc.GetAllParagraphs !== "function") {
      return {ok: false, code: "unsupported", message: "当前文档不支持读取原生公式。"};
    }

    function kind(element) {
      return element && typeof element.GetClassType === "function" ? element.GetClassType() : "unknown";
    }
    function identity(element) {
      return element && typeof element.GetInternalId === "function" ? String(element.GetInternalId()) : "";
    }
    function textOf(element, format) {
      return element && typeof element.GetText === "function" ? String(element.GetText(format) || "") : "";
    }
    function scan() {
      var paragraphs = doc.GetAllParagraphs();
      var formulas = [];
      var signature = [];
      function children(container, paragraph, paragraphIndex, path, depth) {
        if (depth > 32) throw new Error("文档内容嵌套过深，无法安全定位公式。");
        var result = [];
        var count = container.GetElementsCount();
        for (var index = 0; index < count; index += 1) {
          var element = container.GetElement(index);
          var type = kind(element);
          var position = path.concat([index]);
          if (type === "math") {
            if (typeof element.GetText !== "function") throw new Error("当前编辑器不能读取公式，请使用 ONLYOFFICE Docs 10.0 或更高版本。");
            var latex = textOf(element, "latex");
            result.push([type, latex]);
            formulas.push({
              paragraphIndex: paragraphIndex,
              paragraphId: identity(paragraph),
              path: position,
              latex: latex,
              context: textOf(paragraph).replace(/\s+/g, " ").trim().slice(0, 180),
              _parent: container,
              _paragraph: paragraph,
              _index: index
            });
          } else if (element && typeof element.GetElementsCount === "function" && typeof element.GetElement === "function") {
            result.push([type, identity(element), children(element, paragraph, paragraphIndex, position, depth + 1)]);
          } else {
            result.push([type, identity(element), textOf(element)]);
          }
        }
        return result;
      }
      for (var p = 0; p < paragraphs.length; p += 1) {
        var paragraph = paragraphs[p];
        var paragraphId = identity(paragraph);
        if (!paragraphId) throw new Error("编辑器未提供段落身份，已停止公式修改以保护文档。");
        signature.push([paragraphId, textOf(paragraph), children(paragraph, paragraph, p, [], 0)]);
      }
      return {formulas: formulas, version: JSON.stringify(signature)};
    }
    function publicFormula(item) {
      return {paragraphIndex: item.paragraphIndex, paragraphId: item.paragraphId, path: item.path, latex: item.latex, context: item.context};
    }
    function listResult(snapshot) {
      return {ok: true, version: snapshot.version, formulas: snapshot.formulas.map(publicFormula)};
    }
    function checkedTarget(snapshot) {
      if (typeof payload.version !== "string" || payload.version !== snapshot.version) return null;
      var target = payload.target;
      if (!target || !Array.isArray(target.path) || !target.paragraphId) return null;
      var path = JSON.stringify(target.path);
      for (var i = 0; i < snapshot.formulas.length; i += 1) {
        var item = snapshot.formulas[i];
        if (item.paragraphId === target.paragraphId && item.paragraphIndex === target.paragraphIndex && JSON.stringify(item.path) === path && item.latex === target.latex) return item;
      }
      return null;
    }
    function createMath() {
      var latex = typeof payload.latex === "string" ? payload.latex.trim() : "";
      if (!latex || latex.length > 20000 || /\u0000/.test(latex)) throw new Error("LaTeX 表达式为空、过长或包含无效字符。");
      var math = Api.CreateMath(latex, "latex");
      if (!math || kind(math) !== "math" || !textOf(math, "latex").trim()) throw new Error("文档编辑器无法转换这条公式，请检查 LaTeX 命令。");
      return math;
    }
    function insertionFontSize(anchor) {
      // The effective caret may carry a direct size or inherit a journal style.
      // Paragraph.GetTextPr alone does not resolve that inheritance.
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
          if (Number.isFinite(size) && size > 0 && size <= 3276) return size;
        } catch (error) { /* Try the next public formatting source. */ }
      }
      return null;
    }

    if (payload.action === "list") return listResult(scan());
    if (payload.action === "insert") {
      var newMath = createMath();
      var paragraph = Api.CreateParagraph();
      if (paragraph.AddElement(newMath) === false) throw new Error("无法创建公式段落。");
      if (payload.placement === "display") {
        paragraph.SetJc("center");
        var anchor = typeof doc.GetCurrentParagraph === "function" ? doc.GetCurrentParagraph() : null;
        if (!anchor || typeof anchor.InsertParagraph !== "function") throw new Error("当前光标位置不能插入独立公式，请先点击可编辑正文。");
        var fontSize = insertionFontSize(anchor);
        if (fontSize) paragraph.SetFontSize(fontSize);
        // In Docs 10.0.0-169, InsertContent prefers inserting into an existing
        // math run when the caret remains inside a previous equation, even if
        // isInline is false. InsertParagraph creates an actual sibling instead.
        if (!anchor.InsertParagraph(paragraph, "after", true)) throw new Error("独立公式插入失败，请检查正文是否可编辑。");
        var insertedRange = typeof paragraph.GetRange === "function" ? paragraph.GetRange() : null;
        if (insertedRange && typeof insertedRange.MoveCursorToPos === "function") insertedRange.MoveCursorToPos(0);
      } else {
        // Use the editor's native equation-at-caret operation for inline input.
        // Generic paragraph paste may promote a math-only paragraph to a display
        // block or merge it into an existing math object before considering inline.
        if (typeof doc.AddMathEquation !== "function" || doc.AddMathEquation(payload.latex, "latex") === false) {
          throw new Error("插入失败，请先在可编辑正文中放置光标。");
        }
      }
      return {ok: true, latex: textOf(newMath, "latex")};
    }
    if (payload.action === "select" || payload.action === "replace") {
      var snapshot = scan();
      var current = checkedTarget(snapshot);
      if (!current) return {ok: false, code: "stale", message: "文档内容已变化。请刷新公式清单，重新选择后再修改；你的输入已保留。"};
      if (payload.action === "select") {
        // The deployed 10.0 API exposes cursor movement on ApiRange, not on
        // ApiParagraph. Use a collapsed caret and never Select the whole paragraph.
        // If a host lacks range navigation, reading/editing the verified target
        // remains available without moving the caret.
        var range = typeof current._paragraph.GetRange === "function" ? current._paragraph.GetRange() : null;
        var located = !!(range && typeof range.MoveCursorToPos === "function" && range.MoveCursorToPos(0));
        return {ok: true, located: located};
      }
      var parent = current._parent;
      if (typeof parent.AddElement !== "function" || typeof parent.RemoveElement !== "function") {
        return {ok: false, code: "unsupported", message: "该公式所在的内容控件不能通过插件编辑。"};
      }
      var replacement = createMath();
      // Preserve a uniform paragraph's actual size even when the caret has
      // moved elsewhere since selecting this formula. Do not normalize mixed
      // font sizes or change surrounding text and numbering.
      var replacementFontSize = null;
      try {
        replacementFontSize = current._paragraph.GetRange().GetTextPr().GetFontSize();
      } catch (error) { /* Older hosts retain the existing inheritance path. */ }
      if (Number.isFinite(replacementFontSize) && replacementFontSize > 0 && replacementFontSize <= 3276) {
        var fontHolder = Api.CreateParagraph();
        if (fontHolder.AddElement(replacement) === false) throw new Error("无法保留原公式字号，原公式未修改。");
        fontHolder.SetFontSize(replacementFontSize);
      }
      // Insert first. A failed conversion or insertion never removes the original.
      // Both mutations share one macro; explicitly clean up if removing the old
      // object fails, rather than assuming every thrown macro error rolls back.
      if (parent.AddElement(replacement, current._index) === false) throw new Error("公式所在位置不可编辑，原公式未修改。");
      if (parent.RemoveElement(current._index + 1) === false) {
        parent.RemoveElement(current._index);
        throw new Error("原公式更新失败，请检查该位置是否被锁定。");
      }
      return {ok: true, latex: textOf(replacement, "latex")};
    }
    return {ok: false, code: "invalid", message: "未知公式操作。"};
  }

  return {normalizeLatex: normalizeLatex, serverScriptUrl: serverScriptUrl, configuredServerScriptUrl: configuredServerScriptUrl, startSdkHandshake: startSdkHandshake, documentCommand: documentCommand};
});
