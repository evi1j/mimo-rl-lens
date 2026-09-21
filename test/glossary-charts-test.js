/* 验证 benchmark 图表与指标库图表也接上了 AI 讲解：
   1) benchmark 卡片挂 bench:<key>，点开讲的是**这一个**基准（不再是所有基准共用一个面板讲解）
   2) 指标库卡片挂 tag:<name>，点开讲的是**这一个**指标
   3) 两类都有「AI 讲解」分页，而且提交给后端的 payload 各带自己的真实数据
   4) 精选指标那条老路径没被改坏（key 不加前缀、仍讲单个指标）
   AI 请求全部在这一层拦下造流，不碰真实模型、不烧 token。
   用法：node test/glossary-charts-test.js   （需 8787 上跑着服务） */
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

/* 讲解请求的 payload 会存到这里，供断言检查 —— 这是本次改动的核心：
   模型到底拿到了哪些数。 */
let captured = null;
let aiCalls = 0;

window.fetch = function (u, opt) {
  const url = new URL(u, BASE).toString();
  const method = (opt && opt.method) || 'GET';
  // AI 可用性探测：假装已配置好模型，否则按钮会置灰
  if (/\/api\/ai\/test$/.test(url)) {
    return Promise.resolve(new Response(
      JSON.stringify({ enabled: true, ok: true, model: 'mock-model' }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  if (method === 'POST' && /\/api\/explain$/.test(url)) {
    aiCalls++;
    try { captured = JSON.parse(opt.body); } catch (e) { captured = { parseError: String(e) }; }
    const nd = '{"delta":"第一段：测试讲解正文。"}\n' +
               '{"delta":"第二段：仍在读数。"}\n' +
               '{"done":true,"model":"mock-model"}\n';
    return Promise.resolve(new Response(nd, {
      status: 200, headers: { 'content-type': 'application/x-ndjson' },
    }));
  }
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
const txt = function (id) { return (doc.getElementById(id) || {}).textContent || ''; };

/* 切到 AI 分页（已经是当前页就不动它，避免多余重渲染） */
async function openAiTab() {
  const tab = doc.querySelector('#gl-body .gl-tab[data-glt="ai"]');
  if (tab && !tab.classList.contains('on')) { click(tab); await sleep(450); }
  return doc.querySelector('#gl-body .gl-ai-btn');
}

(async function () {
  await sleep(9000);   // 等 pins / benchmarks / tags 都加载完

  /* ---------- 1. benchmark 卡片 ---------- */
  console.log('\n=== benchmark：卡片挂载点 ===');
  const bcards = Array.from(doc.querySelectorAll('#bench-grid .bench-card'));
  check('渲染出评测基准卡片', bcards.length >= 2, '卡片 ' + bcards.length);
  const bkeys = bcards.map(function (c) { return c.dataset.gm; });
  check('每张卡挂自己的 key（bench:<名>）',
    bkeys.every(function (k) { return /^bench:.+/ .test(k || ''); }), bkeys.join(','));
  check('不再是所有卡共用 data-gm="bench"',
    bkeys.every(function (k) { return k !== 'bench'; }), bkeys.join(','));
  console.log('    基准 key:', bkeys.join(' | '));

  console.log('\n=== benchmark：抽屉内容 ===');
  const btarget = bcards[0];
  const bkey = btarget.dataset.gm;
  click(btarget);
  await sleep(600);
  check('点卡片打开抽屉', !doc.getElementById('gl-drawer').hidden);
  check('标题是「离线评测基准」', txt('gl-kicker') === '离线评测基准', txt('gl-kicker'));
  check('副标题是该基准的上游 key',
    txt('gl-sub') === bkey.slice(6), txt('gl-sub') + ' vs ' + bkey.slice(6));
  check('标题栏有中文名', /[一-龥]/.test(txt('gl-title')), txt('gl-title'));
  const rows = doc.querySelectorAll('#gl-body .gl-bench-row');
  check('列出各 run 的分数行', rows.length >= 1, '行 ' + rows.length);
  check('分数行有数值', Array.from(rows).every(function (r) {
    return /\d/.test((r.querySelector('.gbr-v') || {}).textContent || '');
  }), Array.from(rows).map(function (r) { return r.textContent.replace(/\s+/g, ' ').trim(); }).join(' / '));
  check('基准讲解没有「上一个 / 下一个」', doc.getElementById('gl-foot').hidden);
  check('有 AI 讲解分页', !!doc.querySelector('#gl-body .gl-tab[data-glt="ai"]'));
  console.log('    ' + doc.getElementById('gl-title').textContent + ' | ' +
    Array.from(rows).map(function (r) { return r.textContent.replace(/\s+/g, ' ').trim(); }).join(' / '));

  console.log('\n=== benchmark：喂给模型的 payload ===');
  let btn = await openAiTab();
  check('AI 分页有讲解按钮', !!btn);
  if (btn && !btn.disabled) {
    click(btn);
    await sleep(900);
    check('发出了讲解请求', aiCalls === 1, '次数 ' + aiCalls);
    check('kind = bench', captured && captured.kind === 'bench', JSON.stringify(captured && captured.kind));
    check('key 带回前缀', captured && captured.key === bkey, JSON.stringify(captured && captured.key));
    check('带该基准的各 run 分数序列',
      captured && Array.isArray(captured.series) && captured.series.length >= 1,
      JSON.stringify(captured && captured.series && captured.series.length));
    const s0 = captured && captured.series && captured.series[0];
    check('每条序列给出最新分 / 首值 / 累计变化',
      s0 && typeof s0.last === 'number' && typeof s0.first === 'number' && typeof s0.gain === 'number',
      JSON.stringify(s0 && { last: s0.last, first: s0.first, gain: s0.gain }));
    check('每条序列给出最近若干次评测的原始分数',
      s0 && Array.isArray(s0.recent) && s0.recent.length > 0 && typeof s0.recent[0].score === 'number',
      JSON.stringify(s0 && s0.recent && s0.recent.slice(0, 2)));
    check('带上这个基准的固定说明（static.desc）',
      captured && captured.static && (captured.static.desc || '').length > 20,
      (captured && captured.static && captured.static.desc || '').slice(0, 40));
    check('不误带单个指标的 live 字段', captured && !captured.live);
    check('正文写进了页面', /测试讲解正文/.test(txt('gl-ai-out')), txt('gl-ai-out').slice(0, 40));
    console.log('    模型看到的分数:', JSON.stringify(s0 && s0.last), '累计', JSON.stringify(s0 && s0.gain));
  } else {
    check('AI 按钮可用（未被置灰）', false, btn ? 'disabled' : 'no button');
  }

  /* ---------- 2. 指标库卡片 ---------- */
  console.log('\n=== 指标库：卡片挂载点 ===');
  click(doc.querySelector('#tabs a[data-view="metrics"]'));
  await sleep(3200);
  const folders = Array.from(doc.querySelectorAll('#folders .folder'));
  check('指标库列出分类目录', folders.length >= 5, '目录 ' + folders.length);
  const folder = folders.find(function (f) { return f.dataset.p === 'timing_s'; }) || folders[0];
  click(folder);
  await sleep(3200);
  const tcards = Array.from(doc.querySelectorAll('#tree-grid .metric-card'));
  check('分类下有指标卡片', tcards.length > 0, '卡片 ' + tcards.length);
  const tkeys = tcards.map(function (c) { return c.dataset.gk; });
  check('每张卡挂 tag:<名>',
    tkeys.every(function (k) { return /^tag:.+/ .test(k || ''); }), tkeys.slice(0, 3).join(','));
  const tkey = tkeys[0];
  const tname = tkey.slice(4);
  console.log('    首个指标:', tname, '| 分类', folder.dataset.p);

  console.log('\n=== 指标库：抽屉内容 ===');
  click(tcards[0]);
  await sleep(700);
  check('点卡片打开抽屉', !doc.getElementById('gl-drawer').hidden);
  check('标题说明来自指标库', /指标库/.test(txt('gl-kicker')), txt('gl-kicker'));
  check('副标题是真实指标名', txt('gl-sub') === tname, txt('gl-sub') + ' vs ' + tname);
  check('有固定讲解正文', doc.querySelectorAll('#gl-body .gl-sec').length >= 1 ||
    !!doc.querySelector('#gl-body .gl-lead'));
  check('指标库讲解没有「上一个 / 下一个」', doc.getElementById('gl-foot').hidden);
  check('有 AI 讲解分页', !!doc.querySelector('#gl-body .gl-tab[data-glt="ai"]'));
  console.log('    ' + txt('gl-title') + ' | ' + txt('gl-sub'));

  console.log('\n=== 指标库：喂给模型的 payload ===');
  btn = await openAiTab();
  check('AI 分页有讲解按钮', !!btn);
  if (btn && !btn.disabled) {
    click(btn);
    await sleep(900);
    check('发出第二次讲解请求', aiCalls === 2, '次数 ' + aiCalls);
    check('kind = tag', captured && captured.kind === 'tag', JSON.stringify(captured && captured.kind));
    check('key = tag:<名>', captured && captured.key === tkey, JSON.stringify(captured && captured.key));
    check('metrics 字段给出真实指标名供工具检索',
      captured && captured.metric === tname, JSON.stringify(captured && captured.metric));
    check('带上此刻的真实数值',
      captured && captured.live && typeof captured.live.last === 'number',
      JSON.stringify(captured && captured.live));
    check('带上最近若干步（模型据此判断趋势）',
      captured && captured.recent && Object.keys(captured.recent).length > 0,
      JSON.stringify(captured && captured.recent && Object.keys(captured.recent)));
    const rk = captured && captured.recent && Object.keys(captured.recent)[0];
    check('最近若干步是 step/value 序列',
      rk && Array.isArray(captured.recent[rk]) && captured.recent[rk].length > 0 &&
      typeof captured.recent[rk][0].step === 'number',
      JSON.stringify(captured.recent[rk].slice(0, 2)));
    console.log('    模型看到的最新值:', JSON.stringify(captured.live.last),
      '| 最近步数:', (captured.recent[rk] || []).length);
  } else {
    check('AI 按钮可用（未被置灰）', false, btn ? 'disabled' : 'no button');
  }

  /* ---------- 3. 精选指标这条老路径没被改坏 ---------- */
  console.log('\n=== 精选指标（回归） ===');
  click(doc.querySelector('#tabs a[data-view="overview"]'));
  await sleep(900);
  const mcards = Array.from(doc.querySelectorAll('#metric-grid .metric-card'));
  check('精选指标卡片仍在', mcards.length === 18, '卡片 ' + mcards.length);
  check('精选指标的 key 不加前缀（保持原样）',
    mcards.every(function (c) { return !/^(tag|bench):/.test(c.dataset.gk || ''); }),
    mcards.slice(0, 3).map(function (c) { return c.dataset.gk; }).join(','));
  click(mcards[0]);
  await sleep(500);
  check('点开仍是「训练指标」讲解', /训练指标/.test(txt('gl-kicker')), txt('gl-kicker'));
  check('精选指标仍能前后翻',
    !doc.getElementById('gl-foot').hidden && !doc.getElementById('gl-pos').hidden);
  btn = await openAiTab();
  if (btn && !btn.disabled) {
    click(btn);
    await sleep(900);
    check('kind = metric', captured && captured.kind === 'metric', JSON.stringify(captured && captured.kind));
    check('key 是原始指标名（没被加前缀）',
      captured && captured.key === mcards[0].dataset.gk, JSON.stringify(captured && captured.key));
    check('仍带 static 五段文案',
      captured && captured.static && !!captured.static.one && !!captured.static.what,
      JSON.stringify(captured && captured.static && Object.keys(captured.static)));
  } else {
    check('AI 按钮可用（未被置灰）', false, btn ? 'disabled' : 'no button');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('测试异常:', e && e.stack);
  process.exit(1);
});
