/* AI 训练教练 —— 站点右下角悬浮入口 + 右侧对话抽屉
   ================================================================
   和后端的分工：这里只管「界面 + 把此刻在看什么报上去 + 把流渲染成消息」。
   问题该怎么理解、工具该怎么用、答成什么样，全在 src/coach.js 的提示词里。

   后端的事件协议（NDJSON，逐行一个 JSON，和图表讲解那一套完全一样）：
     {"delta":"…"}                                   正文片段
     {"think":"…","phase":"tool"|"main","round":n}   思考过程
     {"tool":{name,args,summary,round}}              调了哪个查询工具、查到什么
     {"notice":"…"}                                  后端要重试了，说明原因
     {"restart":{attempt,reason}}                    重跑正文轮，上一次的内容收起来
     {"done":true,model,toolRounds,attempts,truncated}
     {"error":"…"}                                   失败原因（后端已翻成人话）

   和「图表讲解」抽屉（app.js 里的 gl-drawer）的区别：
     讲解  点一张图 → 讲这张图 → 单轮，关掉就结束，结果按图缓存；
     教练  随口问 → 它自己决定查哪些数据 → 多轮追问，历史一直带着。
   两者都是右侧 fixed 抽屉、会叠在一起，所以开教练时先把讲解关掉。 */
