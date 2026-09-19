/* 本地存档层：SQLite（Node 22 内置 node:sqlite，零依赖）
   存三类东西：
     1) metrics   —— 每次轮询抓到的原始指标快照（带变化去重）
     2) narrator  —— 解说流（含 AI 文案、教学段落、事件原始数值）
     3) 指标仓库  —— series / tag_meta / bench / bench_meta / run_state
        series 是窄表：指标名是「值」不是「列名」，所以上游再加指标也不用改表结构。
        这是给 AI 查询工具备的数据地基。
   meta 表放解说引擎的其它内部状态（prev / seenNotices 等），保持 narrator.json 的行为。 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'board.db');
const LEGACY_JSON = path.join(DATA_DIR, 'narrator.json');

let db = null;
let ready = false;

/* ---------- 建库建表 ---------- */
function init() {
  if (db) return ready;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_FILE);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          REAL NOT NULL,
        run         TEXT NOT NULL,
        step        INTEGER,
        phase       TEXT,
        progress    REAL,
        value       REAL,
        prev        REAL,
        passrate    REAL,
        pr0         REAL,
        pr1         REAL,
        cost        REAL,
        tokens_step REAL,
        tokens_cum  REAL,
        restarts    INTEGER,
        judged      INTEGER,
        judged_of   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_run_ts ON metrics(run, ts);

      CREATE TABLE IF NOT EXISTS narrator (
        id        TEXT PRIMARY KEY,
        ts        REAL,
        level     TEXT,
        run       TEXT,
        official  INTEGER DEFAULT 0,
        ai        INTEGER DEFAULT 0,
        ai_state  TEXT,
        ai_model  TEXT,
        ai_error  TEXT,
        text      TEXT,
        why       TEXT,
        lesson    TEXT,
        ctx       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_narrator_ts ON narrator(ts DESC);

      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

      /* 指标序列：所有指标（含将来新增的）每一步的值都在这里。
         主键 (run,tag,step) 天然幂等 —— 上游每次返回全量历史，直接 REPLACE 覆盖即可，
         不需要增量判断，也不会因为重复抓取而膨胀。 */
      CREATE TABLE IF NOT EXISTS series (
        run  TEXT NOT NULL,
        tag  TEXT NOT NULL,
        step INTEGER NOT NULL,
        v    REAL,
        wall REAL,
        ts   REAL NOT NULL,
        PRIMARY KEY (run, tag, step)
      );
      CREATE INDEX IF NOT EXISTS idx_series_tag_step ON series(tag, step);
      CREATE INDEX IF NOT EXISTS idx_series_run_step ON series(run, step);

      /* 指标字典：给 AI 做检索用（上游 2029 个 tag，名字极易幻觉，必须先查后引用） */
      CREATE TABLE IF NOT EXISTS tag_meta (
        tag        TEXT PRIMARY KEY,
        runs       TEXT,
        unit       TEXT,
        descr      TEXT,
        zh         TEXT,
        pinned     INTEGER DEFAULT 0,
        first_seen REAL,
        last_seen  REAL
      );

      /* 评测分数：与 series 同构，将来想交叉分析「训练指标 vs 评测分数」能对齐到 step */
      CREATE TABLE IF NOT EXISTS bench (
        bench TEXT NOT NULL,
        run   TEXT NOT NULL,
        step  INTEGER NOT NULL,
        v     REAL,
        ts    REAL NOT NULL,
        PRIMARY KEY (bench, run, step)
      );

      CREATE TABLE IF NOT EXISTS bench_meta (
        bench  TEXT PRIMARY KEY,
        title  TEXT,
        note   TEXT,
        format TEXT,
        ts     REAL
      );

      /* 训练全局状态快照：progress / 规模 / 阶段。与 metrics 的区别是
         metrics 是事件流（每次轮询追加），run_state 是状态（按 step 覆盖更新）。 */
      CREATE TABLE IF NOT EXISTS run_state (
        run              TEXT NOT NULL,
        step             INTEGER NOT NULL,
        progress         REAL,
        phase            TEXT,
        restarts         INTEGER,
        trained_step     INTEGER,
        prompts_per_step INTEGER,
        tokens_step      REAL,
        cost_so_far      REAL,
        version          TEXT,
        run_start        REAL,
        ts               REAL NOT NULL,
        PRIMARY KEY (run, step)
      );
    `);
    // WAL 默认 1000 页才自动 checkpoint，服务常驻时容易攒到几 MB。压低一些。
    db.exec('PRAGMA wal_autocheckpoint = 256');
    ready = true;
    migrateLegacy();
  } catch (e) {
    console.warn('sqlite: 初始化失败（' + e.message + '），将退回 JSON 存档');
    db = null;
    ready = false;
  }
  return ready;
}

/* 旧的 data/narrator.json 原地迁移进来，原文件改名为 .migrated 留底 */
function migrateLegacy() {
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM narrator').get().c;
    if (count > 0 || !fs.existsSync(LEGACY_JSON)) return;
    const old = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    const rows = Array.isArray(old.feed) ? old.feed : [];
    const ins = db.prepare(
      'INSERT OR REPLACE INTO narrator (id,ts,level,run,official,ai,ai_state,ai_model,ai_error,text,why,lesson,ctx)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    db.exec('BEGIN');
    rows.forEach((it) => ins.run(
      String(it.id), it.ts || 0, it.level || 'info', it.run || null,
      it.official ? 1 : 0, it.ai ? 1 : 0, it.aiState || '', it.aiModel || '', it.aiError || '',
      it.text || '', it.why || '', it.lesson || '', it.ctx ? JSON.stringify(it.ctx) : null
    ));
    const rest = {};
    Object.keys(old).forEach((k) => { if (k !== 'feed') rest[k] = old[k]; });
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('engine', JSON.stringify(rest));
    db.exec('COMMIT');
    fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.migrated');
    console.log(`sqlite: 已迁移 ${rows.length} 条解说（原 JSON 保留为 narrator.json.migrated）`);
  } catch (e) {
    console.warn('sqlite: 迁移旧 JSON 失败', e.message);
  }
}

/* ---------- 解说 ---------- */
function rowToItem(r) {
  let ctx = null;
  if (r.ctx) { try { ctx = JSON.parse(r.ctx); } catch (e) { ctx = null; } }
  return {
    id: r.id, ts: r.ts, level: r.level, run: r.run,
    official: !!r.official, ai: !!r.ai, aiState: r.ai_state || 'skipped',
    aiModel: r.ai_model || '', aiError: r.ai_error || '',
    text: r.text || '', why: r.why || '', lesson: r.lesson || '', ctx: ctx,
  };
}

function loadNarrator() {
  if (!init()) return null;
  try {
    const rows = db.prepare('SELECT * FROM narrator ORDER BY ts DESC, id DESC').all();
    const metaRow = db.prepare("SELECT v FROM meta WHERE k='engine'").get();
    const base = metaRow ? JSON.parse(metaRow.v) : {};
    const feed = rows.map(rowToItem);
    if (!feed.length && !Object.keys(base).length) return null;
    return Object.assign({}, base, { v: 1, feed: feed });
  } catch (e) {
    console.warn('sqlite: 读取解说失败', e.message);
    return null;
  }
}

function saveNarrator(serialized) {
  if (!init()) return false;
  try {
    const feed = Array.isArray(serialized.feed) ? serialized.feed : [];
    const rest = {};
    Object.keys(serialized).forEach((k) => { if (k !== 'feed') rest[k] = serialized[k]; });

    const ins = db.prepare(
      'INSERT OR REPLACE INTO narrator (id,ts,level,run,official,ai,ai_state,ai_model,ai_error,text,why,lesson,ctx)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    db.exec('BEGIN');
    feed.forEach((it) => ins.run(
      String(it.id), it.ts || 0, it.level || 'info', it.run || null,
      it.official ? 1 : 0, it.ai ? 1 : 0, it.aiState || '', it.aiModel || '', it.aiError || '',
      it.text || '', it.why || '', it.lesson || '', it.ctx ? JSON.stringify(it.ctx) : null
    ));
    // 清掉已被挤出列表的旧条目（引擎上限 200 条）
    const keep = feed.map((it) => String(it.id));
    const existing = db.prepare('SELECT id FROM narrator').all().map((r) => String(r.id));
    const drop = existing.filter((id) => keep.indexOf(id) < 0);
    if (drop.length) {
      const del = db.prepare('DELETE FROM narrator WHERE id = ?');
      drop.forEach((id) => del.run(id));
    }
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('engine', JSON.stringify(rest));
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.warn('sqlite: 写入解说失败', e.message);
    return false;
  }
}

/* ---------- 原始指标 ---------- */
const lastSig = {};
const SIG_KEYS = ['step', 'phase', 'value', 'passrate', 'pr0', 'pr1', 'restarts', 'judged'];

function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

function saveMetrics(state) {
  if (!init() || !state || !state.status) return 0;
  let written = 0;
  const ins = db.prepare(
    'INSERT INTO metrics (ts,run,step,phase,progress,value,prev,passrate,pr0,pr1,cost,tokens_step,tokens_cum,restarts,judged,judged_of)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const ts = Date.now() / 1000;
  try {
    Object.keys(state.status).forEach((k) => {
      const st = state.status[k];
      if (!st) return;
      const lv = state.live && state.live[k] && state.live[k].latest;
      const row = {
        step: st.step && st.step.last,
        phase: st.step && st.step.phase,
        value: st.headline && st.headline.last,
        passrate: lv ? r3(lv.passrate) : null,
        pr0: lv ? r3(lv.pr0) : null,
        pr1: lv ? r3(lv.pr1) : null,
        restarts: st.totals && st.totals.restarts,
        judged: lv ? lv.judged : null,
      };
      // 只在真正变了的时候落一行，避免一天几万条重复数据
      const sig = SIG_KEYS.map((key) => String(row[key])).join('|');
      if (lastSig[k] === sig) return;
      lastSig[k] = sig;

      ins.run(
        ts, k, row.step, row.phase || null,
        st.step && st.step.progress != null ? st.step.progress : null,
        row.value != null ? row.value : null,
        st.headline && st.headline.prev != null ? st.headline.prev : null,
        row.passrate, row.pr0, row.pr1,
        st.cost && st.cost.so_far != null ? st.cost.so_far : null,
        st.totals && st.totals.tokens_step != null ? st.totals.tokens_step : null,
        st.totals && st.totals.tokens_cum != null ? st.totals.tokens_cum : null,
        row.restarts != null ? row.restarts : null,
        row.judged, lv && lv.judged_of != null ? lv.judged_of : null
      );
      written++;
    });
  } catch (e) {
    console.warn('sqlite: 写入指标失败', e.message);
  }
  return written;
}

/* ---------- 指标仓库：series / tag_meta / bench / bench_meta / run_state ---------- */

/* 单位/格式：上游给的是 [正则, 格式名] 规则表，比如 ["^timing_s/", "duration"] */
function unitFor(tag, formats) {
  for (let i = 0; i < (formats || []).length; i++) {
    const rule = formats[i];
    if (!Array.isArray(rule) || rule.length < 2) continue;
    try { if (new RegExp(rule[0]).test(tag)) return String(rule[1]); } catch (e) {}
  }
  return null;
}

/* 写指标序列。steps / walls 与 series[tag] 下标一一对应。
   上游每次返回全量历史，所以直接 REPLACE —— 重复抓取不会让表膨胀。 */
function saveSeries(run, steps, walls, series) {
  if (!init() || !run || !series) return 0;
  const tags = Object.keys(series);
  if (!tags.length || !Array.isArray(steps)) return 0;
  const ts = Date.now() / 1000;
  let n = 0;
  const ins = db.prepare(
    'INSERT OR REPLACE INTO series (run,tag,step,v,wall,ts) VALUES (?,?,?,?,?,?)'
  );
  try {
    db.exec('BEGIN');
    for (const tag of tags) {
      const arr = series[tag] || [];
      for (let i = 0; i < arr.length && i < steps.length; i++) {
        const step = steps[i];
        if (step == null) continue;
        let v = arr[i];
        if (v != null && (typeof v !== 'number' || Number.isNaN(v))) v = null;
        ins.run(run, tag, step, v == null ? null : v,
          walls && walls[i] != null ? walls[i] : null, ts);
        n++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.warn('sqlite: 写 series 失败', e.message);
    return 0;
  }
  return n;
}

/* 写指标字典。descr 只在有值时覆盖，避免上游没给释义时把已存的冲掉。 */
function saveTagMeta(tags, runs, opts) {
  if (!init() || !Array.isArray(tags)) return 0;
  opts = opts || {};
  const ts = Date.now() / 1000;
  const runsStr = Array.isArray(runs) ? runs.join(',') : String(runs || '');
  const pinSet = {};
  (opts.pins || []).forEach((t) => { pinSet[t] = 1; });
  const descr = opts.descriptions || {};
  const formats = opts.formats || [];
  let n = 0;
  const ins = db.prepare('INSERT OR IGNORE INTO tag_meta (tag,first_seen) VALUES (?,?)');
  const upd = db.prepare(
    'UPDATE tag_meta SET runs=?, unit=COALESCE(?,unit), descr=COALESCE(?,descr),' +
    ' pinned=?, last_seen=? WHERE tag=?'
  );
  try {
    db.exec('BEGIN');
    for (const tag of tags) {
      if (!tag) continue;
      ins.run(tag, ts);
      upd.run(runsStr, unitFor(tag, formats), descr[tag] || null, pinSet[tag] ? 1 : 0, ts, tag);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.warn('sqlite: 写 tag_meta 失败', e.message);
    return 0;
  }
  return n;
}

/* 写评测分数 + 评测字典。results 结构是 {run: {step: score}} */
function saveBench(payload) {
  if (!init() || !payload) return 0;
  const arr = payload.benchmarks || [];
  if (!Array.isArray(arr)) return 0;
  const ts = Date.now() / 1000;
  let n = 0;
  const insMeta = db.prepare(
    'INSERT OR REPLACE INTO bench_meta (bench,title,note,format,ts) VALUES (?,?,?,?,?)'
  );
  const ins = db.prepare('INSERT OR REPLACE INTO bench (bench,run,step,v,ts) VALUES (?,?,?,?,?)');
  try {
    db.exec('BEGIN');
    for (const b of arr) {
      const key = b.key;
      if (!key) continue;
      insMeta.run(key, b.title || null, b.note || null, b.format || null, ts);
      const results = b.results || {};
      Object.keys(results).forEach((run) => {
        const byStep = results[run] || {};
        Object.keys(byStep).forEach((stepStr) => {
          const step = Number(stepStr);
          if (!Number.isFinite(step)) return;
          let v = byStep[stepStr];
          if (v != null && (typeof v !== 'number' || Number.isNaN(v))) v = null;
          ins.run(key, run, step, v == null ? null : v, ts);
          n++;
        });
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.warn('sqlite: 写 bench 失败', e.message);
    return 0;
  }
  return n;
}

/* 写训练状态快照（按 run+step 覆盖） */
function saveRunState(run, st) {
  if (!init() || !run || !st) return 0;
  const step = st.step && st.step.last;
  if (step == null) return 0;
  const ts = Date.now() / 1000;
  try {
    db.prepare(
      'INSERT OR REPLACE INTO run_state (run,step,progress,phase,restarts,trained_step,' +
      'prompts_per_step,tokens_step,cost_so_far,version,run_start,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      run, step,
      st.step && st.step.progress != null ? st.step.progress : null,
      st.step && st.step.phase ? st.step.phase : null,
      st.totals && st.totals.restarts != null ? st.totals.restarts : null,
      st.totals && st.totals.trained_step != null ? st.totals.trained_step : null,
      st.totals && st.totals.prompts_per_step != null ? st.totals.prompts_per_step : null,
      st.totals && st.totals.tokens_step != null ? st.totals.tokens_step : null,
      st.cost && st.cost.so_far != null ? st.cost.so_far : null,
      st.version || null,
      st.run && st.run.start != null ? st.run.start : null,
      ts
    );
    return 1;
  } catch (e) {
    console.warn('sqlite: 写 run_state 失败', e.message);
    return 0;
  }
}

/* 查一条序列 -> [{run,step,v,wall}]，按 step 升序 */
function querySeries(run, tag, fromStep) {
  if (!init() || !tag) return [];
  const lim = 20000;
  try {
    if (run && fromStep != null) {
      return db.prepare('SELECT run,step,v,wall FROM series WHERE run=? AND tag=? AND step>=? ORDER BY step LIMIT ?').all(run, tag, fromStep, lim);
    }
    if (run) {
      return db.prepare('SELECT run,step,v,wall FROM series WHERE run=? AND tag=? ORDER BY step LIMIT ?').all(run, tag, lim);
    }
    return db.prepare('SELECT run,step,v,wall FROM series WHERE tag=? ORDER BY run, step LIMIT ?').all(tag, lim);
  } catch (e) { return []; }
}

/* 指标检索：先按前缀（走主键索引），前缀没命中再退化为子串模糊匹配。
   空查询返回 pinned 的指标。 */
function searchTags(q, opts) {
  if (!init()) return [];
  opts = opts || {};
  const lim = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const s = String(q || '').trim();
  try {
    if (!s) {
      return db.prepare('SELECT * FROM tag_meta WHERE pinned=1 ORDER BY tag LIMIT ?').all(lim);
    }
    const rows = db.prepare(
      'SELECT * FROM tag_meta WHERE tag >= ? AND tag < ? ORDER BY tag LIMIT ?'
    ).all(s, s + '\uffff', lim);
    if (rows.length) return rows;
    return db.prepare('SELECT * FROM tag_meta WHERE tag LIKE ? ORDER BY tag LIMIT ?').all('%' + s + '%', lim);
  } catch (e) { return []; }
}

/* 评测查询：不传 bench 时返回评测字典 */
function queryBench(bench, run) {
  if (!init()) return [];
  try {
    if (bench && run) {
      return db.prepare('SELECT step, v FROM bench WHERE bench=? AND run=? ORDER BY step').all(bench, run);
    }
    if (bench) {
      return db.prepare('SELECT run, step, v FROM bench WHERE bench=? ORDER BY run, step').all(bench);
    }
    return db.prepare('SELECT * FROM bench_meta ORDER BY bench').all();
  } catch (e) { return []; }
}

/* 训练状态查询：不传 run 返回每个 run 的最新一条 */
function queryRunState(run) {
  if (!init()) return [];
  try {
    if (run) {
      return db.prepare('SELECT * FROM run_state WHERE run=? ORDER BY step DESC LIMIT 1').all(run);
    }
    // 每个 run 只取最新一步：用 MAX(step) 子查询，避免把所有快照都捞出来
    return db.prepare(
      'SELECT r.* FROM run_state r INNER JOIN' +
      ' (SELECT run, MAX(step) AS ms FROM run_state GROUP BY run) m' +
      ' ON r.run = m.run AND r.step = m.ms ORDER BY r.run'
    ).all();
  } catch (e) { return []; }
}

/* 库里已有的最新 step，用来判断要不要重新拉一次全量 */
function latestStep(run) {
  if (!init()) return null;
  try {
    const r = run
      ? db.prepare('SELECT MAX(step) AS s FROM series WHERE run=?').get(run)
      : db.prepare('SELECT MAX(step) AS s FROM series').get();
    return r && r.s != null ? r.s : null;
  } catch (e) { return null; }
}

/* WAL 手动 checkpoint。服务常驻时 WAL 会一直涨，定期收一下。 */
function checkpoint() {
  if (!init()) return null;
  try {
    const r = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all();
    return (r && r[0]) || null;
  } catch (e) {
    try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch (e2) {}
    return null;
  }
}

function history(run, limit) {
  if (!init()) return [];
  const n = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  try {
    if (run) return db.prepare('SELECT * FROM metrics WHERE run = ? ORDER BY ts DESC LIMIT ?').all(run, n);
    return db.prepare('SELECT * FROM metrics ORDER BY ts DESC LIMIT ?').all(n);
  } catch (e) { return []; }
}

function toCSV(rows) {
  const cols = ['ts', 'run', 'step', 'phase', 'progress', 'value', 'prev', 'passrate', 'pr0', 'pr1',
    'cost', 'tokens_step', 'tokens_cum', 'restarts', 'judged', 'judged_of'];
  const head = cols.join(',');
  const iso = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const body = rows.map((r) => cols.map((c) => {
    const v = r[c];
    if (v == null) return '';
    if (c === 'ts') return iso(v);
    return String(v);
  }).join(','));
  return [head].concat(body).join('\n');
}

/* 解说全文检索：text / why / lesson 三个字段 */
function searchNarrator(q, limit) {
  if (!init()) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    const like = '%' + String(q || '') + '%';
    return db.prepare(
      'SELECT * FROM narrator WHERE text LIKE ? OR why LIKE ? OR lesson LIKE ? ORDER BY ts DESC LIMIT ?'
    ).all(like, like, like, n).map(rowToItem);
  } catch (e) { return []; }
}

function stats() {
  if (!init()) return { enabled: false };
  try {
    const m = db.prepare('SELECT COUNT(*) AS c, MIN(ts) AS t0, MAX(ts) AS t1 FROM metrics').get();
    const n = db.prepare('SELECT COUNT(*) AS c FROM narrator').get();
    const perRun = db.prepare('SELECT run, COUNT(*) AS c FROM metrics GROUP BY run').all();
    const sv = db.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT tag) AS tags, MAX(step) AS s1 FROM series').get();
    const tg = db.prepare('SELECT COUNT(*) AS c FROM tag_meta').get();
    const bc = db.prepare('SELECT COUNT(*) AS c FROM bench').get();
    const rs = db.prepare('SELECT COUNT(*) AS c FROM run_state').get();
    let size = 0;
    try { size = fs.statSync(DB_FILE).size; } catch (e) {}
    return {
      enabled: true, file: DB_FILE, sizeBytes: size,
      metrics: m.c, metricsFrom: m.t0, metricsTo: m.t1,
      perRun: perRun, narrator: n.c,
      series: sv.c, seriesTags: sv.tags, seriesMaxStep: sv.s1,
      tagMeta: tg.c, bench: bc.c, runState: rs.c,
    };
  } catch (e) {
    return { enabled: true, error: e.message };
  }
}

module.exports = {
  init, loadNarrator, saveNarrator, saveMetrics,
  history, toCSV, searchNarrator, stats,
  saveSeries, saveTagMeta, saveBench, saveRunState,
  querySeries, searchTags, queryBench, queryRunState, latestStep, checkpoint, unitFor,
  get enabled() { return init(); },
};
