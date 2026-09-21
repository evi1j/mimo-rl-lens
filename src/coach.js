/* AI 训练教练 —— 站点级的对话助手
   ================================================================
   和 llm.explainMetric（讲一张图表）的区别，也是这个文件存在的理由：

   1) 多轮。讲解是「打开一张图 → 讲一遍 → 关掉」，教练是对话，要带 history，
      要能追问「那这个和那个一起看呢」。会话（sid）内的内容全传，不按条数砍 ——
      长对话靠 src/session.js 的主动压缩来控：快到窗口 75% 就先压一次摘要，
      下一轮发「摘要 + 之后的原文」。原文始终留在库里，界面照旧显示完整对话。
   2) 工具开放全量（6 个，多了解说历史与库概览），且首轮 tool_choice 是 auto：
      讲解讲一张图必须先读数，所以它首轮强制 required；教练会被问「什么是 GRPO」
      这类概念题，逼它先查一遍库纯属浪费一轮、还多等十几秒。
   3) 判定「答成了」的字数门槛低得多（60 字）。讲解要求三段四百字，短了就是不完整；
      但「现在练到第几步了」的正确答案可能就是「pro 第 30 步，flash 第 28 步」——
      按讲解的 200 字门槛会被判成失败，然后无意义地重试三次。
   4) 提示词是教练人格：既讲 RL 原理，又要落到这块板上的真实数字，还要教人看懂板子。

   底层那台机器（流式读取、工具轮循环、分层重试、剥 <tool_call> 标签）全部复用
   llm.js 的导出原语，这里只负责「怎么问」和「怎么判答完了」。 */

const llm = require('./llm.js');
const session = require('./session.js');

/* 判定「答成了没有」的两个门槛，分工不同：
   COACH_MIN_CHARS —— 常规口径，够这个字数就是完整回答。
   COACH_MIN_STOP_CHARS —— 只在模型**自己收尾**（finish_reason=stop）时用的宽容门槛。
   为什么要分：用户明确要求简短输出时（「把之前问过的问题列出来，别的别说」），
   模型照办写了两三行，字数当然不够 60 —— 但它是正常写完的，不是没答出来。
   只按字数判会把它打成失败，重试三次后甩给用户一个红框，用户看到的是
   「模型连续几次都只写思考没写正文」，而实际上它第一次就答对了。
   低于这个下限基本只有空响应或剥完标签剩下的换行，那才是真没写出来。 */
const COACH_MIN_CHARS = 60;      // 低于这个字数才算「没答出来」，触发重试
const COACH_MIN_STOP_CHARS = 12; // 自然收尾时：写到这个字数就算答成了
/* 历史不再按「固定条数 + 每条砍字」裁：一个会话里的内容本来就该全传，
   装不装得下交给 src/session.js 按模型窗口算（快到 75% 就先压摘要，
   压完发「摘要 + 之后的原文」；真装不下才丢最旧的）。
   这里只留一条硬上限：单条不许无限长 —— 一条几十字的问答谁都不会写这么长，
   出现超长基本是模型把整张表贴了进来，那种内容进上下文只会把窗口吃掉。 */
const COACH_MSG_MAX_CHARS = 8000;

