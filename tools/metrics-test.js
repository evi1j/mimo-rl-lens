/* 用 jsdom 真实加载看板，验证「训练指标全景」网格：
   1) 拉到 18 个官方 pins 指标
   2) 每个卡片都渲染出折线图
   3) 中文名、末值、说明三项都不为空
   4) pro / flash 两个 run 都有数据
   用法：NODE_PATH=<node workspace>/node_modules node tools/metrics-test.js */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const vc = new VirtualConsole();
vc.on('error', function () { console.log('[jsdom error]', ...arguments); });
vc.on('warn', function () { console.log('[jsdom warn]', ...arguments); });
vc.on('jsdomError', function (e) { console.log('[jsdomError]', e && e.message); });

const DIR = path.join(__dirname, '..', 'public');
const BASE = process.env.BASE || 'http://127.0.0.1:8787/';
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: BASE,
  virtualConsole: vc,
});
const { window } = dom;

// 把页面里的相对请求转发给真实本地服务
// 把页面里的相对请求转发给真实本地服务。
// 注意必须返回完整的 Response（带 .ok / .status / .json），
// 因为 app.js 的 getJSON 依赖这些属性判断成败。
window.fetch = function (u) {
  const url = new URL(u, BASE).toString();
  return fetch(url).then(function (r) {
    console.log('  [fetch] ' + r.status + '  ' + url.replace(BASE, ''));
    return r;
  }).catch(function (e) {
    console.log('  [fetch FAIL] ' + url + '  ' + e.message);
    throw e;
  });
};
window.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };

window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
window.fetch('api/runs').then(function (r) { return r.json(); }).then(function (m) {
  console.log('  [debug] runs 顶层键: ' + Object.keys(m).join(','));
  console.log('  [debug] runs 条数: ' + (m.runs || []).length + ' | pins 条数: ' + (m.pins || []).length);
}).catch(function (e) { console.log('  [debug] 预检失败: ' + e.message); });
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

setTimeout(function () {
  const doc = window.document;
  const grid = doc.getElementById('metric-grid');
  const cards = grid ? grid.querySelectorAll('.metric-card') : [];

  console.log('\n=== 训练指标全景 ===');
  console.log('  [debug] metric-grid: ' + (grid ? JSON.stringify(grid.innerHTML.slice(0, 160)) : 'null'));
  console.log('  [debug] live-text: ' + ((doc.getElementById('live-text') || {}).textContent || ''));
  Array.from(doc.querySelectorAll('.toast')).forEach(function (t) {
    console.log('  [debug] toast: ' + t.textContent);
  });
  check('网格容器存在', !!grid);
  check('卡片数量 = 18', cards.length === 18, '实际 ' + cards.length);

  let withChart = 0, withZh = 0, withNum = 0, withDesc = 0, twoRuns = 0;
  cards.forEach(function (c) {
    if (c.querySelector('.m-chart svg')) withChart++;
    if ((c.querySelector('.m-zh') || {}).textContent) withZh++;
    if ((c.querySelector('.m-num') || {}).textContent) withNum++;
    const d = c.querySelector('.m-desc');
    if (d && d.textContent && d.textContent.length > 20) withDesc++;
    if (c.querySelectorAll('.m-val').length >= 2) twoRuns++;
  });

  check('全部渲染出折线图', withChart === cards.length, withChart + '/' + cards.length);
  check('全部有中文名', withZh === cards.length, withZh + '/' + cards.length);
  check('全部有末值', withNum === cards.length, withNum + '/' + cards.length);
  check('全部有说明文字', withDesc === cards.length, withDesc + '/' + cards.length);
  check('双 run 都出数（pro + flash）', twoRuns === cards.length, twoRuns + '/' + cards.length);

  const first = cards[0];
  if (first) {
    console.log('\n  示例卡片：');
    console.log('    中文名 :', (first.querySelector('.m-zh') || {}).textContent);
    console.log('    指标键 :', (first.querySelector('.m-key') || {}).textContent);
    const vals = Array.from(first.querySelectorAll('.m-val')).map(function (v) { return v.textContent.trim(); });
    console.log('    末值   :', vals.join('  |  '));
    console.log('    说明   :', (first.querySelector('.m-desc') || {}).textContent.slice(0, 60) + '…');
  }

  // 抽查几个特殊格式化：耗时应为 h，通过率应为 %
  const byZh = {};
  cards.forEach(function (c) {
    const zh = (c.querySelector('.m-zh') || {}).textContent;
    const num = (c.querySelector('.m-num') || {}).textContent;
    byZh[zh] = num;
  });
  console.log('\n  格式化抽查：');
  ['单步总耗时', '平均通过率', '零分题占比', '活跃沙箱数', '策略熵', '平均上下文长度'].forEach(function (k) {
    console.log('    ' + k + ' = ' + byZh[k]);
  });
  check('耗时格式为小时', /h$/.test(byZh['单步总耗时'] || ''), byZh['单步总耗时']);
  check('通过率为百分比', /%$/.test(byZh['平均通过率'] || ''), byZh['平均通过率']);
  check('沙箱数为整数千分位', /,/.test(byZh['活跃沙箱数'] || ''), byZh['活跃沙箱数']);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}, 6000);
