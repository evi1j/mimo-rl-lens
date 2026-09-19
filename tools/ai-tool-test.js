/* 工具调用（function calling）测试：模型能不能自己查数据、查错了会不会被告知。
   用法：NODE_PATH=... node tools/ai-tool-test.js
   前半部分直接调模块（秒级），后半部分打真实服务跑一次完整讲解（约 1~2 分钟）。 */

const path = require('path');
const llm = require(path.join(__dirname, '..', 'llm.js'));
require(path.join(__dirname, '..', 'store.js'));

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const BASE = 'http://127.0.0.1:8787';

(async function main() {
  console.log('工具调用测试\n');

  console.log('— 工具定义 —');
  check('定义了 4 个工具', (llm.TOOLS || []).length === 4, String((llm.TOOLS || []).length));
  const names = (llm.TOOLS || []).map((t) => t.function && t.function.name);
  ['list_metrics', 'query_series', 'run_status', 'query_bench'].forEach((n) => {
    check('有工具 ' + n, names.indexOf(n) >= 0, names.join(','));
  });
  (llm.TOOLS || []).forEach((t) => {
    const f = t.function;
    check(f.name + ' 有完整描述', !!(f.name && f.description && f.parameters));
    const req = (f.parameters && f.parameters.required) || [];
    const props = (f.parameters && f.parameters.properties) || {};
    check(f.name + ' 的 required 字段都在 properties 里',
      req.every(function (r) { return !!props[r]; }), req.join(','));
  });

  console.log('\n— runTool 执行 —');
  const lm = llm.runTool('list_metrics', { q: 'dynsam' });
  check('list_metrics 查到指标', !!(lm && lm.count > 0), JSON.stringify(lm).slice(0, 90));
  const lmNone = llm.runTool('list_metrics', { q: 'zzz_no_such_metric_zzz' });
  check('查不到时返回 error（好让模型换名字，而不是静默失败）',
    !!(lmNone && lmNone.error), JSON.stringify(lmNone).slice(0, 90));

  const qs = llm.runTool('query_series', { tag: 'dynsam/avg@n', run: 'pro' });
  check('query_series 返回序列', !!(qs && qs.series && qs.series.length > 0),
    JSON.stringify(qs).slice(0, 90));
  check('序列是 [step, v] 二元组',
    !!(qs && qs.series && qs.series.every(function (p) { return Array.isArray(p) && p.length === 2; })));
  const qsBad = llm.runTool('query_series', { tag: 'not/a/real/tag' });
  check('不存在的指标返回 error', !!(qsBad && qsBad.error), JSON.stringify(qsBad).slice(0, 90));

  const rs = llm.runTool('run_status', {});
  check('run_status 返回训练状态',
    !!(rs && rs.runs && rs.runs.length > 0), JSON.stringify(rs).slice(0, 120));
  check('run_status 含进度与重启次数',
    !!(rs && rs.runs && rs.runs[0] && rs.runs[0].step != null && rs.runs[0].restarts != null),
    JSON.stringify(rs && rs.runs && rs.runs[0]).slice(0, 120));

  const qb = llm.runTool('query_bench', {});
  check('query_bench 返回评测列表', !!(qb && qb.rows && qb.rows.length > 0),
    JSON.stringify(qb).slice(0, 90));

  const bogus = llm.runTool('no_such_tool', {});
  check('幻觉工具名返回 error 并列出可用工具',
    !!(bogus && bogus.error && /list_metrics/.test(bogus.error)), JSON.stringify(bogus).slice(0, 120));

  console.log('\n— 前端摘要文案 —');
  check('list_metrics 摘要含数量',
    /个指标/.test(llm.summarizeToolResult('list_metrics', lm)),
    llm.summarizeToolResult('list_metrics', lm));
  check('query_series 摘要含数据点数',
    /数据点/.test(llm.summarizeToolResult('query_series', qs)),
    llm.summarizeToolResult('query_series', qs));
  check('error 摘要以「没查到」开头',
    /^没查到/.test(llm.summarizeToolResult('query_series', qsBad)),
    llm.summarizeToolResult('query_series', qsBad));

  console.log('\n— 端到端：真实讲解（调用模型，较慢）—');
  try {
    const payload = {
      key: 'dynsam/avg@n', zh: '平均通过率',
      live: { last: 0.626, prev: 0.596, first: 0.565, min: 0.55, max: 0.63, delta: 0.03, flash: 0.644, steps: 25 },
      static: { one: '', what: '', read: '', watch: '' },
    };
    const res = await fetch(BASE + '/api/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

    const dec = new TextDecoder('utf-8');
    const reader = res.body.getReader();
    let buf = '';
    let txt = '';
    let think = '';
    let plan = '';          // 工具轮「决定查什么」的思考
    let planChunks = 0;     // 收到多少块——流式应当是很多小块的
    let planAtFirstTool = -1; // 第一次工具调用时，决策思考已经吐了多少字
    const tools = [];
    let done = null;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.delta) txt += j.delta;
        else if (j.think) {
          // phase=tool 是工具轮「决定查什么」的思考，跟分析数据的思考分开
          if (j.phase === 'tool') { plan += j.think; planChunks++; }
          else think += j.think;
        } else if (j.tool) {
          if (planAtFirstTool < 0) planAtFirstTool = plan.length;
          tools.push(j.tool);
        } else if (j.done) done = j;
      }
    }

    check('收到工具调用事件', tools.length > 0, String(tools.length) + ' 次');
    /* 工具轮改成流式后，「决定查什么」的思考要能逐块吐出来。
       以前是非流式，这段思考直接被丢掉，界面看起来像「没想就开查」。 */
    check('工具轮的「决策思考」被推送出来', plan.length > 0, String(plan.length) + ' 字');
    check('决策思考是流式分块到达（不是一次性塞入）', planChunks > 3, planChunks + ' 块');
    check('决策思考先于第一次工具调用产生', planAtFirstTool > 0,
      '首次调用时已吐 ' + String(planAtFirstTool) + ' 字');
    check('调用的都在已定义工具里',
      tools.every(function (t) { return names.indexOf(t.name) >= 0; }),
      tools.map(function (t) { return t.name; }).join(','));
    check('每条工具调用都带摘要（前端要显示）',
      tools.every(function (t) { return !!t.summary; }));
    check('工具调用去重后仍是有意义的查询',
      tools.filter(function (t) { return t.name !== 'list_metrics'; }).length > 0,
      tools.map(function (t) { return t.name; }).join(','));
    check('done 里带回 toolRounds', !!done && done.toolRounds > 0,
      JSON.stringify(done));
    check('正文非空', txt.length > 80, String(txt.length) + ' 字');
    check('正文里没有 tool_call 标签（不能把标签当讲解给用户看）',
      !/tool_call|<\/?function|parameter=/i.test(txt), txt.slice(0, 120));
    check('思考过程仍在（可折叠查看）', think.length > 0, String(think.length) + ' 字');
    console.log('    工具调用：' + tools.map(function (t) { return t.name + '(' + (t.summary || '') + ')'; }).join(' → '));
    console.log('    正文 ' + txt.length + ' 字，思考 ' + think.length + ' 字');
  } catch (e) {
    check('端到端讲解', false, e.message);
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