const COACH_SYSTEM = [
  '你是 MiMo 强化学习训练看板的 AI 教练。这块板实时抓取小米官方 trainer 的日志，',
  '把两个训练任务（pro、flash）的过程指标、离线评测分数和事件解说落进本地数据库。',
  '你的职责是：结合这块板上**真实的数据**，把大模型强化学习训练讲清楚，帮提问的人真正学会。',
  '',
  '回答范围 —— 只在这三条里回答，超出就按下面的拒答话术回：',
  '1) 这块板上的数据：指标与曲线、训练进度与花费、离线评测、看板记过的事件解说。',
  '2) 大模型强化学习训练本身：算法原理、超参与稳定性、评测方法、常见故障与排查思路。',
  '3) 这块板怎么用：图怎么看、指标怎么找、讲解怎么读、哪些数该一起看。',
  '',
  '超出范围怎么回（拒答）：',
  '- 一句话说清答不了或看不到，然后马上给出一个你能答的方向。不要解释为什么，',
  '  不要说教，不要写「作为一个人工智能…」这类开场，不要反复道歉。',
  '- 二三十字就够，不加免责声明、不空谈通用建议。拒答也要写在正文里，别只写在思考里。',
  '- 例子：「这个我看不到 —— 板上只有 trainer 日志和离线评测。要不要我查一下现在 pro 的熵？」',
  '',
  '你可以调用工具查数据。三条硬规则：',
  '1) 任何具体数字都必须来自工具返回，或来自用户自己给出的数字。绝不凭印象编。',
  '   没查到就直说没查到，并说清是名字写错了、还是这个库里确实没有，',
  '   不要用「大约」「通常在」把没查到的地方糊过去。',
  '2) 引用任何指标名前，先用 list_metrics 确认它在库里真实存在。不要凭记忆写指标名。',
  '3) 只要问题沾到「现在怎么样 / 为什么变了 / 这个指标 / 哪一步 / 出过什么问题 / 花了多少」，',
  '   就先查数据再回答，不要凭常识开讲。纯概念问题（比如「什么是 GRPO」）可以不查，',
  '   但若能顺手用板上的真实数字当例子就查一下 —— 讲概念时挂一个真实数字，效果完全不同。',
  '',
  '你能查的数据：',
  '- list_metrics：按名字检索指标库（几百个 trainer 上报的监控量，含单位与英文说明）。',
  '- query_series：某个指标每一步的历史值，用来看趋势、拐点、波动范围、极值在第几步。',
  '- run_status：训练进度、阶段、重启次数、每步样本规模、累计花费。',
  '- query_bench：离线评测分数，用来把训练过程指标和最终效果连起来。',
  '- search_notes：看板记录过的历史事件解说（重启、掉分、沙箱故障…），回顾性问题的答案在这里。',
  '- db_overview：库里覆盖了哪些数据、到第几步、有哪些评测。不确定某项数据是否存在时先查它。',
  '工具返回 error 就是没查到 —— 换个名字或换个角度再查，绝不能编造。',
  '',
  '回答怎么写：',
  '- 先给结论，再给依据；如果适用，最后给「接下来该盯什么」。不要「这是个好问题」这类开场。',
  '- 讲机制、讲因果、讲设计取舍。能点出「牺牲了 A 换来了 B」最好。',
  '- 术语照用（rollout、advantage、on-policy、熵坍缩、KL、重要性采样…），',
  '  但第一次出现时当场解释它在干什么。术语本身就是知识点，不要为了「通俗」而回避它。',
  '- 禁止用「就像考试一样」「好比练车」这类生活比喻来代替解释。',
  '- 数字要带参照：带上单位、第几步、哪一次评测。不要堆一长串没有刻度的数。',
  '- 长度跟着问题走：一句话的问就一句话答；「为什么」类问题 200~500 字；',
  '  要展开讲机制时可以更长，但必须分段、有结构，不要糊成一坨。',
  '',
  '排版（前端只做下面这几条的轻量渲染，别用其他 markdown 语法）：',
  '- 空行分段；',
  '- 行首「- 」做列表项；',
  '- 用 **这样** 强调关键词；长回答可以用 ### 小标题 分节；',
  '- 要横向对比（两个 run、多个指标、多组配置、多个阶段）就用表格，别写成一大段文字。',
  '  格式必须严格照下面来，首尾都要竖线，表头下面紧跟一行分隔行：',
  '  | 指标 | pro | flash |',
  '  | --- | --- | --- |',
  '  | avg@n | 0.62 | 0.58 |',
  '  列控制在 4 列以内（抽屉只有几百像素宽，列多了要横向滚），单元格里只放短词和数字；',
  '  表格前后各空一行，表里不要再嵌列表、小标题或第二张表。',
  '- 给出具体命令、配置片段、报错片段时用代码块，这样换行与缩进不会被压平：',
  '  ```bash',
  '  vllm serve <sft_checkpoint> --tensor-parallel 8',
  '  ```',
  '  开头和结尾的 ``` 必须单独成行，前后各空一行，块内不要再写 ```。',
  '- 不要用 # 一级标题；除上面几条规则外，不要用其他 markdown 结构。',
  '',
  '查数据只在回答之前的工具阶段进行，请把要用的数据一次查全。开始写正文之后',
  '不要再请求查数据，也不要输出 <tool_call> 之类的标签或函数调用 JSON ——',
  '那些东西前端会整段剥掉，等于这一段的字白写了。正文里只写给人看的自然段落。',
  '',
  '多轮对话：接着上文答，不要重复已经说过的内容。对方追问时说明上一轮没讲透 ——',
  '直接补深那一块，不要从头再讲一遍。',
  '',
  '边界（属于范围外，按上面的拒答话术回）：你看得到的只有这个看板和它背后的 trainer 日志，',
  '看不到训练代码、看不到日志之外的机器状态，也不知道板上没记录的事情。',
  '问到这些就直说看不到，并讲清需要什么信息才能判断。',
].join('\n');

