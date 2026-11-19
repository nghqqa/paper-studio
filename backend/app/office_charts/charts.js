/* Project-library snapshots stay in this editor instance; no shared task queue. */
(function () {
  "use strict";
  var core = window.PaperStudioCharts;
  var ui = {};
  ["charts-type", "charts-title", "charts-x", "charts-y", "charts-data", "charts-render", "charts-status", "charts-preview", "charts-insert", "charts-download",
    "charts-library-refresh", "charts-library-status", "charts-library-select", "charts-library-preview", "charts-library-insert", "charts-width",
    "charts-library-check", "charts-library-update-select", "charts-library-update"].forEach(function (id) {
    ui[id] = document.getElementById(id);
  });
  var ready = false, busy = false, generation = 0, dataUrl = "", previewRevision = 0;
  var current = null, selected = null, previewMeta = null, pendingCheck = false;
  var updateCandidates = [];

  function status(message, isErr, library) {
    var target = ui[library ? "charts-library-status" : "charts-status"];
    target.textContent = message;
    target.dataset.level = isErr ? "error" : "info";
  }
  function buttons() {
    ui["charts-library-refresh"].disabled = !ready || busy;
    ui["charts-library-select"].disabled = !ready || busy || !current;
    ui["charts-library-insert"].disabled = !ready || busy || !selected || pendingCheck;
    ui["charts-render"].disabled = busy;
    ui["charts-insert"].disabled = !ready || busy || !dataUrl || pendingCheck;
    ui["charts-width"].disabled = busy;
    ui["charts-library-check"].disabled = !ready || busy;
    ui["charts-library-update-select"].disabled = !ready || busy;
    ui["charts-library-update"].disabled = !ready || busy || ui["charts-library-update-select"].value === "";
  }
  // crypto.randomUUID 与 crypto.subtle 只在安全上下文（HTTPS/localhost）可用；实验室
  // 内网常是纯 HTTP。唯一性只需 getRandomValues（任何上下文都有）+ 服务端给出的摘要。
  function randomId() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes).map(function (b) {return b.toString(16).padStart(2, "0");}).join("");
  }
  function getContext() { return core.context(window.Asc && window.Asc.plugin && window.Asc.plugin.info); }
  function requireContext(expected) {
    if (!core.sameContext(expected, getContext())) throw new Error("文档会话已变化，请刷新图表库后重新选择。");
  }
  function path(ctx) { return "/api/project-figures/" + encodeURIComponent(ctx.pid); }
  async function json(url, options) {
    var response = await fetch(url, Object.assign({credentials: "same-origin", cache: "no-store", redirect: "error"}, options));
    var result = await response.json();
    if (!response.ok) {
      var detail = result && result.detail;
      throw new Error(typeof detail === "string" ? detail : detail && detail.message || detail && detail[0] && detail[0].msg || "图表请求失败，请重试。");
    }
    return result;
  }
  function showImage(target, url, alt) {
    target.replaceChildren();
    var img = document.createElement("img");
    img.src = url; img.alt = alt;
    target.appendChild(img);
  }
  function clearLibrary() {
    pendingCheck = false;
    selected = null;
    ui["charts-library-select"].replaceChildren();
    var option = document.createElement("option");
    option.value = ""; option.textContent = "请选择图表";
    ui["charts-library-select"].appendChild(option);
    ui["charts-library-preview"].replaceChildren();
  }
  async function refreshLibrary() {
    if (!ready || busy) return;
    var seq = ++generation;
    clearLibrary(); current = null; buttons();
    try {
      var ctx = getContext();
      status("正在读取本项目图表…", false, true);
      var result = await json(path(ctx));
      if (seq !== generation) return;
      requireContext(ctx); current = ctx;
      (result.figures || []).forEach(function (figure) {
        var option = document.createElement("option");
        option.value = figure.id; option.textContent = figure.name;
        ui["charts-library-select"].appendChild(option);
      });
      status(result.figures && result.figures.length ? "选择图表后预览，再插入当前 Word 文档。" : "本项目暂无图表。可在项目首页的“科研图表”中创建并保存，再回来刷新。", false, true);
    } catch (e) { if (seq === generation) status(e.message, true, true); }
    finally { if (seq === generation) buttons(); }
  }
  async function selectFigure() {
    var fid = ui["charts-library-select"].value;
    var ctx = current, seq = ++generation;
    pendingCheck = false;
    selected = null; ui["charts-library-preview"].replaceChildren(); buttons();
    if (!fid || !ctx) return;
    try {
      status("正在读取图表快照…", false, true);
      var snapshot = await json(path(ctx) + "/" + encodeURIComponent(fid) + "/word-image?doc_key=" + encodeURIComponent(ctx.docKey));
      if (seq !== generation) return;
      requireContext(ctx);
      if (snapshot.id !== fid) throw new Error("图表快照不匹配，请刷新后重试。");
      selected = {context: ctx, snapshot: snapshot};
      showImage(ui["charts-library-preview"], snapshot.data_url, snapshot.name);
      status("已选取“" + snapshot.name + "”。请先在正文空白段落中放置光标。", false, true);
    } catch (e) { if (seq === generation) status(e.message, true, true); }
    finally { if (seq === generation) buttons(); }
  }
  async function insertSnapshot(snapshot, library) {
    var size = core.imageSize(snapshot.width_px, snapshot.height_px, Number(ui["charts-width"].value));
    var name = core.insertionName(snapshot.id, snapshot.sha256, randomId());
    var result;
    try {
      result = await core.runInsert(window, {data_url: snapshot.data_url, width: size.width, height: size.height, name: name});
    } catch (e) {
      // 超时=结果未知：锁定按钮，用户必须核查正文并重建操作后才能再次插入。
      pendingCheck = true; buttons();
      throw e;
    }
    if (!result || !result.ok) {
      pendingCheck = true; buttons();
      throw new Error(result && result.message || "插图操作未返回确认。请检查正文，避免重复插入。");
    }
    status("图表已插入。请点击平台“保存”确认文件回传，再下载 Word。", false, library);
  }
  async function insertLibrary() {
    if (!selected || busy || !ready) return;
    var choice = selected;
    busy = true; buttons();
    try {
      requireContext(choice.context);
      // Recheck ACL, session and deletion immediately before the document write.
      var fresh = await json(path(choice.context) + "/" + encodeURIComponent(choice.snapshot.id) + "/word-image?doc_key=" + encodeURIComponent(choice.context.docKey));
      requireContext(choice.context);
      if (fresh.id !== choice.snapshot.id || fresh.sha256 !== choice.snapshot.sha256) throw new Error("图表已变化，请重新选择并确认预览。");
      await insertSnapshot(fresh, true);
    } catch (e) { status(e.message, true, true); }
    finally { busy = false; buttons(); }
  }

  /* 正文图表更新：盘点本平台命名（paper-figure:fid:sha16:…）的图片，与图表库当前
   * 快照比对内容摘要；更新动作紧邻写入前重取快照复核，替换宏在编辑器内原子完成。 */
  function fillUpdateSelect(candidates, message) {
    var select = ui["charts-library-update-select"];
    select.replaceChildren();
    var option = document.createElement("option");
    option.value = "";
    option.textContent = message || (candidates.length ? "选择要更新的正文图" : "没有可更新的图");
    select.appendChild(option);
    candidates.forEach(function (candidate, index) {
      var opt = document.createElement("option");
      opt.value = String(index);
      opt.textContent = "段落 " + (candidate.paragraphIndex + 1) + " · " + candidate.fid;
      select.appendChild(opt);
    });
  }
  async function checkDocument() {
    if (!ready || busy) return;
    var seq = ++generation;
    busy = true; updateCandidates = [];
    fillUpdateSelect([], "正在检查正文…");
    buttons();
    try {
      var ctx = getContext();
      var scan = await core.runDocumentMacro(window, core.inventoryCommand, {});
      if (seq !== generation) return;
      if (!scan.ok) throw new Error(scan.message || "读取正文图表失败。");
      var docFigs = scan.figures || [];
      if (!docFigs.length) {
        fillUpdateSelect([], "正文中没有本平台插入的图表");
        status("正文中没有本平台插入的图表。", false, true);
        return;
      }
      var library = (await json(path(ctx))).figures || [];
      if (seq !== generation) return;
      requireContext(ctx);
      var byId = {};
      library.forEach(function (figure) {byId[figure.id] = figure;});
      var currentSha = {}, uniqueFids = [];
      docFigs.forEach(function (item) {
        if (uniqueFids.indexOf(item.fid) === -1) uniqueFids.push(item.fid);
      });
      for (var i = 0; i < uniqueFids.length; i += 1) {
        var fid = uniqueFids[i];
        try {
          var snap = await json(path(ctx) + "/" + encodeURIComponent(fid) + "/word-image?doc_key=" + encodeURIComponent(ctx.docKey));
          if (seq !== generation) return;
          currentSha[fid] = String(snap.sha256 || "").slice(0, 16);
        } catch (e) { currentSha[fid] = null; }
      }
      var stale = [], orphans = 0, failed = 0;
      docFigs.forEach(function (item) {
        if (!byId[item.fid]) {orphans += 1; return;}
        var sha = currentSha[item.fid];
        // 读取快照失败（sha==null）不是「最新」——单列如实报告，绝不参与均最新的判定
        if (sha == null) {failed += 1; return;}
        if (item.sha16 !== sha) stale.push({fid: item.fid, name: item.name, paragraphIndex: item.paragraphIndex});
      });
      updateCandidates = stale;
      if (seq !== generation) return;
      var notes = [];
      if (orphans) notes.push(orphans + " 张图已在库中删除，正文保留原图");
      if (failed) notes.push(failed + " 张读取快照失败");
      var suffix = notes.length ? "；另有 " + notes.join("，") + "。" : "。";
      if (!stale.length) {
        fillUpdateSelect([], failed ? "部分图表核对失败，请重试" : "正文图表均为最新");
        status(failed
          ? "正文 " + docFigs.length + " 张中 " + failed + " 张核对失败（读取快照失败）——请稍后重新检查。"
          : "正文 " + docFigs.length + " 张本平台图表均为最新" + suffix, failed, true);
      } else {
        fillUpdateSelect(stale, null);
        status("发现 " + stale.length + " 张可更新" + suffix + (failed ? "另有 " + failed + " 张核对失败未参与比对。" : "") + " 选择后点击“更新所选正文图”。", false, true);
      }
    } catch (e) {
      if (seq === generation) {fillUpdateSelect([], null); status(e.message, true, true);}
    } finally {
      if (seq === generation) {busy = false; buttons();}
    }
  }
  async function updateSelected() {
    var index = parseInt(ui["charts-library-update-select"].value, 10);
    var candidate = updateCandidates[index];
    if (!candidate || busy || !ready) return;
    busy = true; buttons();
    try {
      var ctx = getContext();
      // 与插入同款的最后一道复核：紧邻写入前重取快照，防止检查与更新之间图源又变化。
      var fresh = await json(path(ctx) + "/" + encodeURIComponent(candidate.fid) + "/word-image?doc_key=" + encodeURIComponent(ctx.docKey));
      var newSha = String(fresh.sha256 || "").slice(0, 16);
      var newName = core.insertionName(candidate.fid, fresh.sha256, randomId());
      var size = core.imageSize(fresh.width_px, fresh.height_px, Number(ui["charts-width"].value));
      var result = await core.runDocumentMacro(window, core.replaceCommand, {
        name: candidate.name, newName: newName, data_url: fresh.data_url, width: size.width, height: size.height
      });
      if (!result || !result.ok) throw new Error(result && result.message || "替换未完成，请重试。");
      status("已替换为库中最新版（摘要 " + newSha.slice(0, 8) + "…）。请点击平台“保存”确认文件回传。", false, true);
      await checkDocument();
    } catch (e) { status(e.message, true, true); }
    finally { busy = false; buttons(); }
  }

  function invalidatePreview() {
    previewRevision += 1; dataUrl = ""; previewMeta = null; pendingCheck = false;
    ui["charts-preview"].replaceChildren(); ui["charts-download"].hidden = true;
    buttons();
  }
  async function render() {
    if (busy) return;
    invalidatePreview();
    var revision = previewRevision;
    busy = true; buttons();
    try {
      var parsed = JSON.parse(ui["charts-data"].value);
      if (!parsed || !Array.isArray(parsed.categories) || !Array.isArray(parsed.series)) throw new Error("请填写包含 categories 与 series 的数据 JSON。");
      status("正在生成预览…");
      var result = await json("/api/charts/render", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({
        type: ui["charts-type"].value, title: ui["charts-title"].value, x_label: ui["charts-x"].value, y_label: ui["charts-y"].value,
        categories: parsed.categories, series: parsed.series
      })});
      if (revision !== previewRevision) return;
      if (typeof result.width_px !== "number" || typeof result.height_px !== "number" || typeof result.sha256 !== "string") {
        throw new Error("渲染服务返回数据不完整，请刷新后重试。");
      }
      dataUrl = result.data_url;
      previewMeta = {width_px: result.width_px, height_px: result.height_px, sha256: result.sha256};
      showImage(ui["charts-preview"], dataUrl, "新图预览"); ui["charts-download"].hidden = false;
      status("预览已生成。插入前请在正文空白段落放置光标。");
    } catch (e) { status(e.message, true); }
    finally { busy = false; buttons(); }
  }
  async function insertPreview() {
    if (!dataUrl || !previewMeta || busy || !ready) return;
    var source = dataUrl, meta = previewMeta, revision = previewRevision;
    var ctx;
    try { ctx = getContext(); } catch (e) { status(e.message, true); return; }
    busy = true; buttons();
    try {
      // 调用插入宏前的最后一道复核：预览版本与文档会话都必须仍是发起时的那个；
      // 此后不再有可安全中断的等待点（宏一旦发出，写入可能已发生）。
      if (revision !== previewRevision || source !== dataUrl) throw new Error("数据已修改，请重新生成预览。");
      requireContext(ctx);
      await insertSnapshot({id: "preview", data_url: source, width_px: meta.width_px, height_px: meta.height_px, sha256: meta.sha256}, false);
    } catch (e) { status(e.message, true); }
    finally { busy = false; buttons(); }
  }
  ui["charts-render"].addEventListener("click", render);
  ui["charts-insert"].addEventListener("click", insertPreview);
  ui["charts-library-refresh"].addEventListener("click", refreshLibrary);
  ui["charts-library-select"].addEventListener("change", selectFigure);
  ui["charts-library-insert"].addEventListener("click", insertLibrary);
  ui["charts-library-check"].addEventListener("click", checkDocument);
  ui["charts-library-update"].addEventListener("click", updateSelected);
  ui["charts-download"].addEventListener("click", function () {
    if (!dataUrl) return;
    var a = document.createElement("a"); a.href = dataUrl; a.download = "chart.png"; a.click();
  });
  ["charts-type", "charts-title", "charts-x", "charts-y", "charts-data"].forEach(function (id) {ui[id].addEventListener("input", invalidatePreview);});
  document.addEventListener("paper-studio-editor-ready", function () {ready = true; buttons(); refreshLibrary();});
  document.addEventListener("struct-view-changed", function (e) {if (e.detail === "view-charts" && ready && !current) refreshLibrary();});
  window.addEventListener("pagehide", function () {generation += 1; ready = false;});
  buttons();
})();
