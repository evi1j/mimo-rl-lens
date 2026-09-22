/* 教练的会话管理与上下文压缩
   ================================================================
   为什么单开一个文件：这两件事跟「怎么问模型」（coach.js）和「怎么落盘」（store.js）
   都不是一回事，塞进哪边都会让那边变味。

   一、会话（session）
     一段对话 = 一个 sid。消息原文按 sid 存在 coach_msg 里，压缩状态（摘要、压到哪
     一条为止）挂在 coach_session 上。这样：
       · 界面显示的永远是完整原文 —— 压缩只动「发给模型那一份」，不动历史；
       · 可以开新对话、切回旧对话，各自有各自的上下文与摘要。

   二、上下文（context）
     会话内的内容「全传」—— 不再像以前那样只带最近 8 条、每条再砍到 1200 字。
     全传的前提是提前算好账：每轮开跑前估一次这一轮要占多少 token，
     快到窗口的水位线（默认 75%）就主动压一次，下一轮发的就是「摘要 + 之后的原文」。

     为什么是「提前」压，而不是等到超了再压：
       超了再压这一轮就已经失败了（模型直接报 context length），救不回来；
       提前压的成本只是一次后台摘要调用，用户下一轮照常聊，察觉不到。
     所以压缩有两个触发点：
       1) 收尾后（后台）：这一轮聊完发现快到线了，立刻压 —— 下一轮一上来就是干净的。
       2) 开跑前（兜底）：万一后台那次没压成（模型不可用、并发），这一轮开跑前再压一次；
          压不成也不会炸，还有最后一道「按预算丢最旧的」兜着。

   三、token 怎么估
     没有分词器，只能估。中文按 1 字 ≈ 1 token、其余按 3.6 字 ≈ 1 token 算，
     每条消息再加 4 token 的角色开销。估得偏大一点没关系 —— 偏大只会提前压，
     偏小才会把请求撑爆。 */

const llm = require('./llm.js');
const store = require('./store.js');

/* 兜底窗口。模型真正在跑多大窗口我们无从得知（本项目的接口不返回上限），
   32k 是个对本地中小模型都安全的取值；想改就在 config.json 的 llm 段写
   coachContextWindow。猜大了只会让压缩更晚发生，还可能撞上真实的窗口上限。 */
const DEFAULT_WINDOW = 32768;
const DEFAULT_RATIO = 0.75;      // 到窗口的这个比例就压（留 25% 给这一轮生成和工具返回）
const DEFAULT_KEEP_MSGS = 6;     // 压缩后保留最近几条原文（3 轮问答）
const DEFAULT_SUMMARY_CHARS = 1500; // 摘要上限（字）
/* 工具返回 + 本轮生成的预留。工具轮可能一次拉回几千字的序列数据，
   正文最多 explainMaxTokens —— 这些都不在 history 里，但同样占窗口。 */
const TOOL_RESERVE = 8000;
const SLACK = 512;

/* ---------- token 估算 ---------- */

function isCjk(c) {
  return (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xff00 && c <= 0xffef);
}

/* 中文约 1 字 1 token，其余（英文、数字、代码、标点）约 3.6 字 1 token。 */
function estTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    if (isCjk(s.charCodeAt(i))) cjk++; else other++;
  }
  return Math.ceil(cjk + other / 3.6);
}

/* 一组消息的 token 数：正文 + 每条的角色开销。 */
function estMsgs(msgs) {
  const arr = Array.isArray(msgs) ? msgs : [];
  let n = 0;
  for (const m of arr) n += estTokens(m && m.content) + 4;
  return n;
}

/* ---------- 这一轮的参数 ---------- */

