/* 科研图表插件的 SDK 连接引导：与 LaTeX公式 插件 app.js 的 connect() 同源同语义，
 * 独立成文件以便图表插件单挂。完成后派发 charts.js 依赖的 editor-ready 事件。 */
(function () {
  "use strict";
  var core = window.PaperStudioMath;

  function status(message, isErr) {
    var target = document.getElementById("charts-status");
    if (!target) return;
    target.textContent = message;
    target.dataset.level = isErr ? "error" : "info";
  }

  async function connect() {
    // The backend owns the Document Server setting. Query parameters must never
    // become a script URL on the application's origin.
    var scriptUrl = await core.configuredServerScriptUrl(window.fetch.bind(window), window.location.href);
    var sdk = document.createElement("script");
    sdk.src = scriptUrl;
    sdk.onload = function () {
      if (!window.Asc || !window.Asc.plugin) {status("图表插件接口不可用，请从文档编辑器内部打开。", true); return;}
      window.Asc.plugin.init = function () {
        document.dispatchEvent(new CustomEvent("paper-studio-editor-ready"));
      };
      window.Asc.plugin.button = function () {window.Asc.plugin.executeCommand("close", "");};
      window.Asc.plugin.onThemeChanged = function () {};
      core.startSdkHandshake(window, document.readyState);
    };
    sdk.onerror = function () {status("无法加载文档服务插件接口，请检查 ONLYOFFICE 连接。", true);};
    document.head.appendChild(sdk);
  }

  connect().catch(function (error) {status(error.message, true);});
})();
