/* 解说引擎（public/narrator-core.js）的规则测试 —— 纯 Node，不需要起服务。
   重点盯两件事：
   1) 停滞提示不能在上游已经结束之后还在喊「还没结束」（这次的真实 bug：
      上游 09-21 02:01 就 ended 了，本地最后一条解说还停在「第 30 步跑了 3.5 小时仍未结束」）
   2) 一步跑了多久要用上游自己的时间算（clock.now − step.last_wall），
      不用本地「我盯了多久」—— 后者服务一重启就归零，会把真实耗时低估。
   用法：node test/narrator-core-test.js */
const { createEngine } = require('../public/narrator-core.js');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const NOW = Date.now() / 1000;
const H = 3600;

/* 造一份 status：mode/end 控制「结束与否」，lastWall 控制「这一步跑了多久」 */
function statusOf(o) {
  o = o || {};
  return {
    run: {
      key: o.key || 'pro',
      start: o.start != null ? o.start : NOW - 60 * H,
      end: o.end != null ? o.end : null,
      mode: o.mode || 'live',
    },
    cost: { so_far: 2620670, rate_per_s: 5.71 },
    clock: { now: NOW },
    step: {
      last: o.step != null ? o.step : 30,
      last_wall: o.lastWall != null ? o.lastWall : NOW - 600,
      since: 600, expected: 16711, progress: null, phase: null,
    },
    totals: { restarts: 14, tokens_step: 3.4e9 },
    headline: { last: 0.6331, prev: 0.6221 },
  };
}
function stateOf(list) {
  const st = { ok: true, meta: { runs: [] }, status: {}, live: {}, notices: [] };
  list.forEach(function (s) {
    st.meta.runs.push({ key: s.run.key, label: 'mimo-v2.6-' + s.run.key });
    st.status[s.run.key] = s;
    st.live[s.run.key] = null;
  });
  return st;
}
function texts(e) { return e.getFeed().map(function (it) { return it.text; }); }
function has(e, re) { return texts(e).some(function (t) { return re.test(t); }); }

console.log('=== 训练还在跑：一步拖太久要提醒 ===');
{
  const e = createEngine();
  e.update(stateOf([statusOf({ lastWall: NOW - 4 * H })]));
  check('一步跑了 4 小时会提示「还没结束」', has(e, /还没结束/), texts(e).join(' | '));
  check('提示里带上了步数', has(e, /第 30 步/));
}
{
  const e = createEngine();
  e.update(stateOf([statusOf({ lastWall: NOW - 600 })]));
  check('刚跑 10 分钟不提示（3.5 小时才是一条真正的异常）', !has(e, /还没结束/), texts(e).join(' | '));
}
{
  /* 关键：本地 lastStepTs 是「刚刚」（像服务刚重启那样），但上游这一步已经跑了 4 小时。
     用本地时间算就不该报，用上游时间算才该报 —— 真实耗时是后者。 */
  const e = createEngine();
  e.update(stateOf([statusOf({ lastWall: NOW - 4 * H })]));
  const e2 = createEngine();
  e2.hydrate(e.serialize());          // 模拟重启：lastStepTs 被重置成现在
  e2.update(stateOf([statusOf({ lastWall: NOW - 4 * H })]));
  check('耗时看上游 clock/墙钟，服务重启也不影响判断', has(e2, /还没结束/), texts(e2).join(' | '));
}