function ctxConfig(cfg) {
  const c = cfg || {};
  const window = Math.max(2000, Number(c.coachContextWindow) || DEFAULT_WINDOW);
  let ratio = Number(c.coachCompressAt);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) ratio = DEFAULT_RATIO;
  const out = Number(c.explainMaxTokens) || 4000;
  /* 预留（本轮生成 + 工具返回 + 余量）最多只能占窗口一半 ——
     窗口填得很小时（小模型），不设上限的话预留会把整个窗口吃光，
     于是每轮都判成「超了」、预算算成 0，只剩最近一条历史，聊不下去。 */
  const reserve = Math.min(out + TOOL_RESERVE + SLACK, Math.round(window * 0.5));
  /* 真正能放「提示词 + 摘要 + 历史 + 本问」的地方：窗口刨掉本轮预留。
     水位线和百分比都按它算 —— 按整个窗口算的话，预留（固定的一万多 token）
     会一直挂在分子里，空会话也显示百分之四十几；而且触发线会比可用空间还大，
     等于永远压不到。 */
  const cap = Math.max(1000, window - reserve);
  return {
    window: window,
    ratio: ratio,
    cap: cap,                  // 历史可用空间
    trigger: Math.round(cap * ratio),
    reserve: reserve,          // 本轮生成 + 工具返回 + 余量
    keepMsgs: Math.max(2, Number(c.coachKeepMsgs) || DEFAULT_KEEP_MSGS),
    summaryChars: Math.max(300, Number(c.coachSummaryChars) || DEFAULT_SUMMARY_CHARS),
  };
}

/* 水位。
     load  = 提示词 + 摘要 + 历史 + 本问 —— 这段会话累计占了多少，前端百分比看它；
     used  = load + 本轮预留 —— 这一轮请求大概要占窗口多少，诊断看它；
     over  = load 到没到可用空间的触发线（到了就该压）。 */
function measure(parts, cfg) {
  const k = ctxConfig(cfg);
  const system = estTokens(parts.systemText);
  const summary = estTokens(parts.summary);
  const history = estMsgs(parts.history);
  const question = estTokens(parts.questionText);
  const load = system + summary + history + question;
  const used = load + k.reserve;
  return {
    system: system, summary: summary, history: history, question: question,
    load: load, reserve: k.reserve, used: used, window: k.window, cap: k.cap,
    ratio: k.ratio, trigger: k.trigger,
    // 给前端看的百分比：累计占用 / 这段会话真正能用的空间（不是整个窗口）
    pct: Math.min(100, Math.round((load / k.cap) * 100)),
    over: load >= k.trigger,
  };
}

function needsCompress(stats, cfg) {
  return !!(stats && stats.over);
}

/* ---------- 按预算挑历史 ----------
   会话内的内容全传，只有真的装不下才动刀，而且是从最旧的那头开始丢 ——
   最近的对话才是这一轮最可能用到的。丢掉的条数会记进 stats.dropped，
   前端能看到（正常情况下应该是 0：压缩会先于丢条发生）。 */
function fitHistory(history, budget) {
  const arr = Array.isArray(history) ? history : [];
  const kept = [];
  let used = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = estTokens(arr[i] && arr[i].content) + 4;
    if (kept.length && used + t > budget) break;  // 至少留一条（最近的）
    kept.unshift(arr[i]);
    used += t;
  }
  return { kept: kept, dropped: arr.length - kept.length, tokens: used };
}

/* ---------- 压缩 ---------- */

const COMPRESS_SYSTEM = [
  '你是对话压缩器。把下面这段「更早的对话」压成一份紧凑的中文摘要，',
  '供同一个会话的后续轮次接着用 —— 之后模型只能看到你写的这份摘要，看不到原文。',
  '',
  '必须保留：',
  '- 对方问过的每个问题（各一句话概括，按时间顺序）；',
  '- 给出的关键结论，以及**全部数字**：数值、单位、第几步、哪一个 run（pro / flash）。',
  '  数字只能照抄，不许四舍五入、不许换算、不许合并；',
  '- 查过的指标名原文（比如 actor/entropy_loss），后续还要照着它们去查；',
  '- 做过的判断、给过的建议、以及还没解决的疑问。',
  '',
  '写法：',
  '- 纯文本，空行分段，行首「- 」列条目。不要用标题、表格、代码块。',
  '- 不写客套话，不写「用户问了…」这类元叙述，直接写内容本身。',
  '- 如果给了「更早的摘要」，它的信息要并进来 —— 它是旧内容唯一的载体，漏了就是永久丢失。',
  '- 控制在 ' + DEFAULT_SUMMARY_CHARS + ' 字以内。宁可少写细节，也不要为了塞满而写空话。',
].join('\n');

