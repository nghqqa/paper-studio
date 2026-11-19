(function () {
  "use strict";
  var core = window.PaperStudioMath;
  var state = {ready: false, busy: false, valid: false, stale: false, version: "", formulas: [], target: null, numbered: null};
  var ui = {};
  ["status", "latex", "placement", "preview", "preview-error", "submit", "submit-hint", "reset", "refresh", "convert-current", "number-next-line", "input-title", "target-info", "formula-list", "formula-count", "auto-number", "check-refs", "renumber-all", "refs-report"].forEach(function (id) {ui[id] = document.getElementById(id);});

  function status(message, level) {
    ui.status.textContent = message;
    ui.status.dataset.level = level || "info";
  }
  function buttons() {
    ui.submit.disabled = !state.ready || state.busy || !state.valid || state.stale;
    ui.refresh.disabled = !state.ready || state.busy;
    ui["convert-current"].disabled = !state.ready || state.busy;
    ui["number-next-line"].disabled = !state.ready || state.busy;
    ui["auto-number"].disabled = !state.ready || state.busy || state.stale || !!state.target || !ui.latex.value.trim();
    ui["check-refs"].disabled = !state.ready || state.busy;
    ui["renumber-all"].disabled = !state.ready || state.busy || state.stale;
    ui.reset.disabled = state.busy;
    ui.placement.disabled = !!state.target || state.busy;
    ui["formula-list"].querySelectorAll("button").forEach(function (button) {button.disabled = state.busy || state.stale;});
    var invalid = !!ui.latex.value.trim() && !state.valid;
    ui["submit-hint"].dataset.level = state.stale || invalid ? "error" : "info";
    ui["submit-hint"].textContent = !state.ready ? "正在连接文档编辑器…" : state.busy ? "正在处理公式…" : state.stale ? "文档内容已变化，请刷新公式清单后重新选择。" : invalid ? "公式有错误，请查看上方预览中的提示。" : state.target ? "保留原位置与版式，Ctrl / ⌘ + Enter 更新。" : state.numbered ? "将插入居中公式，编号 " + state.numbered.label + " 靠右。" : "先在正文放置光标，Ctrl / ⌘ + Enter 确认。";
  }
  function preview() {
    state.valid = false;
    state.numbered = null;
    ui.preview.classList.remove("has-number");
    ui["preview-error"].hidden = true;
    if (!ui.latex.value.trim()) {ui.preview.textContent = "在上方输入 LaTeX"; buttons(); return;}
    try {
      var input = window.PaperStudioNativeNumbering.parseInput(ui.latex.value);
      if (state.target && input.label) throw new Error("公式编号请在正文右侧直接修改；此处仅更新公式内容。");
      var latex = core.normalizeLatex(input.formula);
      if (input.label) {state.numbered = {formula: latex, label: input.label}; ui.placement.value = "display";}
      if (!window.katex) throw new Error("本地公式预览资源未加载，请联系管理员检查安装。");
      window.katex.render(latex, ui.preview, {displayMode: ui.placement.value === "display", throwOnError: true, trust: false, strict: "warn", maxExpand: 1000});
      if (input.label) {
        ui.preview.classList.add("has-number");
        var number = document.createElement("span"); number.className = "preview-number"; number.textContent = input.label; ui.preview.appendChild(number);
      }
      state.valid = true;
    } catch (error) {
      ui.preview.textContent = "请检查表达式";
      ui["preview-error"].textContent = error.message;
      ui["preview-error"].hidden = false;
    }
    buttons();
  }
  function clearTarget() {
    state.target = null;
    state.stale = false;
    ui["input-title"].textContent = "新建公式";
    ui.submit.textContent = "插入到光标位置";
    ui["target-info"].hidden = true;
    renderList();
    buttons();
  }
  function markStale() {
    state.stale = true;
    if (state.target) {
      ui["target-info"].hidden = false;
      ui["target-info"].textContent = "文档内容已变化，已暂停更新。请复制需要保留的输入，然后刷新清单并重新选择公式。";
    }
  }
  function renderList() {
    var list = ui["formula-list"];
    list.replaceChildren();
    ui["formula-count"].textContent = state.formulas.length ? "(" + state.formulas.length + ")" : "";
    if (!state.formulas.length) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "暂无原生数学公式。插入公式后点击刷新；图片和 MathType OLE 对象不在此清单中。";
      list.appendChild(empty);
      return;
    }
    state.formulas.forEach(function (formula, index) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "formula-item";
      item.setAttribute("aria-pressed", String(formula === state.target));
      item.setAttribute("aria-label", "编辑公式 " + (index + 1));
      var label = document.createElement("span"); label.className = "formula-label"; label.textContent = "公式 " + (index + 1) + " · 段落 " + (formula.paragraphIndex + 1);
      if (formula.label) {
        var badge = document.createElement("span");
        badge.className = "formula-badge";
        badge.textContent = "编号 (" + formula.label + ")";
        label.appendChild(badge);
      }
      var latex = document.createElement("span"); latex.className = "formula-latex"; latex.textContent = formula.latex;
      item.append(label, latex);
      /* 独立公式段落的段落文本就是「latex+编号」，不重复展示 context 行。 */
      if (core.contextAddsInfo(formula)) {
        var context = document.createElement("span"); context.className = "formula-context"; context.textContent = formula.context;
        item.appendChild(context);
      }
      if (formula.label) {
        var copy = document.createElement("span");
        copy.className = "formula-copy";
        copy.setAttribute("role", "button");
        copy.setAttribute("tabindex", "0");
        copy.textContent = "复制引用";
        function copyThis(event) {
          event.stopPropagation();
          event.preventDefault();
          copyReference(formula.label);
        }
        copy.addEventListener("click", copyThis);
        copy.addEventListener("keydown", function (event) {if (event.key === "Enter" || event.key === " ") copyThis(event);});
        item.appendChild(copy);
      }
      item.addEventListener("click", function () {selectFormula(formula, index);});
      list.appendChild(item);
    });
    buttons();
  }

  function run(payload) {
    return runWith(core.documentCommand, payload);
  }
  function runWith(command, payload) {
    // Public community plugin API. No Automation API / createConnector license.
    if (window.Editor && typeof window.Editor.RunMacro === "function") {
      return window.Editor.RunMacro(command, payload).then(checkResponse);
    }
    // Some embedded 10.0 hosts still expose only the legacy plugin bridge.
    // Its Office API context receives JSON through Asc.scope, as documented.
    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () {reject(new Error("编辑器未响应。请重新打开公式插件后检查文档。"));}, 20000);
      window.Asc.scope.paperStudioMathPayload = payload;
      window.Asc.plugin.callCommand(command, false, payload.action === "insert" || payload.action === "replace" || payload.action === "convert-current" || payload.action === "number-next-line", function (result) {
        clearTimeout(timeout);
        try {resolve(checkResponse(result));} catch (error) {reject(error);}
      });
    });
  }
  function checkResponse(result) {
    if (!result || result.onlyoffice_id_error_message) throw new Error(result && result.onlyoffice_id_error_message || "公式操作未完成，请确认文档服务版本不低于 10.0。");
    if (!result.ok) {var error = new Error(result.message || "公式操作失败。"); error.code = result.code; throw error;}
    return result;
  }
  async function refresh() {
    if (state.busy) return;
    state.busy = true; buttons();
    try {
      var result = await run({action: "list"});
      var nativeStatus = await runWith(window.PaperStudioNativeNumbering.installCommand, {action: "status"});
      var nativeText = nativeStatus.lastError || (nativeStatus.enabled ? "正文快捷输入：Alt+= → 公式#(2) → 回车。编号为手动编号。" : "可在下方输入公式#(2)，插入居中公式和右侧编号。");
      document.getElementById("native-status").textContent = nativeText + (nativeStatus.dblClick ? " 双击正文公式可在本面板定位编辑。" : "");
      state.version = result.version;
      state.formulas = result.formulas;
      clearTarget();
      status("已读取 " + state.formulas.length + " 条公式。选择清单中的公式即可编辑。", "success");
    } catch (error) {status(error.message, "error");}
    finally {state.busy = false; buttons();}
  }
  async function selectFormula(formula, index) {
    if (state.busy) return;
    state.busy = true; buttons();
    try {
      var selection = await run({action: "select", target: formula, version: state.version});
      state.target = formula;
      ui.latex.value = formula.latex;
      ui["input-title"].textContent = "编辑公式 " + (index + 1);
      ui.submit.textContent = "更新原公式";
      ui["target-info"].hidden = false;
      ui["target-info"].textContent = "正在编辑公式 " + (index + 1) + "，位于段落 " + (formula.paragraphIndex + 1) + "。更新将在原位置完成。";
      renderList(); preview();
      status(selection.located ? "已定位公式所在段落。修改后点击“更新原公式”。" : "已读取目标公式。修改后点击“更新原公式”。");
      ui.latex.focus();
    } catch (error) {if (error.code === "stale") markStale(); status(error.message, "error");}
    finally {state.busy = false; buttons();}
  }
  async function submit() {
    if (!state.ready || state.busy || !state.valid || state.stale) return;
    state.busy = true; buttons();
    var editing = !!state.target;
    try {
      if (!editing && state.numbered) {
        await runWith(window.PaperStudioNativeNumbering.numberingCommand, {action: "insert", value: state.numbered.formula + "#" + state.numbered.label});
      } else {
        await run({action: editing ? "replace" : "insert", latex: core.normalizeLatex(ui.latex.value), placement: ui.placement.value, target: state.target, version: state.version});
      }
      clearTarget();
      try {
        var result = await run({action: "list"});
        state.version = result.version;
        state.formulas = result.formulas;
        renderList();
      } catch (refreshError) {
        markStale();
        status("公式已" + (editing ? "更新" : "插入") + "；清单暂时无法刷新，请点击“刷新”重试。", "success");
        return;
      }
      status(editing ? "已更新原公式。可在正文使用撤销恢复。" : "已插入可编辑的 Word 公式。点击工作台“保存”确认文件回传。", "success");
    } catch (error) {
      if (error.code === "stale") markStale();
      status(error.message, "error");
    } finally {state.busy = false; buttons();}
  }

  async function formatNumber(action) {
    if (!state.ready || state.busy) return;
    state.busy = true; buttons();
    try {
      var result = await runWith(window.PaperStudioNativeNumbering.numberingCommand, {action: action});
      clearTarget();
      try {
        var snapshot = await run({action: "list"});
        state.version = snapshot.version; state.formulas = snapshot.formulas; renderList();
      } catch (refreshError) {markStale();}
      var message = action === "convert-current" ? "已将 " + result.count + " 条旧公式改为无表格排版。公式和编号仍可编辑，可在正文撤销。" : result.changed ? "编号已另起一行靠右。可在正文撤销。" : "编号已经另起一行，无需重复调整。";
      status(message + (state.stale ? "请刷新公式清单。" : ""), "success");
    } catch (error) {status(error.message, "error");}
    finally {state.busy = false; buttons();}
  }

  function copyReference(label) {
    var text = "式(" + label + ")";
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(function () {status("已复制 “" + text + "”，可粘贴到正文。", "success");}, function () {fallbackCopy(text);});
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {ok = document.execCommand("copy");} catch (error) {ok = false;}
    document.body.removeChild(area);
    status(ok ? "已复制 “" + text + "”，可粘贴到正文。" : "复制失败，请手动记录：" + text, ok ? "success" : "error");
  }

  async function autoNumber() {
    if (!state.ready || state.busy || state.stale || state.target) return;
    if (!ui.latex.value.trim()) {status("请先输入公式，再点击自动编号。", "error"); return;}
    state.busy = true; buttons();
    try {
      var result = await run({action: "suggest-label"});
      if (!result.label) {status("最近一条编号带子图字母（如 1a），不参与自动递增；请手动输入编号。", "error"); return;}
      var input = window.PaperStudioNativeNumbering.parseInput(ui.latex.value);
      ui.latex.value = input.formula + "#(" + result.label + ")";
      preview();
      status("已按文中最新编号追加建议编号 (" + result.label + ")，可修改后再插入。", "success");
    } catch (error) {status(error.message, "error");}
    finally {state.busy = false; buttons();}
  }

  async function checkRefs() {
    if (!state.ready || state.busy) return;
    state.busy = true; buttons();
    try {
      var report = await run({action: "check-refs"});
      renderRefs(report);
      var problems = report.missing.length + report.duplicates.length;
      status(problems ? "引用核对发现 " + problems + " 处问题，详见清单下方报告。" : "引用核对通过：" + report.definedCount + " 条编号、" + report.referencedCount + " 处正文引用。", problems ? "error" : "success");
    } catch (error) {status(error.message, "error");}
    finally {state.busy = false; buttons();}
  }
  function renderRefs(report) {
    var box = ui["refs-report"];
    box.replaceChildren();
    box.hidden = false;
    var problems = report.missing.length + report.duplicates.length;
    var title = document.createElement("p");
    title.className = "refs-title";
    title.dataset.level = problems ? "error" : "success";
    title.textContent = problems
      ? "引用核对：发现 " + problems + " 处问题"
      : "引用核对通过：" + report.definedCount + " 条编号、" + report.referencedCount + " 处正文引用";
    box.appendChild(title);
    report.duplicates.forEach(function (duplicate) {
      refsItem("重复编号 (" + duplicate + ")：文中有相同的编号，请「全文重编号」或手动修正后再引用。", true);
    });
    report.missing.forEach(function (ref) {
      refsItem("正文引用 式(" + ref.label + ")（段落 " + (ref.paragraphIndex + 1) + "）没有对应编号公式。→ 点击定位", true, ref.paragraphIndex);
    });
    if (report.unreferenced.length) {
      refsItem("从未被正文引用的编号：" + report.unreferenced.map(function (l) {return "(" + l + ")";}).join("、") + "。", false);
    }
    if (!report.definedCount && !report.referencedCount) {
      refsItem("文中没有编号公式，也没有“式(2)”形式的正文引用。", false);
    }
    var guide = document.createElement("p");
    guide.className = "refs-guide";
    guide.textContent = "处理方式：修改正文中的引用编号，或给公式补/改编号（插入时写 公式#(n)，或用「全文重编号」统一）。标红条目可点击跳到对应段落。";
    box.appendChild(guide);
    function refsItem(text, warn, paragraphIndex) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "refs-item";
      row.textContent = text;
      row.dataset.warn = String(!!warn);
      if (typeof paragraphIndex === "number") {
        row.dataset.goto = "true";
        row.title = "点击定位到该段落";
        row.addEventListener("click", function () {gotoParagraph(paragraphIndex);});
      }
      box.appendChild(row);
    }
  }

  async function gotoParagraph(paragraphIndex) {
    if (!state.ready || state.busy) return;
    state.busy = true; buttons();
    try {
      var result = await run({action: "goto", paragraphIndex: paragraphIndex});
      status(result.located ? "已定位到段落 " + (paragraphIndex + 1) + "，可直接修改正文引用。" : "已找到该段落，但当前编辑器不支持移动光标，请手动滚动查找。", "info");
    } catch (error) {status(error.message, "error");}
    finally {state.busy = false; buttons();}
  }

  async function renumberAll() {
    if (!state.ready || state.busy || state.stale) return;
    if (!window.confirm("将按文档顺序为全部编号公式重新编号（同前缀各自连续，可整段撤销）。是否继续？")) return;
    state.busy = true; buttons();
    try {
      var result = await run({action: "renumber", version: state.version});
      clearTarget();
      try {
        var snapshot = await run({action: "list"});
        state.version = snapshot.version; state.formulas = snapshot.formulas; renderList();
      } catch (refreshError) {markStale();}
      status("已重编号 " + result.changed.length + " 条" + (result.skipped.length ? "，跳过 " + result.skipped.length + " 条（结构不识别，未改动）。" : "。") + (state.stale ? " 请刷新公式清单。" : " 可在正文撤销。"), "success");
    } catch (error) {
      if (error.code === "stale") markStale();
      status(error.message, "error");
    } finally {state.busy = false; buttons();}
  }

  /* 双击回编面板侧：接收后台插件的定位广播（BroadcastChannel 优先，localStorage 降级），
   * 刷新清单后按 LaTeX 精确匹配选中对应公式。 */
  var locateChannel = null;
  try {if (typeof BroadcastChannel === "function") locateChannel = new BroadcastChannel("paper-studio-math");} catch (error) {locateChannel = null;}
  var lastLocate = {key: "", at: 0};
  async function handleLocate(message) {
    if (!message || message.type !== "paper-studio-math-locate" || !state.ready || state.busy) return;
    var key = String(message.latex || "") + "|" + String(message.label || "");
    var now = new Date().getTime();
    if (key === lastLocate.key && now - lastLocate.at < 800) return;
    lastLocate = {key: key, at: now};
    state.busy = true; buttons();
    try {
      var snapshot = await run({action: "list"});
      state.version = snapshot.version; state.formulas = snapshot.formulas; renderList();
    } catch (error) {status(error.message, "error"); state.busy = false; buttons(); return;}
    state.busy = false; buttons();
    var index = -1;
    if (message.paraId) {
      var same = [];
      for (var p = 0; p < state.formulas.length; p += 1) {
        if (state.formulas[p].paragraphId === message.paraId) same.push(state.formulas[p]);
      }
      if (same.length === 1) {
        // 单命中且为嵌套公式（内容控件内，路径深度>1）时同样拒绝：事件层的段落级
        // 视角无法证明双击命中的就是这条（顶层公式+控件内公式并存的段落）。
        if (same[0].path.length > 1) {
          status("该段落含内容控件内的公式，无法确定双击目标——请在清单中直接选择。", "info");
          return;
        }
        index = state.formulas.indexOf(same[0]);
      } else if (same.length > 1) {
        var hasNested = same.some(function (f) { return f.path.length > 1; });
        if (hasNested) {
          status("该段落含内容控件内的公式，无法确定双击目标——请在清单中直接选择。", "info");
          return;
        }
        // 同段多条公式：按双击命中的顶层位置精确匹配；位置缺失或未命中时拒绝定位
        if (typeof message.mathIndex === "number") {
          for (var q = 0; q < same.length; q += 1) {
            if (same[q].path.length === 1 && same[q].path[0] === message.mathIndex) {
              index = state.formulas.indexOf(same[q]);
              break;
            }
          }
        }
        if (index === -1) {
          status("该段落含多条公式，无法确定双击目标——请在清单中直接选择。", "info");
          return;
        }
      }
    }
    if (index === -1) {
      for (var i = 0; i < state.formulas.length; i += 1) {
        if (state.formulas[i].latex === message.latex) {index = i; break;}
      }
    }
    if (index === -1 && message.label) {
      for (var j = 0; j < state.formulas.length; j += 1) {
        if (state.formulas[j].label === message.label) {index = j; break;}
      }
    }
    if (index === -1) {status("双击的段落不是可编辑的原生公式。", "info"); return;}
    await selectFormula(state.formulas[index], index);
  }
  if (locateChannel) locateChannel.onmessage = function (event) {handleLocate(event.data);};
  window.addEventListener("storage", function (event) {
    if (event.key !== "paper-studio-math-locate" || !event.newValue) return;
    try {handleLocate(JSON.parse(event.newValue));} catch (error) { /* 忽略无法解析的广播 */ }
  });

  ui.latex.addEventListener("input", preview);
  ui.placement.addEventListener("change", preview);
  ui.submit.addEventListener("click", submit);
  ui.refresh.addEventListener("click", refresh);
  ui["convert-current"].addEventListener("click", function () {formatNumber("convert-current");});
  ui["number-next-line"].addEventListener("click", function () {formatNumber("number-next-line");});
  ui["auto-number"].addEventListener("click", autoNumber);
  ui["check-refs"].addEventListener("click", checkRefs);
  ui["renumber-all"].addEventListener("click", renumberAll);
  ui.reset.addEventListener("click", function () {clearTarget(); preview(); status("先在正文点击插入位置，再输入新公式。"); ui.latex.focus();});
  ui.latex.addEventListener("keydown", function (event) {if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {event.preventDefault(); submit();}});
  document.querySelectorAll("[data-snippet]").forEach(function (button) {
    button.addEventListener("click", function () {
      var start = ui.latex.selectionStart;
      var end = ui.latex.selectionEnd;
      ui.latex.setRangeText(button.dataset.snippet, start, end, "end");
      ui.latex.focus(); preview();
    });
  });

  async function connect() {
    // The backend owns the Document Server setting. Query parameters must never
    // become a script URL on the application's origin.
    var scriptUrl = await core.configuredServerScriptUrl(window.fetch.bind(window), window.location.href);
    var sdk = document.createElement("script");
    sdk.src = scriptUrl;
    sdk.onload = function () {
      if (!window.Asc || !window.Asc.plugin) {status("公式插件接口不可用，请从文档编辑器内部打开。", "error"); return;}
      window.Asc.plugin.init = function () {
        state.ready = true; buttons();
        document.dispatchEvent(new CustomEvent("paper-studio-editor-ready"));
        window.Asc.plugin.executeMethod("GetVersion", [], function (version) {
          runWith(window.PaperStudioNativeNumbering.installCommand, {action: "install", sdkVersion: version}).then(refresh).catch(function (error) {status(error.message, "error");});
        });
      };
      window.Asc.plugin.button = function () {window.Asc.plugin.executeCommand("close", "");};
      // Keep this document tool self-consistently light even in the editor's dark
      // chrome. The SDK's base theme injects white foreground text, which clashes
      // with this plugin's intentionally white formula/input surfaces.
      window.Asc.plugin.onThemeChanged = function () {};
      core.startSdkHandshake(window, document.readyState);
    };
    sdk.onerror = function () {status("无法加载文档服务插件接口，请检查 ONLYOFFICE 连接。", "error");};
    document.head.appendChild(sdk);
  }
  connect().catch(function (error) {status(error.message, "error");});
  preview();
})();
