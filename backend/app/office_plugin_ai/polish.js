/* 论文助手选区桥（v0.3）：隐形 ONLYOFFICE 插件。
 * 应用内「论文助手」侧栏是原生面板，无法跨源读取 DS iframe 选区；
 * 本插件随编辑器自启动，把选中文本经 postMessage 推给顶层窗口（应用页面）。
 * 页面由应用同源伺服（pluginsData → /api/office-plugin-ai/config.json），
 * ONLYOFFICE 插件运行时（plugins.js）从文档服务动态加载（与 office_plugin/core.js 同一模式）。 */
(function () {
  "use strict";
  var SOURCE = "paper-studio-assistant";
  var MAX_CHARS = 8000;
  var last = "";
  var stopped = false;
  var ticks = 0;

  function status(msg) {
    var el = document.getElementById("status");
    if (el) el.textContent = msg;
  }

  function push(text) {
    var value = typeof text === "string" ? text : "";
    if (value === last) return;
    report("sel:" + value.length);
    last = value;
    try {
      window.top.postMessage({ source: SOURCE, type: "selection", text: value.slice(0, MAX_CHARS) }, "*");
    } catch (e) { /* 顶层不可达时静默：侧栏保持上一次选区 */ }
  }

  function report(step) {
    try {
      fetch("/api/office-plugin-ai/debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ step: step })
      }).catch(function () { /* 调试回传失败不影响桥接 */ });
    } catch (e) { /* 同上 */ }
  }

  function poll(editor) {
    if (stopped) return;
    editor.executeMethod("GetSelectedText", [], function (text) {
      if (ticks < 2) report("tick" + ticks + ":" + (typeof text === "string" ? text.length : String(text)));
      ticks += 1;
      push(text);
    });
  }

  function connect() {
    /* 与公式插件一致：settings.json 相对页面地址解析（应用同源伺服）。 */
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
            if (!window.Asc || !window.Asc.plugin) { report("no-asc-plugin"); reject(new Error("bridge: no Asc.plugin")); return; }
            window.Asc.plugin.init = function () {
              if (stopped) return;
              status("桥接中");
              report("init");
              try { window.top.postMessage({ source: SOURCE, type: "ready" }, "*"); } catch (e) { report("ready-post-failed"); }
              /* 选区变化事件若可用则订阅；无论可用与否都以 1s 轮询兜底（去重后仅变化时推送）。 */
              try {
                window.Asc.plugin.attachEvent("onSelectionChanged", function () { poll(window.Asc.plugin); });
                report("evt-on");
              } catch (e) { report("evt-fail:" + (e && e.message)); /* 旧版 SDK 无此事件，轮询已覆盖 */ }
              window.setInterval(function () { poll(window.Asc.plugin); }, 1000);
              poll(window.Asc.plugin);
            };
            window.Asc.plugin.button = function () { /* 无界面按钮；编辑器关闭时自然回收 */ };
            /* plugins.js 通过 window.onload 取自身 config.json 并 postMessage 初始化；
             * SDK 注入晚于页面 load 事件时需手动补跑（office_plugin/core.js 同款握手）。 */
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
          sdk.onerror = function () { report("sdk-error"); reject(new Error("bridge: sdk load failed")); };
          document.head.appendChild(sdk);
        });
      });
  }

  report("boot");
  connect().catch(function (e) {
    status(e.message === "settings" ? "无法读取桥接设置" : "桥接不可用");
    report("connect-failed:" + e.message);
  });

  window.addEventListener("pagehide", function () { stopped = true; });
})();
