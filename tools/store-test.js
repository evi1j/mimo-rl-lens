/* 指标仓库（series / tag_meta / bench / bench_meta / run_state）的端到端测试。
   用法：NODE_PATH=... node tools/store-test.js
   注意：store.js 是单例，直接用 data/board.db；写入的假数据用 __test__ 前缀，跑完清理。 */

const path = require('path');
const store = require(path.join(__dirname, '..', 'store.js'));
// 走适配层而不是直接 require('node:sqlite')：本机 Node 太旧时测试也能跑（wasm 兜底）
const sqlite = require(path.join(__dirname, '..', 'sqlite.js'));

const DB = process.env.MIMO_DB_FILE || path.join(__dirname, '..', 'data', 'board.db');
let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

function cleanup() {
  const db = sqlite.open(DB).db;
  db.exec("DELETE FROM series WHERE run='__test__'");
  db.exec("DELETE FROM tag_meta WHERE tag LIKE '__test__%'");
  db.exec("DELETE FROM bench WHERE bench='__test__'");
  db.exec("DELETE FROM bench_meta WHERE bench='__test__'");
  db.exec("DELETE FROM run_state WHERE run='__test__'");
}

(async function main() {
  console.log('指标仓库测试（data/board.db）\n');
  cleanup();

  const db = sqlite.open(DB).db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);

  console.log('— 建表 —');
  ['series', 'tag_meta', 'bench', 'bench_meta', 'run_state'].forEach((t) => {
    check('表 ' + t + ' 存在', tables.indexOf(t) >= 0, tables.join(','));
  });
  check('原有表没被破坏（metrics/narrator/meta 仍在）',
    ['metrics', 'narrator', 'meta'].every((t) => tables.indexOf(t) >= 0));

  console.log('\n— series 写入与幂等 —');
  const steps = [1, 2, 3, 4];
  const walls = [100.5, 200.5, 300.5, 400.5];
  const series = { '__test__/a': [1.5, null, 3.5, 4.5], '__test__/b': [0.1, 0.2, 0.3, 0.4] };
  const n1 = store.saveSeries('__test__', steps, walls, series);
  const n2 = store.saveSeries('__test__', steps, walls, series);
  check('首次写入 8 行', n1 === 8, String(n1));
  check('重复写入返回同样行数（幂等）', n2 === 8, String(n2));
  const cnt = db.prepare("SELECT COUNT(*) c FROM series WHERE run='__test__'").get().c;
  check('库里仍是 8 行（REPLACE 覆盖而非追加）', cnt === 8, String(cnt));

  console.log('\n— series 查询 —');
  const rows = store.querySeries('__test__', '__test__/a');
  check('按 tag 查到 4 行', rows.length === 4, String(rows.length));
  check('按 step 升序', rows.every((r, i) => i === 0 || r.step > rows[i - 1].step));
  check('NULL 值保留为 null（不丢行、不填 0）',
    rows[1].v === null, JSON.stringify(rows[1]));
  check('wall 时间写入', rows[0].wall === 100.5, String(rows[0].wall));
  const fromRows = store.querySeries('__test__', '__test__/a', 3);
  check('from=3 只返回后两步', fromRows.length === 2, String(fromRows.length));

  console.log('\n— tag_meta 与检索 —');
  store.saveTagMeta(['__test__/a', '__test__/b'], ['pro', 'flash'], {
    pins: ['__test__/a'],
    descriptions: { '__test__/a': '测试指标释义' },
    formats: [['^__test__/', 'num2'], ['_gb$', 'gb']],
  });
  const meta = db.prepare("SELECT * FROM tag_meta WHERE tag='__test__/a'").get();
  check('descr 写入', meta.descr === '测试指标释义', String(meta.descr));
  check('unit 由 formats 正则推导', meta.unit === 'num2', String(meta.unit));
  check('pinned 标记正确', meta.pinned === 1, String(meta.pinned));
  check('runs 记录为 pro,flash', meta.runs === 'pro,flash', String(meta.runs));
  const metaB = db.prepare("SELECT * FROM tag_meta WHERE tag='__test__/b'").get();
  check('非 pins 的 pinned=0', metaB.pinned === 0, String(metaB.pinned));

  // descr 为空时不应把已存的值冲掉
  store.saveTagMeta(['__test__/a'], ['pro'], { formats: [] });
  const meta2 = db.prepare("SELECT * FROM tag_meta WHERE tag='__test__/a'").get();
  check('descr 为空时不覆盖旧值', meta2.descr === '测试指标释义', String(meta2.descr));

  const hits = store.searchTags('__test__/');
  check('前缀检索命中 2 条', hits.length === 2, String(hits.length));
  const sub = store.searchTags('test__/a', { limit: 10 });
  check('子串回退也能命中', sub.length >= 1, String(sub.length));

  console.log('\n— bench —');
  store.saveBench({
    benchmarks: [{
      key: '__test__', title: '测试评测', note: 'avg@3', format: 'num2',
      results: { pro: { 1: 10.5, 2: 20 }, flash: { 1: 9.5 } },
    }],
  });
  const bm = db.prepare("SELECT * FROM bench_meta WHERE bench='__test__'").get();
  check('bench_meta 写入标题', bm && bm.title === '测试评测', bm ? bm.title : '');
  check('bench 写入 3 行（pro 2 + flash 1）',
    db.prepare("SELECT COUNT(*) c FROM bench WHERE bench='__test__'").get().c === 3);
  const bq = store.queryBench('__test__', 'pro');
  check('按 bench+run 查询升序', bq.length === 2 && bq[0].step === 1 && bq[1].step === 2,
    JSON.stringify(bq));
  check('不传参数返回评测字典', Array.isArray(store.queryBench()) && store.queryBench().length >= 1);

  console.log('\n— run_state —');
  store.saveRunState('__test__', {
    step: { last: 7, progress: 0.5, phase: 'training' },
    totals: { restarts: 3, trained_step: 100, prompts_per_step: 20, tokens_step: 1e9 },
    cost: { so_far: 123.4 }, version: 'v-test', run: { start: 1000 },
  });
  const rs = db.prepare("SELECT * FROM run_state WHERE run='__test__'").get();
  check('run_state 主键是 run+step', !!rs && rs.step === 7);
  check('progress/phase/restarts 写入',
    rs.progress === 0.5 && rs.phase === 'training' && rs.restarts === 3,
    JSON.stringify(rs));
  check('规模字段写入（trained_step/prompts/cost）',
    rs.trained_step === 100 && rs.prompts_per_step === 20 && rs.cost_so_far === 123.4);
  store.saveRunState('__test__', { step: { last: 7, progress: 0.9 } });
  check('同 step 重复写只留一行（覆盖更新）',
    db.prepare("SELECT COUNT(*) c FROM run_state WHERE run='__test__'").get().c === 1);

  console.log('\n— 其它 —');
  check('latestStep 返回最大 step', store.latestStep('__test__') === 4, String(store.latestStep('__test__')));
  const cp = store.checkpoint();
  check('checkpoint 可执行', cp === null || typeof cp === 'object', JSON.stringify(cp));

  const st = store.stats();
  check('stats 含 series 统计', typeof st.series === 'number' && st.series > 0, String(st.series));
  check('stats 含 bench / tagMeta / runState',
    typeof st.bench === 'number' && typeof st.tagMeta === 'number' && typeof st.runState === 'number',
    JSON.stringify({ b: st.bench, t: st.tagMeta, r: st.runState }));

  cleanup();

  console.log('\n— HTTP 接口（需服务在 8787 运行）—');
  try {
    const r1 = await fetch('http://127.0.0.1:8787/api/db/series?run=pro&tag=dynsam/avg@n');
    const j1 = await r1.json();
    check('/api/db/series 返回真实序列', Array.isArray(j1.rows) && j1.rows.length > 0,
      String((j1.rows || []).length));
    check('/api/db/series 首行有 v 和 wall',
      j1.rows[0] && j1.rows[0].v != null && j1.rows[0].wall != null, JSON.stringify(j1.rows[0]));

    const r2 = await fetch('http://127.0.0.1:8787/api/db/tags?q=dynsam');
    const j2 = await r2.json();
    check('/api/db/tags 前缀检索命中', (j2.rows || []).length > 0, String((j2.rows || []).length));

    const r3 = await fetch('http://127.0.0.1:8787/api/db/bench?bench=deepswe&run=pro');
    const j3 = await r3.json();
    check('/api/db/bench 返回分数序列', (j3.rows || []).length > 0, String((j3.rows || []).length));

    const r4 = await fetch('http://127.0.0.1:8787/api/db/series');
    check('/api/db/series 缺 tag 时返回 400', r4.status === 400, String(r4.status));
  } catch (e) {
    check('HTTP 接口可访问', false, e.message);
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
