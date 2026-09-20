/* 打印一次真实的 AI 讲解 payload，用来核对「喂给模型的数据到底有多少」
   用法：NODE_PATH=<node workspace>/node_modules node scripts/dump-ai-payload.js
   可选：KEY=critic/rewards/mean 指定指标（默认平均通过率） */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = path.join(__dirname, '..', 'public');
const BASE = process.env.BASE || 'http://127.0.0.1:8787/';
const KEY = process.env.KEY || 'dynsam/avg@n';
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

const vc = new VirtualConsole();
vc.on('jsdomError', function (e) { console.log('[jsdomError]', e && e.message); });
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: BASE, virtualConsole: vc });
const w = dom.window;
w.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };
w.TextDecoder = TextDecoder;
w.TextEncoder = TextEncoder;

let captured = null;
let stepCounts = {};
w.fetch = function (u, opt) {
  const url = new URL(u, BASE).toString();
  if (opt && opt.method === 'POST' && url.indexOf('/api/explain') >= 0) {
    captured = JSON.parse(opt.body);
  }
  return fetch(url, opt).then(function (r) {
    if (url.indexOf('/api/series') >= 0) {
      return r.json().then(function (j) {
        const m = /run=([^&]+)/.exec(url);
        if (m) stepCounts[m[1]] = (j.steps || []).length;
        return { ok: true, status: 200, json: function () { return Promise.resolve(j); } };
      });
    }
    return r;
  });
};

w.eval(fs.readFileSync(path.join(DIR, 'glossary.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

(async function () {
  await sleep(8000);
  const doc = w.document;
  const card = doc.querySelector('.metric-card[data-gk="' + KEY + '"]');
  if (!card) { console.log('找不到指标卡片：' + KEY); process.exit(1); }
  card.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(500);
  const tabs = doc.querySelectorAll('.gl-tab[data-glt]');
  tabs[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);
  const btn = doc.querySelector('.gl-ai-btn[data-ai="' + KEY + '"]');
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(1500);

  if (!captured) { console.log('没抓到 payload'); process.exit(1); }

  console.log('=== 各 run 实际步数 vs 发给 AI 的点数 ===');
  console.log('实际步数:', JSON.stringify(stepCounts));
  Object.keys(captured.recent || {}).forEach(function (k) {
    const total = stepCounts[k];
    console.log('  ' + k + ': 发给 AI ' + captured.recent[k].length + ' 点' +
      (total ? ' / 实际 ' + total + ' 点（' + Math.round(captured.recent[k].length / total * 100) + '%）' : ''));
  });
  console.log('\n=== live ===\n' + JSON.stringify(captured.live));
  console.log('\n=== run ===\n' + JSON.stringify(captured.run));
  console.log('\n=== static（键 + 字数）===');
  Object.keys(captured.static || {}).forEach(function (k) {
    console.log('  ' + k + ': ' + String(captured.static[k]).length + ' 字');
  });
  console.log('\n=== 顶层键 ===\n' + Object.keys(captured).join(', '));
  console.log('\n=== payload 字节数 === ' + JSON.stringify(captured).length);
  process.exit(0);
})();
