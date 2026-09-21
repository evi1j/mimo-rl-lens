/* Local proxy + static server for the mimo-v2.6 RL live board.
   Upstream: https://mimo.xiaomi.com/rl/  (public JSON endpoints)
   Run: node src/server.js   ->   http://127.0.0.1:8787            */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { at } = require('./paths.js'); // 根目录探测：源码在 src/，分发包是扁平的
const { createEngine } = require(at('public', 'narrator-core.js'));
const llm = require('./llm.js');
const coach = require('./coach.js');
const session = require('./session.js');
const store = require('./store.js');

/* 端口与监听地址从 config.json 的 server 段读，环境变量可临时覆盖。
   优先级：环境变量 > config.json > 内置默认。
   环境变量放最高是 Unix 惯例：换端口试试时不必改文件（PORT=8799 node src/server.js）。
   配置项写错（比如端口写成 80abc）不致命，回退默认值并在启动时提示。 */
function loadServerConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(at('config.json'), 'utf8'));
  } catch (e) {
    // 配置文件缺失或损坏都不致命，走默认值
  }
  const s = (file && file.server) || {};
  let port = Number(process.env.PORT || s.port || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.log('[配置] server.port 不是合法端口（' + (s.port || process.env.PORT) +
      '），回退 8787');
    port = 8787;
  }
  const host = String(process.env.HOST || s.host || '0.0.0.0').trim() || '0.0.0.0';
  return { port: port, host: host };
}

const SERVER_CFG = loadServerConfig();
const PORT = SERVER_CFG.port;
// 0.0.0.0 = 监听所有网卡，局域网/虚拟局域网内的其他设备才能访问。
// 只想本机访问的话，config.json 里写 "host": "127.0.0.1"，或启动时加 HOST=127.0.0.1 覆盖。
const HOST = SERVER_CFG.host;
const UPSTREAM = 'https://mimo.xiaomi.com/rl/';
const PUBLIC_DIR = at('public');
const TTL = 5000; // ms — be polite to upstream, the board polls every 10s
const NARRATOR_MS = 20000; // 解说引擎后台轮询间隔

const cache = new Map();
const inflight = new Map();

async function fetchUpstream(target) {
  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < TTL) return hit.body;
  if (inflight.has(target)) return inflight.get(target);

  const task = (async () => {
    const res = await fetch(UPSTREAM + target, {
      headers: { accept: 'application/json', 'user-agent': 'mimo-train-live/0.1' },
    });
    if (!res.ok) throw new Error('upstream ' + res.status);
    const body = await res.json();
    cache.set(target, { at: Date.now(), body });
    return body;
  })();

  inflight.set(target, task);
  try {
    return await task;
  } finally {
    inflight.delete(target);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': buf.length,
  });
  res.end(buf);
}

/* 读 JSON 请求体。坏 JSON / 空 body 一律返回空对象 —— 这些辅助接口都允许不带
   body（比如前端只 POST 一下表示「清空」），解析失败不该把整条请求打断。 */
async function readJsonBody(req, maxBytes) {
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > (maxBytes || 100000)) break;
    }
  } catch (e) { return {}; }
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

/* 会话标题：拿第一句话当标题，长就掐断。标题只是给用户认人的，
   不准也没关系 —— 认得出是哪段对话就行。 */
function titleOf(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 16 ? t.slice(0, 16) + '…' : t;
}

/* AI 出错时给观众看的一句话。原始错误（HTTP 400 {...}）上屏没人看得懂，
   原文只在服务端日志里留着。 */
