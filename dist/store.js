/* 本地存档层：SQLite（Node 22 内置 node:sqlite，零依赖）
   存两样东西：
     1) metrics   —— 每次轮询抓到的原始指标快照（带变化去重）
     2) narrator  —— 解说流（含 AI 文案、教学段落、事件原始数值）
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
    `);
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
    let size = 0;
    try { size = fs.statSync(DB_FILE).size; } catch (e) {}
    return {
      enabled: true, file: DB_FILE, sizeBytes: size,
      metrics: m.c, metricsFrom: m.t0, metricsTo: m.t1,
      perRun: perRun, narrator: n.c,
    };
  } catch (e) {
    return { enabled: true, error: e.message };
  }
}

module.exports = {
  init, loadNarrator, saveNarrator, saveMetrics,
  history, toCSV, searchNarrator, stats,
  get enabled() { return init(); },
};
