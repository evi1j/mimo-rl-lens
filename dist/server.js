/* Local proxy + static server for the mimo-v2.6 RL live board.
   Upstream: https://mimo.xiaomi.com/rl/  (public JSON endpoints)
   Run: node server.js   ->   http://127.0.0.1:8787            */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEngine } = require('./public/narrator-core.js');
const llm = require('./llm.js');
const store = require('./store.js');

const PORT = Number(process.env.PORT || 8787);
// 0.0.0.0 = 监听所有网卡，局域网/虚拟局域网内的其他设备才能访问。
// 只想本机访问的话，启动时加 HOST=127.0.0.1 覆盖。
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = 'https://mimo.xiaomi.com/rl/';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'narrator.json');
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

function loadLog() {
  // 优先 SQLite；建库失败时退回原来的 JSON 文件
  if (store.enabled) {
    const d = store.loadNarrator();
    if (d) {
      engine.hydrate(d);
      console.log(`narrator: 已从 SQLite 恢复 ${engine.getFeed().length} 条历史解说`);
      return;
    }
  }
  try {
    engine.hydrate(JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')));
    console.log(`narrator: 已恢复 ${engine.getFeed().length} 条历史解说（JSON）`);
  } catch (e) {
    // 首次运行没有历史，属正常
  }
}

function saveLog() {
  if (store.enabled && store.saveNarrator(engine.serialize())) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = LOG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(engine.serialize()));
    fs.renameSync(tmp, LOG_FILE);
  } catch (e) {
    console.warn('narrator: 写日志失败', e.message);
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
    console.log(`sqlite: data/board.db · 指标 ${s.metrics} 条 · 解说 ${s.narrator} 条 · ${(s.sizeBytes / 1024).toFixed(0)} KB`);
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
