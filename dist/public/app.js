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

  /* 官方精选指标（上游 runs.pins）的中文名与说明。
     说明按「讲机制、不打比方」写：说清它度量什么、由什么决定、异常意味着什么。 */
  var METRIC_DEFS = [
    { k: "dynsam/avg@n", zh: "平均通过率", kind: "pct",
      desc: "每道题采样 n 次后答对次数占比，再对所有题取平均。这是主成绩指标：它涨了才说明模型真的变强。单步会抖，要看三五步的趋势。" },
    { k: "critic/rewards/mean", zh: "平均奖励", kind: "num",
      desc: "本步参与训练的所有轨迹的奖励均值。与通过率不同，奖励里可能含长度、格式等 shaping 项，所以它反映判分口径的整体松紧，不完全等同于答对率。" },
    { k: "actor/entropy_loss", zh: "策略熵", kind: "num",
      desc: "策略在生成每个 token 时输出分布的平均熵，度量不确定性。熵高说明输出多样、还在探索；持续下降说明策略在收敛；掉得太快则可能是熵坍缩——输出趋同、丧失探索能力。" },
    { k: "actor/pg_loss", zh: "策略梯度损失", kind: "num",
      desc: "PPO 的裁剪版策略梯度目标。它不追求降到 0：符号和幅度取决于本批 advantage 的分布，所以要看趋势而非绝对值，单独一步的涨跌没有意义。" },
    { k: "actor/grad_norm", zh: "梯度范数", kind: "num",
      desc: "裁剪前的全局梯度范数，用于监控训练稳定性。突然飙升通常意味着一批异常样本或数值不稳；PPO 会按 max_grad_norm 做裁剪兜底，所以不会真的把参数带飞。" },
    { k: "train_infer_diff/new_infer/kl", zh: "推理/训练 KL", kind: "num",
      desc: "同一批序列在推理引擎（vLLM）和训练框架下算出的 log-probs 差异。理想接近 0；偏大说明两侧算子实现或数值精度不一致，会让重要性采样比失真，是异步 RL 必须盯的校准项。" },
    { k: "ctx_total_length/mean", zh: "平均上下文长度", kind: "int",
      desc: "每条轨迹的上下文总长（题目 + 回答），单位 token。attention 的代价是长度的平方级，所以它直接决定显存与耗时，悄悄上涨就等于成本在涨。" },
    { k: "dynsam/agg_turn/mean", zh: "平均交互轮数", kind: "num",
      desc: "每条轨迹里 agent 与环境的平均交互轮数（一次工具调用或一次环境反馈算一轮）。轮数越多，单条轨迹要生成的 token 越多，rollout 越慢。" },
    { k: "perf/total_num_tokens", zh: "本步训练 token 量", kind: "big",
      desc: "这一步实际参与训练的 token 总数，与算力开销近似成正比，是账单的主要来源。它和上下文长度、题数、采样次数三者相乘的结果相关。" },
    { k: "timing_s/step", zh: "单步总耗时", kind: "sec",
      desc: "一个训练步的墙钟时间。等于生成耗时 + 训练耗时 + 判分与数据搬运，通常几小时，所以看板上几个小时没动静是正常的。" },
    { k: "timing_s/outer_gen", zh: "生成阶段耗时", kind: "sec",
      desc: "rollout 阶段的耗时，即让模型大量做题的时间。它通常是单步里最大的一块，因为要逐 token 解码上万条轨迹，无法像训练那样靠大 batch 摊薄。" },
    { k: "timing_s/trainer_ops", zh: "训练阶段耗时", kind: "sec",
      desc: "参数更新阶段的耗时。与生成相比通常更容易被 batch 并行摊薄；如果这块占比异常升高，往往是数据搬运或算子效率出了问题。" },
    { k: "dynsam/passrate/zero", zh: "零分题占比", kind: "pct",
      desc: "n 次采样全部答错的题占比。这类题在 GRPO 里组内方差为 0，advantage 恒为 0，梯度为零——算力花了但参数没动，动态采样会尽量过滤掉它们。" },
    { k: "dynsam/passrate/one", zh: "满分题占比", kind: "pct",
      desc: "n 次采样全部答对的题占比。模型早就会了，同样产生不了有效梯度。零分率与满分率一起看：两者越高，说明有效样本越少、浪费的算力越多。" },
    { k: "dynsam/infra_error/seq_rate", zh: "基础设施故障率", kind: "pct",
      desc: "因沙箱崩溃、判分超时等基础设施问题而作废的序列占比。这不是模型的错，但会污染统计数据，所以工程上要剔除后再算通过率。" },
    { k: "env/active", zh: "活跃沙箱数", kind: "int",
      desc: "同时在跑的沙箱环境数量，反映 rollout 的并发规模。它是「生成是吞吐瓶颈」最直观的证据：几万个环境在并行解码。" },
    { k: "partial/avg_staleness", zh: "平均策略陈旧度", kind: "num",
      desc: "生成样本时用的策略版本与训练时当前版本相差多少代。异步 RL 为了不让生成等训练，会用略旧的权重采样，代价就是这个偏移；TIS 截断重要性采样正是用来校正它的。" },
    { k: "dynsam/num_measurable", zh: "可测量题数", kind: "int",
      desc: "本步真正拿到有效通过率的题目数量（排除基础设施失败等无效样本）。它比总题数更能反映这一步训练实际用了多少有效样本。" },
  ];
  var METRIC_BY_KEY = {};
  METRIC_DEFS.forEach(function (d) { METRIC_BY_KEY[d.k] = d; });

  /* 按指标量级选择合适的精度，避免 0.0055 显示成 0.01、108418 显示成 108418.000 */
  function fmtMetric(v, kind) {
    if (v == null || isNaN(v)) return "--";
    var a = Math.abs(v);
    if (kind === "pct") return (v * 100).toFixed(1) + "%";
    if (kind === "int") return int(v);
    if (kind === "big") return big(v);
    if (kind === "sec") {
      if (a >= 3600) return (v / 3600).toFixed(1) + " h";
      if (a >= 60) return (v / 60).toFixed(0) + " min";
      return v.toFixed(0) + " s";
    }
    if (a >= 100) return v.toFixed(0);
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.1) return v.toFixed(3);
    if (a >= 0.001) return v.toFixed(4);
    if (a === 0) return "0";
    return v.toExponential(1);
  }

  var state = {
    meta: null,
    status: {},
    live: {},
    bench: [],
    notices: [],
    series: {},
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
        // 指标序列：按上游 pins 一次批量拉齐，两个 run 各一次请求
        var pins = (state.meta && state.meta.pins) || [];
        if (!pins.length) return;
        var tags = encodeURIComponent(pins.join(","));
        return Promise.all(runs.map(function (k) {
          return getJSON("api/series?run=" + k + "&tags=" + tags)
            .then(function (s) { state.series[k] = s; })
            .catch(function () {});
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
    // minimal：小卡片里用的紧凑模式，去掉坐标文字与刻度，留白收到最小
    var minimal = !!opt.minimal;
    var W = opt.width || 1000, H = opt.height || 240;
    var padL = minimal ? 8 : 54, padR = minimal ? 8 : 18;
    var padT = minimal ? 8 : 14, padB = minimal ? 8 : 28;
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
    var nGrid = minimal ? 2 : 4;
    for (var i = 0; i <= nGrid; i++) {
      var v = yMin + ((yMax - yMin) * i) / nGrid;
      var y = sy(v);
      svg += '<line class="grid-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"/>';
      if (!minimal) {
        svg += '<text class="axis-text" x="' + (padL - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + esc(opt.yFmt ? opt.yFmt(v) : v.toFixed(3)) + "</text>";
      }
    }

    // x ticks
    if (!minimal) {
      var ticks = Math.min(6, Math.max(2, Math.round((W - padL - padR) / 130)));
      for (var t = 0; t <= ticks; t++) {
        var xv = xMin + ((xMax - xMin) * t) / ticks;
        var xx = sx(xv);
        svg += '<text class="axis-text" x="' + xx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(opt.xFmt ? opt.xFmt(xv) : String(Math.round(xv))) + "</text>";
      }
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
        svg += '<circle class="pt" cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="' + (minimal ? 3.5 : 3) + '" fill="' + s.color + '"><title>' +
               esc(s.name + " · step " + p.x + " · " + (opt.tipFmt ? opt.tipFmt(p.y) : p.y)) + "</title></circle>";
      });
      var last = s.pts[s.pts.length - 1];
      svg += '<circle cx="' + sx(last.x).toFixed(1) + '" cy="' + sy(last.y).toFixed(1) + '" r="' + (minimal ? 5 : 4.5) + '" fill="' + s.color + '" stroke="var(--panel)" stroke-width="2"/>';
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

  /* ---------------- 训练指标全景（官方 pins 精选） ---------------- */
  function metricSeries(key) {
    var runs = (state.meta && state.meta.runs) || [];
    var out = [];
    runs.forEach(function (r) {
      var s = state.series[r.key];
      if (!s || !s.series) return;
      var arr = s.series[key];
      if (!Array.isArray(arr)) return;
      var steps = s.steps || [];
      var pts = [];
      for (var i = 0; i < arr.length; i++) {
        var v = arr[i];
        if (v == null || typeof v !== "number" || isNaN(v)) continue;
        pts.push({ x: steps[i] != null ? steps[i] : i + 1, y: v });
      }
      if (pts.length) out.push({ name: r.label || r.key, color: COLORS[r.key] || "#8892a6", pts: pts });
    });
    return out;
  }

  function renderMetrics() {
    var host = $("metric-grid");
    if (!host) return;
    var pins = (state.meta && state.meta.pins) || [];
    var list = pins.filter(function (k) { return METRIC_BY_KEY[k]; });
    if (!list.length) list = METRIC_DEFS.map(function (d) { return d.k; });

    var built = list.map(function (k) { return { def: METRIC_BY_KEY[k], series: metricSeries(k) }; })
                    .filter(function (it) { return it.series.length; });

    if (!built.length) {
      host.innerHTML = '<div class="empty">指标数据加载中…</div>';
      return;
    }

    host.innerHTML = built.map(function (it, i) {
      var d = it.def;
      var vals = it.series.map(function (s) {
        var last = s.pts[s.pts.length - 1].y;
        var prev = s.pts.length > 1 ? s.pts[s.pts.length - 2].y : null;
        var delta = prev == null ? null : last - prev;
        var cls = delta == null ? "" : delta > 0 ? "up" : delta < 0 ? "down" : "";
        return '<div class="m-val"><i class="swatch" style="background:' + s.color + '"></i>' +
               '<span class="m-num">' + esc(fmtMetric(last, d.kind)) + "</span>" +
               (delta == null ? "" : '<span class="m-delta ' + cls + '">' +
                 (delta > 0 ? "+" : "") + esc(fmtMetric(delta, d.kind)) + "</span>") +
               "</div>";
      }).join("");
      return '<div class="metric-card">' +
             '<div class="m-head"><span class="m-zh">' + esc(d.zh) + "</span>" +
             '<span class="m-key mono">' + esc(d.k) + "</span></div>" +
             '<div class="m-vals">' + vals + "</div>" +
             '<div class="m-chart" data-mi="' + i + '"></div>' +
             '<div class="m-desc" title="' + esc(d.desc) + '">' + esc(d.desc) + "</div>" +
             "</div>";
    }).join("");

    Array.prototype.forEach.call(host.querySelectorAll(".m-chart"), function (el) {
      var it = built[+el.dataset.mi];
      if (!it) return;
      lineChart(el, it.series, {
        minimal: true, width: 340, height: 120,
        tipFmt: function (v) { return fmtMetric(v, it.def.kind); },
      });
    });
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
    renderMetrics();
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