/* 组装给压缩器看的对话。原文整段给它（它就是要读原文），
   但每条先截到 2500 字 —— 单条再长，摘要里也只留得下结论。 */
function compressMessages(oldSummary, msgs, maxChars) {
  const lines = [];
  if (oldSummary) lines.push('[更早的摘要]\n' + String(oldSummary));
  lines.push('[要压进摘要的对话]');
  for (const m of msgs) {
    const who = m.role === 'user' ? '对方' : '教练';
    let c = String(m.content || '').trim();
    if (c.length > 2500) c = c.slice(0, 2500) + '…（本条有截断）';
    lines.push(who + '：' + c);
  }
  const body = lines.join('\n\n');
  return [
    { role: 'system', content: COMPRESS_SYSTEM },
    { role: 'user', content: body + '\n\n请把以上内容压成摘要，直接输出摘要正文：' +
      (maxChars ? '不超过 ' + maxChars + ' 字。' : '') },
  ];
}

/* 有些模型会把思考也写进 content（<think>…</think>），那不是摘要正文。 */
function stripThink(s) {
  return String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/^\s*【思考】[\s\S]*?【\/思考】/g, '')
    .trim();
}

const inflight = {};   // sid -> Promise，同一个会话不并发压

/* 主动压一次。返回 { ok, why, ... }。失败一律 ok:false 并说明原因 ——
   压不成绝不能影响聊天：最坏的情况不过是这一轮多带点历史。 */
async function compressSession(sid, opts) {
  opts = opts || {};
  const id = sid || store.DEFAULT_SID;
  if (!opts.force && inflight[id]) return inflight[id];

  const job = (async function () {
    const cfg = llm.loadConfig();
    if (!cfg.enabled) return { ok: false, why: 'ai-disabled' };
    const k = ctxConfig(cfg);
    const sess = store.getCoachSession(id) || store.ensureCoachSession(id) || {};
    const all = store.coachHistory(id, 200);
    const upto = Number(sess.summaryUpto) || 0;
    /* 还没进过摘要的那些里，留最后 keepMsgs 条继续以原文形式带着 ——
       刚聊完的两三轮最可能接着被追问，压成摘要反而会丢语气和细节。 */
    const pending = all.filter(function (m) { return !upto || m.id > upto; });
    if (pending.length <= k.keepMsgs) {
      return { ok: false, why: 'too-few', pending: pending.length, keep: k.keepMsgs };
    }
    const todo = pending.slice(0, pending.length - k.keepMsgs);
    const before = estMsgs(pending) + estTokens(sess.summary);

    const msgs = compressMessages(sess.summary, todo, k.summaryChars);
    let text = '';
    try {
      const model = await llm.resolveModel(cfg);
      const j = await llm.request(cfg, 'POST', '/chat/completions', {
        model: model,
        messages: msgs,
        temperature: 0,
        // 摘要是中文，1 字约 1 token；给到上限的 1.7 倍留足思考与余量
        max_tokens: Math.round(k.summaryChars * 1.7),
        stream: false,
      });
      const got = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
      text = stripThink(got.content || '');
    } catch (e) {
      console.log('ai coach: 压缩上下文失败（' + String(e.message || e).slice(0, 80) + '）');
      return { ok: false, why: 'model-error', error: String(e.message || e).slice(0, 160) };
    }
    if (!text) return { ok: false, why: 'empty' };
    if (text.length > k.summaryChars * 1.5) text = text.slice(0, Math.round(k.summaryChars * 1.5));

    const lastId = todo[todo.length - 1].id;
    store.saveCoachSummary(id, text, lastId);
    const after = estMsgs(pending.slice(pending.length - k.keepMsgs)) + estTokens(text);
    console.log('ai coach: 上下文已压缩（' + todo.length + ' 条 → ' + text.length +
      ' 字摘要，约 ' + before + ' → ' + after + ' token）');
    return {
      ok: true, sid: id, summary: text, upto: lastId, msgs: todo.length,
      kept: pending.length - todo.length, before: before, after: after,
    };
  })().finally(function () { delete inflight[id]; });

  inflight[id] = job;
  return job;
}

