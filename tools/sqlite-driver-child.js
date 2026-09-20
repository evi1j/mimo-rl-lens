/* 驱动测试的子进程：用一个指定的驱动跑一遍 store 的真实操作，结果打成 JSON。
   父进程 tools/sqlite-driver-test.js 负责起它和断言。
   环境变量：MIMO_SQLITE_DRIVER=builtin|wasm|none，MIMO_DB_FILE=临时库路径 */

const path = require('path');
const fs = require('fs');
const store = require(path.join(__dirname, '..', 'store.js'));

const out = { driver: null, enabled: store.enabled, error: null, steps: {} };

function step(name, fn) {
  try { out.steps[name] = fn(); }
  catch (e) { out.steps[name] = { error: String(e && e.message || e) }; }
}

step('stats', () => {
  const s = store.stats();
  out.driver = s.driver;
  return { enabled: s.enabled, driver: s.driver, metrics: s.metrics, narrator: s.narrator, reason: s.reason };
});

step('narrator', () => {
  const feed = [{
    id: 'drv-1', ts: 1700000000, level: 'info', run: '__drv__',
    official: true, ai: true, aiState: 'ok', aiModel: 'm', aiError: '',
    text: '驱动往返测试', why: '因为要验证绑定参数', lesson: '两个驱动行为必须一致',
    ctx: { step: 12, value: 0.5 },
  }];
  const okWrite = store.saveNarrator({ v: 1, feed: feed, prev: { a: 1 } });
  const back = store.loadNarrator();
  const row = back && back.feed && back.feed[0];
  return {
    write: okWrite,
    text: row && row.text,
    lesson: row && row.lesson,
    ctxStep: row && row.ctx && row.ctx.step,
    aiState: row && row.aiState,
    prevKept: back && back.prev && back.prev.a,
  };
});

step('search', () => store.searchNarrator('驱动往返').map((r) => r.id));

step('series', () => {
  const steps = [1, 2, 3];
  const walls = [10.5, 20.5, 30.5];
  const series = { '__drv__/loss': [1.5, null, 0.5], '__drv__/acc': [0, 0.25, 0.75] };
  const n = store.saveSeries('__drv__', steps, walls, series);
  const rows = store.querySeries('__drv__', '__drv__/loss');
  return {
    written: n,
    rows: rows.length,
    nullKept: rows[1] && rows[1].v === null,
    zeroKept: (store.querySeries('__drv__', '__drv__/acc')[0] || {}).v === 0,
    wall: rows[0] && rows[0].wall,
    latest: store.latestStep('__drv__'),
  };
});

step('tagmeta', () => {
  store.saveTagMeta(['__drv__/loss', '__drv__/acc'], ['__drv__'], { pins: ['__drv__/loss'] });
  const all = store.searchTags('__drv__/');
  const pinned = store.searchTags('');
  return {
    all: all.length,
    pinnedHits: pinned.filter((t) => t.tag.indexOf('__drv__') === 0).length,
    unit: (all[0] || {}).unit === null || (all[0] || {}).unit === undefined,
  };
});

step('metrics', () => {
  const state = {
    status: {
      __drv__: {
        step: { last: 3, phase: 'training', progress: 0.5 },
        headline: { last: 0.75, prev: 0.7 },
        totals: { restarts: 0, tokens_step: 100, tokens_cum: 300 },
        cost: { so_far: 1.25 },
      },
    },
    live: { __drv__: { latest: { passrate: 0.5, pr0: 0.2, pr1: 0.3, judged: 4, judged_of: 8 } } },
  };
  const w = store.saveMetrics(state);
  const rows = store.history('__drv__', 10);
  return { written: w, rows: rows.length, step: rows[0] && rows[0].step, restartsZero: rows[0] && rows[0].restarts === 0 };
});

step('bench', () => {
  store.saveBench({ benchmarks: [{ key: '__drv__b', title: 't', results: { __drv__: { 1: 0.5, 3: null } } }] });
  return { rows: store.queryBench('__drv__b', '__drv__').length };
});

step('runstate', () => {
  store.saveRunState('__drv__', {
    step: { last: 3, phase: 'training', progress: 0.5 },
    totals: { restarts: 0, trained_step: 3, prompts_per_step: 8, tokens_step: 100 },
    cost: { so_far: 1.25 },
    version: 'v', run: { start: 1699999000 },
  });
  const rows = store.queryRunState('__drv__');
  return { rows: rows.length, restarts: rows[0] && rows[0].restarts };
});

step('checkpoint', () => ({ r: store.checkpoint() }));

// 结果写文件，不写 stdout —— stdout 上还有 store 自己的启动日志，混在一起没法解析
out.error = store.reason;
fs.writeFileSync(process.argv[2], JSON.stringify(out));
