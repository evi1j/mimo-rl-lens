/* AI 讲解的分层重试测试。
   用本地 mock 服务模拟各种「讲不出来」的情况，不走真实模型（秒级）：
   1) 正文空 / 过短 → 只重跑正文轮，工具轮查过的数据不重查
   2) 流中途断连 → 已讲够字数就收下并标记不完整，不再烧一次生成
   3) 连接失败 → 重试 N 次后才报错
   4) 工具轮 5xx → 降级成不查工具直接讲，整条讲解不中断
   5) isRetryable / bodyStrategy 的判定
   用法：NODE_PATH=<node workspace>/node_modules node tools/ai-retry-test.js */
const http = require('http');
const path = require('path');
const llm = require(path.join(__dirname, '..', 'llm.js'));
require(path.join(__dirname, '..', 'store.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---------- mock 推理服务 ---------- */
let handler = null;
const srv = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://mock');
  if (u.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    return;
  }
  if (u.pathname !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  let body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
    if (handler) handler(j, res);
    else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }
  });
});

/* 按 SSE 格式吐一段流。events: [{think}] | [{content}] */
function sse(res, events, cutAfter) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  (function next() {
    if (i >= events.length) { res.write('data: [DONE]\n\n'); res.end(); return; }
    const e = events[i++];
    const delta = e.think ? { reasoning_content: e.think } : { content: e.content };
    res.write('data: ' + JSON.stringify({ choices: [{ delta: delta }] }) + '\n\n');
    // cutAfter：写到第 n 个事件后把连接掐断，模拟流中途断连
    if (cutAfter != null && i >= cutAfter) { res.socket.destroy(); return; }
    setTimeout(next, 5);
  })();
}

const LONG_OK = '平均通过率当前 42%，比上一步上涨 2 个百分点。最近七步在 38%~44% 区间内震荡，' +
  '当前处于中位偏上。单步涨跌受每步换题的难度分布影响，两三个百分点的抖动属于采样噪声，' +
  '不必干预。要看趋势得连看三五步：如果连续三步同向、且零分率同步上升，说明模型在部分题上彻底失效，' +
  '这时才需要回头查判分逻辑或 KL 约束是否过松。目前 flash 线略高于 pro 线约 4 个百分点，' +
  '两线差距稳定，没有出现一条线单独塌陷的情况。结合训练状态：本步处于 rollout 阶段，' +
  '重启次数没有异常增加，说明策略更新本身是稳定的。综上，这一步的成绩波动在预期范围内，继续观察即可。';

const PAYLOAD = { key: 'dynsam/avg@n', metric: { zh: '平均通过率', unit: 'pct' }, now: { pro: { last: 0.42 } } };

function run(hooks) {
  hooks = hooks || {};
  const seen = { deltas: [], tools: [], notices: [], restarts: [], thinks: [] };
  return llm.explainMetric(
    PAYLOAD,
    function (d) { seen.deltas.push(d); return true; },
    function (t, ph, rn) { seen.thinks.push({ t: t, phase: ph || 'main', round: rn || 0 }); return true; },
    function (info) { seen.tools.push(info); return true; },
    {
      onNotice: function (m) { seen.notices.push(m); return true; },
      onRestart: function (i) { seen.restarts.push(i || {}); return true; },
    }
  ).then(function (out) { return { out: out, seen: seen }; });
}

