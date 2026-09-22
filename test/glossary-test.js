/* 验证指标讲解抽屉：
   1) 导读索引页列出全部模块与 18 个指标
   2) 点索引项 / 点指标卡片 / 点面板「?」都能打开对应讲解
   3) 指标讲解含五段结构，且「现在的数在说什么」代入了实时数值
   4) 上一个 / 下一个 能在 18 个指标间导航
   5) 未收录指标走 fallback
   6) 关闭与 Esc 生效
   用法：NODE_PATH=<node workspace>/node_modules node test/glossary-test.js */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const vc = new VirtualConsole();
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
window.fetch = function (u) {
  const url = new URL(u, BASE).toString();
  return fetch(url).then(function (r) { return r; })
    .catch(function (e) { console.log('  [fetch FAIL] ' + url + ' ' + e.message); throw e; });
};
window.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };

// 顺序要和 index.html 一致：glossary 必须在 app 之前
window.eval(fs.readFileSync(path.join(DIR, 'glossary.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

const doc = window.document;
function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

(async function () {
  await sleep(8000);   // 等 18 指标序列加载

  /* ---------- 1. 抽屉初始状态 ---------- */
  console.log('\n=== 抽屉初始状态 ===');
  const drawer = doc.getElementById('gl-drawer');
  check('抽屉节点存在', !!drawer);
  check('抽屉初始隐藏', drawer && drawer.hidden);
  const guide = doc.querySelector('.gb-btn[data-g="__index"]');
  check('导读入口存在', !!guide);
  const qbtns = doc.querySelectorAll('.qbtn[data-g]');
  check('面板「?」按钮 = 7', qbtns.length === 7, '实际 ' + qbtns.length);

  /* ---------- 2. 导读索引页 ---------- */
  console.log('\n=== 导读索引页 ===');
  click(guide);
  await sleep(400);
  check('点击后抽屉打开', !drawer.hidden);
  const idxItems = doc.querySelectorAll('#gl-body .gl-idx-item');
  const modItems = Array.from(idxItems).filter(function (b) { return b.dataset.gm; });
  const metItems = Array.from(idxItems).filter(function (b) { return b.dataset.gk; });
  check('索引列出 8 个图表模块', modItems.length === 8, '实际 ' + modItems.length);
  check('索引列出 18 个训练指标', metItems.length === 18, '实际 ' + metItems.length);
  console.log('    模块:', modItems.map(function (b) { return b.querySelector('.gi-t').textContent; }).join(' / '));

  /* ---------- 3. 指标讲解内容 ---------- */
  console.log('\n=== 指标讲解内容 ===');
  const first = metItems[0];
  click(first);
  await sleep(500);
  const secTitles = Array.from(doc.querySelectorAll('#gl-body .gl-sec h4')).map(function (h) { return h.textContent; });
  check('含五段结构', secTitles.length >= 5, secTitles.join(' / '));
  check('含「这是什么」', secTitles.indexOf('这是什么') >= 0);
  check('含「这张图怎么看」', secTitles.indexOf('这张图怎么看') >= 0);
  check('含「现在的数在说什么」', secTitles.indexOf('现在的数在说什么') >= 0);
  check('含「什么情况要警惕」', secTitles.indexOf('什么情况要警惕') >= 0);
  const kicker = (doc.getElementById('gl-kicker') || {}).textContent || '';
  check('标题显示序号 1 / 18', /1 \/ 18/.test(kicker), kicker);
  console.log('    打开的是:', doc.getElementById('gl-title').textContent, '|', kicker);

  // 实时数值代入：应出现具体数字，而不是占位符
  const nowSec = Array.from(doc.querySelectorAll('#gl-body .gl-sec')).find(function (s) {
    return (s.querySelector('h4') || {}).textContent === '现在的数在说什么';
  });
  const nowTxt = nowSec ? nowSec.textContent : '';
  check('当前数值已代入', /\d/.test(nowTxt) && !/没有读到数据/.test(nowTxt), nowTxt.slice(0, 90));
  const nowVal = doc.querySelector('#gl-body .gn-v');
  check('显示当前数值卡片', !!nowVal && /\d/.test(nowVal.textContent), nowVal && nowVal.textContent);
  console.log('    当前值:', nowVal && nowVal.textContent, '|', nowTxt.replace(/\s+/g, ' ').slice(0, 100));

  /* ---------- 4. 逐个导航 ---------- */
  console.log('\n=== 逐个导航 ===');
  const nextBtn = doc.getElementById('gl-next');
  check('有「下一个」按钮', !!nextBtn && !nextBtn.hidden);
  click(nextBtn);
  await sleep(500);
  const kicker2 = (doc.getElementById('gl-kicker') || {}).textContent || '';
  check('下一个翻到第 2 个', /2 \/ 18/.test(kicker2), kicker2);
  console.log('    第 2 个:', doc.getElementById('gl-title').textContent);
  click(doc.getElementById('gl-prev'));
  await sleep(400);
  check('上一个回到第 1 个', /1 \/ 18/.test((doc.getElementById('gl-kicker') || {}).textContent || ''));
  const prevHidden = doc.getElementById('gl-prev').hidden;
  check('第 1 个时隐藏「上一个」', prevHidden);

  /* ---------- 5. 关联跳转 ---------- */
  console.log('\n=== 关联跳转 ===');
  const links = doc.querySelectorAll('#gl-body .gl-link');
  check('有相关指标链接', links.length > 0, '链接 ' + links.length);
  if (links.length) {
    const target = links[0].dataset.gk;
    click(links[0]);
    await sleep(500);
    const sub = (doc.getElementById('gl-sub') || {}).textContent || '';
    check('点了关联跳转到对应指标', sub === target, sub + ' vs ' + target);
    console.log('    跳转到:', doc.getElementById('gl-title').textContent);
  }

  /* ---------- 6. 点指标卡片打开 ---------- */
  console.log('\n=== 点卡片打开 ===');
  /* 卡片网格每 10 秒被自动刷新重建一次，所以不能把节点引用攥在手里 ——
     重建后那个节点已经脱离文档，dispatchEvent 不会再冒泡到 document，
     表现为「点了没反应」，很容易被误判成功能坏了。每次点击前现查一次。 */
  const cardAt = function (i) {
    return doc.querySelectorAll('#metric-grid .metric-card[data-gk]')[i];
  };
  const cards = doc.querySelectorAll('#metric-grid .metric-card[data-gk]');
  check('18 张指标卡片都带 data-gk', cards.length === 18, '实际 ' + cards.length);
  const wantKey = cardAt(2).dataset.gk;
  click(cardAt(2));
  await sleep(500);
  check('点卡片打开对应讲解',
        !drawer.hidden && (doc.getElementById('gl-sub') || {}).textContent === wantKey,
        wantKey);
  console.log('    卡片讲解:', doc.getElementById('gl-title').textContent);

  /* 抽屉已经开着时再点另一张卡片：应当直接切换过去。
     曾经遮罩是全屏可点击的，这次点击会被当成「点外面」把抽屉关掉，
     于是表现为「点了没反应、要再点一次」。 */
  const c5 = cardAt(4);
  const wantKey2 = c5.dataset.gk;
  click(c5);
  await sleep(500);
  const sub2 = (doc.getElementById('gl-sub') || {}).textContent || '';
  check('抽屉开着时点另一张卡片直接切换',
        !drawer.hidden && sub2 === wantKey2,
        'hidden=' + drawer.hidden + ' | ' + sub2 + ' vs ' + wantKey2);

  // 点抽屉外、又不是讲解触发元素的地方：仍然要能关掉
  click(doc.querySelector('.brand h1') || doc.body);
  await sleep(300);
  check('点抽屉外空白处关闭抽屉', drawer.hidden);
  click(cardAt(4));   // 同样现查，别用上面那个可能已过期的引用
  await sleep(400);
  check('关掉后还能再打开', !drawer.hidden);

  /* ---------- 7. 面板「?」按钮 ---------- */
  console.log('\n=== 面板 ? 按钮 ===');
  for (const key of ['headline', 'bench', 'comp', 'metrics']) {
    const btn = doc.querySelector('.qbtn[data-g="' + key + '"]');
    if (!btn) { check('? 按钮存在: ' + key, false); continue; }
    click(btn);
    await sleep(350);
    const t = (doc.getElementById('gl-title') || {}).textContent || '';
    check('? 打开模块讲解: ' + key, !drawer.hidden && t.length > 0, t);
  }

  /* ---------- 8. 未收录指标走 fallback ---------- */
  console.log('\n=== 未收录指标 ===');
  click(doc.querySelector('.qbtn[data-g="metrics"]'));
  await sleep(300);
  // 直接调 fallback 分支：造一个库里没有的 key
  const fake = doc.createElement('div');
  fake.dataset.gk = 'some/unknown_metric_xyz';
  doc.body.appendChild(fake);
  click(fake);
  await sleep(350);
  const fbTitle = (doc.getElementById('gl-title') || {}).textContent || '';
  const fbBody = (doc.getElementById('gl-body') || {}).textContent || '';
  check('未收录指标给出兜底讲解', fbBody.length > 40 && !drawer.hidden, fbTitle);
  console.log('    兜底:', fbTitle, '|', fbBody.replace(/\s+/g, ' ').slice(0, 80));

  /* ---------- 9. 关闭 ---------- */
  console.log('\n=== 关闭 ===');
  click(doc.getElementById('gl-close'));
  await sleep(250);
  check('点关闭按钮收起抽屉', drawer.hidden);
  click(guide);
  await sleep(300);
  check('可再次打开', !drawer.hidden);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(250);
  check('Esc 关闭抽屉', drawer.hidden);

  /* ---------- 10. 关掉后别被数据刷新弹回来 ----------
     页面每 10s 拉一次数据，拉完会顺手重画抽屉（让讲解里的实时数值跟上）。
     抽屉关掉时 glCur 故意留着（下次点开要判断有没有跨类），所以「关了」和「开着」
     在 glCur 上长一个样 —— 重画必须先看抽屉是不是还开着，否则刚关就被弹回来。 */
  console.log('\n=== 关掉后不再自己弹回来 ===');
  click(guide);
  await sleep(300);
  click(doc.body);
  await sleep(250);
  check('点抽屉外面收起', drawer.hidden);
  await sleep(12000);   // 熬过一次 10s 的数据刷新
  check('刷新数据后抽屉不会自己弹开', drawer.hidden,
    '刷新后 hidden=' + drawer.hidden);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('测试异常:', e && e.stack);
  process.exit(1);
});
