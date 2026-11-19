/* Shared chart operations. The document command is serialized into ONLYOFFICE. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaperStudioCharts = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function context(info) {
    var cb = new URL(String(info && info.documentCallbackUrl || ""));
    var match = /^\/api\/office\/callback\/([^/]+)\/([^/]+)$/.exec(cb.pathname);
    if (!/^https?:$/.test(cb.protocol) || !match) throw new Error("请从当前 Word 项目的编辑器中打开图表面板。");
    var pid = decodeURIComponent(match[1]), key = decodeURIComponent(match[2]);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(pid) || !/^[a-zA-Z0-9_-]{8,80}$/.test(key)) throw new Error("文档会话信息无效，请重新打开编辑器。");
    // Only the identifiers are used. Never fetch the callback URL or its token.
    return {pid: pid, docKey: key};
  }

  function sameContext(a, b) { return !!a && !!b && a.pid === b.pid && a.docKey === b.docKey; }

  function imageSize(widthPx, heightPx, widthMm) {
    if (![widthPx, heightPx, widthMm].every(Number.isFinite) || widthPx <= 0 || heightPx <= 0 || widthMm < 10 || widthMm > 160) {
      throw new Error("图片尺寸无效，插入宽度须为 10–160 毫米。");
    }
    return {width: Math.round(widthMm * 36000), height: Math.round(widthMm * heightPx / widthPx * 36000)};
  }

  function insertionName(fid, sha, uuid) {
    if (!/^(fig-[0-9]+-[0-9a-f]{6}|preview)$/.test(fid) || !/^[0-9a-f]{64}$/.test(sha) || !/^[a-zA-Z0-9-]{16,64}$/.test(uuid)) {
      throw new Error("图表标识无效，请刷新后重新选择。");
    }
    return "paper-figure:" + fid + ":" + sha.slice(0, 16) + ":" + uuid;
  }

  /* 反向解析正文图片名 → {fid, sha16}；非本平台命名的图片返回 null。 */
  function parseInsertionName(name) {
    var text = String(name || "");
    if (!/^paper-figure:[a-zA-Z0-9:-]{20,180}$/.test(text)) return null;
    var parts = text.split(":");
    if (parts.length < 4) return null;
    var uuid = parts.pop(), sha = parts.pop();
    var fid = parts.slice(1).join(":");
    if (!/^fig-[0-9]+-[0-9a-f]{6}$/.test(fid) || !/^[0-9a-f]{16}$/.test(sha) || !/^[a-zA-Z0-9-]{16,64}$/.test(uuid)) return null;
    return {fid: fid, sha16: sha};
  }

  function insertCommand(payload) {
    "use strict";
    if (!payload && typeof Asc !== "undefined" && Asc.scope) payload = Asc.scope.paperStudioChartPayload;
    payload = payload || {};
    function fail(message) { return {ok: false, message: message}; }
    try {
      if (typeof Api === "undefined" || typeof Api.CreateImage !== "function" || typeof Api.CreateParagraph !== "function") {
        return fail("当前编辑器不支持原生图片插入，请下载 PNG 后手动插入。");
      }
      if (typeof payload.data_url !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(payload.data_url)
          || payload.data_url.length > 7 * 1024 * 1024 || !/^paper-figure:[a-zA-Z0-9:-]{20,180}$/.test(payload.name)
          || !Number.isFinite(payload.width) || !Number.isFinite(payload.height) || payload.width <= 0 || payload.height <= 0
          || payload.width > 160 * 36000 || payload.height > 250 * 36000) return fail("插图数据或尺寸无效。");
      var doc = Api.GetDocument();
      if (!doc || typeof doc.InsertContent !== "function" || typeof doc.GetDrawingsByName !== "function"
          || typeof doc.GetSelectedDrawings !== "function" || typeof doc.GetRangeBySelect !== "function") {
        return fail("当前编辑器缺少图片定位接口，请下载 PNG 后手动插入。");
      }
      if (doc.GetSelectedDrawings().length) return fail("请取消图片选择，并把光标放到正文空白段落中。");
      var selection = doc.GetRangeBySelect();
      if (selection && (typeof selection.GetStartPos !== "function" || typeof selection.GetEndPos !== "function"
          || selection.GetStartPos() !== selection.GetEndPos())) return fail("请取消文字选择，并把光标放到正文空白段落中。");
      var anchor = doc.GetCurrentParagraph();
      if (!anchor || typeof anchor.GetText !== "function" || String(anchor.GetText()).trim()) return fail("请先在正文新建一个空白段落，再插入图表。");
      if (typeof anchor.IsEmpty !== "function" || !anchor.IsEmpty()) return fail("请先在正文新建一个空白段落，再插入图表。");
      if (typeof anchor.GetParent !== "function" || !anchor.GetParent() || anchor.GetParent().GetClassType() !== "document"
          || (typeof anchor.GetParentTable === "function" && anchor.GetParentTable())) return fail("请在表格外的正文空白段落插入图表。");
      if (doc.GetDrawingsByName([payload.name]).length) return fail("该插图操作已经执行，请先检查正文。");
      var width = payload.width;
      // Section widths use twips. Use the smallest column when columns differ.
      try {
        var columns = anchor.GetSection().GetColumnsWidths();
        if (!Array.isArray(columns) || !columns.length || !columns.every(function (v) { return Number.isFinite(v) && v > 0; })) return fail("无法读取正文栏宽，请重新放置光标。");
        width = Math.min(width, Math.min.apply(Math, columns) * 635);
      } catch (e) { return fail("无法读取正文栏宽，请在正文空白段落重试。"); }
      var height = Math.round(payload.height * width / payload.width);
      var image = Api.CreateImage(payload.data_url, Math.round(width), height);
      if (!image || typeof image.SetName !== "function" || image.SetName(payload.name) === false) return fail("无法创建图片，正文未修改。");
      var paragraph = Api.CreateParagraph();
      paragraph.SetJc("center");
      if (paragraph.AddDrawing(image) === false) return fail("无法建立图片段落，正文未修改。");
      if (doc.InsertContent([paragraph], false) === false) return fail("编辑器未允许插图，请检查文档权限和当前光标位置。");
      var inserted = doc.GetDrawingsByName([payload.name]);
      if (!inserted || inserted.length !== 1) return {ok: false, uncertain: true, message: "插图操作已发出，但未能确认结果。请先检查正文，避免重复插入。"};
      return {ok: true, name: payload.name, width: Math.round(width), height: height};
    } catch (error) {
      return {ok: false, uncertain: true, message: "未能确认插图结果，请检查正文后再操作：" + error.message};
    }
  }

  function runInsert(host, payload, timeoutMs) {
    // 插入可能已生效而回执丢失（uncertain）。绝不能用另一条传输通道重试同一个
    // 写入；唯一的安全网是限时：超时后按「结果未知」上报，由用户先核查正文。
    var limit = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 20000;
    var attempt;
    if (host.Editor && typeof host.Editor.RunMacro === "function") {
      attempt = Promise.resolve(host.Editor.RunMacro(insertCommand, payload));
    } else {
      attempt = new Promise(function (resolve, reject) {
        if (!host.Asc || !host.Asc.plugin || typeof host.Asc.plugin.callCommand !== "function") {
          reject(new Error("编辑器尚未连接，请稍后重试。")); return;
        }
        host.Asc.scope = host.Asc.scope || {};
        host.Asc.scope.paperStudioChartPayload = payload;
        // Do not retry a failed macro through another transport: it may already have inserted.
        host.Asc.plugin.callCommand(insertCommand, false, true, resolve);
      });
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error("插图操作长时间未返回，结果未知。请先检查正文中是否已出现该图片，再决定后续操作；请勿直接重复插入。"));
      }, limit);
      attempt.then(function (value) { clearTimeout(timer); resolve(value); },
                    function (error) { clearTimeout(timer); reject(error); });
    });
  }

  /* 盘点/替换宏：自包含（编辑器只序列化函数体），名称解析逻辑与模块侧 parseInsertionName 保持一致。 */
  function inventoryCommand() {
    "use strict";
    if (typeof Api === "undefined" || typeof Api.GetDocument !== "function") return {ok: false, message: "当前编辑器不支持读取图片。"};
    var doc = Api.GetDocument();
    if (!doc || typeof doc.GetAllParagraphs !== "function") return {ok: false, message: "当前文档不支持读取图片清单。"};
    function parseName(name) {
      var text = String(name || "");
      if (!/^paper-figure:[a-zA-Z0-9:-]{20,180}$/.test(text)) return null;
      var parts = text.split(":");
      if (parts.length < 4) return null;
      var uuid = parts.pop(), sha = parts.pop(), fid = parts.slice(1).join(":");
      if (!/^fig-[0-9]+-[0-9a-f]{6}$/.test(fid) || !/^[0-9a-f]{16}$/.test(sha)) return null;
      return {fid: fid, sha16: sha};
    }
    var items = [];
    var paragraphs = doc.GetAllParagraphs();
    for (var p = 0; p < paragraphs.length; p += 1) {
      var paragraph = paragraphs[p];
      var count = typeof paragraph.GetElementsCount === "function" ? paragraph.GetElementsCount() : 0;
      for (var i = 0; i < count; i += 1) {
        var element = paragraph.GetElement(i);
        if (!element || typeof element.GetClassType !== "function" || element.GetClassType() !== "image") continue;
        if (typeof element.GetName !== "function") continue;
        var parsed = parseName(element.GetName());
        if (!parsed) continue;
        var item = {name: String(element.GetName()), fid: parsed.fid, sha16: parsed.sha16, paragraphIndex: p, index: i};
        if (typeof element.GetWidth === "function" && typeof element.GetHeight === "function") {
          var w = element.GetWidth(), h = element.GetHeight();
          if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {item.width = w; item.height = h;}
        }
        items.push(item);
      }
    }
    return {ok: true, figures: items, total: items.length};
  }

  function replaceCommand(payload) {
    "use strict";
    if (!payload && typeof Asc !== "undefined" && Asc.scope) payload = Asc.scope.paperStudioChartPayload;
    payload = payload || {};
    function fail(message) { return {ok: false, message: message}; }
    function parseName(name) {
      var text = String(name || "");
      if (!/^paper-figure:[a-zA-Z0-9:-]{20,180}$/.test(text)) return null;
      var parts = text.split(":");
      if (parts.length < 4) return null;
      var uuid = parts.pop(), sha = parts.pop(), fid = parts.slice(1).join(":");
      if (!/^fig-[0-9]+-[0-9a-f]{6}$/.test(fid) || !/^[0-9a-f]{16}$/.test(sha)) return null;
      return {fid: fid, sha16: sha};
    }
    try {
      if (typeof Api === "undefined" || typeof Api.CreateImage !== "function" || typeof Api.GetDocument !== "function") {
        return fail("当前编辑器不支持替换图片，请下载 PNG 后手动替换。");
      }
      var oldParsed = parseName(payload.name), newParsed = parseName(payload.newName);
      if (!oldParsed || !newParsed || oldParsed.fid !== newParsed.fid || oldParsed.sha16 === newParsed.sha16
          || typeof payload.data_url !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(payload.data_url)
          || payload.data_url.length > 7 * 1024 * 1024
          || !Number.isFinite(payload.width) || !Number.isFinite(payload.height) || payload.width <= 0 || payload.height <= 0
          || payload.width > 160 * 36000 || payload.height > 250 * 36000) {
        return fail("替换数据或图片标识无效，正文未修改。");
      }
      var doc = Api.GetDocument();
      if (!doc || typeof doc.GetAllParagraphs !== "function") return fail("当前文档不支持图片替换。");
      var paragraphs = doc.GetAllParagraphs();
      var found = null;
      for (var p = 0; p < paragraphs.length && !found; p += 1) {
        var paragraph = paragraphs[p];
        var count = typeof paragraph.GetElementsCount === "function" ? paragraph.GetElementsCount() : 0;
        for (var i = 0; i < count; i += 1) {
          var element = paragraph.GetElement(i);
          if (element && typeof element.GetClassType === "function" && element.GetClassType() === "image"
              && typeof element.GetName === "function" && String(element.GetName()) === payload.name) {
            found = {paragraph: paragraph, index: i, element: element};
            break;
          }
        }
      }
      if (!found) return fail("正文中未找到该旧图（可能已被删除或移动），请重新检查正文图表。");
      if (doc.GetDrawingsByName && typeof doc.GetDrawingsByName === "function" && doc.GetDrawingsByName([payload.newName]).length) {
        return fail("同名新图已存在，请先检查正文再重试。");
      }
      // 优先沿用旧图在正文中的实际渲染尺寸（EMU），读不到时退回快照尺寸。
      var width = payload.width, height = payload.height;
      try {
        if (typeof found.element.GetWidth === "function" && typeof found.element.GetHeight === "function") {
          var ow = found.element.GetWidth(), oh = found.element.GetHeight();
          if (Number.isFinite(ow) && Number.isFinite(oh) && ow > 0 && oh > 0 && oh <= 250 * 36000) {width = ow; height = oh;}
        }
      } catch (e) { /* 尺寸读取失败时使用快照尺寸 */ }
      var image = Api.CreateImage(payload.data_url, Math.round(width), Math.round(height));
      if (!image || typeof image.SetName !== "function" || image.SetName(payload.newName) === false) return fail("无法创建替换图片，正文未修改。");
      if (typeof found.paragraph.AddElement !== "function" || typeof found.paragraph.RemoveElement !== "function") {
        return fail("该图片所在位置不支持替换，正文未修改。");
      }
      if (found.paragraph.AddElement(image, found.index) === false) return fail("替换位置不可编辑，正文未修改。");
      if (found.paragraph.RemoveElement(found.index + 1) === false) {
        found.paragraph.RemoveElement(found.index);
        return fail("旧图移除失败，请检查该位置是否被锁定；正文未修改。");
      }
      return {ok: true, name: payload.newName, fid: oldParsed.fid, width: Math.round(width), height: Math.round(height)};
    } catch (error) {
      return {ok: false, uncertain: true, message: "未能确认替换结果，请检查正文后再操作：" + error.message};
    }
  }

  /* 盘点/替换是幂等读或原子替换，与插入的「不可重试」语义不同，可安全限时重试。 */
  function runDocumentMacro(host, command, payload, timeoutMs) {
    var limit = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 20000;
    var attempt;
    if (host.Editor && typeof host.Editor.RunMacro === "function") {
      attempt = Promise.resolve(host.Editor.RunMacro(command, payload));
    } else {
      attempt = new Promise(function (resolve, reject) {
        if (!host.Asc || !host.Asc.plugin || typeof host.Asc.plugin.callCommand !== "function") {
          reject(new Error("编辑器尚未连接，请稍后重试。")); return;
        }
        host.Asc.scope = host.Asc.scope || {};
        host.Asc.scope.paperStudioChartPayload = payload;
        host.Asc.plugin.callCommand(command, false, true, resolve);
      });
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("文档操作长时间未返回，请稍后重试。")); }, limit);
      attempt.then(function (value) { clearTimeout(timer); resolve(value); },
                    function (error) { clearTimeout(timer); reject(error); });
    });
  }

  return {context: context, sameContext: sameContext, imageSize: imageSize, insertionName: insertionName, parseInsertionName: parseInsertionName,
    insertCommand: insertCommand, runInsert: runInsert, inventoryCommand: inventoryCommand, replaceCommand: replaceCommand, runDocumentMacro: runDocumentMacro};
});
