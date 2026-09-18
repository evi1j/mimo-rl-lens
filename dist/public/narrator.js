/* mimo-train-live — 实时解说栏（渲染层）
   解说内容由服务端持续生成并落盘（/api/narrator），刷新页面不丢历史。
   本文件只负责取数 + 渲染，规则都在 narrator-core.js 里。 */
(function () {
  "use strict";

  var lastFetch = 0;
  var MIN_GAP = 4000;
  var inflight = false;

  /* 展开状态按条目 id 记住 —— 解说流每 15 秒重建一次 innerHTML，
     不记住的话用户刚展开的条目会被重新渲染成收起状态。
     存到 localStorage，这样连刷新页面都能保住。 */
  var LS_KEY = "mtl.narrator.expanded";
  var expanded = {};
  try { expanded = JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch (e) { expanded = {}; }
  function saveExpanded() {
    try {
      // 只保留最近 120 条记录，别让它无限增长
      var keys = Object.keys(expanded);
      if (keys.length > 120) {
        var trimmed = {};
        keys.slice(-120).forEach(function (k) { trimmed[k] = expanded[k]; });
        expanded = trimmed;
      }
      localStorage.setItem(LS_KEY, JSON.stringify(expanded));
    } catch (e) {}
  }
  var lastSig = "";

  function itemKey(it) {
    return String(it.id != null ? it.id : (it.ts + "|" + it.text));
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function hhmm(ts) {
    var d = new Date(ts * 1000);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function money(n) {
    if (n == null) return "--";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    return "$" + Math.round(n / 1e3) + "K";
  }

  function renderNow(items) {
    var host = document.getElementById("nar-now");
    if (!host) return;
    if (!items || !items.length) { host.innerHTML = '<div class="empty">等待服务端数据…</div>'; return; }
    var html = "<h3>此刻正在发生</h3>";
    items.forEach(function (r) {
      var txt = "<b>" + esc(r.label) + "</b> 跑到第 " + (r.step != null ? r.step : "--") + " 步，" + esc(r.phase);
      if (r.progress != null) txt += "，本步完成 " + (r.progress * 100).toFixed(1) + "%";
      txt += "。";
      if (r.value != null) txt += " 当前成绩 <b>" + r.value.toFixed(4) + "</b>。";
      if (r.judgedPct != null) txt += " 本步答案已判完 " + r.judgedPct + "%。";
      txt += " 累计花费 <b>" + money(r.cost) + "</b>。";
      html += '<div class="nar-run"><span class="nar-dot" style="background:' + esc(r.color || "#888") + '"></span><div>' + txt + "</div></div>";
    });
    host.innerHTML = html;
  }

  function renderAIState(ai) {
    var host = document.getElementById("ai-state");
    if (!host) return;
    if (!ai) { host.innerHTML = ""; return; }
    var dot, txt, cls;
    if (!ai.enabled) {
      cls = "off"; dot = "●";
      txt = "AI 解说未开启 · 当前全部由固定规则生成";
    } else if (ai.ok) {
      cls = "on"; dot = "●";
      txt = "AI 解说已接入 " + esc(ai.model || "") + (ai.generated ? " · 已生成 " + ai.generated + " 条" : "");
    } else {
      cls = "err"; dot = "●";
      txt = "AI 连接失败，已回退规则：" + esc(ai.lastError || "未知原因");
    }
    host.className = "ai-state " + cls;
    host.innerHTML = '<span class="ai-dot"></span>' + txt;
  }

  var CTX_LABEL = {
    step: "步数", value: "成绩", phase: "阶段", passrate: "通过率",
    pr0: "零分率", pr1: "满分率", restarts: "重启次数", cost: "累计花费",
  };
  var PHASE_ZH = { rollout: "生成（让模型做题）", training: "训练（改模型）" };

  function fmtVal(k, v) {
    if (v == null) return "--";
    if (k === "cost") return money(v);
    if (k === "pr0" || k === "pr1" || k === "passrate") return (v * 100).toFixed(1) + "%";
    if (k === "value") return v.toFixed(4);
    if (k === "phase") return PHASE_ZH[v] || v;
    return String(v);
  }

  /* 折叠区：AI 写的教学段落 + 这次事件背后的原始数值 */
  function buildExtra(it) {
    var out = "";
    if (it.lesson) out += '<p class="nar-lesson-p">' + esc(it.lesson) + "</p>";
    var c = it.ctx;
    if (c && c.before && c.after) {
      var rows = "";
      ["step", "value", "phase", "passrate", "pr0", "pr1", "restarts", "cost"].forEach(function (k) {
        var a = c.before[k], b = c.after[k];
        if (a == null && b == null) return;
        if (String(a) === String(b)) return; // 只列真正变了的
        rows += '<div class="nar-ctx-row"><span>' + (CTX_LABEL[k] || k) + "</span><span>" +
          fmtVal(k, a) + " → <b>" + fmtVal(k, b) + "</b></span></div>";
      });
      if (rows) out += '<div class="nar-ctx"><div class="nar-ctx-t">这次的原始数据</div>' + rows + "</div>";
    }
    return out;
  }

  /* 逐个按钮绑定。解说流每 15 秒重建一次 innerHTML，所以每次渲染后要重新绑。 */
  function bindToggles(host) {
    var btns = host.querySelectorAll(".nar-more");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var box = this.nextElementSibling;
        if (!box || !box.classList || !box.classList.contains("nar-lesson")) {
          var item = this.closest(".nar-item");
          box = item ? item.querySelector(".nar-lesson") : null;
        }
        if (!box) return;
        var key = this.getAttribute("data-key");
        if (box.hasAttribute("hidden")) {
          box.removeAttribute("hidden");
          this.setAttribute("aria-expanded", "true");
          this.textContent = "收起 ▴";
          if (key) { expanded[key] = true; saveExpanded(); }
        } else {
          box.setAttribute("hidden", "");
          this.setAttribute("aria-expanded", "false");
          this.textContent = "展开讲讲 ▾";
          if (key) { delete expanded[key]; saveExpanded(); }
        }
      });
    }
  }

  function renderFeed(list, force) {
    var host = document.getElementById("nar-feed");
    if (!host) return;
    if (!list || !list.length) { host.innerHTML = '<div class="empty">正在观察，有变化就会记录…</div>'; lastSig = ""; return; }

    // 内容没变就不重绘，避免每 15 秒闪一下、也避免打断正在阅读的状态
    var sig = JSON.stringify(list);
    if (!force && sig === lastSig) return;
    lastSig = sig;

    var C = (window.MTLNarratorCore && window.MTLNarratorCore.RUN_COLOR) || { pro: "#5b9dff", flash: "#ffab3d" };
    host.innerHTML = list.slice(0, 60).map(function (it) {
      var key = itemKey(it);
      var open = !!expanded[key];
      var tag = it.run
        ? '<span style="color:' + (C[it.run] || "#888") + ';font-weight:600">' + esc(it.run) + "</span>"
        : it.official ? '<span class="dim">官方公告</span>' : '<span class="dim">看板</span>';
      var aiTag = it.ai
        ? '<span class="nar-ai" title="由本地 AI 生成' + (it.aiModel ? "（" + esc(it.aiModel) + "）" : "") + '">AI</span>'
        : '<span class="nar-rule" title="由固定规则模板生成，非 AI">规则</span>';
      var extra = buildExtra(it);
      // 按钮与折叠区必须是相邻兄弟：点击逻辑用 nextElementSibling 定位
      var more = extra
        ? '<button class="nar-more" type="button" data-key="' + esc(key) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
          (open ? "收起 ▴" : "展开讲讲 ▾") + "</button>" +
          '<div class="nar-lesson"' + (open ? "" : " hidden") + ">" + extra + "</div>"
        : "";
      return '<div class="nar-item ' + esc(it.level || "info") + '">' +
        '<div class="nar-t">' + tag + "<span>" + aiTag + "<span>" + hhmm(it.ts) + "</span></span></div>" +
        "<div>" + esc(it.text) + "</div>" +
        (it.why ? '<span class="nar-why">' + esc(it.why) + "</span>" : "") +
        more +
        "</div>";
    }).join("");
    bindToggles(host);
  }

  var searchQ = "";
  var searchTimer = null;

  function renderStat(s) {
    var host = document.getElementById("nar-dbstat");
    if (!host) return;
    if (!s || !s.enabled) { host.innerHTML = ""; return; }
    var txt = "本地存档：指标 " + (s.metrics || 0) + " 条 · 解说 " + (s.narrator || 0) + " 条 · " +
      ((s.sizeBytes || 0) / 1024).toFixed(0) + " KB";
    if (s.error) txt += "（" + esc(s.error) + "）";
    host.innerHTML = '<a href="api/history.csv" target="_blank" rel="noopener" title="导出全部指标为 CSV">导出 CSV</a>' +
      "<span>" + txt + "</span>";
  }

  function fetchStat() {
    fetch("api/db/stats", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) renderStat(j); })
      .catch(function () {});
  }

  function fetchSearch(q) {
    fetch("api/search?q=" + encodeURIComponent(q) + "&limit=60", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (j) {
        renderFeed(j.items || [], true);
        lastSig = ""; // 搜索结果不参与"内容没变就不重绘"的判断
      })
      .catch(function () {});
  }

  function fetchLog(force) {
    if (inflight) return;
    var now = Date.now();
    if (!force && now - lastFetch < MIN_GAP) return;
    lastFetch = now;
    inflight = true;
    fetch("api/narrator", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) {
        renderNow(j.now);
        renderAIState(j.ai);
        if (searchQ) return; // 搜索时不动解说流，免得结果被冲掉
        renderFeed(j.items);
      })
      .catch(function () {
        var host = document.getElementById("nar-feed");
        if (host && !host.dataset.warned) {
          host.dataset.warned = "1";
          host.innerHTML = '<div class="empty">解说服务未响应，请确认 node server.js 是最新版本。</div>';
        }
      })
      .then(function () { inflight = false; });
  }

  window.MTLNarrator = { update: function () { fetchLog(false); } };

  function bindSearch() {
    var input = document.getElementById("nar-search");
    var clear = document.getElementById("nar-clear");
    if (!input) return;
    input.addEventListener("input", function () {
      var q = (input.value || "").trim();
      if (clear) clear.hidden = !q;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchQ = q;
        if (!q) { lastSig = ""; fetchLog(true); return; }
        fetchSearch(q);
      }, 300);
    });
    if (clear) {
      clear.addEventListener("click", function () {
        input.value = "";
        clear.hidden = true;
        searchQ = "";
        lastSig = "";
        fetchLog(true);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    fetchLog(true);
    fetchStat();
    bindSearch();
    setInterval(function () { fetchLog(true); }, 15000);
    setInterval(fetchStat, 60000);
  });
})();