const VIEW_LABEL = { overview: '总览', metrics: '指标库', about: '关于' };

/* 把前端报上来的「此刻在哪儿」翻成一句话给模型。
   这一段的措辞刻意保守：只说对方在看什么，不暗示这是问题的一部分 ——
   否则模型容易答成「你在看 X 视图，这个视图有…」这种没人要的复述。 */
function contextText(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const parts = [];
  const v = VIEW_LABEL[ctx.view] || (ctx.view ? String(ctx.view) : '');
  if (v) parts.push('停在' + v + '视图');
  const chart = String(ctx.chartName || ctx.chart || '').trim();
  if (chart) parts.push('正打开图表「' + chart + '」');
  if (ctx.run) parts.push('正在看 ' + String(ctx.run) + ' 这个 run');
  if (!parts.length) return '';
  return '[看板现状] 对方此刻' + parts.join('、') + '。';
}

/* 组装这一轮的 user 消息。上下文是可选的：payload.useContext === false 时
   一个字都不带 —— 用户关掉「参考当前页面」开关后，就不该再有隐含信息影响回答。 */
function coachUserText(payload) {
  const q = String((payload && payload.question) || '').trim();
  const ctx = payload && payload.useContext === false ? '' : contextText(payload && payload.context);
  return (ctx ? ctx + '\n\n' : '') + '问题：' + q;
}

/* 单条超长时掐头去尾留中间标记 —— 比硬砍一半好：结论常在开头，数据常在结尾。 */
function clipMsg(s) {
  const t = String(s == null ? '' : s);
  if (t.length <= COACH_MSG_MAX_CHARS) return t;
  const head = Math.round(COACH_MSG_MAX_CHARS * 0.7);
  const tail = COACH_MSG_MAX_CHARS - head - 24;
  return t.slice(0, head) + '\n…（本条中间省略）…\n' + t.slice(Math.max(head, t.length - tail));
}

/* 组装完整 messages 并算出这一轮的水位。
   历史只认 user/assistant 两种角色（tool 消息由工具轮自己在当次请求里补，
   不能由前端回传 —— 那边的 tool_call_id 对不上）。
   顺序：system（含更早对话的摘要）→ 尽量全量的历史 → 本轮问题。
   历史被裁只在两种情况下发生：单条超长（clipMsg），或预算真的装不下（丢最旧的）。 */
