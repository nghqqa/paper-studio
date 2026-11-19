(function () {
  "use strict";
  async function connect() {
    var core = window.PaperStudioMath;
    var page = new URL("../index.html", window.location.href).href;
    var sdkUrl = await core.configuredServerScriptUrl(window.fetch.bind(window), page);
    var sdk = document.createElement("script"); sdk.src = sdkUrl;
    sdk.onload = function () {
      if (!window.Asc || !window.Asc.plugin) return;
      window.Asc.plugin.init = function () {
        var command = window.PaperStudioNativeNumbering.numberingCommand;
        window.Asc.plugin.executeMethod("GetVersion", [], function (version) {
          var payload = {action: "install", sdkVersion: version};
          if (window.Editor && typeof window.Editor.RunMacro === "function") {
            window.Editor.RunMacro(command, payload).catch(function (error) {console.warn("公式编号未启用", error.message);});
          } else {
            window.Asc.scope.paperStudioMathPayload = payload;
            window.Asc.plugin.callCommand(command, false, false);
          }
        });
      };
      window.Asc.plugin.button = function () {};
      core.startSdkHandshake(window, document.readyState);
    };
    document.head.appendChild(sdk);
  }
  connect().catch(function (error) {console.warn("公式编号未启用", error.message);});
})();