console.log('\n=== 上游已经结束：不再喊「还没结束」，改为收尾 ===');
{
  const e = createEngine();
  // 先跑一次正常的：真实服务 hydrate 回来 started 已经是 true，不会再把「解说已开启」压在最上面
  e.update(stateOf([statusOf({ lastWall: NOW - 600 })]));
  e.update(stateOf([statusOf({
    mode: 'ended', end: NOW - 5 * H, lastWall: NOW - 5 * H, start: NOW - 60 * H,
  })]));
  check('结束了就推一条「已结束」', has(e, /已经结束/), texts(e).join(' | '));
  check('不再推「还没结束」（它不是卡住，是跑完了）', !has(e, /还没结束/), texts(e).join(' | '));
  const top = e.getFeed()[0];
  check('收尾那条在最上面（最新在前）', /已经结束/.test(top.text), top && top.text);
  check('带上停在第几步', /停在第 30 步/.test(top.text), top.text);
  check('带上成绩', /0\.6331/.test(top.text), top.text);
  check('带上总耗时', /55\.0 小时/.test(top.text), top.text);
  check('级别是 good（正常收尾，不是告警）', top.level === 'good', top.level);
  check('给了知识点（说清结束后该看什么）', !!top.lesson, String(top.lesson).slice(0, 20));
}
{
  /* 真实场景：结束之前刚发过一条「还没结束」，收尾那条要把它接上，
     否则两条并排看着像自相矛盾。 */
  const e = createEngine();
  e.update(stateOf([statusOf({ lastWall: NOW - 600 })]));           // 启动过
  e.update(stateOf([statusOf({ lastWall: NOW - 4 * H })]));         // 先报停滞
  e.update(stateOf([statusOf({ mode: 'ended', end: NOW - 5 * H, lastWall: NOW - 5 * H })]));
  const top = e.getFeed()[0];
  check('收尾那条解释了前面那条「还没结束」', /不是卡死/.test(top.why || ''), top.why);
}
{
  const e = createEngine();
  const st = stateOf([statusOf({ mode: 'ended', end: NOW - 5 * H, lastWall: NOW - 5 * H })]);
  e.update(st);
  const n1 = e.getFeed().length;
  e.update(st); e.update(st); e.update(st);
  check('结束只说一次（每 20 秒轮询不刷屏）',
    e.getFeed().length === n1, n1 + ' -> ' + e.getFeed().length);
}
{
  // 上游只有 end 没写 mode（老接口形态）也要认出来是结束了
  const e = createEngine();
  e.update(stateOf([statusOf({ mode: 'live', end: NOW - 5 * H, lastWall: NOW - 5 * H })]));
  check('只给了 end、没给 mode 也认作结束', has(e, /已经结束/), texts(e).join(' | '));
}
{
  const e = createEngine();
  e.update(stateOf([statusOf({ mode: 'ended', end: NOW - 5 * H, lastWall: NOW - 5 * H })]));
  const now = e.getNow()[0];
  check('「此刻」里标了 ended', now.ended === true, JSON.stringify(now));
  check('「此刻」的相位写成「已结束」', now.phase === '已结束', now.phase);
}

console.log('\n=== 重启后不重复收尾 ===');
{
  const e = createEngine();
  const st = stateOf([statusOf({ mode: 'ended', end: NOW - 5 * H, lastWall: NOW - 5 * H })]);
  e.update(st);
  const before = e.getFeed().length;
  const e2 = createEngine();
  e2.hydrate(e.serialize());
  e2.update(st);
  check('hydrate 带上了 endedNotified', e2.serialize().endedNotified.pro === 1,
    JSON.stringify(e2.serialize().endedNotified));
  check('重启后再轮询不会又说一遍「已结束」',
    e2.getFeed().length === before, before + ' -> ' + e2.getFeed().length);
}

console.log('\n=== 两路训练：一路结束一路还在跑 ===');
{
  const e = createEngine();
  e.update(stateOf([
    statusOf({ key: 'pro', mode: 'ended', end: NOW - 5 * H, lastWall: NOW - 5 * H }),
    statusOf({ key: 'flash', lastWall: NOW - 4 * H }),
  ]));
  const proEnd = e.getFeed().some(function (it) { return it.run === 'pro' && /已经结束/.test(it.text); });
  const flashStall = e.getFeed().some(function (it) { return it.run === 'flash' && /还没结束/.test(it.text); });
  check('结束的那路说「已结束」', proEnd);
  check('还在跑的那路照样提示停滞（互不串台）', flashStall, texts(e).join(' | '));
  const now = e.getNow();
  check('「此刻」两条各自标了状态',
    now.length === 2 && now[0].ended === true && now[1].ended === false,
    JSON.stringify(now.map(function (x) { return x.key + ':' + x.ended; })));
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
