/* mimo-train-live — 前端看板
   数据全部来自本地代理 /api/* -> https://mimo.xiaomi.com/rl/ */
(function () {
  "use strict";

  if (location.protocol === "file:") {
    document.addEventListener("DOMContentLoaded", function () {
      document.body.innerHTML =
        '<div style="max-width:620px;margin:72px auto;padding:28px 32px;' +
        'font-family:system-ui,-apple-system,\'PingFang SC\',sans-serif;line-height:1.75;color:#222">' +
        '<h2 style="margin:0 0 14px;font-size:18px">请通过本地服务打开，不要直接双击 HTML 文件</h2>' +
        '<p style="margin:0 0 12px">这个看板的数据要靠一个本地 Node 服务去拉小米的实时接口。' +
        '直接打开文件时它跑不起来，所以显示连接失败。</p>' +
        '<p style="margin:0 0 8px">两种启动方式，任选一个：</p>' +
        '<p style="margin:0 0 8px"><b>方式一（推荐）：双击项目里的 start.command</b></p>' +
        '<p style="margin:0 0 12px">方式二：在终端执行下面两行</p>' +
        '<pre style="margin:0;padding:12px 16px;background:#f3f3f3;border-radius:8px;' +
        'font-size:13px;overflow:auto">cd mimo-train-live\nnode server.js</pre>' +
        '<p style="margin:12px 0 0">然后浏览器访问 <b>http://127.0.0.1:8787</b></p>' +
        '</div>';
    });
    return;
  }

  var REFRESH_MS = 10000;
  var COLORS = { pro: "#5b9dff", flash: "#ffab3d" };
  var CAT_LABEL = { code: "代码", general: "通用", cyber: "网络安全", visual: "视觉", chat: "对话" };

  var state = {
    meta: null,
    status: {},
    live: {},
    bench: [],
    notices: [],
    lastOk: 0,
    evRun: "pro",
    dsRun: "pro",
    ok: false,
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- formatting ---------------- */
  function big(n) {
    if (n == null || isNaN(n)) return "--";
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }
  function int(n) {
    if (n == null || isNaN(n)) return "--";
    return Math.round(n).toLocaleString("en-US");
  }
  function money(n) {
    if (n == null || isNaN(n)) return "--";
    if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + n.toFixed(0);
  }
  function pct(n, d) { return n == null ? "--" : (n * 100).toFixed(d == null ? 1 : d) + "%"; }
  function dur(s) {
    if (s == null || isNaN(s) || s < 0) return "--";
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + "h " + m + "m";
    return m + "m " + Math.floor(s % 60) + "s";
  }
  function clock(ts) {
    var d = new Date(ts * 1000);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function ago(ts) {
    var s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return Math.floor(s) + " 秒前";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    return Math.floor(s / 86400) + " 天前";
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------------- fetch ---------------- */
  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(r.status + " " + url);
      return r.json();
    }).then(function (j) {
      if (j && j.error) throw new Error(j.error);
      return j;
    });
  }

  function loadAll() {
    var runs;
    return getJSON("api/runs")
      .then(function (m) {
        state.meta = m;
        runs = (m.runs || []).map(function (r) { return r.key; });
        return Promise.all(runs.map(function (k) {
          return Promise.all([
            getJSON("api/status?run=" + k),
            getJSON("api/live?run=" + k).catch(function () { return null; }),
          ]).then(function (pair) {
            state.status[k] = pair[0];
            state.live[k] = pair[1];
          });
        }));
      })
      .then(function () {
        return Promise.all([
          getJSON("api/benchmarks").then(function (b) { state.bench = b.benchmarks || []; }).catch(function () {}),
          getJSON("api/notices").then(function (n) { state.notices = n.notices || []; }).catch(function () {}),
        ]);
      })
      .then(function () {
        state.ok = true;
        state.lastOk = Date.now();
        render();
        setLive(true);
      })
      .catch(function (err) {
        var msg = String(err && err.message ? err.message : err);
        if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
          msg = "本地服务未运行 — 在项目目录执行 node server.js 后访问 http://127.0.0.1:8787";
        }
        setLive(false, msg);
        if (!state.ok) render();
      });
  }

  function setLive(ok, msg) {
    var chip = $("live-chip"), txt = $("live-text"), dot = chip.querySelector(".pulse");
    if (ok) {
      txt.textContent = "实时 · " + REFRESH_MS / 1000 + "s";
      dot.classList.remove("is-stale");
    } else {
      txt.textContent = "连接失败";
      dot.classList.add("is-stale");
      toast("上游数据获取失败：" + msg, true);
    }
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast"; }, 4000);
  }

  /* ---------------- line chart (SVG) ---------------- */
  function lineChart(host, series, opt) {
    opt = opt || {};
    var W = 1000, H = opt.height || 240;
    var padL = 54, padR = 18, padT = 14, padB = 28;
    var all = [];
    series.forEach(function (s) { s.pts.forEach(function (p) { all.push(p); }); });
    if (!all.length) { host.innerHTML = '<div class="empty">暂无数据</div>'; return; }

    var xs = all.map(function (p) { return p.x; }), ys = all.map(function (p) { return p.y; });
    var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
    var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
    if (opt.yMin != null) yMin = opt.yMin;
    var pad = (yMax - yMin) * 0.16 || Math.abs(yMax) * 0.05 || 0.01;
    yMax += pad; yMin -= pad;
    if (yMax === yMin) { yMax += 0.01; yMin -= 0.01; }
    if (xMax === xMin) xMax = xMin + 1;

    var sx = function (v) { return padL + ((v - xMin) / (xMax - xMin)) * (W - padL - padR); };
    var sy = function (v) { return padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB); };

    var gid = "g" + Math.random().toString(36).slice(2, 8);
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet" role="img">';

    // y grid
    var nGrid = 4;
    for (var i = 0; i <= nGrid; i++) {
      var v = yMin + ((yMax - yMin) * i) / nGrid;
      var y = sy(v);
      svg += '<line class="grid-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"/>';
      svg += '<text class="axis-text" x="' + (padL - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + esc(opt.yFmt ? opt.yFmt(v) : v.toFixed(3)) + "</text>";
    }

    // x ticks
    var ticks = Math.min(6, Math.max(2, Math.round((W - padL - padR) / 130)));
    for (var t = 0; t <= ticks; t++) {
      var xv = xMin + ((xMax - xMin) * t) / ticks;
      var xx = sx(xv);
      svg += '<text class="axis-text" x="' + xx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(opt.xFmt ? opt.xFmt(xv) : String(Math.round(xv))) + "</text>";
    }

    // series
    series.forEach(function (s, si) {
      if (!s.pts.length) return;
      var d = s.pts.map(function (p, i) { return (i ? "L" : "M") + sx(p.x).toFixed(1) + " " + sy(p.y).toFixed(1); }).join(" ");
      var area = d + " L" + sx(s.pts[s.pts.length - 1].x).toFixed(1) + " " + (H - padB) + " L" + sx(s.pts[0].x).toFixed(1) + " " + (H - padB) + " Z";
      svg += '<defs><linearGradient id="' + gid + si + '" x1="0" y1="0" x2="0" y2="1">' +
             '<stop offset="0%" stop-color="' + s.color + '" stop-opacity="0.20"/>' +
             '<stop offset="100%" stop-color="' + s.color + '" stop-opacity="0"/></linearGradient></defs>';
      svg += '<path d="' + area + '" fill="url(#' + gid + si + ')"/>';
      svg += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      s.pts.forEach(function (p) {
        svg += '<circle class="pt" cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="3" fill="' + s.color + '"><title>' +
               esc(s.name + " · step " + p.x + " · " + (opt.tipFmt ? opt.tipFmt(p.y) : p.y)) + "</title></circle>";
      });
      var last = s.pts[s.pts.length - 1];
      svg += '<circle cx="' + sx(last.x).toFixed(1) + '" cy="' + sy(last.y).toFixed(1) + '" r="4.5" fill="' + s.color + '" stroke="var(--panel)" stroke-width="2"/>';
    });

    svg += "</svg>";
    host.innerHTML = svg;
  }

  /* ---------------- render ---------------- */
  function stepPoints(key) {
    var s = state.status[key];
    if (!s || !s.events) return [];
    var map = {};
    s.events.forEach(function (e) { if (e.kind === "step" && e.step != null) map[e.step] = e.value; });
    return Object.keys(map).map(Number).sort(function (a, b) { return a - b; }).map(function (k) {
      return { x: k, y: map[k] };
    });
  }

  function renderRuns() {
    var runs = (state.meta && state.meta.runs) || [];
    var host = $("runs");
    var html = "";

    runs.forEach(function (r) {
      var key = r.key;
      var st = state.status[key];
      var lv = state.live[key] && state.live[key].latest;
      var color = COLORS[key] || "#5b9dff";

      if (!st) {
        html += '<div class="skeleton-card"></div>';
        return;
      }

      var sp = st.step || {}, tot = st.totals || {}, cost = st.cost || {}, hl = st.headline || {};
      var delta = hl.last != null && hl.prev != null ? hl.last - hl.prev : null;
      var dCls = delta == null ? "" : delta >= 0 ? "up" : "down";
      var dSign = delta == null ? "" : delta >= 0 ? "▲ +" : "▼ ";
      var remain = sp.expected != null && sp.since != null ? Math.max(0, sp.expected - sp.since) : null;

      var judgedPct = lv && lv.judged_of ? (lv.judged / lv.judged_of) : null;

      html += '<article class="run-card" style="--rc:' + color + '">' +
        '<div class="rc-head">' +
          '<div class="rc-name"><span class="rc-dot"></span>' + esc(r.label || key) + "</div>" +
          '<span class="badge ' + (st.run.mode === "live" ? "live" : "ended") + '">' + esc(st.run.mode || "--") + "</span>" +
        "</div>" +
        '<div class="rc-hero">' +
          '<div class="rc-step"><b>' + (sp.last != null ? sp.last : "--") + "</b><span>step</span></div>" +
          '<div class="rc-score">' +
            "<b>" + (hl.last != null ? hl.last.toFixed(4) : "--") + "</b>" +
            '<div class="rc-delta ' + dCls + '">' + (delta == null ? "" : dSign + delta.toFixed(4)) + "</div>" +
            "<small>avg@n</small>" +
          "</div>" +
        "</div>" +
        '<div class="rc-prog">' +
          '<div class="rc-prog-top"><span>' + esc(sp.phase || "--") + " 阶段</span><span>" + pct(sp.progress, 1) + (remain != null ? " · 剩余 " + dur(remain) : "") + "</span></div>" +
          '<div class="bar"><i style="width:' + ((sp.progress || 0) * 100).toFixed(1) + '%"></i></div>' +
        "</div>" +
        '<dl class="rc-grid">' +
          cell("tokens/步", big(tot.tokens_step)) +
          cell("累计 tokens", big(tot.tokens_cum)) +
          cell("已训练样本", int(tot.trained_cum)) +
          cell("沙箱调用", big(tot.sandboxes_cum)) +
          cell("prompts/步", int(tot.prompts_per_step)) +
          cell("重启次数", tot.restarts != null ? tot.restarts : "--") +
          cell("花费速率", money((cost.rate_per_s || 0) * 3600) + "<small>/h</small>") +
          cell("累计花费", money(cost.so_far)) +
        "</dl>" +
        (lv ? (
          '<div class="rc-roll">' +
            '<div class="rc-roll-title"><span>本步采样判定</span><span>' + int(lv.judged) + " / " + int(lv.judged_of) + "</span></div>" +
            '<div class="bar thin"><i style="width:' + ((judgedPct || 0) * 100).toFixed(1) + '%"></i></div>' +
            '<div class="rc-roll-stats">' +
              "<span>通过率 <b>" + pct(lv.passrate, 1) + "</b></span>" +
              "<span>零分率 <b>" + pct(lv.pr0, 1) + "</b></span>" +
              "<span>满分率 <b>" + pct(lv.pr1, 1) + "</b></span>" +
              "<span>已接受 <b>" + int(lv.accept) + "</b></span>" +
              "<span>进行中 <b>" + int(lv.working) + "</b></span>" +
              "<span>待处理 <b>" + int(lv.remain) + "</b></span>" +
            "</div>" +
          "</div>"
        ) : "") +
        "</article>";
    });

    host.innerHTML = html;
  }

  function cell(label, value) {
    return '<div class="rc-cell"><dt>' + esc(label) + "</dt><dd>" + value + "</dd></div>";
  }

  function renderHeadline() {
    var runs = (state.meta && state.meta.runs) || [];
    var series = runs.map(function (r) {
      return { name: r.label || r.key, color: COLORS[r.key] || "#5b9dff", pts: stepPoints(r.key) };
    }).filter(function (s) { return s.pts.length; });

    lineChart($("chart-headline"), series, {
      height: 250,
      yFmt: function (v) { return v.toFixed(3); },
      xFmt: function (v) { return "s" + Math.round(v); },
      tipFmt: function (v) { return v.toFixed(4); },
    });

    $("legend-headline").innerHTML = series.map(function (s) {
      var last = s.pts[s.pts.length - 1];
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + " · " + last.y.toFixed(4) + " @ step " + last.x + "</span>";
    }).join("");
  }

  function renderBench() {
    var host = $("chart-bench");
    var b = state.bench && state.bench[0];
    if (!b) { host.innerHTML = '<div class="empty">暂无评测数据</div>'; return; }

    var series = Object.keys(b.results).map(function (k) {
      var pts = Object.keys(b.results[k]).map(Number).sort(function (a, c) { return a - c; }).map(function (s) {
        return { x: s, y: b.results[k][s] };
      });
      return { name: "mimo-v2.6-" + k, color: COLORS[k] || "#888", pts: pts };
    });

    lineChart(host, series, {
      height: 230,
      yFmt: function (v) { return v.toFixed(1); },
      xFmt: function (v) { return "s" + Math.round(v); },
      tipFmt: function (v) { return v.toFixed(2); },
    });

    $("legend-bench").innerHTML = series.map(function (s) {
      var last = s.pts[s.pts.length - 1];
      var best = s.pts.reduce(function (a, p) { return Math.max(a, p.y); }, -Infinity);
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + " · 最新 " + last.y.toFixed(2) + " · 峰值 " + best.toFixed(2) + "</span>";
    }).join("");
  }

  function renderNotices() {
    var host = $("notices");
    if (!state.notices.length) { host.innerHTML = '<div class="empty">暂无公告</div>'; return; }
    host.innerHTML = state.notices.map(function (n) {
      return '<div class="item"><div class="item-time mono">' + clock(n.t) + "</div>" +
             '<div class="item-body">' + esc(n.text) +
             '<span class="item-note">' + ago(n.t) + "</span></div></div>";
    }).join("");
  }

  function renderEvents() {
    var host = $("events");
    var st = state.status[state.evRun];
    if (!st || !st.events) { host.innerHTML = '<div class="empty">暂无事件</div>'; return; }
    var evs = st.events.slice().reverse().slice(0, 40);
    host.innerHTML = evs.map(function (e) {
      if (e.kind === "restart") {
        return '<div class="ev restart"><span class="ev-step">重启</span>' +
               '<span class="dim">运行中断并恢复</span>' +
               '<span class="ev-d mono dim">' + clock(e.t) + "</span></div>";
      }
      var d = e.delta;
      var cls = d == null ? "" : d >= 0 ? "up" : "down";
      return '<div class="ev"><span class="ev-step mono">step ' + e.step + "</span>" +
             '<span class="mono">' + (e.value != null ? e.value.toFixed(4) : "--") + "</span>" +
             (e.tokens ? '<span class="dim mono">' + big(e.tokens) + " tok</span>" : "") +
             '<span class="ev-d mono ' + cls + '">' + (d == null ? "" : (d >= 0 ? "+" : "") + d.toFixed(4)) + "</span></div>";
    }).join("");
  }

  function renderDs() {
    var host = $("ds-grid");
    var lv = state.live[state.dsRun] && state.live[state.dsRun].latest;
    if (!lv || !lv.ds) { host.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    var agg = {};
    Object.keys(lv.ds).forEach(function (k) {
      var cat = k.split("/")[0];
      if (!agg[cat]) agg[cat] = { n: 0, sum: 0 };
      agg[cat].n++;
      var v = lv.ds[k];
      if (Array.isArray(v) && typeof v[0] === "number") agg[cat].sum += v[0];
    });
    var order = ["code", "general", "cyber", "visual", "chat"];
    var cats = Object.keys(agg).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    host.innerHTML = cats.map(function (c) {
      return '<div class="ds-card"><div class="ds-cat">' + esc(CAT_LABEL[c] || c) + "</div>" +
             '<div class="ds-num">' + agg[c].n + "</div>" +
             '<div class="ds-sub">数据集 · ' + int(agg[c].sum) + " 采样</div></div>";
    }).join("");
  }

  function render() {
    if (!state.ok) {
      $("runs").innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
      return;
    }
    var m = state.meta || {};
    $("brand-sub").textContent = m.subtitle || "读取 trainer 日志中";
    renderRuns();
    renderHeadline();
    renderBench();
    renderNotices();
    renderEvents();
    renderDs();
    $("updated").textContent = "更新 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    if (m.stream_start) {
      var d = new Date(m.stream_start * 1000);
      $("foot-stream").textContent = "stream since " + d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    }
    if (m.social && m.social.url) {
      $("foot-src").innerHTML = '数据源：<a href="' + esc(m.social.url) + '" target="_blank" rel="noopener">mimo.xiaomi.com/rl</a> · 官方 trainer 日志';
    }
    if (window.MTLNarrator) {
      try { window.MTLNarrator.update(state); } catch (e) {}
    }
  }

  /* ---------------- interactions ---------------- */
  function bindSeg(id, get, set) {
    var box = $(id);
    box.addEventListener("click", function (e) {
      var btn = e.target.closest(".seg-btn");
      if (!btn) return;
      Array.prototype.forEach.call(box.querySelectorAll(".seg-btn"), function (b) { b.classList.remove("is-on"); });
      btn.classList.add("is-on");
      set(btn.dataset.run);
      render();
    });
  }

  /* ---------------- boot ---------------- */
  function initTheme() {
    var saved = localStorage.getItem("mtl-theme");
    if (saved) document.documentElement.dataset.theme = saved;
    $("theme-btn").addEventListener("click", function () {
      var cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = cur;
      localStorage.setItem("mtl-theme", cur);
      if (state.ok) { renderHeadline(); renderBench(); }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    bindSeg("run-switch", function () { return state.evRun; }, function (v) { state.evRun = v; });
    bindSeg("ds-run-switch", function () { return state.dsRun; }, function (v) { state.dsRun = v; });
    loadAll();
    setInterval(loadAll, REFRESH_MS);
  });
})();
