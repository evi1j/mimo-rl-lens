/* 前端在「重跑正文轮」时的表现：
   1) 上一次的不完整内容收成一个折叠块，标题写明不完整，并引导看下面
   2) 工具轮的查询决策块保留（重跑只跑正文，不重查）
   3) 生成中途断掉时保留正文并给出「可能不完整」的提示
   4) 抽屉刷新重渲染后，这些块都还在
   用预制 NDJSON 流喂 jsdom，不依赖真实模型（约 20s）。
   用法：NODE_PATH=<node workspace>/node_modules node test/ai-retry-ui-test.js */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = path.join(__dirname, '..', 'public');
const BASE = process.env.BASE || 'http://127.0.0.1:8787/';
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const LONG = '平均通过率当前 42%，比上一步上涨 2 个百分点。最近七步在 38%~44% 区间内震荡，' +
  '当前处于中位偏上。单步涨跌受每步换题的难度分布影响，两三个百分点的抖动属于采样噪声，不必干预。' +
  '若连续三步同向且零分率同步上升，才需要回头查判分逻辑或 KL 约束是否过松。';

const STREAMS = {
  restart: [
    '{"think":"先看看有哪些指标","phase":"tool","round":1}',
    '{"tool":{"name":"list_metrics","args":{},"summary":"匹配到 6 个指标","round":1}}',
    '{"think":"数据够了，开始分析","phase":"main"}',
    '{"delta":"太短了。"}',
    '{"notice":"第一次没写出正文，降低思考强度再试一次"}',
    '{"restart":{"attempt":2,"reason":"short"}}',
    '{"think":"重新想一遍","phase":"main"}',
    '{"delta":' + JSON.stringify(LONG) + '}',
    '{"done":true,"model":"mock","attempts":2}',
  ],
  truncated: [
    '{"think":"想了一下","phase":"tool","round":1}',
    '{"tool":{"name":"run_status","args":{},"summary":"pro 第27步","round":1}}',
    '{"think":"开始写","phase":"main"}',
    '{"delta":' + JSON.stringify(LONG) + '}',
    '{"done":true,"model":"mock","attempts":1,"truncated":true}',
  ],
};

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function runMode(mode) {
  const lines = STREAMS[mode].map(function (s) { return s + '\n'; });
  const vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { console.log('[jsdomError]', e && e.message); });
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: BASE, virtualConsole: vc });
  const w = dom.window;
  w.TextDecoder = TextDecoder;
  w.TextEncoder = TextEncoder;
  w.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };
  const realFetch = function (u, o) { return fetch(new URL(String(u), BASE).toString(), o); };
  w.fetch = function (u, o) {
    if (String(u).indexOf('api/explain') >= 0) {
      let i = 0, closed = false;
      const stream = new ReadableStream({
        pull: function (c) {
          setTimeout(function () {
            if (closed) return;
            if (i >= lines.length) { closed = true; c.close(); return; }
            c.enqueue(new TextEncoder().encode(lines[i++]));
          }, 50);
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    return realFetch(u, o);
  };
  w.eval(fs.readFileSync(path.join(DIR, 'glossary.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

  const doc = w.document;
  await sleep(8000); // 等指标序列加载
  const card = doc.querySelector('.metric-card[data-gk="dynsam/avg@n"]');
  if (!card) return null;
  card.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(500);
  doc.querySelectorAll('.gl-tab[data-glt]')[1]
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(300);
  doc.querySelector('.gl-ai-btn[data-ai="dynsam/avg@n"]')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));

  let waited = 0;
  while (waited < 30000) {
    const b = doc.querySelector('.gl-ai-btn[data-ai="dynsam/avg@n"]');
    if (b && b.textContent === '重新生成') break;
    await sleep(300); waited += 300;
  }
  await sleep(300);
  return { doc: doc, win: w };
}

(async function main() {
  console.log('重跑正文轮时的界面表现\n');

  console.log('— 正文过短，重跑一次 —');
  let r = await runMode('restart');
  if (!r) { check('找到指标卡片', false); return; }
  let doc = r.doc;
  const parts = Array.prototype.slice.call(doc.querySelectorAll('.gl-ai-partial'));
  check('上一次的内容被收成折叠块', parts.length === 1, '块数 ' + parts.length);
  check('折叠块默认收起', parts.length === 1 && !parts[0].open);
  check('标题写明这段不完整', parts.length === 1 &&
    /不完整/.test(parts[0].querySelector('summary').textContent),
    parts.length ? parts[0].querySelector('summary').textContent : '');
  check('块内引导去看下面的完整版', parts.length === 1 &&
    /下面/.test((parts[0].querySelector('.gl-ai-partial-h') || {}).textContent || ''));
  check('旧内容确实留着', parts.length === 1 &&
    parts[0].querySelector('.gl-ai-think-b').textContent.indexOf('太短了') >= 0);
  check('工具轮的查询决策块没被清掉（没重查）',
    doc.querySelectorAll('.gl-ai-step').length === 1, String(doc.querySelectorAll('.gl-ai-step').length));
  const outTxt = doc.getElementById('gl-ai-out').textContent;
  check('正文是重跑后的完整版', outTxt.indexOf('平均通过率当前') === 0 && outTxt.length > 80,
    outTxt.length + ' 字');
  check('没有误报「内容不完整」', !doc.querySelector('.gl-ai-warn'));

  // 模拟 10s 轮询刷新导致的重渲染
  doc.querySelector('.metric-card[data-gk="dynsam/avg@n"]')
    .dispatchEvent(new r.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);
  check('抽屉刷新后折叠块仍在', doc.querySelectorAll('.gl-ai-partial').length === 1);

  console.log('\n— 生成中途断掉，但已讲出内容 —');
  r = await runMode('truncated');
  doc = r.doc;
  check('不留空的收缩块', doc.querySelectorAll('.gl-ai-partial').length === 0);
  const warn = doc.querySelector('.gl-ai-warn');
  check('给出「可能不完整」提示', !!warn && /不完整/.test(warn.textContent),
    warn ? warn.textContent.slice(0, 30) : '无');
  check('已讲出的内容保留', String(doc.getElementById('gl-ai-out').textContent).length > 80,
    String(doc.getElementById('gl-ai-out').textContent).length + ' 字');
  check('仍然可以再生成一次',
    !!doc.querySelector('.gl-ai-btn[data-ai="dynsam/avg@n"]') &&
    doc.querySelector('.gl-ai-btn[data-ai="dynsam/avg@n"]').textContent === '重新生成');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