(function () {
  "use strict";

  if (location.protocol === "file:") return; // 数据要靠本地服务，双击打开时整页已被 app.js 换掉

  var MIMO = window.MIMO || {};
  var esc = MIMO.esc || function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  var toolZh = MIMO.toolZh || function (n) { return n || "查询"; };

  var HISTORY_MAX = 8;           // 回传几轮历史，和后端 COACH_HISTORY_MAX 对齐
  var CTX_KEY = "mtl-coach-ctx"; // 「参考当前页面」开关的记忆
  var GREET_TEXT = "我是 AI 训练教练。这块板爬下来的数据我都能查 —— 两个 run 的逐指标历史、" +
    "离线评测分数、训练进度与花费，还有看板记下来的事件解说；训练上的概念也可以直接问。" +
    "问我之前，我会自己决定该去查哪些数据。";

  var QUICK = [
    "现在训练状态怎么样？该重点盯哪几个指标",
    "最近训练出过什么问题",
    "核心指标和离线评测分数对得上吗",
    "熵坍缩是什么，在这块板上怎么看出来",
  ];

  var msgs = [];    // 对话内容，只存 { role, content } —— 原样回传给后端当 history
  var busy = false; // 正在生成
  var token = 0;    // 自增让旧流的回调失效，避免两次回答互相覆盖
  var ctl = null;   // AbortController，用于「停止」
  var useCtx = localStorage.getItem(CTX_KEY) !== "0";
  var avail = null; // null=还没探测；true/false=AI 可用与否

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function nearBottom(box) {
    return !box || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  }
  function toBottom(box) {
    if (box) box.scrollTop = box.scrollHeight;
  }

  /* ---------------- 正文渲染：先转义，再补几样最轻的排版 ----------------
     教练的回答会带列表与小标题，纯 pre-wrap 看着太糊。这里只认三样：
       ### 小标题     行首「- 」列表项     **加粗**
     全部在 esc() 之后做，所以模型输出里的 <script> 之类只会显示成字面量。 */
  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`\n]+)`/g, '<code class="coach-code">$1</code>');
  }

  function rich(text) {
    var lines = String(text || "").split("\n");
    var out = [], inList = false;
    function closeList() { if (inList) { out.push("</ul>"); inList = false; } }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { closeList(); continue; }
      var h = /^#{2,4}\s+(.+)$/.exec(t);
      if (h) { closeList(); out.push('<div class="coach-h">' + inline(h[1]) + "</div>"); continue; }
      var li = /^[-*·]\s+(.+)$/.exec(t);
      if (li) {
        if (!inList) { out.push('<ul class="coach-ul">'); inList = true; }
        out.push("<li>" + inline(li[1]) + "</li>");
        continue;
      }
      closeList();
      out.push('<p class="coach-p">' + inline(t) + "</p>");
    }
    closeList();
    return out.join("");
  }

  /* ---------------- 消息渲染 ---------------- */

  function body() { return $("coach-body"); }

  function pushWho(role, text) {
    var wrap = el("div", "coach-msg coach-msg-" + (role === "user" ? "me" : "ai"));
    if (role !== "user") wrap.appendChild(el("div", "coach-who", "教练"));
    var bub = el("div", "coach-bub");
    if (role === "user") {
      bub.textContent = text;
    } else {
      bub.innerHTML = rich(text);
    }
    wrap.appendChild(bub);
    body().appendChild(wrap);
    toBottom(body());
    return wrap;
  }

  /* 一条教练消息的骨架。返回一个 view 对象，流式回调往它上面写。 */
  function pushAi() {
    var wrap = el("div", "coach-msg coach-msg-ai");
    wrap.appendChild(el("div", "coach-who", "教练"));
    var bub = el("div", "coach-bub");
    var status = el("span", "coach-status");
    status.hidden = true;
    var steps = el("div", "coach-steps");
    steps.hidden = true;

    var think = el("details", "coach-think");
    think.hidden = true;
    var tsum = el("summary");
    var tspin = el("span", "coach-spin");
    var tt = el("span", "coach-think-t", "思考过程");
    tsum.appendChild(tspin);
    tsum.appendChild(tt);
    var tbox = el("div", "coach-think-b");
    think.appendChild(tsum);
    think.appendChild(tbox);

    var out = el("div", "coach-out is-wait", "教练正在看数据…");

    bub.appendChild(status);
    bub.appendChild(steps);
    bub.appendChild(think);
    bub.appendChild(out);
    wrap.appendChild(bub);
    body().appendChild(wrap);
    toBottom(body());

    return {
      wrap: wrap, status: status, steps: steps, think: think,
      thinkTitle: tt, thinkBox: tbox, out: out,
      acc: "", thinkText: "", err: "", model: "", started: false,
      stepsMap: {}, cur: null, pend: null, tools: 0, truncated: false,
    };
  }

  /* 一轮「决策 → 调用」一个折叠块，标题带轮次；轮次是后端给的（模型想一次 = 一轮），
     前端不自己猜边界 —— 不然会把同一轮的几次调用拆成好几组。 */
  function stepFor(v, n) {
    n = n || 1;
    if (v.cur && v.cur.round === n) return v.cur;
    if (v.pend && v.pend.round !== n) flushPend(v);
    closeStep(v);
    var s = v.stepsMap[n];
    if (!s) {
      var d = el("details", "coach-step");
      var sum = el("summary");
      sum.appendChild(el("span", "coach-spin"));
      sum.appendChild(el("span", null, "第 " + n + " 轮查询"));
      var cnt = el("span", "coach-step-c");
      sum.appendChild(cnt);
      var b = el("div", "coach-step-b");
      var tools = el("div", "coach-tools");
      tools.hidden = true;
      d.appendChild(sum);
      d.appendChild(b);
      d.appendChild(tools);
      v.steps.appendChild(d);
      v.steps.hidden = false;
      s = { round: n, el: d, box: b, tools: tools, cnt: cnt, text: "", calls: 0 };
      v.stepsMap[n] = s;
    }
    if (v.pend && v.pend.round === n) {
      s.text += v.pend.text;
      s.box.textContent = s.text;
      v.pend = null;
    }
    v.cur = s;
    return s;
  }

  function closeStep(v) {
    if (v.cur && v.cur.el) v.cur.el.classList.remove("is-live");
  }

  /* 模型想了一轮却决定「不用查」时，那段思考不该占一个空块 ——
     并进下面的「思考过程」里，它确实是在分析而不是在决策。 */
  function flushPend(v) {
    if (!v.pend || !v.pend.text) { v.pend = null; return; }
    v.thinkText += (v.thinkText ? "\n\n" : "") + v.pend.text;
    v.pend = null;
  }

  function addTool(v, info) {
    var s = stepFor(v, info.round || 1);
    s.calls++;
    s.cnt.textContent = s.calls + " 次调用";
    s.tools.hidden = false;
    var row = el("div", "coach-tool");
    row.appendChild(el("span", "coach-tool-n", toolZh(info.name)));
    row.appendChild(el("span", "coach-tool-s", info.summary || ""));
    s.tools.appendChild(row);
    v.tools++;
  }

  function setThinkLive(v, on) {
    v.think.classList.toggle("is-live", !!on);
    v.thinkTitle.textContent = on ? "正在思考…" : "思考过程";
  }

  /* ---------------- 一轮问答 ---------------- */

  function setBusyUI(on) {
    var go = $("coach-go"), stop = $("coach-stop"), q = $("coach-q");
    if (go) go.hidden = !!on;
    if (stop) stop.hidden = !on;
    if (q) q.disabled = !!on;
  }

  function send() {
    var q = $("coach-q");
    var text = String((q && q.value) || "").trim();
    if (!text || busy || avail === false) return;
    if (q) { q.value = ""; grow(q); }

    // 历史必须在把本轮问题放进去之前取 —— 本轮问题单独走 question 字段传，
    // 否则后端会看到同一个问题出现两次。
    var hist = msgs.slice(-HISTORY_MAX).map(function (m) {
      return { role: m.role, content: m.content };
    });
    msgs.push({ role: "user", content: text });
    pushWho("user", text);
    hideQuick();
    run(text, hist);
  }

  function run(text, hist) {
    var ctx = null;
    if (useCtx && typeof MIMO.getContext === "function") {
      try { ctx = MIMO.getContext(); } catch (e) { ctx = null; }
    }

    var v = pushAi();
    var my = ++token;
    busy = true;
    ctl = typeof AbortController === "function" ? new AbortController() : null;
    setBusyUI(true);

    function live() { return my === token && v; }

    function finish() {
      if (!live()) return;
      busy = false;
      ctl = null;
      setBusyUI(false);
      flushPend(v);
      closeStep(v);
      if (v.thinkBox) v.thinkBox.textContent = v.thinkText;
      if (v.thinkText) v.think.hidden = false;
      setThinkLive(v, false);
      v.status.hidden = true;

      var txt = v.err ? "" : String(v.acc).replace(/^[\s　]+/, "");
      // 兜底：推理型模型偶尔只输出思考、正文空白。给个空白框没意义，
      // 把思考当正文呈现，至少把思路交代清楚（完整版仍在思考框里）。
      if (!txt && !v.err && v.thinkText) txt = String(v.thinkText).replace(/^[\s　]+/, "");

      if (v.err) {
        v.out.className = "coach-out is-err";
        v.out.hidden = false;
        v.out.textContent = v.err;
      } else if (txt) {
        if (v.truncated) {
          var w = el("div", "coach-warn", "这段在生成过程中断，可能不完整，可以再问一次让它接着说");
          v.out.parentNode.insertBefore(w, v.out);
        }
        v.out.className = "coach-out";
        v.out.innerHTML = rich(txt);
        msgs.push({ role: "assistant", content: txt });
      } else {
        v.out.hidden = true;
      }
      refreshCtx();
      toBottom(body());
    }

    fetch("api/coach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: text, history: hist,
        context: ctx, useContext: useCtx,
      }),
      signal: ctl ? ctl.signal : undefined,
    }).then(function (r) {
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      return pump(r.body.getReader(), v, live);
    }).then(finish).catch(function (e) {
      if (!live()) return;
      if (!v.err) {
        v.err = (e && e.name === "AbortError")
          ? "已停止生成"
          : (String((e && e.message) || e) || "生成失败");
      }
      finish();
    });
  }

  /* 逐块解析 NDJSON。返回 false 表示这一条流已经作废（用户又发了一轮），
     后面别再往 DOM 上写。 */
  function pump(reader, v, live) {
    var dec = new TextDecoder("utf-8");
    var buf = "";
    function step() {
      return reader.read().then(function (r) {
        if (r.done) return;
        if (!live()) { try { reader.cancel(); } catch (e) {} return; }
        buf += dec.decode(r.value, { stream: true });
        var lines = buf.split("\n");
        buf = lines.pop() || "";
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          if (!live()) return;
          var j;
          try { j = JSON.parse(lines[i]); } catch (e) { continue; }
          handle(j, v);
        }
        return step();
      });
    }
    return step();
  }

  function handle(j, v) {
    if (j.delta) {
      // 第一段正文到了：撤掉占位、关掉「正在思考」的转圈
      if (!v.started) {
        v.started = true;
        v.out.className = "coach-out is-typing";
        v.out.textContent = "";
        setThinkLive(v, false);
      }
      v.acc += j.delta;
      v.out.textContent = v.acc;
      if (v.status) { v.status.hidden = false; v.status.textContent = "正在回答…"; }
      if (nearBottom(body())) toBottom(body());
      return;
    }
    if (j.tool) {
      var info = j.tool || {};
      addTool(v, info);
      v.status.hidden = false;
      v.status.textContent = "正在" + toolZh(info.name) + "…";
      if (!v.started && v.out.classList.contains("is-wait")) {
        v.out.textContent = "教练正在查数据…";
      }
      return;
    }
    if (j.think) {
      if (j.phase === "tool") {
        // 「决定查什么」的思考进本轮查询块；这一轮最后没真调用的话，
        // 收尾时会并进「思考过程」（见 flushPend）
        var rn = j.round || 1;
        var ex = v.stepsMap[rn];
        if (ex) {
          ex.text += j.think;
          ex.box.textContent = ex.text;
          ex.el.classList.add("is-live");
        } else {
          if (!v.pend || v.pend.round !== rn) { flushPend(v); v.pend = { round: rn, text: "" }; }
          v.pend.text += j.think;
        }
        if (!v.started) v.out.textContent = "教练正在决定查什么…";
        v.status.hidden = false;
        v.status.textContent = "正在决定查什么…";
      } else {
        flushPend(v);
        closeStep(v);
        v.thinkText += j.think;
        v.think.hidden = false;
        v.thinkBox.textContent = v.thinkText;
        if (!v.think.classList.contains("is-live")) setThinkLive(v, true);
        if (!v.started) v.out.textContent = "教练正在分析…";
        v.status.hidden = false;
        v.status.textContent = "正在分析…";
      }
      return;
    }
    if (j.notice) {
      v.status.hidden = false;
      v.status.textContent = j.notice;
      return;
    }
    if (j.restart) {
      /* 重跑正文轮。上一版内容不丢，收成一个折叠块留在上面 ——
         用户可能正看到一半，突然被换掉会以为看错了。 */
      var cur = String(v.out.textContent || "").trim();
      if (cur && v.started) {
        var d = el("details", "coach-think coach-partial");
        var sum = el("summary", null, "上一次没写完 · 点开看已有的部分");
        var box = el("div", "coach-think-b", cur);
        d.appendChild(sum);
        d.appendChild(box);
        v.out.parentNode.insertBefore(d, v.out);
      }
      v.started = false;
      v.acc = "";
      v.thinkText = "";
      v.think.hidden = true;
      v.thinkBox.textContent = "";
      setThinkLive(v, false);
      v.out.hidden = false;
      v.out.className = "coach-out is-wait";
      v.out.textContent = "教练正在重新组织回答…";
      return;
    }
    if (j.done) {
      v.model = j.model || "";
      v.truncated = !!j.truncated;
      return;
    }
    if (j.error) v.err = j.error;
  }

  /* ---------------- 上下文条 ---------------- */
  /* 「参考当前页面」是可关的：关掉之后后端一个字都收不到，
     回答就不会受「你正在看什么」的暗示影响。开关状态记在 localStorage。 */
  function refreshCtx() {
    var sw = $("coach-ctx-sw"), t = $("coach-ctx-t");
    if (!sw || !t) return;
    var ctx = null;
    if (typeof MIMO.getContext === "function") {
      try { ctx = MIMO.getContext(); } catch (e) { ctx = null; }
    }
    var label = "";
    if (ctx) {
      if (ctx.chartName) label = "在看「" + ctx.chartName + "」";
      else if (ctx.view) label = "在" + ({ overview: "总览", metrics: "指标库", about: "关于" }[ctx.view] || ctx.view);
    }
    sw.textContent = useCtx ? "参考当前页面：开" : "参考当前页面：关";
    sw.setAttribute("aria-pressed", useCtx ? "true" : "false");
    sw.classList.toggle("on", useCtx);
    t.textContent = useCtx
      ? (label ? "会带上：" + label : "会带上你此刻所在的页面")
      : "已关闭，教练只看你问的话";
  }

  /* ---------------- 快捷问题 ---------------- */
  function renderQuick() {
    var box = $("coach-quick");
    if (!box) return;
    box.innerHTML = "";
    QUICK.forEach(function (q) {
      var b = el("button", "coach-chip", q);
      b.type = "button";
      b.addEventListener("click", function () {
        var t = $("coach-q");
        if (t) t.value = q;
        send();
      });
      box.appendChild(b);
    });
  }
  function hideQuick() {
    var box = $("coach-quick");
    if (box) box.hidden = true;
  }

  /* ---------------- 开关抽屉 ---------------- */
  function openPanel() {
    var d = $("coach-drawer"), m = $("coach-mask");
    if (!d) return;
    // 图表讲解抽屉也是右侧 fixed，两个叠在一起会打架：先把那个关掉
    var glDrawer = $("gl-drawer"), glClose = $("gl-close");
    if (glDrawer && !glDrawer.hidden && glClose) glClose.click();

    d.hidden = false;
    if (m) m.hidden = false;
    refreshCtx();
    if (avail === null) probe();
    if (!body().childNodes.length) {
      pushWho("ai", GREET_TEXT);
      renderQuick();
    }
    var q = $("coach-q");
    if (q) setTimeout(function () { try { q.focus(); } catch (e) {} }, 30);
  }

  function closePanel() {
    var d = $("coach-drawer"), m = $("coach-mask");
    if (d) d.hidden = true;
    if (m) m.hidden = true;
  }

  /* 探测模型可用性：不可用就把输入区禁掉、在顶部说清楚，
     而不是让人打完一长段问题才收到报错。 */
  function probe() {
    fetch("api/ai/test", { cache: "no-store" }).then(function (r) { return r.json(); })
      .then(function (j) {
        avail = !!(j && j.enabled && j.ok);
        renderAvail(j);
      })
      .catch(function () { avail = false; renderAvail(null); });
  }

  function renderAvail(j) {
    var q = $("coach-q"), go = $("coach-go");
    if (avail) {
      if (q) q.disabled = busy;
      return;
    }
    if (q) { q.disabled = true; q.placeholder = "AI 未接入，无法提问"; }
    if (go) go.disabled = true;
    var tip = el("div", "coach-warn", "AI 教练没接上：" +
      ((j && j.lastError) || (j && j.error) || "模型服务不可用") +
      "。检查 config.json 里的 llm 段，或点右上角刷新重试。");
    body().appendChild(tip);
  }

  function grow(t) {
    if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 132) + "px";
  }

  var bound = false;

  function bind() {
    /* 防重复绑定。真实浏览器里不会重复（script 在 body 末尾，DOMContentLoaded 只来一次），
       但 jsdom 下 eval 的时机与手动派发会让它跑两趟 —— 那样每个监听器都挂两份，
       点一下「参考当前页面」开关会被取反两次、看着像没反应。
       app.js 的 bindGlossary 用 _done 防的是同一件事。 */
    if (bound) return;
    bound = true;

    var fab = $("coach-fab");
    if (!fab) return;

    fab.addEventListener("click", openPanel);
    var c = $("coach-close");
    if (c) c.addEventListener("click", closePanel);
    var m = $("coach-mask");
    if (m) m.addEventListener("click", closePanel);

    var sw = $("coach-ctx-sw");
    if (sw) {
      sw.addEventListener("click", function () {
        useCtx = !useCtx;
        localStorage.setItem(CTX_KEY, useCtx ? "1" : "0");
        refreshCtx();
      });
    }

    var form = $("coach-form");
    if (form) {
      form.addEventListener("submit", function (e) { e.preventDefault(); send(); });
    }
    var q = $("coach-q");
    if (q) {
      q.addEventListener("input", function () { grow(q); });
      q.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      });
    }
    var stop = $("coach-stop");
    if (stop) {
      stop.addEventListener("click", function () {
        if (ctl) { try { ctl.abort(); } catch (e) {} }
      });
    }

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var d = $("coach-drawer");
      if (d && !d.hidden) closePanel();
    });

    // 视图或打开的图表变了就刷新上下文条，让人随时知道「它现在知道什么」
    window.addEventListener("hashchange", refreshCtx);
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("[data-gk],[data-gm],.qbtn[data-g],.gb-btn[data-g]")) setTimeout(refreshCtx, 60);
    });

    // 打开页面就先探一次：这样点开球的时候不会先看到一个空壳
    probe();
    refreshCtx();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  window.MIMO_COACH = { send: send, open: openPanel, close: closePanel, msgs: msgs };
})();
