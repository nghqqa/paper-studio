/* 文献引用桥（v0.4.1）：隐形 ONLYOFFICE 插件。
 * 应用侧「文献」面板把插入/收集/改写任务 POST 到服务端任务箱（按文档会话键 doc_key 绑定）；
 * 本插件随编辑器自启动，轮询任务箱 → callCommand 在文档线程执行 Builder API → 结果回 POST。
 * - doc_key 从 info.documentCallbackUrl 解析（与页面侧 editorConfig.document.key 同值；
 *   info.documentId 是 DS 内部会话标识，与页面侧不同值——实测）
 * - 本地已完成 request_id 去重：回执丢失后重试不重复执行（重发缓存结果，幂等）
 * - ready 握手：init 后 postMessage 到顶层 + 轮询即服务端心跳（侧栏据此启用入口） */
(function () {
  "use strict";
  var SOURCE = "paper-studio-refs";
  var POLL_MS = 800;
  var docKey = null;
  var busy = false;
  var stopped = false;
  var done = {}; // request_id → 结果缓存（回执丢失重试时幂等重发）

  function report(step) {
    try {
      fetch("/api/office-plugin-refs/debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ step: String(step).slice(0, 180) })
      }).catch(function () { /* 调试回传失败不影响桥接 */ });
    } catch (e) { /* 同上 */ }
  }

  function apiBase() { return "/api/office-plugin-refs"; }

  function resolveDocKey() {
    // doc_key 必须与页面侧 editorConfig.document.key 同值。
    // info.documentId 是 DS 内部会话标识（每次打开都变，与页面侧不同值——实测）；
    // documentCallbackUrl 形如 {public}/api/office/callback/<pid>/<key>?cap=…，从中取 <key>。
    try {
      var info = window.Asc && window.Asc.plugin && window.Asc.plugin.info;
      if (!info) return null;
      var cb = String(info.documentCallbackUrl || "");
      var m = /\/api\/office\/callback\/([^\/\?]+)\/([^\\?\/]+)/.exec(cb);
      if (m) return decodeURIComponent(m[2]);
      if (typeof info.documentId === "string" && info.documentId) return info.documentId;
    } catch (e) { /* fallthrough */ }
    return null;
  }

  function fetchTask() {
    return fetch(apiBase() + "/task?doc_key=" + encodeURIComponent(docKey),
      { credentials: "same-origin", cache: "no-store", redirect: "error" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.task ? d.task : null; });
  }

  function postResult(task, ok, data, error) {
    return fetch(apiBase() + "/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ doc_key: docKey, request_id: task.request_id, ok: ok, data: data || null, error: error || null })
    }).catch(function () { /* 回执丢失：任务仍在箱内，本插件会再次 GET 并按 done 缓存幂等重发 */ });
  }

  // ---------- 文档操作：Builder 代码在 callCommand 沙箱内运行（可序列化、只许引用参数） ----------

  function builderInsertCitation() {
    // v0.4.1 实测：RunMacro 沙箱内 Range.AddText/AddElement(Sdt) 的修改**不落盘**
    // （rangeText 空、AddElement undefined、写入后 Search 不到）。因此插入一律走
    // 插件侧 executeMethod("PasteHtml")——落在用户真实光标处，与提案应用同一条写路径。
    var doc = Api.GetDocument();
    var sdtSupported = false;
    try {
      var p0 = doc.GetElement ? doc.GetElement(0) : null;
      sdtSupported = typeof Api.CreateInlineLvlSdt === "function" && !!p0 && typeof p0.GetAllSdt === "function";
    } catch (e) { sdtSupported = false; }
    return { ok: true, sdtSupported: sdtSupported };
  }

  function pasteViaPlugin(text, isHtml) {
    return new Promise(function (resolve) {
      var escaped = isHtml ? String(text)
        : String(text)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .split(String.fromCharCode(10)).join("<br>");
      window.Asc.plugin.executeMethod("PasteHtml", [escaped], function (ret) {
        resolve({ ok: true, mode: "paste-html", ret: ret === undefined ? null : ret });
      });
    });
  }

  function builderInsertCitationLegacy(payload) {
    var doc = Api.GetDocument();
    var label = typeof payload.label === "string" ? payload.label.slice(0, 200) : "";
    if (!label) throw new Error("引用标签为空");
    var range = typeof doc.GetRangeBySelect === "function" ? doc.GetRangeBySelect() : null;
    if (!range) throw new Error("请先把光标放到要插入引用的正文位置");
    var mode = "plain";
    var sdtSupported = false;
    try {
      var p0 = doc.GetElement ? doc.GetElement(0) : null;
      sdtSupported = typeof Api.CreateInlineLvlSdt === "function" && !!p0 && typeof p0.GetAllSdt === "function";
    } catch (e) { sdtSupported = false; }
    if (sdtSupported) {
      try {
        var sdt = Api.CreateInlineLvlSdt();
        var run = Api.CreateRun();
        run.AddText(label);
        sdt.AddElement(0, run);
        sdt.SetTag("paper-ref:" + JSON.stringify(payload.rids));
        var placed = false;
        if (typeof range.AddElement === "function") {
          range.AddElement(sdt);
          placed = true;
        } else {
          var para = doc.GetCurrentParagraph();
          if (para && typeof para.AddElement === "function") {
            para.AddElement(sdt);
            placed = true;
          }
        }
        mode = placed ? "sdt" : "plain";
        if (!placed) range.AddText(label);
      } catch (e) {
        range.AddText(label);
        mode = "plain";
      }
    } else {
      range.AddText(label);
    }
    return { ok: true, mode: mode };
  }

  function builderCollectRefs(payload) {
    // v3（2026-11-16，P1-0-A）：v0.4.1 起插入走 PasteHtml 纯文本，文档里没有 paper-ref 内容控件
    // 可认——扫描静态引用文本 [n] / [n,m]（v2）+ 范围写法 [1-3]/[1–3]/[1—3] 及混合 [1, 3-5]（v3）。
    // - 范围仅接受合法小范围：端点均 1..999、end>=start、跨度<=100——[2020-2024] 一类年份/非法区间不展开；
    // - 同时递归扫描表格单元格内段落（GetRowsCount/GetRow/GetCell/GetContent，容错缺 API 时安全回退）；
    // - 返回 numbers（按出现顺序去重）、appear_order（正文首次出现顺序，供面板检出顺序标引倒置/断号）、
    //   in_table_count（表格内命中的引用标记组数，诊断用）；
    // - 遇「[参考文献-平台生成]」托管标记或独立「参考文献」/「References」标题段即停止：
    //   其后是文献表区，其自身编号不算正文引用。
    if (payload && payload.__diagnose) {
      var doc = Api.GetDocument();
      var out = { elements: typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : -1,
                  hasSearch: typeof doc.Search, paraTypes: [] };
      var n = out.elements;
      for (var i = 0; i < Math.min(n, 6); i += 1) {
        var el = doc.GetElement(i);
        out.paraTypes.push(el && el.GetClassType ? el.GetClassType() : "null");
      }
      var range = typeof doc.GetRangeBySelect === "function" ? doc.GetRangeBySelect() : null;
      out.rangeNull = !range;
      if (range) {
        out.hasAddElement = typeof range.AddElement;
        out.hasAddText = typeof range.AddText;
        out.rangeText = range.GetText ? String(range.GetText()).slice(0, 40) : null;
      }
      var para = typeof doc.GetCurrentParagraph === "function" ? doc.GetCurrentParagraph() : null;
      out.curPara = para ? (para.GetText ? String(para.GetText()).slice(0, 60) : "para?") : "null";
      out.hasCreateSdt = typeof Api.CreateInlineLvlSdt;
      if (typeof Api.CreateInlineLvlSdt === "function") {
        try {
          var sdt = Api.CreateInlineLvlSdt();
          out.sdtOk = !!sdt;
          out.sdtAddElement = sdt && typeof sdt.AddElement;
          out.sdtSetTag = sdt && typeof sdt.SetTag;
        } catch (e) { out.sdtErr = String((e && e.message) || e); }
      }
      return { ok: true, diag: out };
    }
    var doc = Api.GetDocument();
    var numbers = [];
    var appearOrder = [];
    var inTableCount = 0;
    var stoppedAt = "";
    // 单括号解析：逗号分 token；非数字 token（年份/文字标签）→ 整括号放弃；
    // 范围 token 端点倒序或跨度 >100 → 仅放弃该 token（其余 token 保留）
    function collectBracketNumbers(content) {
      var tokens = String(content).split(/\s*[,，]\s*/);
      var out = [];
      for (var t = 0; t < tokens.length; t += 1) {
        var tok = tokens[t].replace(/^\s+|\s+$/g, "");
        if (!tok) continue;
        if (/^[0-9]{1,3}$/.test(tok)) { out.push(parseInt(tok, 10)); continue; }
        var m = /^([0-9]{1,3})\s*[-–—−]\s*([0-9]{1,3})$/.exec(tok);
        if (!m) return [];
        var start = parseInt(m[1], 10), end = parseInt(m[2], 10);
        if (end < start || end - start > 100) continue;
        for (var v = start; v <= end; v += 1) out.push(v);
      }
      var valid = [];
      for (var k = 0; k < out.length; k += 1) if (out[k] >= 1 && out[k] <= 999) valid.push(out[k]);
      return valid;
    }
    function record(nums, fromTable) {
      if (fromTable) inTableCount += 1;
      for (var k = 0; k < nums.length; k += 1) {
        if (numbers.indexOf(nums[k]) === -1) numbers.push(nums[k]);
        if (appearOrder.indexOf(nums[k]) === -1) appearOrder.push(nums[k]);
      }
    }
    var re = /\[([0-9]{1,4}(?:\s*[,，\-–—−]\s*[0-9]{1,4})*)\]/g;
    function scanText(text, fromTable) {
      re.lastIndex = 0;
      var m = re.exec(text);
      while (m) {
        var nums = collectBracketNumbers(m[1]);
        if (nums.length) record(nums, fromTable);
        m = re.exec(text);
      }
    }
    function scanTable(table, fromTable, depth) {
      if (!table || depth > 4) return;
      try {
        var rows = typeof table.GetRowsCount === "function" ? table.GetRowsCount() : 0;
        for (var r = 0; r < rows; r += 1) {
          var row = typeof table.GetRow === "function" ? table.GetRow(r) : null;
          if (!row) continue;
          var cells = typeof row.GetCellsCount === "function" ? row.GetCellsCount() : 0;
          for (var c = 0; c < cells; c += 1) {
            var cell = typeof row.GetCell === "function" ? row.GetCell(c) : null;
            if (!cell) continue;
            var content = typeof cell.GetContent === "function" ? cell.GetContent() : null;
            if (content) scanContainer(content, fromTable, depth + 1);
          }
        }
      } catch (e) { /* 表格遍历失败按安全回退：保留已收集结果 */ }
    }
    function scanContainer(container, fromTable, depth) {
      if (!container || depth > 4) return;
      var n2 = typeof container.GetElementsCount === "function" ? container.GetElementsCount() : 0;
      for (var i2 = 0; i2 < n2; i2 += 1) {
        var el2 = typeof container.GetElement === "function" ? container.GetElement(i2) : null;
        if (!el2) continue;
        var type = "";
        try { type = typeof el2.GetClassType === "function" ? String(el2.GetClassType()) : ""; } catch (e2) { type = ""; }
        if (type === "table") { scanTable(el2, fromTable, depth + 1); continue; }
        if (typeof el2.GetText === "function") scanText(String(el2.GetText() || ""), fromTable);
      }
    }
    var n = typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
    for (var i = 0; i < n; i += 1) {
      var el = doc.GetElement(i);
      if (!el) continue;
      var cls = "";
      try { cls = typeof el.GetClassType === "function" ? String(el.GetClassType()) : ""; } catch (e3) { cls = ""; }
      if (cls === "table") { scanTable(el, true, 0); continue; }
      if (typeof el.GetText !== "function") continue;
      var text = String(el.GetText() || "");
      if (text.indexOf("[参考文献-平台生成]") === 0) { stoppedAt = "marker"; break; }
      var collapsed = text.replace(/\s+/g, "");
      if (collapsed === "参考文献" || collapsed.toLowerCase() === "references") { stoppedAt = "heading"; break; }
      scanText(text, false);
    }
    return { ok: true, numbers: numbers, appear_order: appearOrder, in_table_count: inTableCount, stopped_at: stoppedAt };
  }

  function builderSetBibliography(payload) {
    if (payload === undefined && typeof Asc !== "undefined" && Asc.scope) payload = Asc.scope.paperRefsPayload;
    payload = payload || {};
    // 托管块两端各有一个平台写入的标记段：删除边界由自己的文本界定。
    // 安全序（对照官方 plugin_base_api：RunMacro 只把异常转错误回执、不回滚文档，
    // 因此恢复必须自己做）：
    //   ① 只读预检（修订/批注/书签/托管区节点类型/恢复接口）——任何不满足，
    //      未做任何修改即返回；
    //   ② 托管块全结构快照（ToJSON/Api.ToJSON + JSON 有效性 + 节点类型）；
    //   ③ 预构建并校验新块（未落盘）；
    //   ④ 删除旧块——任一段失败，按快照原位恢复已删段落（逐段核验），报错不追加；
    //   ⑤ 追加新块——任一段失败，清理本次已插入节点并按快照恢复旧块，报错不假成功；
    //   ⑥ 终验：头标记/条目/尾标记逐段核对通过才返回 ok:true。
    var HEAD_PREFIX = "[参考文献-平台生成]";
    var TAIL_PREFIX = "[参考文献-平台生成]（完）";
    var doc = Api.GetDocument();
    var items = Array.isArray(payload.items) ? payload.items.slice(0, 500) : [];

    // 块外核验签名：类型必须一致；文本仅在双方都可得时才比较（表格等无 GetText 节点按类型核验）
    function nodeSig(el) {
      if (!el) return {type: "null", text: null};
      var type = typeof el.GetClassType === "function" ? String(el.GetClassType()) : "unknown";
      var text = typeof el.GetText === "function" ? String(el.GetText() || "") : null;
      return {type: type, text: text};
    }
    function sigMatch(a, b) {
      return a.type === b.type && (a.text === null || b.text === null || a.text === b.text);
    }

    // ---------- ① 定位托管块（只读）：区分 无标记 / 唯一完整一组 / 异常形态 ----------
    var count = typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
    var head = -1, tail = -1, headCount = 0, tailCount = 0;
    for (var i = 0; i < count; i += 1) {
      var el = doc.GetElement(i);
      if (!el || typeof el.GetText !== "function") continue;
      var t0 = String(el.GetText() || "");
      var isTail = t0.indexOf(TAIL_PREFIX) === 0;
      var isHead = !isTail && t0.indexOf(HEAD_PREFIX) === 0;
      if (isHead) { headCount += 1; if (head === -1) head = i; }
      if (isTail) { tailCount += 1; if (tail === -1) tail = i; }
    }
    var hasBlock = head >= 0 && tail > head;  // 唯一且完整的一组头尾才可自动替换
    if (tailCount > 1 || headCount > 1) {
      return {ok: false, code: "stale",
        message: "检测到重复的文献托管块标记（开始标记 " + headCount + " 个、结束标记 " + tailCount
          + " 个）——为避免误删正文，本次不做自动更新。请手动清理到仅剩一组完整的「[参考文献-平台生成]」标记段与「（完）」标记段后重试。"};
    }
    if (tail >= 0 && head === -1) {
      return {ok: false, code: "stale",
        message: "检测到孤立的结束标记（「（完）」标记段），未找到对应的开始标记——本次不做自动更新。请手动清理该标记段后重试。"};
    }
    if (head >= 0 && tail >= 0 && tail < head) {
      return {ok: false, code: "stale",
        message: "文献托管块标记顺序倒置（结束标记位于开始标记之前）——本次不做自动更新。请手动交换两标记段的位置后重试。"};
    }
    if (head >= 0 && tail === -1) {
      // 旧格式托管块（只有开始标记、没有结束标记）：无法确认块内段落归属，
      // 停止自动迁移并明确报错——避免把用户正文（如以 [2] 开头的段落）当条目删掉。
      return {ok: false, code: "stale",
        message: "检测到旧版参考文献块（只有开始标记、没有结束标记）——为避免误删正文，本次不做自动更新。"
          + "请手动删除旧块（从「[参考文献-平台生成]」标记段到条目末尾），删除后再点一次「更新参考文献表」，"
          + "即会写入带结束标记的新格式托管块；此后可放心一键更新。"};
    }

    // ---------- ② 只读预检（有旧块才需要删除类风险检查；接口检查始终需要） ----------
    var problems = [];
    if (typeof Api.FromJSON !== "function") problems.push("编辑器缺少 FromJSON 接口");
    if (typeof Api.CreateParagraph !== "function" || typeof Api.CreateRun !== "function") {
      problems.push("编辑器缺少段落构建接口");
    }
    if (hasBlock) {
      if (typeof doc.IsTrackRevisions === "function" && doc.IsTrackRevisions()) {
        problems.push("文档处于修订模式（托管块替换会丢失审阅锚点）");
      }
      if (typeof doc.GetAllComments === "function") {
        try {
          if (doc.GetAllComments().length > 0) problems.push("文档存在批注（跨段锚点无法随托管块迁移）");
        } catch (e) { problems.push("无法检查文档批注"); }
      } else problems.push("无法检查文档批注");
      var bm = doc.Document && doc.Document.Ru;
      if (bm && typeof bm.We === "function" && typeof bm.u_ === "function" && typeof bm.Eo === "function") {
        try {
          bm.We();
          for (var b = 0; b < bm.u_(); b += 1) {
            var bname = bm.Eo(b);
            if (bname && bname !== "_GoBack") { problems.push("文档存在书签（" + bname + "），锚点无法随托管块迁移"); break; }
          }
        } catch (e) { problems.push("无法检查文档书签"); }
      } else problems.push("无法检查文档书签");
      for (var z = head; z <= tail; z += 1) {
        var ze = doc.GetElement(z);
        var zt = ze && typeof ze.GetClassType === "function" ? ze.GetClassType() : "unknown";
        if (zt !== "paragraph") { problems.push("托管区含非段落节点（位置 " + z + "：" + zt + "）"); continue; }
        var canSerialize = (typeof Api.ToJSON === "function") || (typeof ze.ToJSON === "function");
        if (!canSerialize) problems.push("托管区段落缺少序列化接口（位置 " + z + "）");
        if (typeof ze.InsertParagraph !== "function") problems.push("托管区段落缺少插入接口（位置 " + z + "）");
      }
      if (typeof doc.AddElement !== "function") {
        problems.push("编辑器缺少按位置插入接口（原位写入与恢复都需要）");
      }
      if (head > 0) {
        var anchorEl = doc.GetElement(head - 1);
        // 前一节点是表格等无 InsertParagraph 的正常节点时，退回按位置 AddElement——不再拒绝（本轮审查问题 2）
        var anchorOk = !!anchorEl && typeof anchorEl.InsertParagraph === "function";
        if (!anchorOk && typeof doc.AddElement !== "function") {
          problems.push("托管块前一段缺少插入锚点接口且编辑器缺少按位置插入接口（位置 " + (head - 1) + "）");
        }
      }
    }
    if (problems.length) {
      return {ok: false, code: "stale",
        message: "无法安全更新参考文献表：" + problems.join("；") + "。本次未做任何修改。"};
    }

    // ---------- ③ 托管块全结构快照（含 JSON 有效性验证 + 未处理修订拒绝） ----------
    // 删除会连带丢弃块内修订锚点——存在未处理修订（reviewType/changes/prChange 等）
    // 时拒绝自动更新，不自动接受或拒绝修订，保证正文零修改。
    // 扫描有深度与节点数预算：**超预算一律按"无法证明安全"拒绝（fail-closed）**，
    // 不允许把没扫到的深层结构判为无修订。
    var REVISION_MAX_DEPTH = 12;
    var REVISION_MAX_NODES = 20000;
    function scanRevisionNoise(node, depth, budget) {
      if (depth > REVISION_MAX_DEPTH || budget.left <= 0) return "over";
      budget.left -= 1;
      if (!node || typeof node !== "object") return false;
      if (node.reviewType && node.reviewType !== "common") return true;
      if (node.changes && node.changes.length) return true;
      if (node.prChange || node.rPrChange || node.pPrChange) return true;
      for (var key in node) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          var value = node[key];
          if (value && typeof value === "object") {
            if (Object.prototype.toString.call(value) === "[object Array]") {
              for (var idx = 0; idx < value.length; idx += 1) {
                var rArr = scanRevisionNoise(value[idx], depth + 1, budget);
                if (rArr) return rArr;  // true=有修订 / "over"=超预算，都上抛
              }
            } else {
              var rObj = scanRevisionNoise(value, depth + 1, budget);
              if (rObj) return rObj;
            }
          }
        }
      }
      return false;
    }
    var snapshot = [];
    if (hasBlock) {
      for (var s = head; s <= tail; s += 1) {
        var se = doc.GetElement(s);
        var json = typeof Api.ToJSON === "function" ? String(Api.ToJSON(se) || "") : String(se.ToJSON() || "");
        var parsed = null;
        try { parsed = JSON.parse(json); } catch (e) { /* 无效 JSON */ }
        if (!json || !parsed || (parsed.type && parsed.type !== "paragraph")) {
          return {ok: false, code: "stale",
            message: "托管块序列化异常（位置 " + s + "）——未做任何修改。请重试；若反复出现，请手动删除两标记段之间的旧条目后重试。"};
        }
        var budget = {left: REVISION_MAX_NODES};
        var scan = scanRevisionNoise(parsed, 0, budget);
        if (scan === "over") {
          return {ok: false, code: "stale",
            message: "托管块结构超出修订扫描预算（嵌套深度超过 " + REVISION_MAX_DEPTH
              + " 层或节点数超过 " + REVISION_MAX_NODES + "）——无法证明块内没有未处理修订，"
              + "本次拒绝自动更新（未做任何修改）。请手动核对该块或接受/拒绝全部修订后重试。"};
        }
        if (scan) {
          return {ok: false, code: "stale",
            message: "托管块内含未处理的修订记录——为保证正文零丢失，本次不做自动更新（未做任何修改）。"
              + "请在 Word 中接受或拒绝全部修订后重试。"};
        }
        var stag = "";
        try { stag = (typeof se.GetTag === "function" && se.GetTag()) || ""; } catch (e) { /* noop */ }
        snapshot.push({json: json, tag: stag === "paper-bibliography" ? "paper-bibliography" : null,
          text: typeof se.GetText === "function" ? String(se.GetText() || "") : ""});
      }
      // 块外内容快照（删除前基线）：head 之前与 tail 之后的所有节点。
      // 用「类型+文本（可能缺失）」签名而非纯文本——表格等无 GetText 的正常节点
      // 不能被当成核验失败（本轮审查问题 4）。nodeSig/sigMatch 定义在函数顶层。
      var outsideBefore = [];
      for (var o3 = 0; o3 < count; o3 += 1) {
        if (o3 >= head && o3 <= tail) continue;
        outsideBefore.push(nodeSig(doc.GetElement(o3)));
      }
    }

    // ---------- ④ 预构建并校验新块（纯内存，未落盘） ----------
    // 样式继承（P1-0-A）：从旧块首条文献段落安全尝试读取段落样式/字号/字体/行距——
    // 任何读取失败或接口缺失都按「无样式可继承」处理（新块保持默认样式），绝不因
    // 样式读取失败中断更新；沿用同样只在写入时逐项尝试，单项失败不阻断其余。
    var oldEntryStyle = null;
    if (hasBlock && tail - head >= 2) {
      oldEntryStyle = (function () {
        var st = { style: null, fontName: null, fontSize: null, spacing: null };
        try {
          var first = doc.GetElement(head + 1);
          if (!first) return st;
          if (typeof first.GetStyle === "function") {
            var s = first.GetStyle();
            if (s && typeof s === "object") st.style = s;
          }
          var run0 = typeof first.GetElement === "function" ? first.GetElement(0) : null;
          if (run0) {
            if (typeof run0.GetFontName === "function") {
              var fn = run0.GetFontName();
              if (typeof fn === "string" && fn) st.fontName = fn;
            }
            if (typeof run0.GetFontSize === "function") {
              var fs = run0.GetFontSize();
              if (typeof fs === "number" && fs > 0 && isFinite(fs)) st.fontSize = fs;
            }
          }
          if (typeof first.GetSpacingBetween === "function") {
            var sp = first.GetSpacingBetween();
            if (typeof sp === "number" && sp > 0 && isFinite(sp)) st.spacing = sp;
          }
        } catch (e) { /* 读取失败 = 无样式可继承 */ }
        return st;
      })();
    }
    var expected = [];
    var newParas = [];
    function buildPara(text, tag, withEntryStyle) {
      var para = Api.CreateParagraph();
      var run = Api.CreateRun();
      if (run.AddText(String(text).slice(0, 2000)) === false) throw new Error("Run.AddText 失败");
      if (withEntryStyle && oldEntryStyle) {
        try {
          if (oldEntryStyle.style && typeof para.SetStyle === "function") para.SetStyle(oldEntryStyle.style);
          if (oldEntryStyle.fontName && typeof run.SetFontName === "function") run.SetFontName(oldEntryStyle.fontName);
          if (oldEntryStyle.fontSize && typeof run.SetFontSize === "function") run.SetFontSize(oldEntryStyle.fontSize);
          if (oldEntryStyle.spacing && typeof para.SetSpacingBetween === "function") para.SetSpacingBetween(oldEntryStyle.spacing, "auto");
        } catch (e) { /* 单项样式沿用失败不阻断（保持默认样式） */ }
      }
      if (para.AddElement(run) === false) throw new Error("AddElement 失败");
      if (tag && typeof para.SetTag === "function") {
        try { para.SetTag(tag); } catch (e) { /* 块级 tag 不可用则跳过 */ }
      }
      return para;
    }
    try {
      newParas.push(buildPara(HEAD_PREFIX + "（由文献面板管理；删除此标记前请先在面板更新）", null, false));
      for (var m = 0; m < items.length; m += 1) {
        // CSL 纯文本条目以 "[1]\t…" 开头，DS 里制表符渲染为空导致编号与内容粘连——补一个空格
        newParas.push(buildPara(String(items[m]).replace(/^(\[\d+\])\s*/, "$1 "), "paper-bibliography", true));
      }
      newParas.push(buildPara(TAIL_PREFIX, null, false));
    } catch (e) {
      return {ok: false, code: "stale", message: "预构建新文献块失败：" + ((e && e.message) || e) + "。未做任何修改。"};
    }
    for (var v = 0; v < newParas.length; v += 1) {
      var expectedText = String(newParas[v].GetText());
      if (!expectedText) {
        return {ok: false, code: "stale", message: "预构建新文献块校验失败（第 " + (v + 1) + " 段为空）——未做任何修改。"};
      }
      expected.push(expectedText);
    }

    // ---------- ⑤ 原位替换：新块写入旧块位置（附录/正文位置保持不变） ----------
    // 顺序：删旧块 → 排走 DS 删除后自动保留的空段 → 在 head 原位逐段写入新块 → 终验
    // （新块+块外签名核对）。任一步失败：清理**仅本次写入的节点**并按快照恢复旧块；
    // 清理或恢复任一未完成 → 抛错保留现场，绝不报告「已恢复原状/无净变更」。
    var insertedOk = 0;  // 本次已成功落位并通过按位核验的新段数（失败清理只动这些节点）
    function removeRange(from, to) {
      for (var d = to; d >= from; d -= 1) {
        try {
          if (doc.GetElement(d).Delete() === false) {
            var err = new Error("Delete 返回 false（位置 " + d + "）");
            err.failIdx = d;
            throw err;
          }
        } catch (e1) {
          if (!e1 || e1.failIdx === undefined) {
            var wrapped = new Error("Delete 异常（位置 " + d + "）：" + ((e1 && e1.message) || e1));
            wrapped.failIdx = d;
            throw wrapped;
          }
          throw e1;
        }
      }
    }
    // 从 fromIdx 起按快照重建托管块（anchor 逐个后插），失败返回错误描述、成功返回 ""
    function restoreBlock(fromIdx) {
      var insertBase = doc.GetElementsCount();
      var anchor = fromIdx > 0 ? doc.GetElement(fromIdx - 1) : null;
      for (var r = fromIdx; r <= tail; r += 1) {
        var snap = snapshot[r - head];
        var rp = null;
        try { rp = Api.FromJSON(snap.json); } catch (e) { return "位置 " + r + " 反序列化异常：" + ((e && e.message) || e); }
        if (!rp || typeof rp.GetClassType !== "function" || rp.GetClassType() !== "paragraph") {
          return "位置 " + r + " 反序列化结果不是段落";
        }
        if (snap.tag && typeof rp.SetTag === "function") {
          try { rp.SetTag(snap.tag); } catch (e) { /* noop */ }
        }
        if (anchor && typeof anchor.InsertParagraph === "function") {
          var placed = anchor.InsertParagraph(rp, "after", true);
          if (!placed) return "位置 " + r + " InsertParagraph 失败";
        } else if (typeof doc.AddElement === "function") {
          doc.AddElement(r, rp);
        } else {
          return "位置 " + r + " 无可用插入接口";
        }
        var placedEl = doc.GetElement(r);
        if (!placedEl || typeof placedEl.GetText !== "function" || String(placedEl.GetText()) !== snap.text) {
          return "位置 " + r + " 恢复后内容与快照不符";
        }
        // 每次插入后核对节点数确实 +1（插入返回真但未落位的异常形态）
        if (doc.GetElementsCount() !== insertBase + (r - fromIdx) + 1) {
          return "位置 " + r + " 插入后节点数与预期不符";
        }
        anchor = placedEl;
      }
      for (var v2 = fromIdx; v2 <= tail; v2 += 1) {
        var elv = doc.GetElement(v2);
        if (!elv || typeof elv.GetText !== "function" || String(elv.GetText()) !== snapshot[v2 - head].text) {
          return "位置 " + v2 + " 恢复终验不符";
        }
      }
      return "";
    }
    // 排走 DS 的自动补位空段。**只处理一种形态**：删除后文档本应为空（块=整文档）时
    // DS 删一补一留下的空段——它不可移除也无需移除（按位写入会落在它之前），
    // 检测到"删除后数量未减"即停止。其余任何空段（含块后用户的格式空段，1 个或
    // 连续多个）都在预期节点数之内、属于用户内容，绝不删除（本轮审查问题 1）。
    function drainAutoEmpties(pos, extras) {
      var removed = 0;
      while (removed < extras) {
        var el = doc.GetElement(pos);
        if (!el) return "";
        var t2 = typeof el.GetText === "function" ? String(el.GetText() || "") : null;
        if (t2 === null || t2 !== "") {
          return "位置 " + pos + " 存在非空的 DS 补位节点——无法安全排空";
        }
        var beforeCount = doc.GetElementsCount();
        try {
          if (el.Delete() === false) return "DS 自动保留空段删除返回 false（位置 " + pos + "）";
        } catch (e2) {
          return "DS 自动保留空段删除异常（位置 " + pos + "）：" + ((e2 && e2.message) || e2);
        }
        removed += 1;
        if (doc.GetElementsCount() >= beforeCount && removed < extras) {
          return "DS 删一补一：剩余 " + (extras - removed) + " 个补位空段无法排尽";
        }
      }
      return "";
    }

    // 在 pos 原位逐段写入新块并按位核验；失败返回错误描述，insertedOk 记录已落位段数。
    // 前一节点是表格等无 InsertParagraph 的正常节点时，整段走按位置 AddElement（本轮审查问题 2）。
    function insertNewAt(pos) {
      var insertBase = doc.GetElementsCount();
      var anchor = pos > 0 ? doc.GetElement(pos - 1) : null;
      var useAnchor = !!(anchor && typeof anchor.InsertParagraph === "function");
      if (pos > 0 && !useAnchor && typeof doc.AddElement !== "function") {
        return "位置 " + (pos - 1) + " 缺少插入锚点接口且编辑器缺少按位置插入接口";
      }
      for (var a = 0; a < newParas.length; a += 1) {
        var placedEl = null;
        if (useAnchor) {
          var placed = anchor.InsertParagraph(newParas[a], "after", true);
          if (!placed) return "第 " + (a + 1) + " 段 InsertParagraph 失败";
          placedEl = placed && typeof placed === "object" ? placed : doc.GetElement(pos + a);
        } else {
          doc.AddElement(pos + a, newParas[a]);
          placedEl = doc.GetElement(pos + a);
        }
        if (doc.GetElementsCount() !== insertBase + a + 1) {
          return "第 " + (a + 1) + " 段插入后节点数与预期不符";  // 数量未增=未落位，不计入清理范围
        }
        insertedOk = a + 1;  // 已确认落位（无论内容校验是否通过，失败清理都必须包含它）
        if (!placedEl || typeof placedEl.GetText !== "function" || String(placedEl.GetText()) !== expected[a]) {
          return "第 " + (a + 1) + " 段写入校验失败";
        }
        if (useAnchor) anchor = placedEl;
      }
      return "";
    }

    // 只清理本次写入的节点 [fromPos, toPos]——绝不触碰其后的附录/正文（本轮审查问题 3）
    function cleanupInserted(fromPos, toPos) {
      for (var c2 = toPos; c2 >= fromPos; c2 -= 1) {
        try {
          if (doc.GetElement(c2).Delete() === false) return "Delete 返回 false（位置 " + c2 + "）";
        } catch (e3) { return String((e3 && e3.message) || e3); }
      }
      return "";
    }

    // 删除失败 → 原位恢复已删部分（此时新块尚未写入，恢复后无混合）
    var failIdx = -1, delErrMsg = "";
    if (hasBlock) {
      try {
        removeRange(head, tail);
      } catch (eDel) {
        failIdx = typeof eDel.failIdx === "number" ? eDel.failIdx : head;
        delErrMsg = (eDel && eDel.message) || "删除失败";
      }
      if (failIdx >= 0) {
        var restoreError = restoreBlock(failIdx + 1);
        if (restoreError) {
          // 恢复未完成：保留现场。自动保存/协同下「刷新不保存」不可靠——
          // 引导 Ctrl+Z 撤销核对并暂勿保存，而不是刷新。
          throw new Error("旧参考文献块清理失败且自动恢复未完成（清理：" + delErrMsg
            + "；恢复：" + restoreError + "）——请立即 Ctrl+Z 撤销本次操作并核对文末参考文献块，"
            + "撤销确认前请勿保存；然后把本提示反馈给管理员。");
        }
        return {ok: false, code: "stale",
          message: "旧参考文献块清理失败（" + delErrMsg + "）——已按快照恢复原状（逐段核验通过），未写入新块。"
            + "请重试；若反复出现，请手动删除两标记段之间的旧条目后重试。"};
      }
    }

    // 统一恢复：清理本次写入节点 + 按快照恢复旧块；任一未完成 → 抛错保留现场
    function rollbackInPlace(appendErrMsg) {
      var cleanupError = insertedOk > 0 ? cleanupInserted(head, head + insertedOk - 1) : "";
      var restoreError2 = cleanupError ? "未执行（清理未完成，为保现场不继续）" : restoreBlock(head);
      if (cleanupError || restoreError2) {
        throw new Error("新参考文献块写入失败（" + appendErrMsg + "）且清理/恢复未完成（清理："
          + (cleanupError || "完成") + "；恢复：" + (restoreError2 || "完成")
          + "）——请立即 Ctrl+Z 撤销本次操作并核对文末参考文献块，撤销确认前请勿保存；然后把本提示反馈给管理员。");
      }
      return {ok: false, code: "stale",
        message: "新参考文献块写入失败（" + appendErrMsg + "）——已清理本次写入节点并按快照恢复旧块"
          + "（逐段核验通过），附录与正文位置不变。请重试；若反复出现，请反馈管理员。"};
    }

    var writeError = "";
    if (hasBlock) {
      // 排空只发生在一种形态：删除后文档本应为空（head=0 且块后无任何内容），
      // DS 补位的空段才存在。expectedCount>0 时（块后有附录/用户空段/正文）一律不排——
      // 那些空段是用户内容（本轮审查问题 1）。
      var afterCount = count - tail - 1;
      var expectedCount = head + afterCount;
      var nowCount = doc.GetElementsCount();
      var drainErr = "";
      if (expectedCount === 0 && nowCount > 0) {
        drainErr = drainAutoEmpties(0, nowCount - expectedCount);
      }
      if (drainErr) {
        // 空段排走失败：按位写入会错位。先恢复旧块，再如实报告残留空段。
        var restoreError3 = restoreBlock(head);
        if (restoreError3) {
          throw new Error("参考文献块更新中止（" + drainErr + "）且自动恢复未完成（恢复：" + restoreError3
            + "）——请立即 Ctrl+Z 撤销本次操作并核对文末参考文献块，撤销确认前请勿保存；然后把本提示反馈给管理员。");
        }
        return {ok: false, code: "stale",
          message: "参考文献块更新中止（" + drainErr + "）——已按快照恢复旧块（逐段核验通过），"
            + "文档可能残留编辑器自动保留的空段，可在编辑器中手动删除。请重试；若反复出现，请反馈管理员。"};
      }
      // 插入与终验纳入统一恢复范围：任何异常（不只是返回 false）都走
      // 清理本次写入节点 + 按快照恢复旧块（本轮审查问题 3）。
      try {
        writeError = insertNewAt(head);
        if (!writeError) {
          // ---------- ⑥ 终验：新块逐段 + 块外（含表格等无 GetText 节点）签名核对 ----------
          for (var f = 0; f < newParas.length; f += 1) {
            var fe = doc.GetElement(head + f);
            if (!fe || typeof fe.GetText !== "function" || String(fe.GetText()) !== expected[f]) {
              writeError = "参考文献块写入校验失败（位置 " + (head + f) + "）";
              break;
            }
          }
          if (!writeError) {
            for (var qb = 0; qb < head; qb += 1) {
              if (!sigMatch(nodeSig(doc.GetElement(qb)), outsideBefore[qb])) {
                writeError = "块外内容核验不符（位置 " + qb + "）";
                break;
              }
            }
          }
          if (!writeError) {
            var afterBase = head + newParas.length;
            for (var qa = 0; qa < count - tail - 1; qa += 1) {
              if (!sigMatch(nodeSig(doc.GetElement(afterBase + qa)), outsideBefore[head + qa])) {
                writeError = "块外内容核验不符（位置 " + (afterBase + qa) + "）";
                break;
              }
            }
          }
        }
      } catch (eW) {
        writeError = "插入/终验异常：" + ((eW && eW.message) || eW);
      }
      if (writeError) return rollbackInPlace(writeError);
      return {ok: true, count: items.length, replaced: true};
    }

    // 无旧块：先探测独立「参考文献/References」标题段（仅作诊断回报）。-1=无标题；
    // -2=多个标题（歧义，不报告位置）；其余=唯一标题位置。插入契约保持文末追加——
    // 标题后无正文内容时文末追加即紧随标题；标题后已有内容时不在用户内容中间插入。
    var bibHeadingIndex = -1;
    for (var bh = 0; bh < count; bh += 1) {
      var be = doc.GetElement(bh);
      if (!be || typeof be.GetText !== "function") continue;
      var bt = String(be.GetText() || "").replace(/\s+/g, "");
      if (bt === "参考文献" || bt.toLowerCase() === "references") {
        if (bibHeadingIndex >= 0) { bibHeadingIndex = -2; break; }
        bibHeadingIndex = bh;
      }
    }
    // 首建写入文档末尾（语义即文末生成，无位置保持问题）；失败清理本次写入段
    var base = -1;
    var appendError = "";
    try {
      base = doc.GetElementsCount();
      for (var a2 = 0; a2 < newParas.length; a2 += 1) {
        if (typeof doc.Push === "function") doc.Push(newParas[a2]);
        else if (typeof doc.InsertParagraph === "function") doc.InsertParagraph(newParas[a2], "after", false);
        else throw new Error("无可用追加接口");
        var nowN = doc.GetElementsCount();
        var placedEl2 = nowN > 0 ? doc.GetElement(nowN - 1) : null;
        if (!placedEl2 || typeof placedEl2.GetText !== "function" || String(placedEl2.GetText()) !== expected[a2]) {
          throw new Error("第 " + (a2 + 1) + " 段写入校验失败");
        }
      }
    } catch (eApp) {
      appendError = (eApp && eApp.message) || "追加失败";
      var cleanupError2 = "";
      var nowN2 = doc.GetElementsCount();
      for (var c3 = nowN2 - 1; c3 >= base && c3 >= 0; c3 -= 1) {
        try {
          if (doc.GetElement(c3).Delete() === false) { cleanupError2 = "Delete 返回 false（位置 " + c3 + "）"; break; }
        } catch (e4) { cleanupError2 = String((e4 && e4.message) || e4); break; }
      }
      if (cleanupError2) {
        throw new Error("新参考文献块写入失败（" + appendError + "）且清理未完成（" + cleanupError2
          + "）——请立即 Ctrl+Z 撤销本次操作并核对文末参考文献块，撤销确认前请勿保存；然后把本提示反馈给管理员。");
      }
      return {ok: false, code: "stale",
        message: "新参考文献块追加失败（" + appendError + "）——已清理本次写入的段落，未做任何净变更。请重试；若反复出现，请反馈管理员。"};
    }
    return {ok: true, count: items.length, replaced: false, bib_heading: bibHeadingIndex};
  }

  // 定位阶段（Builder 侧）：全文检索原文，唯一/歧义/跨段判定
  function builderLocateOriginal(payload) {
    if (payload === undefined && typeof Asc !== "undefined" && Asc.scope) payload = Asc.scope.paperRefsPayload;
    payload = payload || {};
    var doc = Api.GetDocument();
    var original = typeof payload.original_text === "string" ? payload.original_text : "";
    if (!original || original.length > 20000) return { ok: false, reason: "invalid", error: "提案文本为空或超长" };
    var ranges = typeof doc.Search === "function" ? doc.Search(original, true) : null;
    if (!ranges) return { ok: false, reason: "no_search", error: "当前编辑器不支持文本检索，无法安全定位" };
    if (!ranges.length) return { ok: false, reason: "not_found" };
    if (ranges.length > 1) return { ok: false, reason: "ambiguous" };
    var range = ranges[0];
    var paraCount = 1;
    try {
      paraCount = range.GetParagraph ? (range.GetParagraph().length || 1) : 1;
    } catch (e) { paraCount = 1; }
    if (paraCount > 1) return { ok: false, reason: "multi_paragraph" };
    try { if (typeof range.Select === "function") range.Select(); } catch (e) { /* 选不中也继续（PasteHtml 落在光标处） */ }
    return { ok: true };
  }

  // 定稿前清理托管标记（strip-bib-markers，P1-0-A）：仅删除唯一一组头标记段与「（完）」尾标记段，
  // 中间的 [1] … 参考文献条目原样保留。任何异常形态（无标记/孤立/重复/倒置/修订模式/标记段含修订
  // 痕迹/接口缺失）一律 fail-closed 拒绝，未做任何修改即返回；删除后逐项核验，失败按快照原位恢复。
  function builderStripBibMarkers(payload) {
    if (payload === undefined && typeof Asc !== "undefined" && Asc.scope) payload = Asc.scope.paperRefsPayload;
    payload = payload || {};
    var HEAD_PREFIX = "[参考文献-平台生成]";
    var TAIL_PREFIX = "[参考文献-平台生成]（完）";
    var doc = Api.GetDocument();

    function nodeText(el) {
      return el && typeof el.GetText === "function" ? String(el.GetText() || "") : null;
    }
    // 修订痕迹递归扫描（与 builderSetBibliography 同规则；预算超限按「无法证明安全」拒绝）
    var REVISION_MAX_DEPTH = 12;
    var REVISION_MAX_NODES = 20000;
    function scanRevisionNoise(node, depth, budget) {
      if (depth > REVISION_MAX_DEPTH || budget.left <= 0) return "over";
      budget.left -= 1;
      if (!node || typeof node !== "object") return false;
      if (node.reviewType && node.reviewType !== "common") return true;
      if (node.changes && node.changes.length) return true;
      if (node.prChange || node.rPrChange || node.pPrChange) return true;
      for (var key in node) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          var value = node[key];
          if (value && typeof value === "object") {
            if (Object.prototype.toString.call(value) === "[object Array]") {
              for (var idx = 0; idx < value.length; idx += 1) {
                var rArr = scanRevisionNoise(value[idx], depth + 1, budget);
                if (rArr) return rArr;
              }
            } else {
              var rObj = scanRevisionNoise(value, depth + 1, budget);
              if (rObj) return rObj;
            }
          }
        }
      }
      return false;
    }
    function markerSnapshot(el, pos) {
      var json = typeof Api.ToJSON === "function" ? String(Api.ToJSON(el) || "") : String(el.ToJSON() || "");
      var parsed = null;
      try { parsed = JSON.parse(json); } catch (e) { /* 无效 JSON */ }
      if (!json || !parsed || (parsed.type && parsed.type !== "paragraph")) {
        return { error: "标记段序列化异常（位置 " + pos + "）——未做任何修改。" };
      }
      var budget = { left: REVISION_MAX_NODES };
      var scan = scanRevisionNoise(parsed, 0, budget);
      if (scan === "over") {
        return { error: "标记段结构超出修订扫描预算——无法证明安全，本次拒绝清理（未做任何修改）。" };
      }
      if (scan) {
        return { error: "标记段内含未处理的修订记录——请先在 Word 中接受或拒绝全部修订后重试（未做任何修改）。" };
      }
      return { json: json, text: nodeText(el) };
    }

    // ---------- 定位（只读）：唯一完整一组才可自动清理 ----------
    var count = typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
    var head = -1, tail = -1, headCount = 0, tailCount = 0;
    for (var i = 0; i < count; i += 1) {
      var t0 = nodeText(doc.GetElement(i));
      if (t0 === null) continue;
      var isTail = t0.indexOf(TAIL_PREFIX) === 0;
      var isHead = !isTail && t0.indexOf(HEAD_PREFIX) === 0;
      if (isHead) { headCount += 1; if (head === -1) head = i; }
      if (isTail) { tailCount += 1; if (tail === -1) tail = i; }
    }
    if (headCount === 0 && tailCount === 0) {
      return { ok: false, code: "not_found", message: "未找到参考文献托管块标记（无需清理）。" };
    }
    if (tailCount > 1 || headCount > 1) {
      return { ok: false, code: "stale",
        message: "检测到重复的文献托管块标记（开始标记 " + headCount + " 个、结束标记 " + tailCount
          + " 个）——为避免误删正文，本次不做自动清理。请手动清理到仅剩一组完整的标记段后重试。" };
    }
    if (tail >= 0 && head === -1) {
      return { ok: false, code: "stale",
        message: "检测到孤立的结束标记（「（完）」标记段），未找到对应的开始标记——请手动清理该标记段后重试。" };
    }
    if (head >= 0 && tail >= 0 && tail < head) {
      return { ok: false, code: "stale",
        message: "文献托管块标记顺序倒置（结束标记位于开始标记之前）——本次不做自动清理，请手动核对后处理。" };
    }
    if (head >= 0 && tail === -1) {
      return { ok: false, code: "stale",
        message: "检测到旧版参考文献块（只有开始标记、没有结束标记）——无法确认标记归属，本次不做自动清理。"
          + "请手动处理旧块（可在面板「更新参考文献表」重建为带结束标记的新格式后再清理）。" };
    }

    // ---------- 只读预检：接口 + 修订模式 + 标记段可快照 ----------
    var problems = [];
    if (typeof Api.FromJSON !== "function") problems.push("编辑器缺少反序列化接口（无法安全恢复）");
    var canSerialize = typeof Api.ToJSON === "function" || (doc.GetElement(head) && typeof doc.GetElement(head).ToJSON === "function");
    if (!canSerialize) problems.push("编辑器缺少序列化接口");
    if (typeof doc.IsTrackRevisions === "function" && doc.IsTrackRevisions()) {
      problems.push("文档处于修订模式（删除标记段会产生修订痕迹）");
    }
    for (var z = head + 1; z < tail; z += 1) {
      var ze = doc.GetElement(z);
      var zt = ze && typeof ze.GetClassType === "function" ? ze.GetClassType() : "unknown";
      if (zt !== "paragraph" || typeof (ze && ze.GetText) !== "function") {
        problems.push("标记段之间含非段落节点（位置 " + z + "）——无法逐项核验条目，拒绝清理");
        break;
      }
    }
    if (problems.length) {
      return { ok: false, code: "stale", message: "无法安全清理托管标记：" + problems.join("；") + "。本次未做任何修改。" };
    }
    var headSnap = markerSnapshot(doc.GetElement(head), head);
    if (headSnap.error) return { ok: false, code: "stale", message: headSnap.error };
    var tailSnap = markerSnapshot(doc.GetElement(tail), tail);
    if (tailSnap.error) return { ok: false, code: "stale", message: tailSnap.error };

    // 删除前基线：除两个标记段外全部节点的文本（null=该节点无 GetText，按位置核验）
    var before = [];
    for (var b = 0; b < count; b += 1) {
      if (b === head || b === tail) continue;
      var be = doc.GetElement(b);
      before.push({ type: be && typeof be.GetClassType === "function" ? String(be.GetClassType()) : "unknown", text: nodeText(be) });
    }
    var entries = tail - head - 1;

    // ---------- 删除（尾→头，保证索引有效）+ 逐项核验 ----------
    function deleteAt(pos) {
      try {
        if (doc.GetElement(pos).Delete() === false) return "Delete 返回 false（位置 " + pos + "）";
      } catch (e) { return "Delete 异常（位置 " + pos + "）：" + ((e && e.message) || e); }
      return "";
    }
    var delErr = deleteAt(tail);
    if (!delErr) delErr = deleteAt(head);
    if (!delErr && doc.GetElementsCount() !== count - 2) {
      delErr = "删除后节点数与预期不符（现 " + doc.GetElementsCount() + "，预期 " + (count - 2) + "）";
    }
    function verifyKept() {
      if (doc.GetElementsCount() !== count - 2) return "节点数与预期不符";
      for (var v = 0; v < count - 2; v += 1) {
        var el = doc.GetElement(v);
        var sig = { type: el && typeof el.GetClassType === "function" ? String(el.GetClassType()) : "unknown", text: nodeText(el) };
        var want = before[v];
        if (sig.type !== want.type) return "位置 " + v + " 节点类型与删除前不符";
        if (sig.text !== null && want.text !== null && sig.text !== want.text) return "位置 " + v + " 内容与删除前不符";
      }
      return "";
    }
    if (!delErr) delErr = verifyKept();
    if (delErr) {
      // 删除或核验失败：按快照原位恢复标记段（先头后尾，位置与删除前一致）。
      // 该标记若仍在原位（删除失败未生效）则跳过——绝不重复插入。
      function restoreMarker(snap, pos) {
        var cur = doc.GetElement(pos);
        if (cur && typeof cur.GetText === "function" && String(cur.GetText()) === snap.text) return "";
        var rp = null;
        try { rp = Api.FromJSON(snap.json); } catch (e) { return "位置 " + pos + " 反序列化异常：" + ((e && e.message) || e); }
        if (!rp || typeof rp.GetClassType !== "function" || rp.GetClassType() !== "paragraph") {
          return "位置 " + pos + " 反序列化结果不是段落";
        }
        var anchor = pos > 0 ? doc.GetElement(pos - 1) : null;
        if (anchor && typeof anchor.InsertParagraph === "function") {
          if (!anchor.InsertParagraph(rp, "after", true)) return "位置 " + pos + " InsertParagraph 失败";
        } else if (typeof doc.AddElement === "function") {
          doc.AddElement(pos, rp);
        } else {
          return "位置 " + pos + " 无可用插入接口";
        }
        var placed = doc.GetElement(pos);
        if (!placed || typeof placed.GetText !== "function" || String(placed.GetText()) !== snap.text) {
          return "位置 " + pos + " 恢复后内容与快照不符";
        }
        return "";
      }
      var r1 = restoreMarker(headSnap, head);
      var r2 = r1 ? "未执行（头部恢复未完成，为保现场不继续）" : restoreMarker(tailSnap, tail);
      // 恢复后核验：数量与原一致，且中间条目仍与删除前基线一致
      function verifyRestored() {
        if (doc.GetElementsCount() !== count) return "恢复后节点数与预期不符";
        for (var v2 = 0; v2 < count; v2 += 1) {
          if (v2 === head || v2 === tail) continue;
          var el2 = doc.GetElement(v2);
          var sig2 = { type: el2 && typeof el2.GetClassType === "function" ? String(el2.GetClassType()) : "unknown", text: nodeText(el2) };
          var want2 = v2 < head ? before[v2] : (v2 < tail ? before[v2 - 1] : before[v2 - 2]);
          if (sig2.type !== want2.type) return "位置 " + v2 + " 恢复后节点类型不符";
          if (sig2.text !== null && want2.text !== null && sig2.text !== want2.text) return "位置 " + v2 + " 恢复后内容不符";
        }
        return "";
      }
      if (r1 || r2) {
        throw new Error("托管标记清理失败且自动恢复未完成（删除：" + delErr + "；恢复：" + (r1 || "") + "/" + (r2 || "")
          + "）——请立即 Ctrl+Z 撤销本次操作并核对文末参考文献块，撤销确认前请勿保存；然后把本提示反馈给管理员。");
      }
      var reErr = verifyRestored();
      if (reErr) {
        throw new Error("托管标记清理失败且恢复后核验不符（" + reErr + "）——请立即 Ctrl+Z 撤销本次操作并核对文末参考文献块，"
          + "撤销确认前请勿保存；然后把本提示反馈给管理员。");
      }
      return { ok: false, code: "stale",
        message: "托管标记清理失败（" + delErr + "）——已按快照恢复原状（逐项核验通过），未删除任何内容。请重试；若反复出现，请反馈管理员。" };
    }
    return { ok: true, removed: 2, entries: entries };
  }

  var BUILDER = {
    "insert-citation": builderInsertCitation,
    "collect-refs": builderCollectRefs,
    "set-bibliography": builderSetBibliography,
    "strip-bib-markers": builderStripBibMarkers,
  };

  function callBuilder(kind, payload) {
    return new Promise(function (resolve) {
      var fn = kind === "apply-proposal" ? builderLocateOriginal : BUILDER[kind];
      // 正路（Docs 10 实测，公式插件同款）：window.Editor.RunMacro(fn, payload)——
      // DS 在 init 前注入 RunMacro 桥，函数在文档线程执行、修改真正落盘并回传返回值。
      if (window.Editor && typeof window.Editor.RunMacro === "function") {
        try {
          report("transport:runmacro");
          window.Editor.RunMacro(fn, payload || {}).then(function (ret) {
            if (ret && typeof ret === "object") ret.transport = "runmacro";
            resolve(ret === undefined ? null : ret);
          }, function (e) {
            report("runmacro-fail:" + ((e && e.message) || String(e)));
            resolve({ ok: false, error: "RunMacro 失败：" + ((e && e.message) || String(e)) });
          });
          return;
        } catch (e) { report("runmacro-throw:" + ((e && e.message) || String(e))); /* 落到 legacy */ }
      } else {
        report("transport:callcommand(no Editor)");
      }
      // legacy callCommand 兜底（第 4 参必须是回调；payload 经 Asc.scope；
      // isNoCalc=true——改文档的命令否则被丢弃）
      try {
        window.Asc.scope.paperRefsPayload = payload || {};
        window.Asc.plugin.callCommand(fn, false, true, function (ret) {
          resolve(ret === undefined ? null : ret);
        });
      } catch (e) {
        resolve({ ok: false, error: "callCommand 失败：" + ((e && e.message) || String(e)) });
      }
    });
  }

  function applyProposalViaPaste(payload) {
    return new Promise(function (resolve) {
      var suggested = typeof payload.suggested_text === "string" ? payload.suggested_text : "";
      var escaped = suggested
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      window.Asc.plugin.executeMethod("PasteHtml", [escaped], function (ret) {
        resolve({ ok: true, mode: "paste-html", ret: ret === undefined ? null : ret });
      });
    });
  }

  function runTask(task) {
    var cached = done[task.request_id];
    if (cached) {
      // 回执丢失重试：不重复执行，幂等重发上次结果
      report("dedup:" + task.request_id);
      return Promise.resolve(cached);
    }
    var p;
    if (task.kind === "insert-citation") {
      // v0.4.1 实测：本 DS 版本 RunMacro 沙箱内 Range 写入不落盘，且无内容控件收集 API
      // （GetAllSdt 缺失）——插入一律走插件侧 PasteHtml（用户真实光标处），如实报 plain
      var label = typeof task.payload.label === "string" ? task.payload.label.slice(0, 200) : "";
      if (!label) return Promise.resolve({ ok: false, error: "引用标签为空" });
      if (task.payload.superscript) {
        // GB/T 7714 上标引用：面板侧已把 [1],[2] 合并为 [1,2]，这里包一层 <sup>。
        var supHtml = "<sup>" + label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</sup>";
        p = pasteViaPlugin(supHtml, true);
      } else {
        p = pasteViaPlugin(label);
      }
    } else if (task.kind === "apply-proposal") {
      p = callBuilder("apply-proposal", task.payload).then(function (loc) {
        if (!loc || loc.ok !== true) {
          var reason = (loc && loc.reason) || "error";
          return { ok: false, reason: reason, error: (loc && loc.error) || null };
        }
        return applyProposalViaPaste(task.payload);
      });
    } else {
      p = callBuilder(task.kind, task.payload).then(function (ret) {
        if (ret && typeof ret === "object" && ret.ok === false) return ret;
        if (ret === null || ret === undefined) {
          return { ok: false, error: "文档侧执行无返回（callCommand 被编辑器拒绝或超时）" };
        }
        return ret;
      });
    }
    return p.then(function (data) {
      done[task.request_id] = data;
      return data;
    }).catch(function (e) {
      var err = { ok: false, error: (e && e.message) || String(e) };
      done[task.request_id] = err;
      return err;
    });
  }

  function tick() {
    if (stopped || busy || !docKey) return;
    busy = true;
    fetchTask()
      .then(function (task) {
        if (!task) return null;
        report("task:" + task.kind);
        return runTask(task).then(function (data) {
          var ok = !!(data && data.ok !== false);
          return postResult(task, ok, data, ok ? null : ((data && (data.error || data.message)) || null));
        });
      })
      .catch(function (e) { report("tick-fail:" + (e && e.message)); })
      .then(function () { busy = false; });
  }

  function startPolling() {
    window.setInterval(function () {
      // 定期清理 done 缓存（防无限增长；保留最近 40 条）
      var ids = Object.keys(done);
      if (ids.length > 40) for (var i = 0; i < ids.length - 40; i += 1) delete done[ids[i]];
      tick();
    }, POLL_MS);
    tick();
  }

  function connect() {
    return fetch("settings.json", { credentials: "omit", cache: "no-store", redirect: "error" })
      .then(function (r) { if (!r.ok) throw new Error("settings"); return r.json(); })
      .then(function (d) {
        if (!d || typeof d.document_server_url !== "string") throw new Error("settings");
        return d.document_server_url.replace(/\/+$/, "") + "/sdkjs-plugins/v1/plugins.js";
      })
      .then(function (scriptUrl) {
        return new Promise(function (resolve, reject) {
          var sdk = document.createElement("script");
          sdk.src = scriptUrl;
          sdk.onload = function () {
            report("sdk-loaded");
            if (!window.Asc || !window.Asc.plugin) { reject(new Error("no Asc.plugin")); return; }
            window.Asc.plugin.init = function () {
              if (stopped) return;
              docKey = resolveDocKey();
              try { report("init key=" + (docKey ? String(docKey).slice(0, 8) + "…" : "null")); } catch (e) { /* noop */ }
              try { window.top.postMessage({ source: SOURCE, type: "ready", docKey: docKey }, "*"); } catch (e) { /* 顶层不可达 */ }
              if (!docKey) { report("no-doc-key"); return; }
              startPolling();
            };
            window.Asc.plugin.button = function () { /* 无界面 */ };
            var started = false;
            var sdkOnload = window.onload;
            if (typeof sdkOnload === "function") {
              window.onload = function (event) {
                if (started) return;
                started = true;
                return sdkOnload.call(window, event);
              };
              if (document.readyState === "complete") window.onload();
            }
          };
          sdk.onerror = function () { reject(new Error("sdk load failed")); };
          document.head.appendChild(sdk);
        });
      });
  }

  report("boot v0.4.3");
  void 0;
  connect().catch(function (e) {
    report("connect-failed:" + (e && e.message));
  });
  window.addEventListener("pagehide", function () { stopped = true; });
  // node 回归测试入口（浏览器环境无 module，不影响运行时）
  if (typeof module === "object" && module.exports) {
    module.exports = {
      builderSetBibliography: builderSetBibliography,
      builderCollectRefs: builderCollectRefs,
      builderStripBibMarkers: builderStripBibMarkers,
    };
  }
})();
