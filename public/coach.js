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
  var SID_KEY = "mtl-coach-sid"; // 上次在聊哪一段对话（刷新后接着那一段）
  var GREET_TEXT = "我是 AI 训练教练。这块板爬下来的数据我都能查 —— 两个 run 的逐指标历史、" +
    "离线评测分数、训练进度与花费，还有看板记下来的事件解说；训练上的概念也可以直接问。" +
    "问我之前，我会自己决定该去查哪些数据。";

  var QUICK = [
    "现在训练状态怎么样？该重点盯哪几个指标",
    "最近训练出过什么问题",
    "核心指标和离线评测分数对得上吗",
    "熵坍缩是什么，在这块板上怎么看出来",
  ];

  /* 会话（sid）：一段对话一个 sid。库里那份才是准的（刷新后还在），
     前端这份 msgs 只是「当前显示的内容 + 库不可用时回传给后端」的兜底。 */
  var msgs = [];    // 对话内容，只存 { role, content } —— 原样回传给后端当 history
  var sid = "";     // 当前会话；为空表示还没拿到（后端会归到默认会话）
  var sessList = [];    // 会话列表（切换下拉用）
  var histPending = 0;  // 还有几次历史请求在飞（避免欢迎语被插两遍）
  var busy = false; // 正在生成
  var token = 0;    // 自增让旧流的回调失效，避免两次回答互相覆盖
  var ctl = null;   // AbortController，用于「停止」
  var useCtx = localStorage.getItem(CTX_KEY) !== "0";
  var avail = null; // null=还没探测；true/false=AI 可用与否
  var armed = false;      // 「清空」按钮是否已进入待确认状态
  var armedTimer = null;  // 待确认的自动复原计时器

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
     教练的回答会带列表、小标题和对比表，纯 pre-wrap 看着太糊。这里只认四样：
       ### 小标题   行首「- 」列表项   **加粗**   markdown 表格
     全部在 esc() 之后做，所以模型输出里的 <script> 之类只会显示成字面量。

     注意：渲染只发生在收尾（finish）那一次，流式期间上屏的是纯文本。
     表格尤其如此 —— 生成途中会看到一堆竖线，收尾才成表格。 */
  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`\n]+)`/g, '<code class="coach-code">$1</code>');
  }

  /* 表格的识别条件（两道，缺一不可）：
       1) 这一行 trim 后以竖线开头；
       2) 紧跟的下一行是分隔行（|---|:--:| 之类）。
     只认第一道的话，正文里偶发的「a | b」也会被当成表格 —— 所以必须成对出现，
     文案侧（src/coach.js）同样约定了「首尾都要竖线、表头下面必须有分隔行」。
     列数以表头为准，多出来的截掉、缺的补空，避免参差不齐把版面撑歪。 */
  function isTableRow(l) { return /^\s*\|/.test(l); }
  function isTableSep(l) {
    return /^\|\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|$/.test(String(l).trim());
  }
  function tableCells(l) {
    var s = String(l).trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|").map(function (x) { return x.trim(); });
  }
  function tableHtml(rows) {
    var w = rows[0].length;
    function tr(cs, tag) {
      var tds = [];
      for (var k = 0; k < w; k++) {
        tds.push("<" + tag + ">" + inline(cs[k] || "") + "</" + tag + ">");
      }
      return "<tr>" + tds.join("") + "</tr>";
    }
    return '<div class="coach-tw"><table class="coach-table"><thead>' +
      tr(rows[0], "th") + "</thead><tbody>" +
      rows.slice(1).map(function (r) { return tr(r, "td"); }).join("") +
      "</tbody></table></div>";
  }

  /* 代码块：成对的三反引号，围栏单独成行。
     块内只转义 HTML，不做 markdown 替换（块里出现的 ** 就是字面量 ** ）。
     没找到闭合围栏时按普通文本处理，这样即使模型忘了收尾也不会把整篇正文都吃进代码块。 */
  function isFence(l) { return /^```\s*(\S*)\s*$/.test(String(l || "")); }

  function rich(text) {
    var lines = String(text || "").split("\n");
    var out = [], inList = false;
    function closeList() { if (inList) { out.push("</ul>"); inList = false; } }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { closeList(); continue; }

      /* 代码块优先于所有其他排版：否则 ``` 也会被表格的 | 逻辑干扰 */
      if (isFence(lines[i])) {
        /* 先找闭合围栏再决定是否成立。找不到就不成立 ——
           否则一个漏了收尾的 ``` 会把后面整篇正文都吃进等宽块里，
           用户看到的是一坨没有排版的文字。降级成普通段落最多露出三个反引号。 */
        var end = -1;
        for (var k = i + 1; k < lines.length; k++) {
          if (isFence(lines[k])) { end = k; break; }
        }
        if (end < 0) {
          closeList();
          out.push('<p class="coach-p">' + inline(t) + "</p>");
          continue;
        }
        closeList();
        out.push('<pre class="coach-pre"><code class="coach-code-block">' +
          esc(lines.slice(i + 1, end).join("\n")) + '</code></pre>');
        i = end;                                    // 外层 for 还要自增一次，正好落在闭合行之后
        continue;
      }

      if (isTableRow(lines[i]) && isTableSep(lines[i + 1])) {
        closeList();
        var rows = [tableCells(lines[i])];
        i += 2;                                     // 跳过表头行与分隔行
        while (i < lines.length && isTableRow(lines[i])) { rows.push(tableCells(lines[i])); i++; }
        i--;                                        // 外层 for 还要自增一次
        out.push(tableHtml(rows));
        continue;
      }
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
    var hist = msgs.map(function (m) {
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
        /* 即使后端报错了，如果思考过程里已经有内容，就把思考呈现出来，
           而不是只给一个空白/红框。很多情况下模型其实已经想明白了，
           只是正文输出没达到成稿门槛（比如简单的是非问只有十几字）。 */
        if (!txt && v.thinkText) txt = String(v.thinkText).replace(/^[\s　]+/, "");
        if (txt) {
          v.out.className = "coach-out";
          v.out.hidden = false;
          v.out.innerHTML = rich(txt);
          var errNote = el("div", "coach-warn", "（模型未按预期格式完成，以上是它的思考过程）");
          v.out.parentNode.insertBefore(errNote, v.out.nextSibling);
        } else {
          v.out.className = "coach-out is-err";
          v.out.hidden = false;
          v.out.textContent = v.err;
        }
      } else if (txt) {
        if (v.truncated) {
          var w = el("div", "coach-warn", "这段在生成过程中断，可能不完整，可以再问一次让它接着说");
          v.out.parentNode.insertBefore(w, v.out);
        }
        v.out.className = "coach-out";
        v.out.innerHTML = rich(txt);
        msgs.push({ role: "assistant", content: txt });
        refreshClearUI();
        /* 会话标题是拿第一句话起的（后端写的）：第一轮回完刷一次列表，
           下拉里就不再是「未命名对话」了。之后每轮都刷会打断正在展开的下拉。 */
        var cur = currentSess();
        if (!cur || !cur.title) refreshSessions();
      } else {
        v.out.hidden = true;
      }
      refreshCtx();
      /* 生成结束时只在用户本来就贴着底部时才自动跟到底；
         如果用户正在翻看上面的历史，别强行把他拉下来。 */
      var box = body();
      if (nearBottom(box)) toBottom(box);
    }

    fetch("api/coach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: text, history: hist, sid: sid,
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
    /* 上下文水位：这一轮占窗口的百分之多少、有没有压过。
       放在这里显示，不是为了好看 —— 压缩是后端悄悄做的，
       用户得知道「更早的对话被压成摘要了」，不然会觉得它忘了。 */
    if (j.context) { setMeter(j.context); return; }
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
  /* ---------------- 会话：新对话 / 切换 / 水位 ----------------
     后端按 sid 存整段对话（原文照存，压缩只动发给模型那一份），
     这里负责：拉列表、记住上次在聊哪段、切过去、开新的一段。 */
  function rememberSid() {
    try { localStorage.setItem(SID_KEY, sid || ""); } catch (e) {}
  }

  function renderSessions() {
    var sel = $("coach-sess");
    if (!sel) return;
    var keep = sid || sel.value;
    sel.innerHTML = "";
    sessList.forEach(function (s) {
      var o = el("option", null, (s.title || "未命名对话") + "（" + (s.msgs || 0) + " 条）");
      o.value = s.sid;
      sel.appendChild(o);
    });
    sel.value = keep;
    if (sel.value !== keep) sel.value = ""; // 这段已经被删了，等下一次列表刷新
  }

  function refreshSessions() {
    return fetch("api/coach/sessions", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        sessList = (j && Array.isArray(j.sessions)) ? j.sessions : [];
        renderSessions();
        return sessList;
      })
      .catch(function () { return sessList; });
  }

  /* 切到某段对话：清掉界面上现有的内容，再把它自己的历史取回来。 */
  function useSession(id, load) {
    sid = id || "";
    rememberSid();
    renderSessions();
    msgs.length = 0;
    var box = body();
    if (box) box.innerHTML = "";
    hideQuick();
    resetMeter();
    refreshClearUI();
    if (load !== false) loadHistory();
    else { pushWho("ai", GREET_TEXT); renderQuick(); }
  }

  function newSession() {
    if (busy) return;
    fetch("api/coach/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        var s = (j && j.session) || {};
        return refreshSessions().then(function () { useSession(s.sid || "", false); });
      })
      .catch(function () { useSession("", false); });
  }

  /* 首次进入：拿列表 → 优先回到上次那段；一个都没有就开一段新的。 */
  function bootSessions() {
    return refreshSessions().then(function (list) {
      if (!list.length) return newSession();
      var saved = "";
      try { saved = localStorage.getItem(SID_KEY) || ""; } catch (e) {}
      var hit = list.filter(function (s) { return s.sid === saved; })[0];
      useSession((hit || list[0]).sid, true);
      return null;
    });
  }

  /* ---------------- 上下文水位条 ---------------- */
  function resetMeter() {
    var m = $("coach-meter");
    if (m) { m.hidden = true; m.textContent = ""; m.className = "coach-meter"; }
  }

  function setMeter(c) {
    var m = $("coach-meter");
    if (!m || !c) return;
    var pct = Math.max(0, Math.min(100, Number(c.pct) || 0));
    m.hidden = false;
    m.textContent = "上下文 " + pct + "%";
    m.className = "coach-meter" + (pct >= 80 ? " is-hot" : "");
    var k = function (n) { return Math.round((Number(n) || 0) / 1000) + "k"; };
    var bits = ["约 " + k(c.used) + " / " + k(c.window) + " tokens"];
    if (c.summary) bits.push("更早的部分已压成摘要");
    if (c.compressed) bits.push("累计压缩 " + c.compressed + " 次");
    if (c.dropped) bits.push("本轮丢掉最旧的 " + c.dropped + " 条");
    bits.push("到 " + Math.round((Number(c.ratio) || 0.75) * 100) + "% 会自动压缩");
    m.title = bits.join("；");
  }

  /* ---------------- 历史：刷新后接着聊 / 清空 ----------------
     对话原本只在 msgs 里（内存），刷新就没了。现在后端按会话落了一份，
     这里负责取回来渲染 —— 只恢复文本：思考过程与工具调用属于「当时那次生成」，
     重建出来只会让页面变长，而且下一轮本来就会重新查。 */
  function loadHistory() {
    var url = "api/coach/history" + (sid ? ("?sid=" + encodeURIComponent(sid)) : "");
    histPending++;
    return fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var list = (j && Array.isArray(j.msgs)) ? j.msgs : [];
        if (j && j.sid) { sid = j.sid; rememberSid(); }
        var box = body();
        if (!list.length || !box) {
          if (box && !box.childNodes.length) { pushWho("ai", GREET_TEXT); renderQuick(); }
          refreshClearUI();
          return;
        }
        box.appendChild(el("div", "coach-sep", "以上是上次的对话"));
        list.forEach(function (m) {
          var txt = String((m && m.content) || "");
          if (!txt.trim()) return;
          var isUser = !!(m && m.role === "user");
          pushWho(isUser ? "user" : "ai", txt);
          msgs.push({ role: isUser ? "user" : "assistant", content: txt });
        });
        refreshClearUI();
        toBottom(box);
      })
      .catch(function () { /* 拿不到就当没有，不影响聊天 */ })
      .then(function () { histPending--; });
  }

  function currentSess() {
    for (var i = 0; i < sessList.length; i++) if (sessList[i].sid === sid) return sessList[i];
    return null;
  }

  function refreshClearUI() {
    var b = $("coach-clear");
    if (!b) return;
    b.disabled = !msgs.length;
    if (!armed) b.textContent = "清空";
  }

  function disarmClear() {
    armed = false;
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
    var b = $("coach-clear");
    if (b) { b.classList.remove("is-armed"); b.textContent = "清空"; }
  }

  /* 两态确认：点一次按钮变成「再点一次」，3 秒内不再点就自己复原。
     用 confirm() 的话 jsdom 里根本没有它，测不了，而且会打断操作。 */
  function onClearClick() {
    if (!msgs.length || busy) return;
    if (!armed) {
      armed = true;
      var b = $("coach-clear");
      if (b) { b.textContent = "再点一次"; b.classList.add("is-armed"); }
      armedTimer = setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    doClear();
  }

  function doClear() {
    fetch("api/coach/clear", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: sid }),
    }).catch(function () {
      /* 库清不掉也照样把界面清了：至少这次会话是干净的，
         下次刷新会重新读库 —— 那种情况下面板上会再出现旧消息，但概率极低。 */
    }).then(function () {
      msgs.length = 0;
      var box = body();
      if (box) box.innerHTML = "";
      pushWho("ai", GREET_TEXT);
      renderQuick();
      refreshClearUI();
      toBottom(body());
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
    /* 历史是异步取回来的，那段时间里别插欢迎语 —— 否则会先插一条、
       取回来的内容再插一条，看着像重复开场。 */
    if (!body().childNodes.length && !histPending) {
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
    var clr = $("coach-clear");
    if (clr) clr.addEventListener("click", onClearClick);
    var nb = $("coach-new");
    if (nb) nb.addEventListener("click", newSession);
    var sel = $("coach-sess");
    if (sel) {
      sel.addEventListener("change", function () {
        if (busy) { renderSessions(); return; }
        useSession(sel.value, true);
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
    refreshClearUI();
    bootSessions();   // 拉会话列表 → 回到上次那段（没有就开一段新的）
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  window.MIMO_COACH = {
    send: send, open: openPanel, close: closePanel, msgs: msgs,
    load: loadHistory, clear: doClear,
    session: function () { return sid; },
    sessions: function () { return refreshSessions(); },
    use: function (id) { return useSession(id, true); },
    newSession: newSession,
  };
})();