/* 收尾后调用：快到线就压，不快就不压。后台跑，不等它 ——
   这一轮已经答完了，用户不需要为压缩多等一秒。 */
function scheduleCompress(sid, opts) {
  opts = opts || {};
  const id = sid || store.DEFAULT_SID;
  try {
    const cfg = llm.loadConfig();
    if (!cfg.enabled) return null;
    const sess = store.getCoachSession(id) || {};
    const upto = Number(sess.summaryUpto) || 0;
    const all = store.coachHistory(id, 200).filter(function (m) { return !upto || m.id > upto; });
    /* systemText 由调用方给（提示词在 coach.js 里）：漏掉它会少算三千来个 token，
       于是「后台压过了」但下一轮实测又过线，白等一次同步压缩。 */
    const st = measure({
      systemText: opts.systemText || '', summary: sess.summary || '',
      history: all, questionText: '',
    }, cfg);
    // 摘要 + 未压的原始消息已经过线：现在压，下一轮就轻了
    if (!st.over) return null;
    const p = compressSession(id).catch(function (e) {
      console.log('ai coach: 后台压缩异常（' + String(e.message || e).slice(0, 80) + '）');
      return { ok: false, why: 'throw' };
    });
    return p;
  } catch (e) {
    return null;
  }
}

/* ---------- 这一轮要发什么 ---------- */

/* 把「会话里的内容」整理成这一轮的历史：已经压进摘要的那些不再重复发，
   剩下的全发。返回的东西前端也要看（水位条），所以顺带把 stats 算出来。 */
function prepareTurn(o) {
  o = o || {};
  const cfg = o.cfg || llm.loadConfig();
  const id = o.sid || store.DEFAULT_SID;
  const sess = store.getCoachSession(id) || {};
  const upto = Number(sess.summaryUpto) || 0;
  const all = Array.isArray(o.history) ? o.history : store.coachHistory(id, 200);
  const rest = all.filter(function (m) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
    if (typeof m.content !== 'string' || !m.content.trim()) return false;
    /* 已经进过摘要的不再重复发（摘要里有了）。认不出来的一律留下 ——
       宁可多发一条，也不能把没压过的对话当成压过了丢掉。 */
    return !upto || !m.id || m.id > upto;
  });
  const stats = measure({
    systemText: o.systemText || '',
    summary: sess.summary || '',
    history: rest,
    questionText: o.questionText || '',
  }, cfg);
  stats.compressed = Number(sess.compressCnt) || 0;
  return {
    sid: id,
    summary: sess.summary || '',
    summaryUpto: upto,
    history: rest,
    total: all.length,
    stats: stats,
    session: sess,
  };
}

module.exports = {
  estTokens, estMsgs, ctxConfig, measure, needsCompress, fitHistory,
  compressMessages, stripThink, compressSession, scheduleCompress, prepareTurn,
  COMPRESS_SYSTEM,
  DEFAULT_WINDOW, DEFAULT_RATIO, DEFAULT_KEEP_MSGS, DEFAULT_SUMMARY_CHARS, TOOL_RESERVE,
};
