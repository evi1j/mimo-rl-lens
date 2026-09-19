/* 验证指标抽屉里的 AI 讲解（流式吐字）
   1) 指标讲解底部有 AI 按钮，AI 可用时未置灰
   2) 点击后逐字追加（采样到多个递增的中间态，而不是一次塞入）
   3) 完成后显示正文、按钮变「重新生成」
   4) 切到别的指标再切回，缓存内容仍在
   5) AI 不可用时按钮置灰，点击不触发请求
   用法：NODE_PATH=<node workspace>/node_modules node tools/ai-explain-test.js */
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

function makeDom(fetchImpl) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { console.log('[jsdomError]', e && e.message); });
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: BASE,
    virtualConsole: vc,
  });
  const w = dom.window;
  w.fetch = fetchImpl;
  w.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };
  // app.js 流式解码需要 TextDecoder，jsdom 的 window 里不一定有，从 Node 补上
  w.TextDecoder = TextDecoder;
  w.TextEncoder = TextEncoder;
  w.eval(fs.readFileSync(path.join(DIR, 'glossary.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return dom;
}

const realFetch = function (u, opt) {
  const url = new URL(u, BASE).toString();
  return fetch(url, opt).catch(function (e) {
    console.log('  [fetch FAIL] ' + url + ' ' + e.message);
    throw e;
  });
};

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* 主流程：打真实服务 + 真实 AI */
async function mainFlow() {
  console.log('=== AI 讲解（真实服务） ===');
  const dom = makeDom(realFetch);
  const doc = dom.window.document;
  const win = dom.window;

  await sleep(8000); // 等指标序列加载

  // 打开第一个指标（平均通过率）
  const card = doc.querySelector('.metric-card[data-gk="dynsam/avg@n"]');
  if (!card) { check('找到指标卡片', false); return; }
  card.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(600);

  const btn = doc.querySelector('.gl-ai-btn[data-ai="dynsam/avg@n"]');
  check('讲解里有 AI 按钮', !!btn);
  check('AI 可用时按钮未置灰', btn && !btn.disabled);
  check('按钮初始文案', btn && btn.textContent === 'AI 讲解当前数据',
    btn ? btn.textContent : '');

  // 记录是否真的发出了 POST 请求
  let posted = 0;
  const origFetch = win.fetch;
  win.fetch = function (u, opt) {
    if (String(u).indexOf('api/explain') >= 0) posted++;
    return origFetch(u, opt);
  };

  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(300);

  const out = doc.getElementById('gl-ai-out');
  const statusEl = doc.getElementById('gl-ai-status');
  check('点击后发出了 POST api/explain', posted === 1, '实际 ' + posted);
  check('生成中显示状态提示', !!statusEl && !statusEl.hidden,
    statusEl ? String(statusEl.hidden) : 'no node');
  check('生成中输出框带吐字光标', !!out && /is-typing/.test(out.className),
    out ? out.className : '');

  // 采样：每 250ms 记一次文本，收集递增的中间态
  const snaps = [];
  let last = '';
  const t0 = Date.now();
  const thinkEl = doc.getElementById('gl-ai-think');
  let sawThink = false;
  while (Date.now() - t0 < 120000) {
    await sleep(250);
    const txt = out ? out.textContent : '';
    if (txt && txt !== last) { snaps.push(txt); last = txt; }
    if (thinkEl && !thinkEl.hidden && thinkEl.textContent) sawThink = true;
    const b = doc.querySelector('.gl-ai-btn[data-ai="dynsam/avg@n"]');
    const done = (b && b.textContent === '重新生成') ||
                 (out && /is-err/.test(out.className));
    if (done && txt) break;
  }

  const finalTxt = out ? out.textContent : '';
  const isErr = out && /is-err/.test(out.className);

  check('输出非空', !!finalTxt, '长度 ' + String(finalTxt).length);
  check('没有落到错误态', !isErr, isErr ? finalTxt : '');
  check('流式逐字追加（中间态 > 2 个）', snaps.length > 2, '采样到 ' + snaps.length + ' 个中间态');
  const growing = snaps.every(function (s, i) { return i === 0 || s.length >= snaps[i - 1].length; });
  check('中间态长度递增', growing);
  if (snaps.length) {
    console.log('    首帧:', JSON.stringify(String(snaps[0]).slice(0, 30)));
    console.log('    末帧:', JSON.stringify(String(finalTxt).slice(0, 60)));
  }

  const b2 = doc.querySelector('.gl-ai-btn[data-ai="dynsam/avg@n"]');
  check('完成后按钮变「重新生成」', b2 && b2.textContent === '重新生成',
    b2 ? b2.textContent : '');
  check('完成后隐藏状态提示', !!statusEl && statusEl.hidden);
  const modelEl = doc.getElementById('gl-ai-model');
  check('显示模型名', !!modelEl && !!modelEl.textContent, modelEl ? modelEl.textContent : '');
  console.log('    模型:', modelEl ? modelEl.textContent : '-',
    '| 思考过程:', sawThink ? '有' : '无',
    '| 字数:', String(finalTxt).length);

  // 切到下一个指标再切回来，验证缓存
  const nextBtn = doc.getElementById('gl-next');
  if (nextBtn) {
    nextBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(400);
    const otherBtn = doc.querySelector('.gl-ai-btn[data-ai="critic/rewards/mean"]');
    check('切到下一个指标也有 AI 按钮', !!otherBtn);
    check('新指标按钮文案为「AI 讲解当前数据」',
      otherBtn && otherBtn.textContent === 'AI 讲解当前数据',
      otherBtn ? otherBtn.textContent : '');
    const prevBtn = doc.getElementById('gl-prev');
    prevBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(400);
    const back = doc.getElementById('gl-ai-out');
    check('切回后缓存内容仍在',
      !!back && back.textContent === finalTxt,
      back ? '长度 ' + back.textContent.length + ' vs ' + String(finalTxt).length : '');
  }

  dom.window.close();
}

/* 降级流程：mock 掉 ai/test，让前端认为 AI 不可用 */
async function disabledFlow() {
  console.log('\n=== AI 不可用时降级 ===');
  const dom = makeDom(function (u, opt) {
    const url = new URL(u, BASE).toString();
    if (url.indexOf('/api/ai/test') >= 0) {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ enabled: false, ok: false }); },
      });
    }
    return realFetch(u, opt);
  });
  const doc = dom.window.document;
  const win = dom.window;

  await sleep(8000);
  const card = doc.querySelector('.metric-card[data-gk="dynsam/avg@n"]');
  card.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(600);

  const btn = doc.querySelector('.gl-ai-btn[data-ai="dynsam/avg@n"]');
  check('AI 不可用时按钮置灰', btn && btn.disabled);
  const why = doc.querySelector('.gl-ai-why');
  check('给出不可用原因', !!why && /llm\.enabled/.test(why.textContent),
    why ? why.textContent : '');

  let posted = 0;
  const orig = dom.window.fetch;
  win.fetch = function (u, opt) {
    if (String(u).indexOf('api/explain') >= 0) posted++;
    return orig(u, opt);
  };
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(500);
  check('置灰时点击不触发请求', posted === 0, '实际 ' + posted);

  dom.window.close();
}

(async function () {
  await mainFlow();
  await disabledFlow();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
