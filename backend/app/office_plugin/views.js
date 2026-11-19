/* 视图切换：公式 / AI 润色 / 科研图表。切换时收起非当前视图与公式专用操作条。 */
(function () {
  "use strict";
  function switchTo(id) {
    document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.id !== id; });
    document.querySelectorAll(".view-tab").forEach(function (t) { t.classList.toggle("active", t.dataset.view === id); });
    var footer = document.querySelector("footer.action-bar");
    if (footer) footer.hidden = id !== "view-formula";
    document.dispatchEvent(new CustomEvent("struct-view-changed", { detail: id }));
  }
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".view-tab").forEach(function (t) {
      t.addEventListener("click", function () { switchTo(t.dataset.view); });
    });
  });
})();