function buildPlan(payload) {
  payload = payload || {};
  const cfg = llm.loadConfig();
  const k = session.ctxConfig(cfg);

  const history = (Array.isArray(payload.history) ? payload.history : []).filter(function (m) {
    return m && (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' && m.content.trim();
  }).map(function (m) {
    return { role: m.role, content: clipMsg(m.content) };
  });

  const summary = String(payload.summary || '').trim();
  /* 摘要挂在 system 里，不单独占一条消息：它就是背景资料，不是对话的一部分 ——
     单独发一条 assistant 消息的话，模型容易把它当成自己说过的话接着复述。 */
  const systemText = summary
    ? COACH_SYSTEM + '\n\n[更早对话的摘要 —— 以下是这段会话更早部分压缩后的记录，' +
      '供你接着答；要具体数字请重新查，不要直接引用摘要里的旧值]\n' + summary + '\n[摘要结束]'
    : COACH_SYSTEM;

  const questionText = coachUserText(payload);
  const stats = session.measure({
    systemText: systemText, summary: '', history: history, questionText: questionText,
  }, cfg);
  const budget = Math.max(0, k.window - k.reserve - stats.system - stats.question - 64);
  const fit = session.fitHistory(history, budget);

  const msgs = [{ role: 'system', content: systemText }];
  for (const m of fit.kept) msgs.push({ role: m.role, content: m.content });
  msgs.push({ role: 'user', content: questionText });

  const out = Object.assign({}, stats, {
    summary: session.estTokens(summary),
    history: fit.tokens,
    used: stats.system + stats.question + fit.tokens + k.reserve,
    dropped: fit.dropped,
    total: history.length,
  });
  out.pct = Math.min(100, Math.round((out.used / k.window) * 100));
  out.over = out.used >= k.trigger;
  return { msgs: msgs, stats: out, keep: k.keepMsgs, window: k.window, trigger: k.trigger };
}

/* 只要 messages 的时候用它（测试与调用方多数只要这个）。 */
function buildMessages(payload) {
  return buildPlan(payload).msgs;
}

/* 正文轮每次尝试的参数。与讲解的差别：最后那次的补话不说「250~450 字」，
   因为教练的回答可能本来就该很短，硬凑字数会把它带偏成废话。 */
function coachStrategy(attempt, cfg, effort) {
  const base = Number(cfg.explainMaxTokens) || 4000;
  if (attempt === 0) return { effort: effort, maxTokens: base, reason: '', notice: '' };
  if (attempt === 1) {
    return {
      effort: null, // 实测：不传 effort 时思考量最少，正文最容易被挤出来
      maxTokens: Math.round(base * 1.25),
      reason: 'short',
      notice: '第一次没写出正文，降低思考强度再试一次',
    };
  }
  return {
    effort: null,
    maxTokens: Math.round(base * 1.5),
    reason: 'short',
    notice: '正文仍不完整，最后一次尝试：直接给结论',
    extra: '注意：上一次你只输出了思考或工具标签，正文几乎没写。' +
      '这一次请直接输出给对方看的回答正文，不要再调用工具、不要再长篇推导，控制在一屏以内。',
  };
}

/* 一次教练回答。流式回调与 llm.explainMetric 同构：
     onDelta(文本片段)  正文
     onThink(文本, phase, round)  思考；phase='tool' 是「决定查什么」，'main' 是拿到数据后的分析
     onTool(info)       调用了哪个工具、查到什么
     hooks.onNotice / hooks.onRestart  重试提示与重跑正文轮
   返回 { model, toolRounds, attempts, truncated?, aborted? }。失败抛错，由调用方降级。 */
async function coachReply(payload, onDelta, onThink, onTool, hooks) {
  const cfg = llm.loadConfig();
  llm.setStatus({ enabled: !!cfg.enabled, baseUrl: cfg.baseUrl });
  if (!cfg.enabled) {
    llm.setStatus({ ok: false, lastError: '未启用（config.json 里 llm.enabled=false）' });
    throw new Error('AI 未启用（config.json 里 llm.enabled=false）');
  }

  /* 调用方（server）可以先组好 messages 再传进来 —— 它要顺带拿水位给前端看，
     组两次浪费。没传就自己组。 */
  const plan = buildPlan(payload);
  const messages = (Array.isArray(payload.messages) && payload.messages.length)
    ? payload.messages : plan.msgs;
  const effort = cfg.explainReasoningEffort || 'low';
  hooks = hooks || {};
  const notify = function (msg) { if (typeof hooks.onNotice === 'function') hooks.onNotice(msg); };

  /* 工具轮：开放全量工具，首轮 auto —— 概念题不该被逼着先查库。
     失败一律降级成「不查工具直接答」，绝不把整条链路打断。 */
  let rounds = 0;
  let aborted = false;
  if (cfg.explainUseTools !== false) {
    const onToolSafe = onTool ? function (info) {
      if (onTool(info) === false) { aborted = true; return false; }
      return true;
    } : null;
    const onThinkTool = onThink ? function (t, ph, rn) { return onThink(t, 'tool', rn); } : null;
    rounds = await llm.toolPhase(cfg, messages, onToolSafe, onThinkTool, {
      tools: llm.TOOLS,
      firstChoice: 'auto',
    });
    if (rounds) console.log('ai coach: 工具轮 ' + rounds + ' 次，随后生成回答');
    if (aborted) return { model: '', toolRounds: rounds, aborted: true };
  }

  const attempts = Math.max(1, Number(cfg.bodyAttempts) || 3);
  let model = '';
  let lastErr = null;
  let switched = false;
  let curCfg = cfg;

  for (let a = 0; a < attempts; a++) {
    const n = a + 1;
    const st = coachStrategy(a, cfg, effort);
    if (a > 0) {
      if (st.notice) notify(st.notice);
      if (typeof hooks.onRestart === 'function') hooks.onRestart({ attempt: n, reason: st.reason });
    }
    const msgs = st.extra ? messages.concat([{ role: 'user', content: st.extra }]) : messages;
    const onDeltaSafe = llm.filterToolCallText(onDelta || function () { return true; });
    // 以「真正上屏的字数」判定，不是模型吐出的原始长度 —— 模型有可能会在正文里
    // 写一串 <tool_call> 标签（工具轮之后还想接着查），那截会被剥掉（见 llm.filterToolCallText）
    const kept = function () { return onDeltaSafe.emitted(); };
    try {
      const r = await llm.streamChat(curCfg, msgs, onDeltaSafe, onThink,
        { effort: st.effort, maxTokens: st.maxTokens });
      model = r.model || model;
      if (r.aborted) return { model: model, toolRounds: rounds, attempts: n, aborted: true };
      const got = kept();
      if (got >= COACH_MIN_CHARS) {
        llm.setStatus({ ok: true, model: model, lastOkAt: Date.now() / 1000,
          lastError: null, generated: llm.status.generated + 1 });
        return { model: model, toolRounds: rounds, attempts: n };
      }
      /* 字数不够，但模型是自己收尾的（不是撞上 max_tokens 被截断）——
         说明它认为话已经说完，只是说得短。用户要求「只列问题」时就属这种。
         收下，别再逼它重跑三次。 */
      if (r.finishReason === 'stop' && got >= COACH_MIN_STOP_CHARS) {
        console.log('ai coach: 第 ' + n + ' 次只写 ' + got + ' 字但模型自然收尾，按答成处理');
        llm.setStatus({ ok: true, model: model, lastOkAt: Date.now() / 1000,
          lastError: null, generated: llm.status.generated + 1 });
        return { model: model, toolRounds: rounds, attempts: n };
      }
      lastErr = new Error(r.finishReason === 'length'
        ? '回答被长度上限截断（' + got + ' 字）'
        : '正文过短（' + got + ' 字 < ' + COACH_MIN_CHARS + '）');
      console.log('ai coach: 第 ' + n + ' 次只写出 ' + got + ' 字' +
        (r.finishReason ? '，结束原因 ' + r.finishReason : '') + '，判定不完整');
    } catch (e) {
      const got = kept() || Number(e.partialChars || 0);
      // 断连但已经答出足够内容：当作答成了，不重跑（重跑会让用户把已有的字再看一遍）
      if (got >= COACH_MIN_CHARS) {
        console.log('ai coach: 流在第 ' + n + ' 次中断，已吐出 ' + got + ' 字，按可用处理');
        llm.setStatus({ ok: true, model: model, lastOkAt: Date.now() / 1000,
          lastError: null, generated: llm.status.generated + 1 });
        return { model: model, toolRounds: rounds, attempts: n, truncated: true };
      }
      lastErr = e;
      if (llm.isModelError(e) && !switched) {
        try {
          const models = await llm.listModels(curCfg);
          const alt = models.filter((m) => m !== curCfg.model)[0];
          if (alt) {
            console.log('ai coach: 模型 ' + (curCfg.model || '-') + ' 不可用，自动改用 ' + alt);
            curCfg = Object.assign({}, curCfg, { model: alt });
            switched = true;
            continue;
          }
        } catch (e2) { /* 换个模型也失败，按普通错误处理 */ }
      }
      if (!llm.isRetryable(e) && !/HTTP 400/.test(String(e.message || e))) break;
      console.log('ai coach: 第 ' + n + ' 次生成失败（' + String(e.message || e).slice(0, 60) + '）');
    }
    if (a < attempts - 1) await llm.sleep(llm.backoffMs(a, cfg));
  }

  llm.setStatus({ ok: false, lastError: String((lastErr && lastErr.message) || lastErr).slice(0, 160),
    failed: llm.status.failed + 1 });
  throw lastErr || new Error('回答生成失败');
}

module.exports = {
  COACH_SYSTEM, coachReply, buildMessages, buildPlan, coachUserText, contextText, coachStrategy,
  COACH_MIN_CHARS, COACH_MIN_STOP_CHARS, COACH_MSG_MAX_CHARS, clipMsg,
};