(async function main() {
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  const port = srv.address().port;
  process.env.LLM_ENABLED = '1';
  process.env.LLM_BASE_URL = 'http://127.0.0.1:' + port + '/v1';
  process.env.LLM_MODEL = 'mock-model';

  console.log('分层重试测试（mock 服务 127.0.0.1:' + port + '）\n');

  console.log('— 判定逻辑 —');
  check('网络类错误可重试', llm.isRetryable(new Error('fetch failed')));
  check('超时可重试', llm.isRetryable(new Error('The operation timed out')));
  check('5xx 可重试', llm.isRetryable(new Error('HTTP 503 Service Unavailable')));
  check('429 可重试', llm.isRetryable(new Error('HTTP 429 too many requests')));
  check('400 不重试（那是参数问题）', !llm.isRetryable(new Error('HTTP 400 Bad Request')));
  const s0 = llm.bodyStrategy(0, { explainMaxTokens: 4000 }, 'low');
  const s1 = llm.bodyStrategy(1, { explainMaxTokens: 4000 }, 'low');
  const s2 = llm.bodyStrategy(2, { explainMaxTokens: 4000 }, 'low');
  check('首次尝试用配置的思考强度', s0.effort === 'low' && s0.maxTokens === 4000);
  check('第 2 次去掉思考强度并加额度', s1.effort === null && s1.maxTokens > s0.maxTokens, String(s1.maxTokens));
  check('第 3 次追加「直接给结论」指令', !!s2.extra && s2.maxTokens > s1.maxTokens);

  console.log('\n— 正文过短：只重跑正文轮 —');
  let calls = 0;
  handler = function (j, res) {
    if (Array.isArray(j.tools)) {           // 工具轮：调一次工具后收工
      sse(res, [{ think: '查一下' }, { content: '' }]);
      // tool_calls 只能通过非流式或流式 delta 给；这里直接结束工具轮（等于模型不查）
      return;
    }
    calls++;
    if (calls === 1) return sse(res, [{ think: '想了很多' }, { content: '太短了。' }]);
    return sse(res, [{ think: '再来' }, { content: LONG_OK }]);
  };
  let r = await run();
  check('最终正文够长', r.out && r.out.attempts >= 2, '尝试 ' + (r.out && r.out.attempts) + ' 次');
  check('重试前收到提示', r.seen.notices.length >= 1, JSON.stringify(r.seen.notices[0] || ''));
  check('重试前通知前端收起旧内容', r.seen.restarts.length >= 1);
  check('工具轮没有被重跑', calls === 2, '正文轮请求 ' + calls + ' 次');

  console.log('\n— 正文为空（只吐思考）—');
  calls = 0;
  handler = function (j, res) {
    if (Array.isArray(j.tools)) return sse(res, [{ think: '查一下' }, { content: '' }]);
    calls++;
    if (calls === 1) return sse(res, [{ think: '思考占满了所有额度，正文一个字都没有' }]);
    return sse(res, [{ content: LONG_OK }]);
  };
  r = await run();
  check('空正文会被重试', r.out && r.out.attempts >= 2, '尝试 ' + (r.out && r.out.attempts) + ' 次');
  check('最终拿到了正文', r.seen.deltas.join('').length > 20, r.seen.deltas.join('').slice(0, 30));

  console.log('\n— 流中途断连，但已讲出足够内容 —');
  calls = 0;
  handler = function (j, res) {
    if (Array.isArray(j.tools)) return sse(res, [{ think: '查一下' }, { content: '' }]);
    calls++;
    const long = LONG_OK;
    return sse(res, [{ think: '想' }].concat(long.split('').map(function (ch) { return { content: ch }; })), 240);
  };
  r = await run();
  check('断连后不再重跑（内容已够用）', calls === 1, '正文轮请求 ' + calls + ' 次');
  check('标记为不完整', !!(r.out && r.out.truncated));
  check('已吐出的内容保留下来了', r.seen.deltas.join('').length > 40, r.seen.deltas.join('').length + ' 字');

  console.log('\n— 工具轮 5xx：降级，不中断讲解 —');
  let toolCalls = 0;
  handler = function (j, res) {
    if (Array.isArray(j.tools)) {
      toolCalls++;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    return sse(res, [{ content: LONG_OK }]);
  };
  r = await run();
  check('工具轮失败后仍然讲出了正文', r.seen.deltas.join('').length > 20);
  check('工具轮一次都没成功', r.out.toolRounds === 0, String(r.out.toolRounds));
  check('工具轮按配置重试过', toolCalls >= 1, toolCalls + ' 次请求');

  console.log('\n— 服务连不上：重试到上限后报错 —');
  const dead = http.createServer(function () {});
  await new Promise(function (r2) { dead.listen(0, '127.0.0.1', r2); });
  const deadPort = dead.address().port;
  await new Promise(function (r2) { dead.close(r2); });   // 立刻关掉，端口变死端口
  const savedUrl = process.env.LLM_BASE_URL;
  process.env.LLM_BASE_URL = 'http://127.0.0.1:' + deadPort;
  handler = null;
  let err = null;
  try { await run(); } catch (e) { err = e; }
  check('连不上时最终抛错', !!err, err ? String(err.message).slice(0, 60) : '没抛错');
  check('错误信息是原始的（由 server 翻成人话）', !!err && /fetch failed|ECONNREFUSED/i.test(String(err.message)),
    err ? String(err.message).slice(0, 60) : '');
  process.env.LLM_BASE_URL = savedUrl;

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  srv.close();
  process.exit(fail ? 1 : 0);
})();