function friendlyAiError(e) {
  const m = String((e && e.message) || e);
  const code = (m.match(/HTTP (\d{3})/) || [])[1];
  if (/fetch failed|ECONNREFUSED|EAI_AGAIN|ENOTFOUND/i.test(m)) {
    return '连不上 AI 服务。检查 config.json 里的 llm.baseUrl，以及推理服务是否在跑';
  }
  if (code === '429') return 'AI 服务限流了（429），过一会儿再试';
  if (code === '401' || code === '403') return 'AI 服务拒绝了鉴权（' + code + '），检查 llm.apiKey';
  if (code === '400') return 'AI 服务不接受这次请求（400），多半是参数不被这个模型支持';
  if (code && /^5/.test(code)) return 'AI 服务暂时不可用（' + code + '），过一会儿再试';
  if (/timed out|timeout|aborted/i.test(m)) return 'AI 服务响应超时，讲解没能写完，可以再点一次';
  if (/正文过短/.test(m)) return '模型连续几次都只写思考没写正文，换一个模型或调大 llm.explainMaxTokens 再试';
  return '生成失败：' + m.slice(0, 120);
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

/* ---------- 解说引擎（后台常驻，历史落盘） ---------- */
const engine = createEngine();

let saveWarned = false; // 存档不可用的提示只打一次，别每 20 秒刷一行

function loadLog() {
  // 存档只走 SQLite。驱动不可用时 store.enabled 为 false，历史不落盘但不影响看板。
  if (!store.enabled) {
    console.warn('narrator: 存档不可用，本次运行的历史解说不会保存');
    return;
  }
  const d = store.loadNarrator();
  if (!d) return; // 首次运行没有历史，属正常
  engine.hydrate(d);
  console.log(`narrator: 已恢复 ${engine.getFeed().length} 条历史解说`);
}

function saveLog() {
  if (!store.enabled) {
    if (!saveWarned) { saveWarned = true; console.warn('narrator: 存档不可用，跳过落盘'); }
    return;
  }
  if (!store.saveNarrator(engine.serialize())) {
    console.warn('narrator: 写入解说失败');
  }
}

/* ---------- AI 解说（可选增强） ----------
   流程：规则引擎先产出文案并落盘 → AI 异步改写同一条 → 成功则替换并标记 ai=true。
   AI 不可用、超时、返回乱码时一律保留规则文案，页面永远不会空。          */
let aiBusy = false;
let lastProbe = 0;
let lastBrief = null; // 最近一次的整体状态快照，给 AI 举例用

function buildBrief(state) {
  const out = [];
  (state.status ? Object.keys(state.status) : []).forEach((k) => {
    const st = state.status[k];
    const lv = state.live && state.live[k] && state.live[k].latest;
    if (!st) return;
    out.push({
      run: k,
      step: st.step && st.step.last,
      phase: st.step && st.step.phase,
      value: st.headline && st.headline.last,
      cost: st.cost && st.cost.so_far,
      restarts: st.totals && st.totals.restarts,
      pr0: lv ? lv.pr0 : null,
      pr1: lv ? lv.pr1 : null,
      passrate: lv ? lv.passrate : null,
    });
  });
  return out;
}

async function aiPass() {
  if (aiBusy) return;
  const cfg = llm.loadConfig();
  if (!cfg.enabled) return;

  // 断了就定期重连：改完 config.json 里的 key，最多 60 秒自动生效，不用重启服务
  const now = Date.now() / 1000;
  if (!llm.status.ok && now - lastProbe > 60) {
    lastProbe = now;
    const wasOk = llm.status.ok;
    await llm.probe();
    if (!wasOk && llm.status.ok) {
      const n = engine.requeueLast(1);
      if (n) console.log(`ai: 已连通，补说最近 ${n} 条`);
    }
  }

  const pend = engine.pendingAI(Number(cfg.maxItemsPerPoll) || 3);
  if (!pend.length) return;

  aiBusy = true;
  try {
    for (const item of pend) {
      const out = await llm.narrate(item, lastBrief);
      if (out && out.text) {
        engine.markAI(item.id, out.text, out.why, out.model, out.lesson);
        console.log(`ai: 已改写 ${item.id} (${out.model})`);
      } else {
        engine.markAISkip(item.id, llm.status.lastError || 'AI 未返回内容');
      }
    }
  } finally {
    aiBusy = false;
    if (engine.isDirty()) saveLog();
  }
}

/* ---------- 指标仓库落盘（给 AI 查询工具备数据） ----------
   pins 序列 + 评测分数 + 训练状态。上游 api/series 每次返回的是「全量历史」，
   所以第一次运行就把 step 1~N 全部回填了，不需要单独写回填逻辑；
   之后只在 step 变化时重抓一次，避免每 20s 都打上游。 */
let lastArchiveSig = '';

async function archivePoll(meta, runs, state) {
  const pins = (meta && meta.pins) || [];
  const sig = runs.map((k) => {
    const st = state && state.status && state.status[k];
    return k + ':' + (st && st.step ? st.step.last : '');
  }).join(',');
  if (sig === lastArchiveSig) return 0; // step 没变，序列也不会变
  lastArchiveSig = sig;

  let n = 0;
  if (pins.length) {
    const tagList = encodeURIComponent(pins.join(','));
    for (const k of runs) {
      try {
        const s = await fetchUpstream('api/series?run=' + k + '&tags=' + tagList);
        n += store.saveSeries(k, s.steps || [], s.walls || [], s.series || {});
      } catch (e) { /* 单个 run 失败不影响其它 */ }
    }
    store.saveTagMeta(pins, runs, {
      pins: pins,
      descriptions: (meta && meta.descriptions) || {},
      formats: (meta && meta.formats) || [],
    });
  }
  try {
    n += store.saveBench(await fetchUpstream('api/benchmarks'));
  } catch (e) { /* 评测拿不到也不影响指标 */ }
  runs.forEach((k) => {
    const st = state && state.status && state.status[k];
    if (st) store.saveRunState(k, st);
  });
  if (n) console.log(`archive: 已落库 ${n} 行（series/bench）`);
  return n;
}

async function narratorPoll() {
  try {
    const meta = await fetchUpstream('api/runs');
    const keys = (meta.runs || []).map((r) => r.key);
    const state = { ok: true, meta, status: {}, live: {}, notices: [] };
    for (const k of keys) {
      state.status[k] = await fetchUpstream('api/status?run=' + k);
      try { state.live[k] = await fetchUpstream('api/live?run=' + k); } catch (e) { state.live[k] = null; }
    }
    try {
      const n = await fetchUpstream('api/notices');
      state.notices = n.notices || [];
    } catch (e) { /* 拿不到公告也不影响其他事件 */ }
    engine.update(state);
    lastBrief = buildBrief(state);
    if (engine.isDirty()) saveLog();
    store.saveMetrics(state); // 原始指标落库（内部做变化去重）
    archivePoll(meta, keys, state); // 指标序列/评测/状态落库（不 await，避免拖慢轮询）
    aiPass(); // 不 await：AI 慢也不该拖住监控轮询
  } catch (e) {
    // 上游偶发失败时静默跳过，下一轮重试
  }
}

const server = http.createServer(async (req, res) => {
  // '//' 这类请求会让 new URL 抛 Invalid URL，先把多余的前导斜杠压成一个
  const rawUrl = String(req.url || '/').replace(/^\/{2,}/, '/');
  const url = new URL(rawUrl, 'http://' + (req.headers.host || '127.0.0.1'));
  const p = url.pathname;

  if (p === '/api/narrator') {
    const s = llm.status;
    sendJSON(res, 200, {
      items: engine.getFeed(),
      now: engine.getNow(),
      ai: {
        enabled: s.enabled, ok: s.ok, model: s.model || '', baseUrl: s.baseUrl,
        lastError: s.lastError, generated: s.generated, failed: s.failed,
        lastOkAt: s.lastOkAt,
      },
      updated: Date.now() / 1000,
    });
    return;
  }

  if (p === '/api/ai/test') {
    let result;
    try { result = await llm.probe(); } catch (e) { result = { ok: false, error: String(e.message || e) }; }
    sendJSON(res, 200, result);
    return;
  }

  /* 图表讲解：POST /api/explain —— 流式吐字。
     payload.key 有三种形态，llm 那边按 kind 字段选讲解大纲（见 explainSystem）：
       dynsam/avg@n    精选指标
       bench:deepswe   离线评测基准
       tag:actor/lr    指标库里的原始指标
     响应是 NDJSON（每行一个 JSON，逐行推给前端）：
       {"think":"...", phase:"tool"|"main", round:n}  思考过程；工具轮的带 round 便于分组
       {"delta":"..."}  正文片段，前端边收边追加
       {"tool":{...}}   AI 调了哪个查询工具
       {"notice":"..."} 重试提示（正文没写出来，正在换策略再试）
       {"restart":{...}}重跑正文轮：前端把上一次的内容收起来，准备收新的
       {"done":true,"model":"...","attempts":n,"truncated":bool}
       {"error":"..."}  出错时给出人话原因
     客户端关掉抽屉时 req 会 close，send 返回 false 即中止生成，不浪费 token。 */
  if (p === '/api/explain') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: '请用 POST' }); return; }
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 200000) break; // body 异常大时截断，避免撑爆内存
      }
    } catch (e) {
      sendJSON(res, 400, { error: '读取请求体失败' });
      return;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch (e) {
      sendJSON(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    if (!payload || typeof payload.key !== 'string') {
      sendJSON(res, 400, { error: '缺少讲解对象的 key' });
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no', // 有反代时也不要缓冲，否则吐字会卡住
    });
    let closed = false;
    req.on('close', function () { closed = true; });
    const send = function (obj) {
      if (closed) return false;
      try { res.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { return false; }
    };
    try {
      const out = await llm.explainMetric(
        payload,
        function (t) { return send({ delta: t }); },
        // 工具轮的思考带 phase='tool'，前端放进「查询决策」区；其余是分析数据的思考
        function (t, phase, round) { return send({ think: t, phase: phase || 'main', round: round || 0 }); },
        function (info) { return send({ tool: info }); }, // AI 查了什么，前端实时显示
        {
          // 重试前通知前端：把上一次的内容收起来，别让观众以为卡住
          onNotice: function (msg) { return send({ notice: msg }); },
          onRestart: function (info) { return send({ restart: info || {} }); },
        });
      send({ done: true, model: out.model, toolRounds: out.toolRounds || 0,
             attempts: out.attempts || 1, truncated: !!out.truncated });
    } catch (e) {
      // 原始错误（HTTP 400 {...}）直接上屏没人看得懂，翻成人话；
      // 完整错误仍在服务端日志里，方便排查
      console.log('ai explain 失败：' + String(e.message || e).slice(0, 200));
      send({ error: friendlyAiError(e) });
    }
    try { res.end(); } catch (e) { /* 客户端已断开 */ }
    return;
  }

  /* 教练会话：一段对话 = 一个 sid。消息原文按 sid 存在库里（界面显示的就是它），
     摘要挂在会话上（只用来发给模型）。
       GET  /api/coach/sessions        会话列表，按最近活跃排序
       POST /api/coach/session         开一段新对话（body 可带 title）
       POST /api/coach/session/delete  删掉一段（连同它的消息与摘要）
       POST /api/coach/compress        手动压一次上下文（一般不用，收尾会自动压）
       GET  /api/coach/history?sid=    某段对话的消息原文，给界面显示
       POST /api/coach/clear           清空某段对话（body 带 sid）
     只有这几条走 JSON，正经对话还是下面那条 NDJSON 流。 */
  if (p === '/api/coach/sessions') {
    sendJSON(res, 200, { ok: true, sessions: store.coachSessions(50) });
    return;
  }
  if (p === '/api/coach/session') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: '请用 POST' }); return; }
    const body = await readJsonBody(req);
    const sid = store.newSid();
    const s = store.ensureCoachSession(sid, titleOf(body.title));
    sendJSON(res, 200, { ok: true, session: s });
    return;
  }
  if (p === '/api/coach/session/delete') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: '请用 POST' }); return; }
    const body = await readJsonBody(req);
    const sid = String(body.sid || '').trim();
    if (!sid) { sendJSON(res, 400, { error: '缺少 sid（要删哪一段对话）' }); return; }
    sendJSON(res, 200, { ok: store.deleteCoachSession(sid) });
    return;
  }
  if (p === '/api/coach/compress') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: '请用 POST' }); return; }
    const body = await readJsonBody(req);
    const sid = String(body.sid || '').trim() || null;
    const r = await session.compressSession(sid, { force: true });
    sendJSON(res, 200, Object.assign({ ok: !!r.ok }, r));
    return;
  }
  if (p === '/api/coach/history') {
    const sid = String(url.searchParams.get('sid') || '').trim() || null;
    sendJSON(res, 200, { ok: true, sid: sid || store.DEFAULT_SID, msgs: store.coachHistory(sid, 60) });
    return;
  }
  if (p === '/api/coach/clear') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: '请用 POST' }); return; }
    const body = await readJsonBody(req);
    const sid = String(body.sid || '').trim() || null;
    const ok = store.clearCoachMsg(sid);
    sendJSON(res, 200, { ok: ok });
    return;
  }

  /* AI 训练教练：POST /api/coach —— 与 /api/explain 同一套 NDJSON 事件协议
     （think / tool / delta / notice / restart / done / error），前端可以共用一套渲染。
     开头还会多推一条 {"context":{...}}：这一轮上下文的水位（给前端那个百分比条）。
     区别在 payload：
       sid       可选，哪一段对话；不传就用默认会话
       question  必填，这一轮问什么
       history   可选，前端内存里那份；有 sid 时以库里的为准（刷新后也接得上）
       context   可选，{view, chart, chartName, run} 此刻在看什么
       useContext false 表示用户关掉了「参考当前页面」，此时 context 一个字都不带
     body 比讲解大（带历史），所以上限放到 500KB。见 src/coach.js。 */
  if (p === '/api/coach') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: '请用 POST' }); return; }
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 500000) break;
      }
    } catch (e) {
      sendJSON(res, 400, { error: '读取请求体失败' });
      return;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch (e) {
      sendJSON(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    if (!payload || typeof payload.question !== 'string' || !payload.question.trim()) {
      sendJSON(res, 400, { error: '缺少 question（这一轮想问什么）' });
      return;
    }
    if (payload.question.length > 4000) {
      sendJSON(res, 400, { error: '问题太长了（上限 4000 字），拆开问更好' });
      return;
    }

    const q = payload.question.trim();
    const wantSid = String(payload.sid || '').trim() || null;
    const sess = store.ensureCoachSession(wantSid, '');
    const sid = (sess && sess.sid) || store.DEFAULT_SID;
    const cfg = llm.loadConfig();

    /* 历史必须在把本轮问题落库之前取 —— 否则本轮问题会在历史里出现一次、
       在 messages 末尾又出现一次，模型看到的是同一个问题问了两遍。 */
    let hist = store.coachHistory(sid, 200);
    if (!hist.length && Array.isArray(payload.history)) hist = payload.history; // 库里没有就信前端那份

    /* 上下文管理：会话内的内容全传，先按当前原文估一次水位；
       快到窗口上限（默认 75%）就先压一次摘要，压完重算 —— 这一轮发的就是
       「摘要 + 之后的原文」。压不成也不挡路，后面还有按预算丢最旧这条兜底。 */
    const qText = coach.coachUserText(payload);
    let turn = session.prepareTurn({ sid: sid, history: hist, questionText: qText,
      systemText: coach.COACH_SYSTEM, cfg: cfg });
    let didCompress = false;
    if (cfg.enabled && session.needsCompress(turn.stats, cfg)) {
      const r = await session.compressSession(sid);
      didCompress = !!(r && r.ok);
      turn = session.prepareTurn({ sid: sid, history: hist, questionText: qText,
        systemText: coach.COACH_SYSTEM, cfg: cfg });
    }
    payload.history = turn.history;
    payload.summary = turn.summary;
    /* 这里就把 messages 组好并算准水位（coachReply 也会组一遍，但传进去的那份
       它会直接采用），这样「丢了最旧的几条」这种事才能如实报给前端。 */
    const plan = coach.buildPlan(payload);
    payload.messages = plan.msgs;

    /* 先落库再生成：这一轮问了什么，哪怕后面生成失败也应留在记录里。
       落库失败不影响回答（store 内部只警告不抛）。 */
    store.touchCoachSession(sid, titleOf(q));
    store.saveCoachMsg('user', q, sid);

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    req.on('close', function () { closed = true; });
    const sendC = function (obj) {
      if (closed) return false;
      try { res.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { return false; }
    };
    /* 水位：这一轮用了窗口的百分之多少、有没有压缩过、丢了最旧的几条。
       丢条正常情况下是 0（压缩会先发生），不是 0 就说明压缩没赶上。 */
    const ps = plan.stats;
    sendC({
      context: {
        sid: sid, used: ps.used, window: ps.window, pct: ps.pct,
        trigger: ps.trigger, ratio: ps.ratio,
        compressed: turn.stats.compressed || 0, justCompressed: didCompress,
        dropped: ps.dropped || 0, msgs: turn.history.length, summary: !!turn.summary,
      },
    });
    if (didCompress) sendC({ notice: '这段对话已经很长，我把更早的部分压成了摘要，接着聊' });
    /* 正文累积在这里，收尾时落库。重跑正文轮（restart）要清零 ——
       否则重试的那几版会叠在一起存进去。 */
    let acc = '';
    try {
      const out = await coach.coachReply(
        payload,
        function (t) { acc += t; return sendC({ delta: t }); },
        function (t, phase, round) { return sendC({ think: t, phase: phase || 'main', round: round || 0 }); },
        function (info) { return sendC({ tool: info }); },
        {
          onNotice: function (msg) { return sendC({ notice: msg }); },
          onRestart: function (info) { acc = ''; return sendC({ restart: info || {} }); },
        });
      sendC({ done: true, model: out.model, toolRounds: out.toolRounds || 0,
              attempts: out.attempts || 1, truncated: !!out.truncated });
      /* 只有真的写出正文才存：只写思考、正文空白的那轮不该留在历史里，
         否则下一轮会看到一条空回答，前端的做法也是这样（见 finish()）。 */
      store.saveCoachMsg('assistant', acc.trim(), sid);
    } catch (e) {
      console.log('ai coach 失败：' + String(e.message || e).slice(0, 200));
      sendC({ error: friendlyAiError(e) });
    }
    try { res.end(); } catch (e) { /* 客户端已断开 */ }
    /* 收尾之后再看一眼：快到线了就后台压一次，下一轮一上来就是干净的。
       不等它 —— 这一轮已经答完，用户不该为压缩多等。 */
    session.scheduleCompress(sid, { systemText: coach.COACH_SYSTEM });
    return;
  }

  /* 指标序列：照常代理，顺手把结果存一份进本地库。
     这样在指标库里浏览过的指标会自动缓存，AI 查询工具就有数据可查了。 */
  if (p === '/api/series') {
    try {
      const body = await fetchUpstream('api/series' + (url.search || ''));
      // 落库失败绝不能影响正常返回——它只是旁路缓存，不是主流程
      try {
        const run = url.searchParams.get('run');
        if (run && body && body.series) {
          store.saveSeries(run, body.steps || [], body.walls || [], body.series);
        }
      } catch (e) { console.warn('archive: series 落库失败', e.message); }
      sendJSON(res, 200, body);
    } catch (err) {
      sendJSON(res, 502, { error: String(err.message || err) });
    }
    return;
  }

  // 评测分数：同样边代理边落库
  if (p === '/api/benchmarks') {
    try {
      const body = await fetchUpstream('api/benchmarks' + (url.search || ''));
      try { store.saveBench(body); } catch (e) { console.warn('archive: bench 落库失败', e.message); }
      sendJSON(res, 200, body);
    } catch (err) {
      sendJSON(res, 502, { error: String(err.message || err) });
    }
    return;
  }

  /* 本地指标仓库查询（给 AI 查询工具用）
       /api/db/series?run=pro&tag=dynsam/avg@n&from=10
       /api/db/tags?q=dynsam&limit=50          （空 q 返回 pinned 指标）
       /api/db/bench?bench=deepswe&run=pro     （都不传返回评测字典） */
  if (p === '/api/db/series') {
    const tag = url.searchParams.get('tag');
    if (!tag) { sendJSON(res, 400, { error: '缺少 tag' }); return; }
    const from = url.searchParams.get('from');
    sendJSON(res, 200, {
      run: url.searchParams.get('run'), tag: tag,
      rows: store.querySeries(
        url.searchParams.get('run'), tag, from != null ? Number(from) : null
      ),
    });
    return;
  }

  if (p === '/api/db/tags') {
    sendJSON(res, 200, {
      q: url.searchParams.get('q') || '',
      rows: store.searchTags(url.searchParams.get('q'), { limit: url.searchParams.get('limit') }),
    });
    return;
  }

  if (p === '/api/db/bench') {
    sendJSON(res, 200, {
      bench: url.searchParams.get('bench'), run: url.searchParams.get('run'),
      rows: store.queryBench(url.searchParams.get('bench'), url.searchParams.get('run')),
    });
    return;
  }

  // 本地存档统计（SQLite）
  if (p === '/api/db/stats') {
    sendJSON(res, 200, store.stats());
    return;
  }

  // 历史指标：/api/history?run=pro&limit=500
  if (p === '/api/history') {
    sendJSON(res, 200, {
      rows: store.history(url.searchParams.get('run'), url.searchParams.get('limit')),
      stats: store.stats(),
    });
    return;
  }

  // CSV 导出：/api/history.csv?run=pro
  if (p === '/api/history.csv') {
    const rows = store.history(url.searchParams.get('run'), url.searchParams.get('limit') || 5000);
    const buf = Buffer.from('\ufeff' + store.toCSV(rows), 'utf8'); // BOM 让 Excel 认中文
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="mimo-metrics.csv"',
      'content-length': buf.length,
    });
    res.end(buf);
    return;
  }

  // 解说全文检索：/api/search?q=重启&limit=50
  if (p === '/api/search') {
    sendJSON(res, 200, {
      q: url.searchParams.get('q') || '',
      items: store.searchNarrator(url.searchParams.get('q'), url.searchParams.get('limit')),
    });
    return;
  }

  // 手动让 AI 补说最近 n 条（n≤10）；force=1 时连已经说过的一起重说（改提示词后刷新用）
  if (p === '/api/ai/retry') {
    const n = Math.min(Number(url.searchParams.get('n') || 1) || 1, 10);
    const force = url.searchParams.get('force') === '1';
    const c = engine.requeueLast(n, force);
    aiPass();
    sendJSON(res, 200, { requeued: c, status: llm.status });
    return;
  }

  if (p.startsWith('/api/')) {
    // /api/status?run=pro  ->  upstream "api/status?run=pro"
    const target = p.replace(/^\//, '') + (url.search || '');
    try {
      const body = await fetchUpstream(target);
      sendJSON(res, 200, body);
    } catch (err) {
      sendJSON(res, 502, { error: String(err.message || err) });
    }
    return;
  }

  serveStatic(res, p);
});

