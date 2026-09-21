/* mimo-train-live — 解说引擎核心（浏览器 / Node 通用，无 DOM 依赖）
   用法：
     Node:     const { createEngine } = require('./public/narrator-core.js');
     浏览器:    window.MTLNarratorCore.createEngine()
   引擎只做「数据 -> 人话」，渲染由调用方负责。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else if (root) root.MTLNarratorCore = api;
})(typeof self !== "undefined" ? self : (typeof global !== "undefined" ? global : this), function () {
  "use strict";

  var MAX_ITEMS = 200;
  var RUN_COLOR = { pro: "#5b9dff", flash: "#ffab3d" };
  var RUN_NAME = { pro: "pro", flash: "flash" };

  function pct1(n) { return n == null ? "--" : (n * 100).toFixed(1) + "%"; }
  function money(n) {
    if (n == null) return "--";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    return "$" + Math.round(n / 1e3) + "K";
  }
  function f4(v) { return v == null ? "--" : v.toFixed(4); }
  function color(k) { return RUN_COLOR[k] || "#888"; }
  function name(k) { return RUN_NAME[k] || k; }

  function snap(st, lv) {
    var sp = st.step || {}, hl = st.headline || {}, tot = st.totals || {}, cost = st.cost || {};
    return {
      step: sp.last, phase: sp.phase, progress: sp.progress,
      value: hl.last, restarts: tot.restarts, cost: cost.so_far,
      pr0: lv ? lv.pr0 : null, pr1: lv ? lv.pr1 : null,
      passrate: lv ? lv.passrate : null,
    };
  }

  function noticeHint(t) {
    var s = String(t).toLowerCase();
    if (/oom|vram|memory|显存/.test(s)) {
      return "翻成中文：某张 GPU 显存被撑爆（OOM）导致中断。这是工程调度问题，跟模型聪不聪明没关系。";
    }
    if (/network|connectivity/.test(s)) {
      return "翻成中文：训练集群和判分服务之间网络断了，所以重启。";
    }
    if (/infra|dataset/.test(s)) {
      return "翻成中文：某个数据集的基础设施出错，而且有一段时间没被检测到，只能回滚重跑。";
    }
    if (/deepswe|eval/.test(s)) {
      return "翻成中文：更新了离线评测（DeepSWE 编程榜）的最新分数。";
    }
    if (/restart/.test(s)) {
      return "翻成中文：运行中断并重启了。模型有权重存档，会从存档点继续。";
    }
    return "";
  }

  /* 规则版知识点库：AI 不可用时也能学到东西。
     讲机制、讲原理、讲设计取舍，不用生活化比喻。 */
  var LESSONS = {
    restart: "崩溃重启靠的是 checkpoint（存档点）。训练框架会周期性把模型权重、优化器状态（Adam 的一阶与二阶动量）以及数据读取游标一起写盘。缺了优化器状态虽然能续跑，但动量丢失会让收敛轨迹偏掉，所以完整存档三样都要存。代价是写一次盘要几分钟、几十 GB，因此存档不能太频繁——这是崩溃恢复速度与训练开销之间的典型取舍。",

    rollout: "这一阶段叫 rollout（采样生成）：用当前策略让模型对一批题目各生成 n 个候选答案，拿去判分，作为训练数据。关键点在于 RL 的训练数据不是人写的，而是模型自己生成的，这叫 on-policy。生成用 vLLM 这类推理引擎（吞吐高、支持连续批处理），训练用 FSDP 或 Megatron（要存梯度与优化器状态），两者硬件利用模式完全不同，所以工程上必须拆成两个可独立伸缩的阶段。",

    training: "这一阶段才真正更新参数：把 rollout 收集到的答案按组内相对优势（advantage）折算成梯度，反向传播改权重。GRPO 的做法是，同一题的 n 个答案用组内均值当基线，advantage 等于本条得分减组内均值、再除以组内标准差。用组内统计量当基线，就不需要再单独训一个 critic 网络去预估价值，省掉一整个大模型的前向与反向，这是 GRPO 相对 PPO 最核心的工程收益。",

    pr1: "满分率（pr1）指一道题的 n 次尝试全部答对。这类题看着好，其实是废样本：advantage 等于本条得分减组内均值，全对时每条都是满分、组内均值也等于满分，advantage 恒为 0；分母的组内标准差同样是 0。梯度直接归零，反向传播什么都不更新，但生成与判分的算力已经花掉了。所以动态采样（dynamic sampling）会在训练前筛掉这类题，只留有对有错、具备区分度的题。",

    pr0: "零分率（pr0）指一道题的 n 次尝试全部答错，和满分率是同一枚硬币的两面：组内标准差为 0，advantage 恒为 0，梯度归零，样本无效。区别只在成因，pr0 说明题太难超纲，pr1 说明题太简单已掌握，两者都只是在烧钱。训练中 pr0 长期偏高，通常意味着数据难度配比失当，或者模型能力还没到这个梯度。",

    cost: "RL 训练的花费主要来自三块：GPU 时（rollout 生成加 training 反向）、沙箱环境（代码题要真实起容器跑测试，是独占的 CPU 资源）、判分服务（执行单元测试并比对答案）。其中 rollout 往往占大头，因为要生成成千上万条长轨迹，而 attention 的复杂度对序列长度是 O(n²)，长上下文推理极贵。这也是为什么大家拼命优化采样效率——每一条无效样本都是真金白银。",

    step: "一个训练步在 RL 里指：取一批题，rollout 生成 n 个答案，判分，算 advantage，更新一次参数。它和预训练的 step 不同，每一步前的造数据成本极高（几千 GPU 时），所以 RL 的 batch 通常做得很大、步数很少，一步几小时是常态。判断训练是否正常，正确方式是看成绩曲线的多步移动平均，而不是单点抖动——每步换一批新题，题目难度本身就不同。",

    rollback: "回滚重跑是因为检测到某一步的数据有问题（比如判分服务异常、部分轨迹损坏），把这条数据作废，退回上一个 checkpoint 重来。因为权重是从存档点恢复的，之前学到的东西不会丢，代价只是这一步的算力。工程上要能做回滚，前提是 checkpoint 里保存了数据游标，能精确知道该从哪条数据重新开始。",

    stall: "一步要跑几小时，时间几乎全花在 rollout 上：一个 batch 有几万道题，每题采样 n 次，每次生成可能几千个 token。生成阶段逐 token 解码，无法像训练那样靠大 batch 摊薄，且长序列的 attention 是 O(n²)。更麻烦的是判分要等所有答案生成完、跑完测试才能开始，整条流水线是生成、判分、训练串行的。异步训练（async RL）的思路就是让生成不等训练，训练用略旧的权重，用策略陈旧（staleness）换吞吐。",

    eval: "离线评测（如 DeepSWE 编程榜）是在训练中定期拿当前权重跑一套固定题目，看模型在真实任务上的得分。它和训练时的成绩曲线不同：训练成绩是对当前这批题的采样得分，会随题目难度浮动；评测集固定，所以能横向对比不同步数、不同配置的真实能力。评测要离线（offline），是因为它不能干扰训练，通常单独起推理服务、使用独立 GPU。",

    infra: "大规模训练跑在成千上万张 GPU 上，按概率每天都必然会有硬件或网络故障：单卡 OOM、节点掉线、判分服务超时、某个数据集损坏。所以工程上不追求不崩，而是假定一定会崩，用三件事兜底：周期性 checkpoint 存档、崩溃后自动拉起并从存档恢复、对数据做校验发现污染就回滚。看板上会有重启次数这个指标，正是系统可靠性的直接体现。",

    finish: "一次 RL 训练不会一直跑下去：步数、预算或收敛判据到了就停，上游这时会把这次 run 标成 ended，不再上报新的 step。结束之后训练曲线就定格了，最后一步的分数只是那一批题上的采样结果，不代表模型的最终水平——真正对外的是离线评测（固定题库、单独起推理服务跑出来的分数）。所以判断一次训练成不成功，看的是评测集曲线和训练过程的稳定性（重启次数、熵有没有坍缩、零分率与满分率的比例），而不是曲线最后那一个点。",

    intro: "这个看板盯的是一次真实的强化学习（RL）训练。pro 与 flash 是两路独立训练，用同一套算法、不同配置同时跑，用来互相印证结论。RL 和监督微调最大的区别在于训练数据不是人写的，而是模型自己生成的：先让模型做题、对每题采样多个答案（rollout），判分后用得分折算成 advantage 更新参数（training），如此循环。所以页面上的每个指标，本质上都在回答「这一轮做题、判分、改参数，效果究竟如何」。",
  };

  function createEngine() {
    var feed = [];          // 解说流，最新在前
    var seq = 1;            // 条目自增序号，用于生成稳定 id（AI 异步改写要靠它定位）
    var curCtx = null;      // 最近一次事件的原始数据上下文，供 AI 解说参考
    var prev = {};          // run key -> 上次快照
    var lastStepTs = {};    // run key -> 上次完成 step 的时间
    var stallNotified = {}; // run key -> 已提示过停滞的 step
    var endedNotified = {}; // run key -> 已经说过「这次训练结束了」（只说一次）
    var seenNotices = {};   // 公告时间戳 -> 1
    var noticesPrimed = false;
    var started = false;
    var nowCache = [];
    var dirty = false;

    /* 返回新建的 item（去重时返回 null）。
       ai=false 表示这条是规则模板文案；被 AI 改写后 ai 会置 true。 */
    function push(level, run, text, why, official, lesson) {
      for (var i = 0; i < Math.min(8, feed.length); i++) {
        if (feed[i].text === text) return null; // 去重，避免轮询刷屏
      }
      var item = {
        id: "e" + (seq++) + "_" + Math.floor(Date.now() / 1000),
        ts: Date.now() / 1000, level: level, run: run,
        text: text, why: why || "", lesson: lesson || "", official: !!official,
        ai: false, aiState: "pending", ctx: curCtx || null,
      };
      feed.unshift(item);
      if (feed.length > MAX_ITEMS) feed.pop();
      dirty = true;
      return item;
    }

    /* AI 改写成功后回填。找不到就返回 false（可能已被挤出列表）。 */
    function markAI(id, text, why, model, lesson) {
      for (var i = 0; i < feed.length; i++) {
        if (feed[i].id === id) {
          feed[i].text = text;
          if (why) feed[i].why = why;
          feed[i].lesson = lesson || "";
          feed[i].ai = true;
          feed[i].aiState = "done";
          feed[i].aiModel = model || "";
          dirty = true;
          return true;
        }
      }
      return false;
    }

    /* AI 不可用/失败时标记，避免每轮重复请求 */
    function markAISkip(id, reason) {
      for (var i = 0; i < feed.length; i++) {
        if (feed[i].id === id) {
          feed[i].aiState = "skipped";
          feed[i].aiError = String(reason || "").slice(0, 120);
          dirty = true;
          return true;
        }
      }
      return false;
    }

    /* 还没交给 AI 处理过的条目（最新在前） */
    function pendingAI(limit) {
      var out = [];
      for (var i = 0; i < feed.length && out.length < (limit || 5); i++) {
        if (feed[i].aiState === "pending") out.push(feed[i]);
      }
      return out;
    }

    /* 把最近 n 条「规则版」重新排队，让 AI 补说一遍。
       用于刚连通时立刻看到效果，不用干等下一个事件。 */
    function requeueLast(n, includeAI) {
      var c = 0;
      for (var i = 0; i < feed.length && c < (n || 1); i++) {
        if (feed[i].aiState === "pending") continue;
        if (!includeAI && feed[i].ai) continue; // 默认只补说「规则」条目
        feed[i].aiState = "pending";
        feed[i].aiError = "";
        c++;
      }
      if (c) dirty = true;
      return c;
    }

    function diff(key, p, s) {
      var n = name(key);
      // 本轮事件的原始数值上下文，AI 解说时一并喂给模型，避免它瞎编数字
      curCtx = {
        run: key,
        before: { step: p.step, value: p.value, phase: p.phase, cost: p.cost, pr0: p.pr0, pr1: p.pr1, restarts: p.restarts, passrate: p.passrate },
        after: { step: s.step, value: s.value, phase: s.phase, cost: s.cost, pr0: s.pr0, pr1: s.pr1, restarts: s.restarts, passrate: s.passrate },
      };

      // 回滚重跑
      if (s.step != null && p.step != null && s.step < p.step) {
        push("warn", key, n + " 回滚到第 " + s.step + " 步重跑了。",
          "通常是上一步的数据被检测出污染（判分异常、轨迹损坏），整批作废并退回存档点重来。",
          false, LESSONS.rollback);
        return;
      }

      // 崩溃重启
      if (s.restarts != null && p.restarts != null && s.restarts > p.restarts) {
        push("bad", key, n + " 崩溃重启了一次（累计第 " + s.restarts + " 次）。",
          "进程崩溃后从最近的 checkpoint 恢复权重与优化器状态，已完成的步数不会丢；真正的代价是这一步已经投入的 rollout 算力。",
          false, LESSONS.restart);
      }

      // 阶段切换
      if (s.phase && s.phase !== p.phase) {
        if (s.phase === "rollout") {
          push("info", key, n + " 进入「生成」阶段。",
            "生成阶段（rollout）= 让模型对每道题采样 n 个答案并判分，产出这一轮的训练数据。",
            false, LESSONS.rollout);
        } else if (s.phase === "training") {
          push("info", key, n + " 进入「训练」阶段。",
            "训练阶段 = 用刚收集到的答案算 advantage 并更新参数，是真正改变模型的环节。",
            false, LESSONS.training);
        } else {
          push("info", key, n + " 进入「" + s.phase + "」阶段。", "");
        }
      }

      // 满分率飙升
      if (s.pr1 != null && p.pr1 != null && s.pr1 - p.pr1 > 0.08) {
        push("warn", key, n + " 的满分率升到 " + pct1(s.pr1) + "。",
          "满分率是 n 次尝试全部答对的题占比。这类题组内方差为 0，advantage 恒为 0，梯度归零，算力白烧。",
          false, LESSONS.pr1);
      }
      // 零分率飙升
      if (s.pr0 != null && p.pr0 != null && s.pr0 - p.pr0 > 0.08) {
        push("warn", key, n + " 的零分率升到 " + pct1(s.pr0) + "。",
          "零分率是 n 次尝试全部答错的题占比。与满分率同理，组内方差为 0，梯度归零，样本无效。",
          false, LESSONS.pr0);
      }

      // 花费破百万
      if (s.cost != null && p.cost != null) {
        var a = Math.floor(p.cost / 1e6), b = Math.floor(s.cost / 1e6);
        if (b > a) {
          push("info", key, n + " 的花费突破 " + b + " 百万美元了（现在 " + money(s.cost) + "）。",
            "这是真实算力账单，主要由 rollout 生成、沙箱执行与判分服务三块构成。",
            false, LESSONS.cost);
        }
      }

      // 完成新的一步（放最后推，这样它显示在最上面）
      if (s.step != null && p.step != null && s.step > p.step) {
        var d = s.value != null && p.value != null ? s.value - p.value : null;
        if (d == null) {
          push("info", key, n + " 完成了第 " + s.step + " 步，成绩 " + f4(s.value) + "。",
            "本步只推进了步数，成绩尚未回传。");
        } else if (d > 0) {
          push("good", key, n + " 完成第 " + s.step + " 步，成绩涨到 " + f4(s.value) + "（+" + d.toFixed(4) + "）。",
            "成绩上涨说明这批题组内存在区分度、产生了有效梯度，参数更新方向是对的。",
            false, LESSONS.step);
        } else if (Math.abs(d) >= 0.01) {
          push("warn", key, n + " 完成第 " + s.step + " 步，成绩降到 " + f4(s.value) + "（" + d.toFixed(4) + "）。",
            "跌幅较大。每步换一批新题，难度分布本就不同；单点下跌不足以判断，要看多步移动平均是否同向。",
            false, LESSONS.step);
        } else {
          push("info", key, n + " 完成第 " + s.step + " 步，成绩 " + f4(s.value) + "（" + d.toFixed(4) + "）。",
            "小幅波动。单步成绩受题目难度与采样随机性影响天然抖动，看趋势不看单点。");
        }
      }
    }

    function checkNotices(state) {
      var ns = state.notices || [];
      if (!noticesPrimed) {
        ns.forEach(function (x) { seenNotices[x.t] = 1; });
        noticesPrimed = true;
        return;
      }
      ns.forEach(function (x) {
        if (seenNotices[x.t]) return;
        seenNotices[x.t] = 1;
        curCtx = { official: true, notice: x.text };
        push("bad", null, "官方发了新公告：" + x.text, noticeHint(x.text), true,
          /deepswe|eval/i.test(x.text) ? LESSONS.eval : LESSONS.infra);
        curCtx = null;
      });
    }

    function update(state) {
      if (!state || !state.ok) return;
      var runs = (state.meta && state.meta.runs) || [];
      var items = [];

      runs.forEach(function (r) {
        var key = r.key, st = state.status[key];
        if (!st) return;
        var lv = state.live[key] && state.live[key].latest;
        var s = snap(st, lv);
        var p = prev[key];
        if (p) diff(key, p, s);
        if (s.step != null && (!p || p.step !== s.step)) lastStepTs[key] = Date.now() / 1000;

        /* 上游把这次 run 标成 ended 了：它不再上报新的 step。
           这时候「第 N 步还没结束」是假话 —— 不是卡住，是跑完了。
           所以必须先判 ended 再看停滞，否则最后一条解说会永远停在「仍未结束」。 */
        var ended = !!(st.run && (st.run.mode === "ended" || st.run.end != null));
        if (ended) {
          if (!endedNotified[key]) {
            endedNotified[key] = 1;
            var ri = st.run || {};
            var span = (ri.start && ri.end)
              ? "，一共跑了 " + ((ri.end - ri.start) / 3600).toFixed(1) + " 小时" : "";
            curCtx = {
              run: key, ended: true, step: s.step, value: s.value, cost: s.cost,
              restarts: s.restarts, start: ri.start || null, end: ri.end || null,
            };
            /* 如果之前为同一步发过「还没结束」，就在解释里接上：
               那条是它还在跑的时候说的，不是卡死。改历史文案不如纠正它。 */
            var whyEnd = "上游把这次 run 标记为 ended，不再有新的 step 上报，之后所有数字都不会再变。" +
              (stallNotified[key] === s.step
                ? " 上面「第 " + s.step + " 步还没结束」那条是它还在跑的时候说的，不是卡死。" : "");
            push("good", key,
              name(key) + " 的训练已经结束：停在第 " + s.step + " 步，成绩 " + f4(s.value) + span + "。",
              whyEnd, false, LESSONS.finish);
            curCtx = null;
          }
        } else if (s.step != null && lastStepTs[key] && stallNotified[key] !== s.step) {
          /* 这一步跑了多久，用上游自己的时间算（clock.now − 这一步的墙钟起点），
             不用本地「我盯了多久」—— 后者服务一重启就归零，会低估。 */
          var wall = (st.step && st.step.last_wall) || lastStepTs[key];
          var clkN = (st.clock && st.clock.now) || Date.now() / 1000;
          var gap = clkN - wall;
          if (gap > 3.5 * 3600) {
            stallNotified[key] = s.step;
            push("info", key, name(key) + " 在第 " + s.step + " 步已经跑了 " + (gap / 3600).toFixed(1) + " 小时还没结束。",
              "时间主要花在 rollout 上：几万道题各采样 n 次并逐 token 解码，判分还要等生成结束才能开始。",
              false, LESSONS.stall);
          }
        }
        prev[key] = s;

        var sp = st.step || {}, hl = st.headline || {}, cost = st.cost || {};
        items.push({
          key: key,
          label: r.label || key,
          color: color(key),
          step: sp.last != null ? sp.last : null,
          ended: ended,
          phase: ended ? "已结束"
            : sp.phase === "rollout" ? "正在让模型大量做题"
            : sp.phase === "training" ? "正在用刚收集的答案更新模型" : "运行中",
          progress: sp.progress != null ? sp.progress : null,
          value: hl.last != null ? hl.last : null,
          judgedPct: lv && lv.judged_of ? Math.round((lv.judged / lv.judged_of) * 100) : null,
          cost: cost.so_far != null ? cost.so_far : null,
        });
      });

      nowCache = items;
      checkNotices(state);

      if (!started) {
        started = true;
        curCtx = null;
        push("info", null,
          "解说已开启。pro 和 flash 是两个独立训练任务，用同一套方法、不同配置，可以互相印证结果。我会一直盯着，有变化就告诉你。",
          "这条记录由服务端持续生成并落盘，刷新页面也不会丢。点「展开讲讲」可以看这次训练到底在做什么。",
          false, LESSONS.intro);
      }
    }

    return {
      update: update,
      getFeed: function () { return feed.slice(); },
      getNow: function () { return nowCache; },
      isDirty: function () { var v = dirty; dirty = false; return v; },
      pendingAI: pendingAI,
      requeueLast: requeueLast,
      markAI: markAI,
      markAISkip: markAISkip,
      serialize: function () {
        return {
          v: 2, feed: feed, prev: prev, lastStepTs: lastStepTs, seq: seq,
          stallNotified: stallNotified, endedNotified: endedNotified,
          seenNotices: seenNotices,
          noticesPrimed: noticesPrimed, started: started, now: nowCache,
        };
      },
      hydrate: function (d) {
        if (!d || typeof d !== "object") return;
        feed = Array.isArray(d.feed) ? d.feed : [];
        // 老版本日志没有 id / aiState，补齐，避免 AI 层拿到脏数据
        feed.forEach(function (it, i) {
          if (!it.id) it.id = "legacy_" + i;
          if (!it.aiState) it.aiState = it.ai ? "done" : "skipped";
          if (it.ai == null) it.ai = false;
        });
        seq = Number(d.seq) || (feed.length + 1);
        prev = d.prev || {};
        lastStepTs = d.lastStepTs || {};
        stallNotified = d.stallNotified || {};
        endedNotified = d.endedNotified || {};
        seenNotices = d.seenNotices || {};
        noticesPrimed = !!d.noticesPrimed;
        started = !!d.started;
        nowCache = Array.isArray(d.now) ? d.now : [];
      },
    };
  }

  return { createEngine: createEngine, RUN_COLOR: RUN_COLOR, RUN_NAME: RUN_NAME };
});
