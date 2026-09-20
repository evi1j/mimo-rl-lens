/* 用 jsdom 真实加载看板，验证 v1.2 新增的四个模块：
   1) 三页切换（总览 / 指标库 / 关于）
   2) 多时区时钟与总花费
   3) KV 补充项（训练批 × n、相对首步）
   4) batch composition 堆叠面积图与明细表
   5) 指标库树形导航 + 图表卡片
   用法：NODE_PATH=<node workspace>/node_modules node test/views-test.js */
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

// 必须返回完整 Response：app.js 的 getJSON 依赖 .ok / .status / .json
window.fetch = function (u) {
  const url = new URL(u, BASE).toString();
  return fetch(url).then(function (r) { return r; })
    .catch(function (e) { console.log('  [fetch FAIL] ' + url + ' ' + e.message); throw e; });
};
window.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };

window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

(async function () {
  const doc = window.document;
  await sleep(9000);   // 等 tags（2000+ 项）与 composition 序列加载完

  /* ---------- 1. 三页切换 ---------- */
  console.log('\n=== 三页切换 ===');
  const vOver = doc.getElementById('view-overview');
  const vMet = doc.getElementById('view-metrics');
  const vAbout = doc.getElementById('view-about');
  check('三个视图容器都存在', !!vOver && !!vMet && !!vAbout);
  check('默认显示总览页', !vOver.hidden && vMet.hidden && vAbout.hidden);

  /* ---------- 2. 时钟 ---------- */
  console.log('\n=== 多时区时钟 ===');
  const clks = doc.querySelectorAll('#clocks .clk');
  check('时钟格子 = 5（总花费 + 4 城市）', clks.length === 5, '实际 ' + clks.length);
  const costTxt = (doc.querySelector('#clocks .clk-cost .v') || {}).textContent || '';
  check('总花费有数值', /^\$[\d,]+$/.test(costTxt.trim()), costTxt);
  const cityTxt = Array.from(doc.querySelectorAll('#clocks .clk:not(.clk-cost) .v')).map(function (e) { return e.textContent; });
  check('四个城市都是 HH:MM:SS', cityTxt.length === 4 && cityTxt.every(function (t) { return /^\d{2}:\d{2}:\d{2}$/.test(t.trim()); }), cityTxt.join(' '));
  console.log('    时钟:', cityTxt.join('  '), '| 总花费', costTxt);

  /* ---------- 3. KV 补充 ---------- */
  console.log('\n=== 状态卡 KV ===');
  const rcText = Array.from(doc.querySelectorAll('.run-card')).map(function (c) { return c.textContent; }).join(' ');
  check('含「训练批 × n」', /训练批 × n/.test(rcText));
  check('含「vs 首步」', /vs 首步/.test(rcText));
  const bn = Array.from(doc.querySelectorAll('.rc-grid div')).find(function (d) { return /训练批/.test(d.textContent); });
  console.log('    训练批:', bn ? bn.textContent.trim().replace(/\s+/g, ' ') : '(未找到)');
  const sf = Array.from(doc.querySelectorAll('.rc-grid div')).find(function (d) { return /vs 首步/.test(d.textContent); });
  console.log('    vs 首步:', sf ? sf.textContent.trim().replace(/\s+/g, ' ') : '(未找到)');
  check('训练批显示 ×N 采样', bn && /×\s*\d+\s*采样/.test(bn.textContent), bn && bn.textContent);
  check('vs 首步带涨跌符号', sf && /[▲▼]/.test(sf.textContent), sf && sf.textContent);

  /* ---------- 3.5 离线评测基准 ---------- */
  console.log('\n=== 离线评测基准 ===');
  const benchGrid = doc.getElementById('bench-grid');
  const bcards = doc.querySelectorAll('#bench-grid .bench-card');
  check('评测面板存在', !!benchGrid);
  // 上游 api/benchmarks 目前返回 3 个基准，不应再只画 DeepSWE 一个
  check('渲染出全部基准（>=2 张卡）', bcards.length >= 2, '卡片 ' + bcards.length);
  const bTitle = (doc.getElementById('bench-count') || {}).textContent || '';
  check('显示基准总数', /共 \d+ 个基准/.test(bTitle), bTitle);
  const bSvg = Array.from(bcards).filter(function (c) { return c.querySelector('.m-chart svg'); }).length;
  check('每张卡都带折线图', bcards.length > 0 && bSvg === bcards.length, bSvg + '/' + bcards.length);
  const bNames = Array.from(bcards).map(function (c) { return (c.querySelector('.m-zh') || {}).textContent; });
  check('卡片都有中文名', bNames.every(function (n) { return n && /[一-龥]/.test(n); }), bNames.join(' | '));
  const bDescs = Array.from(bcards).map(function (c) { return (c.querySelector('.m-desc') || {}).textContent || ''; });
  check('卡片都有说明文字', bDescs.every(function (d) { return d.length > 20; }));
  // 每张卡应同时给出 pro / flash 两个 run 的末值
  const bVals = Array.from(bcards).map(function (c) { return c.querySelectorAll('.m-val').length; });
  check('每张卡含两个 run 的数值', bVals.every(function (n) { return n === 2; }), bVals.join(','));
  const bTotals = Array.from(bcards).map(function (c) { return c.querySelectorAll('.m-total').length; });
  check('每张卡含累计涨幅', bTotals.every(function (n) { return n === 2; }), bTotals.join(','));
  console.log('    基准:', bNames.join(' | '));
  if (bcards[0]) {
    console.log('    首卡数值:', Array.from(bcards[0].querySelectorAll('.m-val')).map(function (v) { return v.textContent.replace(/\s+/g, ' ').trim(); }).join('  '));
  }
  // 旧实现只画 chart-bench 单图，确认已移除
  check('旧的单图容器已移除', !doc.getElementById('chart-bench'));

  /* ---------- 4. batch composition ---------- */
  console.log('\n=== 训练样本构成 ===');
  const compPanel = doc.getElementById('comp-panel');
  check('构成面板已显示', compPanel && !compPanel.hidden);
  const paths = doc.querySelectorAll('#comp-chart svg path');
  check('堆叠图渲染出多层面积', paths.length >= 3, '层数 ' + paths.length);
  const rows = doc.querySelectorAll('#comp-table tbody tr');
  check('明细表有类别行 + 合计', rows.length >= 4, '行数 ' + rows.length);
  const headTxt = (doc.querySelector('.comp-t-head') || {}).textContent || '';
  console.log('    表头:', headTxt.replace(/\s+/g, ' ').trim());
  check('表头含 step 与 prompts', /step\s*\d+/.test(headTxt) && /prompts/.test(headTxt), headTxt);
  const firstRow = rows[0] ? Array.from(rows[0].querySelectorAll('td')).map(function (t) { return t.textContent.trim(); }) : [];
  console.log('    首行:', firstRow.join(' | '));
  check('首行占比是百分比', firstRow.length >= 4 && /%$/.test(firstRow[3]), firstRow[3]);

  // 切到「占比」模式应重画
  const shareBtn = doc.querySelector('#comp-mode-switch .seg-btn[data-mode="share"]');
  if (shareBtn) {
    click(shareBtn);
    await sleep(1200);
    const yLabels = Array.from(doc.querySelectorAll('#comp-chart svg .axis-text')).map(function (e) { return e.textContent; });
    check('占比模式纵轴为百分比', yLabels.some(function (t) { return /%$/.test(t); }), yLabels.slice(0, 6).join(','));
  }

  /* ---------- 5. 指标库 ---------- */
  console.log('\n=== 指标库 ===');
  const tabMetrics = doc.querySelector('#tabs a[data-view="metrics"]');
  click(tabMetrics);
  await sleep(3500);
  check('切到指标库后该页显示', !vMet.hidden && vOver.hidden);
  const nodes = doc.querySelectorAll('#tree .tree-node');
  check('树形导航渲染出节点', nodes.length >= 5, '节点数 ' + nodes.length);
  const tagCount = (doc.getElementById('tag-count') || {}).textContent || '';
  check('显示指标总数', /\d/.test(tagCount), tagCount);
  console.log('    指标总数:', tagCount, '| 顶层节点:', Array.from(nodes).slice(0, 8).map(function (n) { return n.querySelector('.nm').textContent; }).join(', '));

  // 根路径下没有直接挂着的指标，只列出分类 —— 应给出引导而不是留白
  const folders = doc.querySelectorAll('#folders .folder');
  check('根路径列出分类目录', folders.length >= 5, '目录数 ' + folders.length);
  const gridTxt = (doc.getElementById('tree-grid') || {}).textContent || '';
  check('根路径给出选择引导', /选一个分类/.test(gridTxt), gridTxt.slice(0, 50));

  // 点进某个分类后应渲染出该分类下的指标卡片
  const target = Array.from(folders).find(function (f) { return f.dataset.p === 'timing_s'; }) || folders[0];
  click(target);
  await sleep(3000);
  const tcards = doc.querySelectorAll('#tree-grid .metric-card');
  check('点进分类后渲染出图表卡片', tcards.length > 0, target.dataset.p + ' -> 卡片 ' + tcards.length);
  const withSvg = Array.from(tcards).filter(function (c) { return c.querySelector('.m-chart svg'); }).length;
  check('卡片都带折线图', tcards.length > 0 && withSvg === tcards.length, withSvg + '/' + tcards.length);
  if (tcards[0]) {
    console.log('    示例:', (tcards[0].querySelector('.m-zh') || {}).textContent,
                '=', (tcards[0].querySelector('.m-num') || {}).textContent);
  }

  // 搜索
  const box = doc.getElementById('tag-search');
  box.value = 'entropy';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(2500);
  const crumbs = (doc.getElementById('crumbs') || {}).textContent || '';
  check('搜索后显示匹配数', /项匹配/.test(crumbs), crumbs.slice(0, 60));
  const scards = doc.querySelectorAll('#tree-grid .metric-card');
  check('搜索结果有卡片', scards.length > 0, '卡片 ' + scards.length);
  console.log('    搜索 entropy:', crumbs.replace(/\s+/g, ' ').trim(), '| 卡片', scards.length);

  /* ---------- 6. 关于 ---------- */
  console.log('\n=== 关于页 ===');
  click(doc.querySelector('#tabs a[data-view="about"]'));
  await sleep(600);
  check('切到关于页', !vAbout.hidden && vMet.hidden);
  const aboutTxt = (doc.getElementById('about-body') || {}).textContent || '';
  check('关于页有正文', aboutTxt.length > 200, '长度 ' + aboutTxt.length);
  check('关于页提到本地运行', /本地/.test(aboutTxt));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('测试异常:', e && e.stack);
  process.exit(1);
});