server.listen(PORT, HOST, () => {
  console.log(`mimo-train-live  ->  http://${HOST}:${PORT}`);
  console.log(`proxying upstream: ${UPSTREAM}  (cache ${TTL}ms)`);
  loadLog();
  narratorPoll();
  setInterval(narratorPoll, NARRATOR_MS);
  const s = store.stats();
  if (s.enabled) {
    console.log(`sqlite: data/board.db（驱动 ${s.driver}）· 指标 ${s.metrics} 条 · 解说 ${s.narrator} 条 · ${(s.sizeBytes / 1024).toFixed(0)} KB`);
    console.log(`sequence: series ${s.series} 行 / ${s.seriesTags} 个指标（最新 step ${s.seriesMaxStep}）· 评测 ${s.bench} 行 · 状态 ${s.runState} 行`);
    store.checkpoint(); // 启动时先把攒着的 WAL 收回去
    setInterval(function () { store.checkpoint(); }, 300000); // 之后每 5 分钟收一次
  } else {
    // 存档不可用仍让看板跑起来：实时指标、解说、AI 讲解都不依赖落盘
    console.warn('sqlite: 存档不可用 —— 历史指标 / 解说搜索 / CSV 导出 这次都用不了');
    console.warn(String(s.reason || '未知原因').split('\n').join('\n        '));
  }
  console.log(`narrator engine: 每 ${NARRATOR_MS / 1000}s 记录一次`);

  const lcfg = llm.loadConfig();
  if (!lcfg.enabled) {
    console.log('ai narrator: 未启用（config.json llm.enabled=false），全部走规则模板');
  } else {
    console.log(`ai narrator: ${lcfg.baseUrl}${lcfg.model ? ' model=' + lcfg.model : ' (自动选模型)'}`);
    llm.probe().then((r) => {
      if (r.ok) console.log(`ai narrator: 连通，可用模型 ${r.count} 个 → ${(r.models || []).slice(0, 5).join(', ')}`);
      else console.log(`ai narrator: 连接失败（${r.error}），将保留规则文案`);
    });
  }
});
