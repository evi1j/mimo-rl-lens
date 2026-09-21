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
    series: {},      // 官方 pins 精选指标
    extra: {},       // 按需拉取的其它指标序列（composition / 指标库）
    lastOk: 0,
    evRun: "pro",
    dsRun: "pro",
    ok: false,
    view: "overview",
    tags: [],        // 全部指标名（两个 run 并集）
    tree: null,      // 指标树
    tagPath: "",
    tagQuery: "",
    tagPage: 0,
    compRun: "pro",
    compMode: "count",
    comp: null,
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
  /* 链接上显示的文字由网址自己推导出来（去掉协议和末尾斜杠）。
     之前页脚写死显示「mimo.xiaomi.com/rl」、href 却取上游的 social.url（那是 X 账号），
     点上去跳到 x.com —— 看到的地方和去的地方不是一个。文案跟着 href 走就不会再错。 */
  function hostPath(u) {
    return String(u || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  var SRC_URL = "https://mimo.xiaomi.com/rl/";   // 数据源：看板所有数字都从这里来

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
      .then(function () { return loadTags(runs); })
      .then(function () {
        state.ok = true;
        state.lastOk = Date.now();
        render();
        setLive(true);
        // AI 正在吐字时不要重渲染抽屉，否则会换掉正在写入的节点
        if (glCur && !glAiBusy) renderGlossary(glCur, true);
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

  /* 全部指标名：两个 run 取并集。只在首次拉取，之后靠轮询增量无关
     —— 这列表有 2000 多项，每轮都拉太浪费。 */
  function loadTags(runs) {
    if (state.tagsLoaded) return Promise.resolve();
    return Promise.all(runs.map(function (k) {
      return getJSON("api/tags?run=" + k).then(function (j) { return j.tags || []; }).catch(function () { return []; });
    })).then(function (arr) {
      var set = {};
      arr.forEach(function (a) { a.forEach(function (t) { set[t] = 1; }); });
      state.tags = Object.keys(set).sort();
      state.tree = buildTree(state.tags);
      state.tagsLoaded = true;
      var el = $("tag-count");
      if (el) el.textContent = int(state.tags.length) + " 项";
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

  /* 训练批大小 × 每条 prompt 的采样数：n = 本步训练样本数 ÷ 批内 prompt 数 */
  function batchN(tot) {
    var n = tot.trained_step, p = tot.prompts_per_step;
    if (!n || !p) return "--";
    var r = n / p;
    if (Math.abs(r - Math.round(r)) < 1e-6) return int(p) + ' <small>× ' + Math.round(r) + " 采样</small>";
    return int(p) + ' <small>prompts</small>';
  }
  /* 相对首个训练步的成绩变化，看的是长期趋势而非单步抖动 */
  function sinceFirst(hl) {
    if (hl.last == null || hl.first == null) return "--";
    var d = hl.last - hl.first;
    var cls = d >= 0 ? "up" : "down";
    var txt = (d >= 0 ? "▲ +" : "▼ ") + d.toFixed(4);
    return '<span class="' + cls + '">' + txt + "</span>" +
           '<small>自 step ' + (hl.first_step != null ? hl.first_step : 1) + "</small>";
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
          cell("训练批 × n", batchN(tot)) +
          cell("prompts/步", int(tot.prompts_per_step)) +
          cell("vs 首步", sinceFirst(hl)) +
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

  /* 离线评测基准的中文名与机制说明。
     key 对应 api/benchmarks 里的 key；没有映射时用上游 note 兜底。 */
  var BENCH_INFO = {
    deepswe: {
      zh: "DeepSWE · 真实仓库修 bug",
      desc: "真实开源仓库的 bug 修复题：模型要读懂整个代码库、定位问题、写出能通过单元测试的补丁。" +
            "奖励信号不靠人打分，而是直接用「测试跑不跑得过」判定，这正是可验证奖励的典型形态。",
    },
    "inhouse-coding": {
      zh: "内部编码基准",
      desc: "不外公开的私有题集，用来交叉验证模型不是只在公开榜单上刷分。" +
            "公开基准的题目可能进了预训练语料，分数虚高，私有题集能暴露这种污染。",
    },
    automation: {
      zh: "AutomationBench · 多步自动化任务",
      desc: "自动化类任务：按指令在多步流程里操作环境、调用工具并达成目标，考察的是长程规划与执行。" +
            "与「修一个 bug」这种单点任务互补，两者涨落不同步是正常的。",
    },
  };
  var BENCH_FALLBACK_DESC = "训练过程中定期拿中间存档点跑的离线评测。" +
    "它不参与梯度更新，只是独立的泛化检验——训练分数涨、这里不涨，说明模型在刷训练分布而非真变强。";

  function renderBench() {
    var grid = $("bench-grid");
    if (!grid) return;
    var list = state.bench || [];
    var cnt = $("bench-count");
    if (cnt) cnt.textContent = list.length ? "共 " + list.length + " 个基准" : "";
    if (!list.length) { grid.innerHTML = '<div class="empty">暂无评测数据</div>'; return; }

    var built = list.map(function (b) {
      var info = BENCH_INFO[b.key] || {};
      var series = Object.keys(b.results || {}).map(function (k) {
        var pts = Object.keys(b.results[k]).map(Number).sort(function (a, c) { return a - c; })
                  .map(function (s) { return { x: s, y: b.results[k][s] }; });
        return { name: "mimo-v2.6-" + k, color: COLORS[k] || "#888", pts: pts };
      }).filter(function (s) { return s.pts.length; });
      return { b: b, info: info, series: series };
    }).filter(function (it) { return it.series.length; });

    if (!built.length) { grid.innerHTML = '<div class="empty">暂无评测数据</div>'; return; }

    grid.innerHTML = built.map(function (it, i) {
      var b = it.b;
      var vals = it.series.map(function (s) {
        var last = s.pts[s.pts.length - 1].y;
        var prev = s.pts.length > 1 ? s.pts[s.pts.length - 2].y : null;
        var first = s.pts[0].y;
        var d = prev == null ? null : last - prev;
        var total = last - first;
        return '<div class="m-val"><i class="swatch" style="background:' + s.color + '"></i>' +
               '<span class="m-num">' + last.toFixed(2) + "</span>" +
               (d == null ? "" : '<span class="m-delta ' + (d > 0 ? "up" : d < 0 ? "down" : "") + '">' +
                 (d > 0 ? "+" : "") + d.toFixed(2) + "</span>") +
               '<span class="m-total ' + (total > 0 ? "up" : total < 0 ? "down" : "") + '">累计 ' +
                 (total > 0 ? "+" : "") + total.toFixed(2) + "</span></div>";
      }).join("");
      return '<div class="bench-card" data-gm="bench:' + esc(b.key) + '" title="点一下看这个基准的讲解">' +
             '<div class="m-head"><span class="m-zh">' + esc(it.info.zh || b.title) + "</span>" +
             '<span class="m-key mono">' + esc(b.title) + (b.note ? " · " + esc(b.note) : "") + "</span></div>" +
             '<div class="m-vals">' + vals + "</div>" +
             '<div class="m-chart" data-bi="' + i + '"></div>' +
             '<div class="m-desc" title="' + esc(it.info.desc || BENCH_FALLBACK_DESC) + '">' +
               esc(it.info.desc || BENCH_FALLBACK_DESC) + "</div>" +
             "</div>";
    }).join("");

    Array.prototype.forEach.call(grid.querySelectorAll(".m-chart"), function (el) {
      var it = built[+el.dataset.bi];
      if (!it) return;
      lineChart(el, it.series, {
        minimal: true, width: 340, height: 120,
        tipFmt: function (v) { return v.toFixed(2); },
      });
    });
  }

  /* ================= 指标讲解抽屉 =================
     点击任意指标卡片或面板标题旁的「?」打开。
     now 段是拿实时数值算出来的，所以讲的内容跟着数据走。 */
  var glCur = null;

  /* AI 讲解的运行状态。
     glAi[key] = {status:'done'|'error', text, think, model, err} —— 结果按指标缓存，
       切走再切回来直接显示，不重复烧 token；想换一版点「重新生成」。
     glAiBusy 为真时暂停抽屉的 10s 自动刷新：否则重渲染会换掉正在吐字的节点。
     glAiBuf 保存当前流的累积内容，切换指标时能把半截结果存回 glAi[旧key]。
     glAiToken 自增让旧流的回调失效，避免两个流互相覆盖。 */
  var glAi = {};
  var glAiBusy = false;
  var glAiToken = 0;
  var glAiBuf = null;
  var glAiAvail = null; // null=还没探测，true/false=探测结果
  var glAiThinkOpen = false; // 思考框的展开状态：重渲染时保持，否则会被合上
  var glAiPlanOpen = false;  // 「查询决策」框同上
  /* 讲解抽屉的两个分页：fixed=程序写死的固定讲解，ai=调用模型生成的讲解。
     两者分开显示，避免「哪些是写死的、哪些是模型说的」混在一起看不清。 */
  var glTab = "fixed";

  /* AI 自己调的查询工具，显示时换成中文，让「它在查什么」一眼可读 */
  var TOOL_ZH = {
    list_metrics: "检索指标",
    query_series: "查历史序列",
    run_status: "查训练状态",
    query_bench: "查评测分数",
  };
  function toolZh(name) { return TOOL_ZH[name] || name || "查询"; }

  /* ---------------- 讲解抽屉的取数：三类 key 各取各的序列 ----------------
     key 的命名空间（讲解抽屉靠前缀判断讲的是哪一类）：
       精选指标    dynsam/avg@n          数据在 state.series（上游 pins，常驻）
       评测基准    bench:deepswe         数据在 state.bench（上游 benchmarks）
       指标库指标  tag:actor/lr          数据在 state.extra（浏览指标库时按需拉取）
     三者统一成 [{key, name, color, pts:[{x,y}]}] 这一种形状，
     后面的统计、绘图、喂给模型都只认它。 */
  function isBenchKey(key) { return key.indexOf("bench:") === 0; }
  function isTagKey(key) { return key.indexOf("tag:") === 0; }
  function bareKey(key) {
    return isBenchKey(key) ? key.slice(6) : isTagKey(key) ? key.slice(4) : key;
  }
  /* 讲解对象的类别。同类之间翻页、换分页的习惯是一样的，跨类才需要重置，
     所以判断的是它而不是具体的 key。 */
  function glScope(key) {
    return isBenchKey(key) ? "bench" : isTagKey(key) ? "tag" : "metric";
  }

  /* 评测基准：results 是 { run: { step: 分数 } }，一个基准里跑着多个 run */
  function benchSeries(b) {
    if (!b || !b.results) return [];
    return Object.keys(b.results).map(function (k) {
      var pts = Object.keys(b.results[k]).map(Number)
        .sort(function (a, c) { return a - c; })
        .map(function (s) { return { x: s, y: b.results[k][s] }; })
        .filter(function (p) { return p.y != null && !isNaN(p.y); });
      return { key: k, name: "mimo-v2.6-" + k, color: COLORS[k] || "#888", pts: pts };
    }).filter(function (s) { return s.pts.length; });
  }
  function benchByKey(k) {
    var list = state.bench || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === k) return list[i];
    return null;
  }

  /* 指标库指标：state.extra[run][tag] 是数值数组，步数在 stepsOf(run) */
  function tagSeries(name) {
    var runs = (state.meta && state.meta.runs) || [];
    var out = [];
    runs.forEach(function (r) {
      var arr = seriesAt(r.key, name);
      if (!Array.isArray(arr)) return;
      var steps = stepsOf(r.key) || [];
      var pts = [];
      for (var i = 0; i < arr.length; i++) {
        var v = arr[i];
        if (v == null || typeof v !== "number" || isNaN(v)) continue;
        pts.push({ x: steps[i] != null ? steps[i] : i + 1, y: v });
      }
      if (pts.length) out.push({ key: r.key, name: r.label || r.key, color: COLORS[r.key] || "#8892a6", pts: pts });
    });
    return out;
  }

  /* 按前缀选数据源：精选指标、评测基准、指标库指标都走它 */
  function ctxSeries(key) {
    if (isBenchKey(key)) return benchSeries(benchByKey(bareKey(key)));
    if (isTagKey(key)) return tagSeries(bareKey(key));
    return metricSeries(key);
  }

  /* 指标库当前画的是哪个 run：跟着视图上的切换走，没选过就用第一个 */
  function currentRunKey() {
    var runs = (state.meta && state.meta.runs) || [];
    if (!runs.length) return null;
    if (state.compRun && runs.some(function (r) { return r.key === state.compRun; })) return state.compRun;
    return runs[0].key;
  }

  /* 数值怎么格式化：指标库指标交给 fmtTag（它按上游规则或量级自适应） */
  function glFmt(key, v) {
    if (isTagKey(key)) return fmtTag(bareKey(key), v);
    if (isBenchKey(key)) return v == null ? "--" : (+v).toFixed(2);
    var it = GLOSSARY.items[key];
    return fmtMetric(v, (it && it.unit) || "num");
  }
  /* 数值卡片右下角那行小字：说清这个数是哪来的 */
  function glNowLabel(key) {
    if (isBenchKey(key)) return "pro 最新一次评测";
    return "pro 最新一步";
  }

  function glStatOf(ss, runKey) {
    for (var i = 0; i < ss.length; i++) {
      if (ss[i].key !== runKey) continue;
      var ys = ss[i].pts.map(function (p) { return p.y; });
      if (!ys.length) return {};
      return {
        last: ys[ys.length - 1],
        prev: ys.length > 1 ? ys[ys.length - 2] : null,
        first: ys[0],
        min: Math.min.apply(null, ys),
        max: Math.max.apply(null, ys),
        n: ys.length,
      };
    }
    return {};
  }

  function glCtx(k) {
    var ss = ctxSeries(k);
    var a = glStatOf(ss, "pro"), f = glStatOf(ss, "flash");
    if (!a.n && f.n) a = f;
    var c = {
      last: a.last == null ? null : a.last,
      prev: a.prev == null ? null : a.prev,
      first: a.first == null ? null : a.first,
      min: a.min, max: a.max, n: a.n || 0,
      flash: f.last == null ? null : f.last,
      delta: (a.last != null && a.prev != null) ? a.last - a.prev : null,
      zero: null,
    };
    if (k === "dynsam/passrate/one") {
      var z = glStatOf(metricSeries("dynsam/passrate/zero"), "pro");
      c.zero = z.last == null ? null : z.last;
    }
    return c;
  }

  function glPara(text) {
    return String(text).split(/\n{2,}/).map(function (p) {
      return '<p>' + esc(p) + "</p>";
    }).join("");
  }
  function glSec(title, html) {
    return '<section class="gl-sec"><h4>' + esc(title) + "</h4>" + html + "</section>";
  }
  function glLinks(list) {
    if (!list || !list.length) return "";
    var items = list.map(function (k) {
      var it = GLOSSARY.items[k];
      return '<button class="gl-link" data-gk="' + esc(k) + '">' + esc(it ? it.zh : k) + "</button>";
    }).join("");
    return glSec("相关指标", '<div class="gl-links">' + items + "</div>");
  }

  function renderGlossaryIndex() {
    var mods = Object.keys(GLOSSARY.modules).map(function (k) {
      var m = GLOSSARY.modules[k];
      return '<button class="gl-idx-item" data-gm="' + esc(k) + '">' +
             '<span class="gi-t">' + esc(m.zh) + "</span>" +
             '<span class="gi-s mono">' + esc(m.sub || "") + "</span></button>";
    }).join("");
    var mets = GLOSSARY.order.map(function (k) {
      var it = GLOSSARY.items[k];
      return '<button class="gl-idx-item" data-gk="' + esc(k) + '">' +
             '<span class="gi-t">' + esc(it.zh) + "</span>" +
             '<span class="gi-s mono">' + esc(k) + "</span></button>";
    }).join("");
    return '<div class="gl-intro">' +
           "<p>这块看板有几十个数字。它们不是随便画的，每一个都对应训练过程里的一个具体环节。</p>" +
           "<p>下面分两组：先看<strong>图表模块</strong>（每块面板在讲什么），" +
           "再看<strong>18 个训练指标</strong>（逐个讲它度量什么、图怎么看、现在的值在说什么）。</p>" +
           '<p class="gl-tip">提示：总览页里直接点任意一张指标卡片，也能打开对应讲解；' +
           "面板标题旁的「?」是该面板的讲解。</p></div>" +
           glSec("图表模块", '<div class="gl-idx">' + mods + "</div>") +
           glSec("18 个训练指标", '<div class="gl-idx">' + mets + "</div>");
  }

  function renderGlossary(key, keepScroll) {
    var drawer = $("gl-drawer"), mask = $("gl-mask"), body = $("gl-body");
    if (!drawer || !body) return;
    var savedScroll = keepScroll ? body.scrollTop : 0;

    // 正在某个指标上吐字时切走了：收尾，把半截结果存回缓存
    if (glAiBusy && glAiBuf && glAiBuf.key !== key) glAiStop();

    /* 换讲解对象时该停在哪个分页：同一类之间翻页保持原样（连着看几个指标的
       AI 讲解是常见用法，翻一页就跳回固定讲解会很烦）；跨类则回到固定讲解 ——
       指标库那几百个指标多半没看过，固定讲解先告诉观众「这是哪一类、名字怎么读」
       比一个还没生成的 AI 空白页有用。 */
    var prevKey = glCur;
    if (prevKey && glScope(prevKey) !== glScope(key) && glTab === "ai" && !glAi[key]) {
      glTab = "fixed";
    }

    glCur = key;
    var G = GLOSSARY;

    if (key === "__index") {
      $("gl-kicker").textContent = "看板导读";
      $("gl-title").textContent = "这些图和数字在说什么";
      $("gl-sub").textContent = "";
      body.innerHTML = renderGlossaryIndex();
      $("gl-foot").hidden = true;
    } else if (isBenchKey(key) || isTagKey(key)) {
      /* 评测基准与指标库指标。这两类图表的数不在 state.series 里
         （分别在 state.bench 和 state.extra），所以固定讲解各用一个生成函数，
         AI 讲解则由 glAiPayload 按前缀去取对应的序列。
         没有「上一个 / 下一个」：它们不在官方的 18 项里，没有天然的相邻关系。 */
      var bare = bareKey(key);
      var cb = glCtx(key);
      var fixed, kicker, title, sub;
      if (isBenchKey(key)) {
        var info = BENCH_INFO[bare] || {};
        var bb = benchByKey(bare);
        kicker = "离线评测基准";
        title = info.zh || (bb && bb.title) || bare;
        sub = bare;   // 副标题放上游标识（API 里查它用的名字），版本口径写在正文里
        fixed = glBenchFixed(key, bare, cb);
      } else {
        var ti = G.items[bare];
        kicker = ti ? "指标库 · 精选指标" : "指标库指标";
        title = ti ? ti.zh : descOf(bare);
        sub = bare;
        fixed = ti ? glFixedHtml(bare, key, cb) : glTagFallbackHtml(bare, cb);
        /* 指标库的数据是浏览时按需拉的。从别处（比如讲解里的相关指标按钮）
           跳进来时可能还没有，这时补拉一次再重渲染，别让模型拿到一张空图。 */
        if (!cb.n) {
          var trun = currentRunKey();
          if (trun) fetchSeries(trun, [bare]).then(function () {
            if (glCur === key) renderGlossary(key, true);
          }).catch(function () {});
        }
      }
      $("gl-kicker").textContent = kicker;
      $("gl-title").textContent = title;
      $("gl-sub").textContent = sub;
      body.innerHTML = glTabsHtml() + (glTab === "ai" ? glAiHtml(key, cb) : fixed);
      $("gl-foot").hidden = true;
    } else if (G.modules[key]) {
      var m = G.modules[key];
      $("gl-kicker").textContent = "图表讲解";
      $("gl-title").textContent = m.zh;
      $("gl-sub").textContent = m.sub || "";
      body.innerHTML = '<div class="gl-lead">' + esc(m.body.split(/\n{2,}/)[0]) + "</div>" +
                       glPara(m.body.split(/\n{2,}/).slice(1).join("\n\n")) +
                       glLinks(m.link);
      $("gl-foot").hidden = false;
      $("gl-pos").textContent = "";
      $("gl-prev").hidden = true;
      $("gl-next").hidden = true;
    } else {
      var it = G.items[key];
      if (!it) {
        var fb = G.fallback(key);
        $("gl-kicker").textContent = "指标（暂无专门讲解）";
        $("gl-title").textContent = fb.zh;
        $("gl-sub").textContent = key;
        body.innerHTML = '<div class="gl-lead">' + esc(fb.body) + "</div>" +
                         glSec("怎么读这个名字", "<p>" + esc(key) + " 可以按前缀判断类别：" +
                               "timing 是耗时，rate/ratio 是比率，mean 是均值，" +
                               "num/count 是数量，norm 是范数，kl 是分布差异。</p>");
        $("gl-foot").hidden = true;
      } else {
        var c = glCtx(key);
        var idx = G.order.indexOf(key);
        $("gl-kicker").textContent = "训练指标 " + (idx + 1) + " / " + G.order.length;
        $("gl-title").textContent = it.zh;
        $("gl-sub").textContent = key;
        body.innerHTML = glTabsHtml() +
          (glTab === "ai" ? glAiHtml(key, c) : glFixedHtml(key, key, c));
        $("gl-foot").hidden = false;
        $("gl-pos").textContent = (idx + 1) + " / " + G.order.length;
        $("gl-prev").hidden = idx <= 0;
        $("gl-next").hidden = idx < 0 || idx >= G.order.length - 1;
      }
    }

    drawer.hidden = false;
    mask.hidden = false;
    body.scrollTop = keepScroll ? savedScroll : 0;
  }

  function closeGlossary() {
    var d = $("gl-drawer"), m = $("gl-mask");
    if (d) d.hidden = true;
    if (m) m.hidden = true;
    if (glAiBusy) glAiStop(); // 抽屉都关了就别再烧 token，半截结果存进缓存
    /* glCur 故意不清空：它记的是「最近一次讲过的对象」。切到别的视图（点导航
       会让抽屉先关掉）再点开新图时，要靠它判断这次是不是跨了类别 —— 跨类才把
       分页退回固定讲解。清空的话这个判断就永远失去依据了。 */
  }

  /* ---------------- AI 讲解（流式吐字） ---------------- */

  /* 组装喂给 AI 的上下文：精选，不塞全量。
     固定文案当机制底稿，实时数值才是要它解读的对象。 */
  function glAiPayload(key) {
    var st = state.status && state.status.pro;
    var runInfo = {
      step: st && st.step && st.step.last,
      phase: st && st.step && st.step.phase,
    };
    var c = glCtx(key);
    var bare = bareKey(key);
    /* 最近若干步的原始值，按 run 分组。三类图表都靠这一段让模型直接看到趋势；
       要看更长的历史，模型可以用 query_series 工具自己查。 */
    var recent = {};
    ctxSeries(key).forEach(function (s) {
      recent[s.key] = s.pts.slice(-12).map(function (p) {
        return { step: p.x, v: Math.round(p.y * 1e6) / 1e6 };
      });
    });

    /* 评测基准：这里评的是「某个存档点在这套题上的得分」，
       和训练指标不是一回事，所以字段名换成 score、并给出评测次数。 */
    if (isBenchKey(key)) {
      var info = BENCH_INFO[bare] || {};
      var bb = benchByKey(bare);
      var series = ctxSeries(key).map(function (s) {
        var ys = s.pts.map(function (p) { return p.y; });
        return {
          run: s.key,
          last: ys[ys.length - 1],
          first: ys[0],
          delta: ys.length > 1 ? ys[ys.length - 1] - ys[ys.length - 2] : null,
          gain: ys[ys.length - 1] - ys[0],
          min: Math.min.apply(null, ys),
          max: Math.max.apply(null, ys),
          evaluations: ys.length,
          recent: s.pts.slice(-12).map(function (p) { return { step: p.x, score: p.y }; }),
        };
      });
      return {
        key: key,
        kind: "bench",
        zh: info.zh || (bb && bb.title) || bare,
        title: bb && bb.title,
        note: bb && bb.note,
        static: { desc: info.desc || BENCH_FALLBACK_DESC },
        series: series,
        run: runInfo,
      };
    }

    /* 精选指标与指标库指标走同一套字段。区别是指标库指标多半没有固定文案
       （static 为 null），模型得自己用工具确认它存在、再查它的历史。 */
    var it = GLOSSARY.items[bare];
    var payload = {
      key: key,
      kind: isTagKey(key) ? "tag" : "metric",
      zh: it ? it.zh : descOf(bare),
      unit: isTagKey(key) ? (fmtKindOf(bare) || "auto") : (it ? (it.unit || "num") : "num"),
      static: it ? { one: it.one, what: it.what, read: it.read, watch: it.watch } : null,
      live: {
        last: c.last, prev: c.prev, first: c.first,
        min: c.min, max: c.max, delta: c.delta,
        flash: c.flash, steps: c.n,
      },
      recent: recent,
      run: runInfo,
    };
    if (isTagKey(key)) payload.metric = bare;   // 指标库里那个真实名字，供工具检索
    return payload;
  }

  /* 当前数值卡片，固定讲解页与 AI 页共用。放在 AI 页顶部是为了让读者知道
     模型看到的是哪几个数——AI 讲的内容全部出自这里。 */
  function glNowHtml(key, c) {
    if (!c || c.last == null) return "";
    return '<div class="gl-now">' +
             '<span class="gn-v">' + esc(glFmt(key, c.last)) + "</span>" +
             (c.delta == null ? "" : '<span class="gn-d ' + (c.delta > 0 ? "up" : c.delta < 0 ? "down" : "") + '">' +
               (c.delta > 0 ? "+" : "") + esc(glFmt(key, c.delta)) + "</span>") +
             '<span class="gn-k">' + esc(glNowLabel(key)) + "</span></div>";
  }

  /* 精选指标那五段固定讲解。drawKey 是数值卡片要显示哪条序列的 key ——
     指标库里的指标可能正好也是精选指标，那时 itemKey 与 drawKey 同源不同名。 */
  function glFixedHtml(itemKey, drawKey, c) {
    var it = GLOSSARY.items[itemKey];
    if (!it) return "";
    var nowTxt = "";
    try { nowTxt = it.now ? it.now(c) : ""; } catch (e) { nowTxt = ""; }
    return '<div class="gl-lead">' + esc(it.one) + "</div>" +
           glSec("这是什么", "<p>" + esc(it.what) + "</p>") +
           glSec("这张图怎么看", "<p>" + esc(it.read) + "</p>") +
           glSec("现在的数在说什么", glNowHtml(drawKey, c) + "<p>" + esc(nowTxt) + "</p>") +
           glSec("什么情况要警惕", "<p>" + esc(it.watch) + "</p>") +
           glLinks(it.link);
  }

  /* 评测基准的固定讲解：这个基准考什么、现在各 run 跑多少、和训练指标什么关系。
     与上面那套的区别是数据源不同（state.bench），且要强调「不参与训练」这一点。 */
  function glBenchFixed(key, bare, c) {
    var info = BENCH_INFO[bare] || {};
    var bb = benchByKey(bare);
    var ss = ctxSeries(key);
    var rows = ss.map(function (s) {
      var ys = s.pts.map(function (p) { return p.y; });
      var last = ys[ys.length - 1], first = ys[0], gain = last - first;
      return '<div class="gl-bench-row"><i class="swatch" style="background:' + s.color + '"></i>' +
             '<span class="gbr-r">' + esc(s.name) + "</span>" +
             '<span class="gbr-v">' + esc(glFmt(key, last)) + "</span>" +
             '<span class="gbr-d ' + (gain > 0 ? "up" : gain < 0 ? "down" : "") + '">累计 ' +
               (gain > 0 ? "+" : "") + esc(glFmt(key, gain)) + "</span></div>";
    }).join("");
    // 上游的 title / note 记着这套题的版本和口径，放在正文里，不占副标题
    var upstream = [bb && bb.title, bb && bb.note].filter(Boolean).join(" · ") || bare;
    return '<div class="gl-lead">' + esc(info.desc || BENCH_FALLBACK_DESC) + "</div>" +
           glSec("目前的分数", (rows ? '<div class="gl-bench">' + rows + "</div>" : "") +
                 "<p>横轴是训练步，但点比训练曲线稀得多：每隔若干步才拿当时的存档点跑一次这套题。" +
                 "它不参与梯度更新，只做独立的泛化检验。</p>") +
           glSec("和训练指标的关系", "<p>训练奖励涨、这里不动，说明模型在拟合训练分布而不是真变强；" +
                 "两边同向才算提升落在了泛化上。不同基准涨落不同步也是正常的——" +
                 "它们考的侧重点不一样。</p>") +
           '<p class="dim mono" style="font-size:11.5px">上游标识：' + esc(upstream) + "</p>" +
           '<div class="gl-links"><button class="gl-link" data-g="bench">看全部评测基准</button>' +
           '<button class="gl-link" data-gk="dynsam/avg@n">看训练主指标</button></div>';
  }

  /* 指标库里的指标：词库没收录时，用上游描述 + 名字前缀给一段通用讲解。
     这类指标数量最多（几百个），不可能逐个写文案，所以固定讲解只做「定位」，
     真正逐项解读交给 AI 讲解那一页。 */
  function glTagFallbackHtml(name, c) {
    var fb = GLOSSARY.fallback(name);
    return '<div class="gl-lead">' + esc(descOf(name)) + "</div>" +
           glSec("它是哪一类", "<p>" + esc(fb.body) + "</p>") +
           glSec("怎么读这个名字", "<p>" + esc(name) + " 可以按前缀判断类别：" +
                 "timing 是耗时，rate/ratio 是比率，mean 是均值，" +
                 "num/count 是数量，norm 是范数，kl 是分布差异。</p>") +
           (c && c.last != null ? glSec("现在的数在说什么", glNowHtml("tag:" + name, c)) : "");
  }

  /* 分页条：把「程序写死的」和「模型生成的」分开，避免混在一起分不清来源。 */
  function glTabsHtml() {
    return '<div class="gl-tabs">' +
             '<button class="gl-tab' + (glTab === "fixed" ? " on" : "") + '" data-glt="fixed">固定讲解</button>' +
             '<button class="gl-tab' + (glTab === "ai" ? " on" : "") + '" data-glt="ai">AI 讲解</button>' +
           "</div>";
  }

  /* 「查询决策 + 它触发的那次工具调用」是一组。模型常常想一步、查一步、
     看到结果再想下一步，所以这样的组会出现好几轮。每组单独显示，
     顺序就是它真实的「想 → 查」顺序，比把所有决策揉进一个框好懂。 */
  function glStepHtml(s, i) {
    var rows = (s.tools || []).map(function (t) {
      return '<div class="gl-ai-tool">' +
               '<span class="gl-ai-tool-n">' + esc(toolZh(t.name)) + "</span>" +
               '<span class="gl-ai-tool-s">' + esc(t.summary || "") + "</span>" +
             "</div>";
    }).join("");
    return '<details class="gl-ai-think gl-ai-step"' + (glAiPlanOpen ? " open" : "") + ">" +
             "<summary>" +
               '<span class="gl-spin" aria-hidden="true"></span>' +
               "<span>查询决策 · 第 " + (i + 1) + " 轮</span>" +
               (s.tools && s.tools.length
                 ? '<span class="gl-ai-step-c">' + s.tools.length + " 次调用</span>" : "") +
             "</summary>" +
             '<div class="gl-ai-think-b">' + esc(s.plan || "") + "</div>" +
             '<div class="gl-ai-tools"' + (rows ? "" : " hidden") + ">" + rows + "</div>" +
           "</details>";
  }
  function glStepsHtml(st) {
    var arr = (st && st.steps && st.steps.length) ? st.steps
      : (st && (st.plan || (st.tools && st.tools.length)))
        ? [{ plan: st.plan || "", tools: st.tools || [] }]   // 老缓存兼容
        : [];
    return '<div class="gl-ai-steps" id="gl-ai-steps"' + (arr.length ? "" : " hidden") + ">" +
             arr.map(glStepHtml).join("") + "</div>";
  }

  /* 重跑前收起来的「上一次的不完整内容」。默认收起，观众看下面那版就行。 */
  function glPartialsHtml(st) {
    var arr = (st && st.partials) || [];
    return arr.map(function (p) {
      return '<details class="gl-ai-think gl-ai-partial">' +
               "<summary>" + (p.reason === "short" ? "上一次内容不完整" : "上一次生成中断") +
                 " · 点开看已有的部分</summary>" +
               '<div class="gl-ai-partial-h">下面是重新生成的完整内容。</div>' +
               '<div class="gl-ai-think-b">' + esc(p.text) + "</div>" +
             "</details>";
    }).join("");
  }

  /* AI 讲解页。缓存命中时直接渲染已生成内容，不再请求。
     思考过程用 details 折叠：它比正文先产生，所以排在正文上方；
     默认收起，想看再点开，不占地方。 */
  function glAiHtml(key, c) {
    var st = glAi[key];
    var label = st && st.status === "done" ? "重新生成" : "AI 讲解当前数据";
    var disabled = (glAiAvail === false || glAiBusy) ? " disabled" : "";
    var why = glAiAvail === false
      ? '<span class="gl-ai-why">AI 未启用，见 config.json 的 llm.enabled</span>' : "";
    var text = "", cls = "gl-ai-out";
    if (st && st.status === "done") text = st.text;
    else if (st && st.status === "error") { text = st.err || "生成失败"; cls += " is-err"; }
    var think = st && st.think ? st.think : "";
    var hint = st ? "" : '<p class="gl-ai-tip">模型会读取这张图此刻的真实数据后开讲，' +
                         "内容跟着数据走，不是背好的固定文案。</p>";
    var stepsHtml = glStepsHtml(st);
    return '<div class="gl-ai">' +
             glNowHtml(key, c) +
             '<div class="gl-ai-bar">' +
               '<button class="gl-ai-btn" data-ai="' + esc(key) + '"' + disabled + ">" + label + "</button>" +
               '<span class="gl-ai-status" id="gl-ai-status" hidden></span>' +
               '<span class="gl-ai-model" id="gl-ai-model">' +
                 (st && st.model ? esc(st.model) : "") + "</span>" + why +
             "</div>" +
             hint +
             stepsHtml +
             '<details class="gl-ai-think" id="gl-ai-think"' +
               (glAiThinkOpen ? " open" : "") + (think ? "" : " hidden") + ">" +
               "<summary>" +
                 '<span class="gl-spin" aria-hidden="true"></span>' +
                 '<span id="gl-ai-think-t">AI 思考过程</span>' +
               "</summary>" +
               '<div class="gl-ai-think-b">' + esc(think) + "</div>" +
             "</details>" +
             glPartialsHtml(st) +
             (st && st.truncated
               ? '<div class="gl-ai-warn">这段在生成过程中断，可能不完整，可点「重新生成」再来一次</div>'
               : "") +
             '<div class="' + cls + '" id="gl-ai-out"' + (text ? "" : " hidden") + ">" +
               esc(text) + "</div>" +
           "</div>";
  }

  /* 提前结束当前流：已吐出的内容存进缓存，并让旧回调失效。
     切换指标或切换分页会重建 DOM，必须先调用它——否则旧回调继续往
     已被换掉的节点里写，前端看起来就是「吐了一半卡住了」。 */
  function glAiStop() {
    if (!glAiBusy || !glAiBuf) return;
    glAiToken++;
    glAiBusy = false;
    if (glAiBuf.acc) {
      glAi[glAiBuf.key] = {
        status: "done",
        text: String(glAiBuf.acc).replace(/^[\s　]+/, ""),
        think: glAiBuf.think,
        plan: glAiBuf.plan,
        model: glAiBuf.model,
        tools: glAiBuf.tools,
        steps: stepsPlain(glAiBuf.steps),
        partials: glAiBuf.partials,
        truncated: glAiBuf.truncated,
      };
    }
    glAiBuf = null;
  }

  /* 缓存里只存纯数据，不要把 DOM 节点一起存进去（会拖住已废弃的节点）。 */
  function stepsPlain(steps) {
    return (steps || []).map(function (s) {
      return { plan: s.plan, tools: (s.tools || []).map(function (t) {
        return { name: t.name, args: t.args, summary: t.summary };
      }) };
    });
  }

  /* 点按钮：POST /api/explain，边收边往 #gl-ai-out 里追加，实现吐字效果。 */
  function runAiExplain(key) {
    if (glAiBusy) return;
    var out = $("gl-ai-out"), statusEl = $("gl-ai-status"), thinkEl = $("gl-ai-think");
    var stepsEl = $("gl-ai-steps"); // 一轮「决策 → 调用」一个子块，全都挂在这里
    if (!out || !stepsEl) return;

    var token = ++glAiToken;
    glAiBusy = true;
    glAiBuf = { key: key, acc: "", think: "", plan: "", model: "", err: "",
                started: false, tools: [], steps: [], cur: null, pend: null,
                partials: [], truncated: false };
    glAi[key] = null;
    stepsEl.hidden = true;
    stepsEl.textContent = "";

    // 工具轮在最前面（模型先查数据），所以初始占位不能写成「正在思考」
    out.hidden = false;
    out.className = "gl-ai-out is-wait";
    out.textContent = "AI 正在准备…";
    if (thinkEl) {
      thinkEl.hidden = true;
      var tb = thinkEl.querySelector(".gl-ai-think-b");
      if (tb) tb.textContent = "";
    }
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = "AI 正在读取当前数据…"; }

    /* 开一组新的「决策 → 调用」。模型想一步查一步，所以这样的组会有好几轮；
       每轮一个独立的折叠块，标题带轮次，收起时也能看出查了几次。 */
    function newStep(n) {
      var s = { round: n, plan: "", tools: [] };
      glAiBuf.steps.push(s);
      glAiBuf.cur = s;
      var el = document.createElement("details");
      el.className = "gl-ai-think gl-ai-step";
      el.open = !!glAiPlanOpen;
      el.innerHTML = "<summary>" +
                       '<span class="gl-spin" aria-hidden="true"></span>' +
                       "<span>查询决策 · 第 " + n + " 轮</span>" +
                     "</summary>" +
                     '<div class="gl-ai-think-b"></div>' +
                     '<div class="gl-ai-tools" hidden></div>';
      stepsEl.appendChild(el);
      stepsEl.hidden = false;
      s.el = el;
      // b.plan 是给老缓存兜底的纯文本版，这里补一行轮次分隔
      glAiBuf.plan += (glAiBuf.plan ? "\n\n" : "") + "第 " + n + " 轮决策：";
      return s;
    }
    /* 找已存在的第 n 轮块，不新建。用来判断「这一轮的调用到了没」。 */
    function findStep(n) {
      var b = glAiBuf;
      if (!b) return null;
      for (var i = 0; i < b.steps.length; i++) if (b.steps[i].round === n) return b.steps[i];
      return null;
    }
    /* 决策思考先攒着，等这一轮的调用真的发出去才建块。
       模型最后往往会再想一轮、然后决定「够了，不用再查」——那一轮没有调用，
       单独给它一个块只会多一个空框，所以并进「AI 思考过程」里。 */
    function flushPend() {
      var b = glAiBuf;
      if (!b || !b.pend || !b.pend.text) { if (b) b.pend = null; return; }
      b.think += (b.think ? "\n\n" : "") + b.pend.text;
      b.pend = null;
    }
    /* 取第 n 轮那组：同一轮的思考与多次调用都落进同一块。
       轮次由后端给（模型想一次 = 一轮），前端不自己猜边界。 */
    function stepFor(n) {
      var b = glAiBuf;
      if (!b) return null;
      n = n || 1;
      if (b.cur && b.cur.round === n) return b.cur;
      // 上一轮想了但没真调用（模型决定不查了）→ 那段思考并进分析，不占一个空块
      if (b.pend && b.pend.round !== n) flushPend();
      closeStep();                       // 换轮：上一轮收尾，撤掉它的转圈
      var s = findStep(n) || newStep(n);
      if (b.pend && b.pend.round === n) { // 本轮思考先到、调用后到：补进这一块
        s.plan += b.pend.text;
        b.pend = null;
        stepText(s);
      }
      b.cur = s;
      return s;
    }
    /* 收尾当前轮：撤掉转圈，标题补上调用次数。 */
    function closeStep() {
      var s = glAiBuf && glAiBuf.cur;
      if (!s || !s.el) return;
      s.el.classList.remove("is-live");
      updateStepCount(s);
    }
    function updateStepCount(s) {
      if (!s || !s.el || !s.tools.length) return;
      var c = s.el.querySelector(".gl-ai-step-c");
      if (!c) {
        c = document.createElement("span");
        c.className = "gl-ai-step-c";
        s.el.querySelector("summary").appendChild(c);
      }
      c.textContent = s.tools.length + " 次调用";
    }
    function stepText(s) {
      var b = s && s.el && s.el.querySelector(".gl-ai-think-b");
      if (b) b.textContent = s.plan;
    }

    /* AI 每次调用工具都追加一行到当前这一轮里，让「它查了什么、查到没有」可见。
       否则工具轮那十几秒用户只能对着空白框干等，以为卡住了。 */
    function addToolRow(info, s) {
      var box = s.el && s.el.querySelector(".gl-ai-tools");
      if (!box) return;
      box.hidden = false;
      var row = document.createElement("div");
      row.className = "gl-ai-tool";
      var n = document.createElement("span");
      n.className = "gl-ai-tool-n";
      n.textContent = toolZh(info && info.name);
      var sEl = document.createElement("span");
      sEl.className = "gl-ai-tool-s";
      sEl.textContent = (info && info.summary) || "";
      row.appendChild(n);
      row.appendChild(sEl);
      box.appendChild(row);
    }

    /* 生成中把折叠标题改成进行时态并转圈，结束改回静态标题。
       这样收起状态下也能一眼看出在干什么，而不是一个空白框。 */
    function setThinking(on) {
      if (!thinkEl) return;
      if (on) thinkEl.classList.add("is-live"); else thinkEl.classList.remove("is-live");
      var tEl = $("gl-ai-think-t");
      if (tEl) tEl.textContent = on ? "正在思考…" : "AI 思考过程";
    }

    /* 内容一直在涨，展开后要自己往下拖才能看到新字，很累。
       生成阶段（正文还没开始）始终贴底；正文开始后只在用户本来就在底部时才跟随。 */
    function followBox(el, force) {
      if (!el || !el.open) return;
      var tbox = el.querySelector(".gl-ai-think-b");
      if (!tbox) return;
      if (force || tbox.scrollHeight - tbox.scrollTop - tbox.clientHeight < 60) {
        tbox.scrollTop = tbox.scrollHeight;
      }
    }

    /* 重跑正文轮前，把已经吐出来的内容收成一个折叠块留在正文上方。
       标题写明它不完整，引导观众看下面重新生成的完整版。 */
    function shrinkOut(reason) {
      var cur = String(out.textContent || "").trim();
      if (!cur) return;               // 一个字都没有就没什么可留的
      var d = document.createElement("details");
      d.className = "gl-ai-think gl-ai-partial";
      d.open = false;
      var sum = document.createElement("summary");
      sum.textContent = (reason === "short" ? "上一次内容不完整" : "上一次生成中断") +
                        " · 点开看已有的部分";
      var hint = document.createElement("div");
      hint.className = "gl-ai-partial-h";
      hint.textContent = "下面是重新生成的完整内容。";
      var box = document.createElement("div");
      box.className = "gl-ai-think-b";
      box.textContent = cur;
      d.appendChild(sum);
      d.appendChild(hint);
      d.appendChild(box);
      out.parentNode.insertBefore(d, out);
      if (glAiBuf) glAiBuf.partials.push({ reason: reason || "", text: cur });
    }

    /* 让最新文字始终可见。只在用户已经贴着底部时才跟随，
       否则会打断他往上翻阅读。 */
    function follow() {
      var b = $("gl-body");
      if (!b) return;
      if (b.scrollHeight - b.scrollTop - b.clientHeight < 140) b.scrollTop = b.scrollHeight;
    }

    function finish() {
      glAiBusy = false;
      var buf = glAiBuf;
      glAiBuf = null;
      if (!buf || token !== glAiToken) return;
      if (statusEl) statusEl.hidden = true;
      flushPend();          // 最后那轮「想完决定不查了」的思考并进分析
      if (thinkEl) {
        var tbx = thinkEl.querySelector(".gl-ai-think-b");
        if (tbx) tbx.textContent = buf.think;
        if (buf.think) thinkEl.hidden = false;
      }
      setThinking(false); // 收尾时一定把转圈和「正在思考」撤掉
      closeStep();
      out.className = "gl-ai-out" + (buf.err ? " is-err" : "");
      // 模型爱在正文开头吐几个换行，pre-wrap 下会显示成空白行，去掉
      var txt = buf.err ? "" : String(buf.acc).replace(/^[\s　]+/, "");
      // 兜底：推理型模型有时会只输出 thinking、content 里只有空白。
      // 这时候给观众看空白框没有意义，把分析阶段的思考内容当正文呈现，
      // 至少把思路讲出来。思考框本身仍保留完整版。
      if (!txt && !buf.err && buf.think) txt = String(buf.think).replace(/^[\s　]+/, "");
      if (buf.err) {
        out.textContent = buf.err;
        glAi[key] = { status: "error", err: buf.err };
      } else if (txt) {
        out.textContent = txt;
        // 断连留下的不完整内容：写清楚，别让人当成讲完了
        if (buf.truncated) {
          var warn = document.createElement("div");
          warn.className = "gl-ai-warn";
          warn.textContent = "这段在生成过程中断，可能不完整，可点「重新生成」再来一次";
          out.parentNode.insertBefore(warn, out);
        }
        glAi[key] = { status: "done", text: txt, think: buf.think, plan: buf.plan,
                      model: buf.model, tools: buf.tools, steps: stepsPlain(buf.steps),
                      partials: buf.partials, truncated: buf.truncated };
        var mEl = $("gl-ai-model");
        if (mEl && buf.model) mEl.textContent = buf.model;
        var btn = document.querySelector('.gl-ai-btn[data-ai="' + key + '"]');
        if (btn) { btn.disabled = false; btn.textContent = "重新生成"; }
      } else {
        out.hidden = true;
      }
    }

    function pump(reader) {
      var dec = new TextDecoder("utf-8"), buf = "";
      function step() {
        return reader.read().then(function (r) {
          if (r.done) { finish(); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop() || "";
          for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            if (token !== glAiToken) return; // 已被新的请求顶掉
            var j;
            try { j = JSON.parse(lines[i]); } catch (e) { continue; }
            var b = glAiBuf;
            if (!b) continue;
            if (j.delta) {
              // 收到第一段正文，说明思考结束了：撤掉占位、标题改回静态
              if (!b.started) {
                b.started = true;
                out.className = "gl-ai-out is-typing";
                out.textContent = "";
                setThinking(false);
              }
              b.acc += j.delta;
              if (statusEl) statusEl.textContent = "AI 正在写…";
              out.textContent = b.acc;
              follow();
            } else if (j.tool) {
              var ti = j.tool || {};
              /* 同一轮可能连着发好几个调用，都归到这一组的块里。
                 轮次变了我方才另起一块，形成 决策1+调用1 → 决策2+调用2。 */
              var s = stepFor(j.round || ti.round);
              if (!s) continue;
              s.tools.push({ name: ti.name, args: ti.args, summary: ti.summary });
              b.tools.push({ name: ti.name, args: ti.args, summary: ti.summary });
              b.plan += "\n调用 " + toolZh(ti.name);
              addToolRow(ti, s);
              updateStepCount(s);
              if (statusEl) {
                statusEl.hidden = false;
                statusEl.textContent = "AI 正在" + toolZh(ti.name) + "…";
              }
              if (!b.started) out.textContent = "AI 正在查阅数据…";
              follow();
            } else if (j.think) {
              /* phase=tool 是工具轮「决定查什么」的思考，进当前这一轮的
                 查询决策块；其余是拿到数据后分析用的思考，进「AI 思考过程」框。
                 两者分开，否则决策和分析混在一起，看不出它为什么查这两个指标。 */
              var isPlan = j.phase === "tool";
              if (isPlan) {
                var rn = j.round || 1;
                var ex = findStep(rn);         // 这一轮的调用已到 → 直接追加进那块
                if (ex) {
                  ex.plan += j.think;
                  ex.el.classList.add("is-live");
                  stepText(ex);
                  followBox(ex.el, !b.started);
                } else {
                  // 先攒着：这一轮要是没真调用（模型想完决定不查了），就并入分析思考
                  if (!b.pend || b.pend.round !== rn) { flushPend(); b.pend = { round: rn, text: "" }; }
                  b.pend.text += j.think;
                }
                b.plan += j.think;
              } else {
                // 分析思考出现，说明工具轮全部结束：没调用的那轮思考并入分析，再收尾决策块
                flushPend();
                closeStep();
                b.think += j.think;
                if (thinkEl) {
                  if (thinkEl.hidden) { thinkEl.hidden = false; setThinking(true); }
                  var tbb = thinkEl.querySelector(".gl-ai-think-b");
                  if (tbb) tbb.textContent = b.think;
                  followBox(thinkEl, !b.started);
                }
              }
              if (!b.started) {
                out.textContent = isPlan
                  ? "AI 正在决定查哪些数据…"
                  : "AI 正在思考，想清楚后开始输出…";
              }
              if (statusEl) {
                statusEl.hidden = false;
                statusEl.textContent = isPlan ? "AI 正在决定查什么…" : "AI 正在思考…";
              }
            } else if (j.notice) {
              // 后端要重试了：把原因说清楚，别让观众以为卡死
              if (statusEl) {
                statusEl.hidden = false;
                statusEl.textContent = j.notice;
              }
            } else if (j.restart) {
              /* 重跑正文轮。上一次的内容不丢，收成一个折叠块留在上面
                 （观众可能正看到一半），下面接新的完整内容。
                 工具轮查到的数据不重查，所以决策块保持原样。 */
              shrinkOut(j.restart && j.restart.reason);
              b.started = false;
              b.acc = "";
              b.think = "";      // 新一轮会重新思考，旧的堆着反而看不清
              if (thinkEl) {
                thinkEl.hidden = true;
                var tb2 = thinkEl.querySelector(".gl-ai-think-b");
                if (tb2) tb2.textContent = "";
              }
              out.hidden = false;
              out.className = "gl-ai-out is-wait";
              out.textContent = "AI 正在重新生成…";
            } else if (j.done) {
              b.model = j.model || "";
              b.truncated = !!j.truncated;
            } else if (j.error) {
              b.err = j.error;
            }
          }
          return step();
        });
      }
      return step();
    }

    fetch("api/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(glAiPayload(key)),
    }).then(function (r) {
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      return pump(r.body.getReader());
    }).catch(function (e) {
      if (glAiBuf) glAiBuf.err = String(e && e.message ? e.message : e) || "生成失败";
      finish();
    });
  }

  /* 探测 AI 是否可用，不可用就把按钮置灰，而不是让用户点了才报错。 */
  function probeAi() {
    getJSON("api/ai/test").then(function (r) {
      glAiAvail = !!(r && r.enabled && r.ok);
    }).catch(function () {
      glAiAvail = false;
    });
  }

  function bindGlossary() {
    if (bindGlossary._done) return;   // 防重复绑定：否则一次点击会被处理两遍
    bindGlossary._done = true;
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (t.closest) {
        var q = t.closest(".qbtn[data-g], .gb-btn[data-g]");
        if (q) { renderGlossary(q.dataset.g); return; }
        var gm = t.closest("[data-gm]");
        if (gm) { renderGlossary(gm.dataset.gm); return; }
        var gk = t.closest("[data-gk]");
        if (gk) { renderGlossary(gk.dataset.gk); return; }
        var tab = t.closest(".gl-tab[data-glt]");
        if (tab) {
          var v = tab.dataset.glt;
          if (v !== glTab) {
            glTab = v;
            if (glAiBusy) glAiStop(); // 别让旧流写进即将被换掉的节点
            renderGlossary(glCur);
            // 不自动开讲：点一下 tag 就烧一次 token 太贵，交给用户点按钮决定
          }
          return;
        }
        var ab = t.closest(".gl-ai-btn[data-ai]");
        if (ab && !ab.disabled) { runAiExplain(ab.dataset.ai); return; }
      }
      /* 遮罩已改成 pointer-events:none，点击会直接落到下面的元素上，
         所以「点抽屉外面就关」要在这里兜底。讲解触发元素在上面已 return，
         不会被这条误关。 */
      var dw = $("gl-drawer");
      if (dw && !dw.hidden && !(t.closest && t.closest("#gl-drawer"))) {
        closeGlossary();
        return;
      }
      if (t.id === "gl-close" || t.id === "gl-mask") { closeGlossary(); return; }
      if (t.id === "gl-prev" || t.id === "gl-next") {
        var i = GLOSSARY.order.indexOf(glCur);
        if (i >= 0) renderGlossary(GLOSSARY.order[t.id === "gl-prev" ? i - 1 : i + 1]);
        return;
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeGlossary();
    });
    /* 展开思考框时直接贴到底部：思考内容一直在涨，靠手动拖根本跟不上。
       toggle 事件不冒泡，所以必须用捕获阶段监听。 */
    document.addEventListener("toggle", function (e) {
      var el = e.target;
      if (!el) return;
      // 每一轮「查询决策」都是独立块，展开状态统一记在 glAiPlanOpen 上
      var isStep = el.classList && el.classList.contains("gl-ai-step");
      if (el.id !== "gl-ai-think" && el.id !== "gl-ai-plan" && !isStep) return;
      if (el.id === "gl-ai-think") glAiThinkOpen = !!el.open;
      else glAiPlanOpen = !!el.open;
      if (!el.open) return;
      var tbox = el.querySelector(".gl-ai-think-b");
      if (tbox) tbox.scrollTop = tbox.scrollHeight;
    }, true);
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
      if (pts.length) out.push({ key: r.key, name: r.label || r.key, color: COLORS[r.key] || "#8892a6", pts: pts });
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
      return '<div class="metric-card" data-gk="' + esc(d.k) + '" title="点一下看这项指标的详细讲解">' +
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
    renderComposition();
    renderClocks();
    $("updated").textContent = "更新 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    if (m.stream_start) {
      var d = new Date(m.stream_start * 1000);
      $("foot-stream").textContent = "stream since " + d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    }
    /* 「数据源」和「官方账号」是两件事，别再共用一个 href：
       数据源就是看板取数的站点，官方账号是上游 social 里给的那个（X）。 */
    var srcHtml = '数据源：<a class="link" href="' + esc(SRC_URL) + '" target="_blank" rel="noopener">' +
      esc(hostPath(SRC_URL)) + "</a> · 官方 trainer 日志";
    if (m.social && m.social.url) {
      srcHtml += ' · 官方账号 <a class="link" href="' + esc(m.social.url) +
        '" target="_blank" rel="noopener">' + esc((m.social.handle || hostPath(m.social.url)) +
        " · " + hostPath(m.social.url)) + "</a>";
    }
    $("foot-src").innerHTML = srcHtml;
    if (window.MTLNarrator) {
      try { window.MTLNarrator.update(state); } catch (e) {}
    }
  }

  /* ---------------- 多时区时钟 ---------------- */
  var ZONES = [
    ["北京", "Asia/Shanghai"],
    ["洛杉矶", "America/Los_Angeles"],
    ["纽约", "America/New_York"],
    ["伦敦", "Europe/London"],
  ];
  var ZONE_FMT = null;
  function zoneFmt() {
    if (!ZONE_FMT) {
      ZONE_FMT = ZONES.map(function (z) {
        return new Intl.DateTimeFormat("zh-CN", {
          timeZone: z[1], hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        });
      });
    }
    return ZONE_FMT;
  }
  function totalCost() {
    var total = 0, any = false;
    ((state.meta && state.meta.runs) || []).forEach(function (r) {
      var s = state.status[r.key];
      if (!s || !s.cost || !s.cost.rate_per_s) return;
      any = true;
      total += s.run && s.run.mode === "ended"
        ? s.cost.so_far
        : s.cost.rate_per_s * Math.max(0, Date.now() / 1000 - s.run.start);
    });
    return any ? total : null;
  }
  function renderClocks() {
    var host = $("clocks");
    if (!host) return;
    var cost = totalCost();
    var fmt = zoneFmt(), now = new Date();
    host.innerHTML =
      '<div class="clk clk-cost"><span class="k">总花费</span><span class="v">' +
        (cost == null ? "--" : "$" + int(Math.floor(cost))) + "</span></div>" +
      ZONES.map(function (z, i) {
        return '<div class="clk"><span class="k">' + z[0] + '</span><span class="v mono">' +
               fmt[i].format(now) + "</span></div>";
      }).join("");
  }

  /* ---------------- 视图路由 ---------------- */
  var VIEWS = ["overview", "metrics", "about"];
  function parseHash() {
    var v = String(location.hash || "").replace(/^#/, "").split("/")[0];
    return VIEWS.indexOf(v) >= 0 ? v : "overview";
  }
  function applyView(v, skipHash) {
    v = VIEWS.indexOf(v) >= 0 ? v : "overview";
    state.view = v;
    VIEWS.forEach(function (name) {
      var el = $("view-" + name);
      if (el) el.hidden = name !== v;
    });
    Array.prototype.forEach.call(document.querySelectorAll("#tabs a"), function (a) {
      a.classList.toggle("is-on", a.dataset.view === v);
    });
    if (!skipHash && parseHash() !== v) location.hash = "#" + v;
    if (v === "metrics") { renderTreeNav(); renderTreeMain(); }
    if (v === "about") renderAbout();
  }

  function renderAbout() {
    var m = state.meta || {}, host = $("about-body");
    if (!host) return;
    var src = (m.social && m.social.url) || "https://x.com/XiaomiMiMo";
    var handle = (m.social && m.social.handle) || "@XiaomiMiMo";
    var upstream = (m.about || []).map(function (t) { return "<p>" + esc(t) + "</p>"; }).join("");
    host.innerHTML =
      "<p>这是一个<strong>本地运行</strong>的看板，数据直接代理小米官方公开接口 " +
      '<a class="link" href="' + esc(SRC_URL) + '" target="_blank" rel="noopener">' +
      esc(hostPath(SRC_URL)) + "</a>，" +
      "不经过任何第三方服务器，也不存储除了本地 SQLite 之外的东西。</p>" +
      "<p>右侧的「实时解说」是本地生成的教学文本：规则引擎先给出结构化解说，" +
      "如果你配置了本地大模型（OpenAI 兼容接口），它会进一步改写成更有信息量的版本。两者在界面上有明确标记。</p>" +
      "<h3>怎么看这个面板</h3><ul>" +
      "<li><b>step</b>：一整轮训练循环，先让模型做题（rollout），再拿答案更新参数（training），一步约 2～3 小时。</li>" +
      "<li><b>avg@n</b>：本轮的平均得分，0～1，越高越强。这是最该盯的数字。</li>" +
      "<li><b>零分率 / 满分率</b>：16 次尝试全错或全对的题占比。这两类题没有梯度信号，练了也白烧钱。</li>" +
      "<li><b>指标库</b>页可以浏览 trainer 上报的全部指标，共 " + int(state.tags.length) + " 项。</li>" +
      "</ul>" +
      (upstream ? "<h3>官方说明</h3>" + upstream : "") +
      /* 账号链接把平台域名也写出来（@XiaomiMiMo · x.com/XiaomiMiMo）：
         handle 带 @ 看不出是哪个平台的号，只写它就等于让人猜点下去会去哪。 */
      "<p class='dim'>官方账号 " + '<a class="link" href="' + esc(src) + '" target="_blank" rel="noopener">' +
      esc(handle) + " · " + esc(hostPath(src)) + "</a> · " + esc(m.footer_note || "") + "</p>";
  }

  /* ---------------- 通用指标序列拉取（带缓存） ---------------- */
  var extraInflight = {};
  function fetchSeries(run, tags) {
    // 已缓存的先剔除，只拉缺的；同一 run+tags 组合不会重复发请求
    var need = tags.filter(function (t) { return !(state.extra[run] && state.extra[run][t]); });
    if (!need.length) return Promise.resolve(state.extra[run]);
    var q = encodeURIComponent(tags.join(","));
    var ck = run + "|" + q;
    if (extraInflight[ck]) return extraInflight[ck];
    var p = getJSON("api/series?run=" + run + "&tags=" + q).then(function (s) {
      var bucket = state.extra[run] || (state.extra[run] = {});
      Object.keys(s.series || {}).forEach(function (k) { bucket[k] = s.series[k]; });
      if (s.steps) bucket.__steps = s.steps;
      delete extraInflight[ck];
      return bucket;
    }).catch(function (e) {
      delete extraInflight[ck];
      throw e;
    });
    extraInflight[ck] = p;
    return p;
  }
  function seriesAt(run, tag) {
    var b = state.extra[run];
    return (b && b[tag]) || null;
  }
  function stepsOf(run) {
    var b = state.extra[run];
    if (b && b.__steps) return b.__steps;
    var s = state.series[run];
    return (s && s.steps) || [];
  }

  /* ---------------- 指标树 ---------------- */
  function buildTree(tags) {
    var root = { name: "", path: "", children: {}, leaves: [], total: 0 };
    tags.forEach(function (t) {
      var parts = String(t).split("/");
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var seg = parts[i], cp = node.path ? node.path + "/" + seg : seg;
        if (!node.children[seg]) node.children[seg] = { name: seg, path: cp, children: {}, leaves: [], total: 0 };
        node = node.children[seg];
        node.total++;
      }
      node.leaves.push(t);
      root.total++;
    });
    return root;
  }
  function nodeAt(root, path) {
    if (!path) return root;
    var parts = path.split("/"), node = root;
    for (var i = 0; i < parts.length; i++) {
      node = node.children[parts[i]];
      if (!node) return null;
    }
    return node;
  }
  function sortedChildren(node) {
    return Object.keys(node.children).map(function (k) { return node.children[k]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  var TAG_PAGE = 40;
  var expanded = {};   // 展开的目录路径

  function renderTreeNav() {
    var host = $("tree");
    if (!host) return;
    if (!state.tree) { host.innerHTML = '<div class="empty">指标列表加载中…</div>'; return; }
    // 首次进入时把当前路径的祖先全部展开
    var parts = state.tagPath ? state.tagPath.split("/") : [];
    for (var i = 0; i < parts.length; i++) expanded[parts.slice(0, i + 1).join("/")] = true;

    function build(node, depth) {
      var out = "";
      sortedChildren(node).forEach(function (c) {
        var has = Object.keys(c.children).length > 0;
        var open = !!expanded[c.path];
        out += '<div class="tree-node' + (state.tagPath === c.path ? " is-on" : "") + '" data-p="' + esc(c.path) +
               '" style="padding-left:' + (8 + depth * 12) + 'px">' +
               '<span class="tw">' + (has ? (open ? "▾" : "▸") : "") + "</span>" +
               '<span class="nm">' + esc(c.name) + "</span>" +
               '<span class="cnt">' + c.total + "</span></div>";
        if (has && open) out += build(c, depth + 1);
      });
      return out;
    }
    host.innerHTML = '<div class="tree-node' + (state.tagPath === "" ? " is-on" : "") + '" data-p="" style="padding-left:8px">' +
                     '<span class="tw">▸</span><span class="nm">全部指标</span><span class="cnt">' +
                     state.tree.total + "</span></div>" + build(state.tree, 1);

    Array.prototype.forEach.call(host.querySelectorAll(".tree-node"), function (row) {
      row.addEventListener("click", function () {
        var p = row.dataset.p;
        if (expanded[p]) delete expanded[p]; else expanded[p] = true;
        state.tagPath = p;
        state.tagPage = 0;
        renderTreeNav();
        renderTreeMain();
      });
    });
  }

  function matchedTags() {
    if (!state.tags.length) return { leaves: [], folders: [], title: "" };
    if (state.tagQuery) {
      var m = state.tagQuery.match(/^\/(.+)\/([a-z]*)$/), test = null;
      if (m) { try { test = new RegExp(m[1], m[2]); } catch (e) { test = null; } }
      var q = state.tagQuery.toLowerCase();
      var leaves = state.tags.filter(function (t) {
        return test ? test.test(t) : t.toLowerCase().indexOf(q) >= 0;
      });
      return { leaves: leaves, folders: [], title: '<span class="cur">' + leaves.length + ' 项匹配</span> <span class="dim">' + esc(state.tagQuery) + "</span>" };
    }
    var node = nodeAt(state.tree, state.tagPath);
    if (!node) return { leaves: [], folders: [], title: '<span class="dim">路径不存在：' + esc(state.tagPath) + "</span>" };
    var parts = state.tagPath ? state.tagPath.split("/") : [];
    var crumbs = '<a data-p="">全部</a>' + parts.map(function (p, i) {
      return '<span class="sepc">/</span>' + (i === parts.length - 1
        ? '<span class="cur">' + esc(p) + "</span>"
        : '<a data-p="' + esc(parts.slice(0, i + 1).join("/")) + '">' + esc(p) + "</a>");
    }).join("");
    return {
      leaves: node.leaves.slice().sort(),
      folders: sortedChildren(node),
      title: crumbs + '<span class="dim">&nbsp; ' + node.total + " 项</span>",
    };
  }

  function renderTreeMain() {
    var crumbs = $("crumbs"), folders = $("folders"), grid = $("tree-grid"), more = $("tree-more");
    if (!grid) return;
    var res = matchedTags();
    crumbs.innerHTML = res.title;
    Array.prototype.forEach.call(crumbs.querySelectorAll("a[data-p]"), function (a) {
      a.addEventListener("click", function () {
        state.tagPath = a.dataset.p; state.tagPage = 0;
        renderTreeNav(); renderTreeMain();
      });
    });
    folders.innerHTML = res.folders.map(function (f) {
      return '<button class="folder" data-p="' + esc(f.path) + '">' + esc(f.name) +
             '<span class="cnt">' + f.total + "</span></button>";
    }).join("");
    Array.prototype.forEach.call(folders.querySelectorAll(".folder"), function (b) {
      b.addEventListener("click", function () {
        state.tagPath = b.dataset.p; state.tagPage = 0;
        renderTreeNav(); renderTreeMain();
      });
    });

    var show = res.leaves.slice(0, state.tagPage || TAG_PAGE);
    more.innerHTML = "";
    if (!show.length) {
      // 根路径下全是目录、没有直接挂在根上的指标，给出引导而不是留白
      grid.innerHTML = res.folders.length
        ? '<div class="empty">从上方目录或左侧树里选一个分类，这里会列出该分类下的指标曲线。</div>'
        : '<div class="empty">这个路径下没有指标</div>';
      return;
    }
    grid.innerHTML = '<div class="empty">正在加载 ' + show.length + " 项指标…</div>";
    renderTagCards(grid, show);
    if (res.leaves.length > show.length) {
      more.innerHTML = '<button class="more-btn" id="tree-more-btn">再显示 ' +
        Math.min(TAG_PAGE, res.leaves.length - show.length) + ' 项<span class="dim">（还剩 ' +
        (res.leaves.length - show.length) + "）</span></button>";
      $("tree-more-btn").addEventListener("click", function () { state.tagPage += TAG_PAGE; renderTreeMain(); });
    }
  }

  /* 批量拉一组指标的序列并渲染卡片：一次 series 请求搞定整页 */
  function renderTagCards(grid, tags) {
    var runs = (state.meta && state.meta.runs) || [];
    if (!runs.length) { grid.innerHTML = '<div class="empty">尚未加载</div>'; return; }
    var run = state.compRun && state.meta.runs.some(function (r) { return r.key === state.compRun; })
      ? state.compRun : runs[0].key;
    fetchSeries(run, tags).then(function (bucket) {
      var steps = stepsOf(run);
      var items = tags.filter(function (t) {
        var a = bucket[t];
        return Array.isArray(a) && a.some(function (v) { return v != null && !isNaN(v); });
      });
      if (!items.length) { grid.innerHTML = '<div class="empty">这些指标当前没有数据</div>'; return; }
      grid.innerHTML = items.map(function (t, i) {
        var arr = bucket[t] || [];
        var pts = [], last = null, prev = null;
        for (var k = 0; k < arr.length; k++) {
          var v = arr[k];
          if (v == null || typeof v !== "number" || isNaN(v)) continue;
          pts.push({ x: steps[k] != null ? steps[k] : k + 1, y: v });
        }
        if (pts.length) { last = pts[pts.length - 1].y; prev = pts.length > 1 ? pts[pts.length - 2].y : null; }
        var d = prev == null ? null : last - prev;
        return '<div class="metric-card" data-gk="tag:' + esc(t) + '" title="点一下看讲解">' +
               '<div class="m-head"><span class="m-zh mono">' + esc(t) + "</span></div>" +
               '<div class="m-vals"><div class="m-val"><span class="m-num">' + esc(fmtTag(t, last)) + "</span>" +
                 (d == null ? "" : '<span class="m-delta ' + (d > 0 ? "up" : d < 0 ? "down" : "") + '">' +
                   (d > 0 ? "+" : "") + esc(fmtTag(t, d)) + "</span>") + "</div></div>" +
               '<div class="m-chart" data-ti="' + i + '"></div>' +
               '<div class="m-desc">' + esc(descOf(t)) + "</div>" +
               "</div>";
      }).join("");
      var host = grid;
      Array.prototype.forEach.call(host.querySelectorAll(".m-chart"), function (el) {
        var t = items[+el.dataset.ti];
        var arr = bucket[t] || [], pts = [];
        for (var k = 0; k < arr.length; k++) {
          var v = arr[k];
          if (v == null || typeof v !== "number" || isNaN(v)) continue;
          pts.push({ x: steps[k] != null ? steps[k] : k + 1, y: v });
        }
        lineChart(el, [{ name: t, color: "var(--accent)", pts: pts }], {
          minimal: true, width: 340, height: 110,
          tipFmt: function (v) { return fmtTag(t, v); },
        });
      });
    }).catch(function () {
      grid.innerHTML = '<div class="empty">指标序列加载失败</div>';
    });
  }

  /* 堆叠面积图：mode=count 画绝对值，mode=share 画占比（0~1） */
  function stackedChart(host, steps, series, opt) {
    opt = opt || {};
    var W = opt.width || 640, H = opt.height || 220;
    var padL = 52, padR = 14, padT = 12, padB = 26;
    if (opt.minimal) { padL = 34; padB = 20; }
    var n = steps.length;
    if (!n) { host.innerHTML = '<div class="empty">没有数据</div>'; return; }

    // 逐层累加得到堆叠上沿
    var acc = new Array(n).fill(0);
    var stacks = series.map(function (s) {
      return { s: s, base: acc.slice(), top: acc.map(function (v, i) { return (acc[i] += (s.values[i] || 0)); }) };
    });
    // share 模式：按每步总和归一化，画成 100% 堆叠
    if (opt.mode === "share") {
      stacks = [];
      acc = new Array(n).fill(0);
      series.forEach(function (s) {
        var base = acc.slice();
        var top = acc.map(function (v, i) {
          var tot = series.reduce(function (a, o) { return a + (o.values[i] || 0); }, 0) || 1;
          return (acc[i] += (s.values[i] || 0) / tot);
        });
        stacks.push({ s: s, base: base, top: top });
      });
    }

    var yMax = 0;
    stacks.forEach(function (st) { st.top.forEach(function (v) { if (v > yMax) yMax = v; }); });
    if (opt.mode === "share") yMax = 1;
    if (yMax <= 0) yMax = 1;
    var xMin = steps[0], xMax = steps[n - 1];
    if (xMax === xMin) { xMax = xMin + 1; }
    var sx = function (v) { return padL + ((v - xMin) / (xMax - xMin)) * (W - padL - padR); };
    var sy = function (v) { return padT + (1 - v / yMax) * (H - padT - padB); };
    var fmtY = opt.mode === "share"
      ? function (v) { return (v * 100).toFixed(0) + "%"; }
      : (opt.yFmt || function (v) { return int(v); });

    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" class="chart-svg">';
    var nGrid = 4;
    for (var i = 0; i <= nGrid; i++) {
      var v = (yMax * i) / nGrid, y = sy(v);
      svg += '<line class="grid-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"/>';
      svg += '<text class="axis-text" x="' + (padL - 6) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + esc(fmtY(v)) + "</text>";
    }
    var ticks = Math.min(6, Math.max(2, n));
    for (var t = 0; t <= ticks; t++) {
      var idx = Math.round(((n - 1) * t) / ticks), xv = steps[idx];
      svg += '<text class="axis-text" x="' + sx(xv).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle">s' + xv + "</text>";
    }
    stacks.forEach(function (st) {
      var up = st.top.map(function (v, i) { return sx(steps[i]).toFixed(1) + " " + sy(v).toFixed(1); });
      var dn = st.base.map(function (v, i) { return sx(steps[i]).toFixed(1) + " " + sy(v).toFixed(1); }).reverse();
      var d = "M" + up.join(" L") + " L" + dn.join(" L") + " Z";
      svg += '<path d="' + d + '" fill="' + st.s.color + '" fill-opacity="0.75" stroke="' + st.s.color +
             '" stroke-width="0.8"><title>' + esc(st.s.label) + "</title></path>";
    });
    svg += "</svg>";
    host.innerHTML = svg;
  }

  /* ---------------- batch composition ----------------
     每步真正进入训练的 prompt 来自哪些数据集类别。
     单个数据源的存量满足 held(t) = held(t-1) + accepted(t) - trained(t)，
     于是 trained(t) ≈ held(t-1) + accepted(t) - held(t)；按类别汇总即为训练批的构成。
     刚重启的那一步 held 是在消耗之前上报的，上式会失真，此时回退为
     carryover + 新接受量按比例分摊。 */
  function compSources() {
    var cats = (state.meta && state.meta.categories) || [];
    var re = /^dynsam\/([^/]+)\/([^/]+)\/num_accepted\/step$/;
    var out = [];
    state.tags.forEach(function (t) {
      var m = re.exec(t);
      if (!m) return;
      if (cats.length && cats.indexOf(m[1]) < 0) return;
      out.push({ cat: m[1], ds: m[2], key: m[1] + "/" + m[2] });
    });
    return out;
  }

  function renderComposition() {
    var panel = $("comp-panel");
    if (!panel) return;
    var run = state.compRun;
    var items = compSources();
    if (!items.length) { panel.hidden = true; return; }
    panel.hidden = false;

    var cats = (state.meta && state.meta.categories) || [];
    var tags = [];
    items.forEach(function (it) {
      ["step", "held", "carryover"].forEach(function (k) {
        tags.push("dynsam/" + it.key + "/num_accepted/" + k);
      });
    });
    tags.push("dynsam/num_target");

    fetchSeries(run, tags).then(function (bucket) {
      var steps = stepsOf(run);
      var n = steps.length;
      if (!n) { $("comp-chart").innerHTML = '<div class="empty">暂无数据</div>'; return; }
      var get = function (it, k) { return bucket["dynsam/" + it.key + "/num_accepted/" + k] || []; };
      var bszSeries = bucket["dynsam/num_target"] || [];

      var trained = items.map(function () { return new Array(n).fill(0); });
      var approx = new Array(n).fill(false);
      for (var i = 0; i < n; i++) {
        var bsz = bszSeries[i] || 0;
        var sum = 0;
        var rec = items.map(function (it, k) {
          var a = get(it, "step")[i] || 0, h = get(it, "held")[i] || 0;
          var hp = i ? (get(it, "held")[i - 1] || 0) : null;
          var v = hp == null ? null : Math.max(0, hp + a - h);
          if (v != null) sum += v;
          return v;
        });
        // 与官方 batch size 对得上才采信推导值，否则说明是刚重启的那一步
        if (i > 0 && bsz && Math.abs(sum - bsz) <= 0.05 * bsz) {
          rec.forEach(function (v, k) { trained[k][i] = v; });
        } else {
          approx[i] = true;
          var carry = items.map(function (it) { return get(it, "carryover")[i] || 0; });
          var acc = items.map(function (it) { return get(it, "step")[i] || 0; });
          var carrySum = carry.reduce(function (a, b) { return a + b; }, 0);
          var fresh = Math.max(0, bsz - carrySum);
          var accSum = acc.reduce(function (a, b) { return a + b; }, 0) || 1;
          items.forEach(function (it, k) { trained[k][i] = carry[k] + (acc[k] * fresh) / accSum; });
        }
      }

      var pal = ["#5b9dff", "#22c55e", "#ffab3d", "#a855f7", "#ef4444", "#06b6d4"];
      var series = cats.map(function (g, gi) {
        return {
          key: g, label: CAT_LABEL[g] || g, color: pal[gi % pal.length],
          values: Array.from({ length: n }, function (_, i) {
            return items.reduce(function (a, it, k) { return a + (it.cat === g ? trained[k][i] : 0); }, 0);
          }),
        };
      }).filter(function (s) { return s.values.some(function (v) { return v > 0; }); });

      stackedChart($("comp-chart"), steps, series, {
        mode: state.compMode, height: 200,
        yFmt: function (v) { return int(v); },
      });

      var last = n - 1, prev = n - 2;
      var totAt = function (i) { return series.reduce(function (a, s) { return a + (s.values[i] || 0); }, 0); };
      var total = totAt(last), prevTotal = prev >= 0 ? totAt(prev) : 0;
      var bsz = bszSeries[last] || 0;

      $("comp-table").innerHTML =
        '<div class="comp-t-head"><b>step ' + steps[last] + "</b><span class=\"dim\">" +
        (approx[last] ? "≈ " : "") + int(total) + " prompts" + (bsz ? " · 训练批 " + int(bsz) : "") + "</span></div>" +
        '<table class="tbl"><thead><tr><th>类别</th><th>数据源</th><th>prompts</th><th>占比</th><th>占比变化</th></tr></thead><tbody>' +
        series.map(function (s, gi) {
          var v = s.values[last] || 0, sh = total ? v / total : 0;
          var ps = prevTotal ? (s.values[prev] || 0) / prevTotal : null;
          var d = ps == null ? null : sh - ps;
          var cnt = items.filter(function (it) { return (CAT_LABEL[it.cat] || it.cat) === s.label; }).length;
          return "<tr><td><i class=\"swatch\" style=\"background:" + s.color + '\"></i>' + esc(s.label) + "</td>" +
                 '<td class="dim">' + cnt + "</td><td>" + int(v) + "</td><td>" + (sh * 100).toFixed(1) + "%</td>" +
                 '<td class="' + (d == null ? "dim" : "") + '">' + (d == null ? "—" :
                   (d > 0 ? "▲" : d < 0 ? "▼" : "") + Math.abs(d * 100).toFixed(1) + " pt") + "</td></tr>";
        }).join("") +
        '<tr class="total"><td>合计</td><td class="dim">' + items.length + "</td><td>" + int(total) +
        "</td><td>100%</td><td></td></tr></tbody></table>" +
        (approx.some(Boolean) ? '<div class="comp-note">≈ 标注的步发生在重启之后，此时上报的存量尚未扣除本步消耗，构成按比例估算。</div>' : "");
    }).catch(function () {
      $("comp-chart").innerHTML = '<div class="empty">构成数据加载失败</div>';
    });
  }

  /* 指标库里有 2000 多个指标，靠量级猜格式会出错（比如把 7215 秒显示成 7215.990）。
     上游在 runs.formats 里给了 [正则, 格式名] 规则，按序取第一条命中的，照搬即可。 */
  var FMT_RULES = null;
  function fmtRules() {
    if (FMT_RULES) return FMT_RULES;
    FMT_RULES = ((state.meta && state.meta.formats) || []).map(function (r) {
      try { return { re: new RegExp(r[0]), kind: r[1] }; } catch (e) { return null; }
    }).filter(Boolean);
    return FMT_RULES;
  }
  function fmtKindOf(tag) {
    var rules = fmtRules();
    for (var i = 0; i < rules.length; i++) if (rules[i].re.test(tag)) return rules[i].kind;
    return null;
  }
  function fmtByKind(v, kind) {
    if (v == null || isNaN(v)) return "--";
    switch (kind) {
      case "duration": return dur(v);
      case "compact": return big(v);
      case "gb": return v.toFixed(1) + " GB";
      case "sci": return v === 0 ? "0" : v.toExponential(1);
      case "ratio": return v.toFixed(4);
      case "pct": return (v * 100).toFixed(1) + "%";
      case "int": return int(v);
      default: return fmtAuto(v);
    }
  }
  /* 指标库卡片用：优先按上游规则，没有规则再按量级自适应 */
  function fmtTag(tag, v) {
    var k = fmtKindOf(tag);
    if (k) return fmtByKind(v, k);
    if (METRIC_BY_KEY[tag]) return fmtMetric(v, METRIC_BY_KEY[tag].kind);
    return fmtAuto(v);
  }

  /* 没有中文映射时的兜底格式化：按量级自适应 */
  function fmtAuto(v) {
    if (v == null || isNaN(v)) return "--";
    var a = Math.abs(v);
    if (a !== 0 && a < 0.001) return v.toExponential(1);
    if (a >= 1e9) return big(v);
    if (a >= 1e6) return big(v);
    if (a >= 1e4) return int(v);
    if (a >= 1) return v.toFixed(3);
    return v.toFixed(4);
  }
  function descOf(tag) {
    var d = state.meta && state.meta.descriptions;
    if (d && d[tag]) return d[tag];
    var zh = TAG_ZH[tag];
    if (zh) return zh;
    var parts = String(tag).split("/");
    return "路径 " + parts.slice(0, -1).join("/") + " 下的 " + parts[parts.length - 1];
  }
  var TAG_ZH = {};   // 关键路径的中文说明（覆盖官方 descriptions 没有的）
  (function () {
    METRIC_DEFS.forEach(function (d) { TAG_ZH[d.k] = d.zh + "：" + d.desc; });
  })();

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
  function initNav() {
    document.getElementById("tabs").addEventListener("click", function (e) {
      var a = e.target.closest("a[data-view]");
      if (!a) return;
      e.preventDefault();
      applyView(a.dataset.view);
    });
    window.addEventListener("hashchange", function () { applyView(parseHash(), true); });

    // composition：切换 run 与「数量/占比」两种画法
    bindSeg("comp-run-switch", function () { return state.compRun; }, function (v) { state.compRun = v; });
    var modeBox = $("comp-mode-switch");
    if (modeBox) {
      modeBox.addEventListener("click", function (e) {
        var btn = e.target.closest(".seg-btn");
        if (!btn) return;
        Array.prototype.forEach.call(modeBox.querySelectorAll(".seg-btn"), function (b) { b.classList.remove("is-on"); });
        btn.classList.add("is-on");
        state.compMode = btn.dataset.mode;
        renderComposition();
      });
    }

    // 指标库搜索：防抖，支持子串与 /正则/
    var box = $("tag-search"), timer = null;
    if (box) {
      box.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          state.tagQuery = box.value.trim();
          state.tagPage = 0;
          renderTreeMain();
        }, 200);
      });
    }
  }

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

  /* 给 coach.js（AI 训练教练）用的最小接口。只暴露它真的需要的三样：
     转义、工具名中文化，以及「此刻在看什么」—— 后者只有这个闭包知道
     （state.view 与讲解抽屉当前打开的 glCur 都在里面）。
     不暴露 state 本身：教练没有理由去改看板状态。 */
  function getContext() {
    var c = { view: state.view || "overview", chart: null, chartName: null, run: state.evRun || null };
    if (!glCur) return c;
    var bare = bareKey(glCur);
    c.chart = glCur;
    var d = METRIC_BY_KEY[bare];
    if (d && d.zh) {
      c.chartName = d.zh;
    } else if (isBenchKey(glCur)) {
      var b = (state.bench || []).filter(function (x) { return x.key === bare; })[0];
      c.chartName = (b && b.title) || bare;
    } else {
      c.chartName = bare;
    }
    return c;
  }

  window.MIMO = { esc: esc, toolZh: toolZh, getContext: getContext };

  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    bindGlossary();
    probeAi();
    initNav();
    bindSeg("run-switch", function () { return state.evRun; }, function (v) { state.evRun = v; });
    bindSeg("ds-run-switch", function () { return state.dsRun; }, function (v) { state.dsRun = v; });
    renderClocks();
    setInterval(renderClocks, 1000);
    applyView(parseHash(), true);
    loadAll();
    setInterval(loadAll, REFRESH_MS);
  });
})();
