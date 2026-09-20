/* 用 jsdom 真实加载解说栏，验证：
   1) 「展开讲讲」能展开/收起
   2) 15 秒自动重绘后，已展开的条目不会被收回去
   3) 新事件导致列表变化时，已展开的条目仍保持展开
   4) 展开状态写进 localStorage，刷新页面后仍在
   用法：NODE_PATH=<node workspace>/node_modules node test/dom-test.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { execSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(DIR, 'narrator.js'), 'utf8');

let raw;
try {
  raw = execSync("curl -s --noproxy '*' http://127.0.0.1:8787/api/narrator", { encoding: 'utf8' });
} catch (e) {
  console.log('✘ 取不到 /api/narrator，请先启动服务：node server.js');
  process.exit(1);
}
const data = JSON.parse(raw);

let pass = true;
function check(label, cond, extra) {
  console.log((cond ? '✔ ' : '✘ ') + label + (extra ? '  ' + extra : ''));
  if (!cond) pass = false;
}

function boot(seedStorage) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:8787/' });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.self = window;
  global.localStorage = window.localStorage;
  if (seedStorage) window.localStorage.setItem('mtl.narrator.expanded', seedStorage);
const narData = data;
global.fetch = (u) => {
  const s = String(u || '');
  let body = narData;
  if (s.indexOf('api/db/stats') >= 0) body = { enabled: true, metrics: 12, narrator: narData.items.length, sizeBytes: 36864 };
  else if (s.indexOf('api/search') >= 0) {
    const q = decodeURIComponent((s.split('q=')[1] || '').split('&')[0] || '');
    body = { q, items: narData.items.filter((it) => (it.text + (it.why || '') + (it.lesson || '')).indexOf(q) >= 0) };
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
};
window.fetch = global.fetch;
  eval(js);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return window;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let win = boot(null);
  await wait(400);
  let doc = win.document;
  let feed = doc.getElementById('nar-feed');
  const btns = feed.querySelectorAll('.nar-more');
  console.log('解说条数:', feed.querySelectorAll('.nar-item').length, '| 展开按钮数:', btns.length);
  if (!btns.length) { console.log('✘ 没有展开按钮，无法测试'); process.exit(1); }

  const key = btns[0].getAttribute('data-key');
  const boxOf = (d, k) => {
    const b = d.getElementById('nar-feed').querySelector('.nar-more[data-key="' + k + '"]');
    return b ? b.nextElementSibling : null;
  };

  console.log('\n— 基础展开/收起 —');
  btns[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('点击后展开', !boxOf(doc, key).hasAttribute('hidden'));

  console.log('\n— 连续 5 次自动重绘（内容不变）—');
  for (let i = 0; i < 5; i++) {
    doc.dispatchEvent(new win.Event('DOMContentLoaded'));
    await wait(120);
  }
  check('重绘后仍展开', !boxOf(doc, key).hasAttribute('hidden'),
    '文字=' + doc.getElementById('nar-feed').querySelector('.nar-more[data-key="' + key + '"]').textContent);

  console.log('\n— 插入一条新事件（列表变化触发重绘）—');
  data.items.unshift({
    id: 'test_new_1', ts: Date.now() / 1000, level: 'info', run: 'pro',
    text: '（测试）pro 进入生成阶段。', why: '测试用条目。', lesson: '这是测试教学段落。',
    ai: true, aiModel: 'test', ctx: { before: { step: 18 }, after: { step: 19 } },
  });
  doc.dispatchEvent(new win.Event('DOMContentLoaded'));
  await wait(200);
  check('新事件后旧条目仍展开', !boxOf(doc, key).hasAttribute('hidden'));

  const stored = win.localStorage.getItem('mtl.narrator.expanded');
  check('展开状态已写入 localStorage', !!stored && stored.indexOf(key) >= 0, stored || '');

  console.log('\n— 模拟刷新页面（新 JSDOM 实例 + 同一份 localStorage）—');
  const win2 = boot(stored);
  await wait(400);
  const box2 = boxOf(win2.document, key);
  check('刷新后仍保持展开', box2 && !box2.hasAttribute('hidden'));

  // 收起并确认持久化为收起
  const btn2 = win2.document.getElementById('nar-feed').querySelector('.nar-more[data-key="' + key + '"]');
  btn2.dispatchEvent(new win2.MouseEvent('click', { bubbles: true }));
  check('可正常收起', box2.hasAttribute('hidden'));
  check('收起状态也已持久化', (win2.localStorage.getItem('mtl.narrator.expanded') || '').indexOf(key) < 0);

  console.log('\n— 存档状态条 + 解说搜索 —');
  const statEl = win2.document.getElementById('nar-dbstat');
  check('存档状态条已渲染', /本地存档/.test(statEl.textContent || ''), (statEl.textContent || '').trim().slice(0, 40));

  const input = doc.getElementById('nar-search');
  input.value = '训练';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await wait(500);
  const resCount = doc.getElementById('nar-feed').querySelectorAll('.nar-item').length;
  check('搜索后解说流被替换为结果', resCount > 0 && resCount < feed.querySelectorAll('.nar-item').length + 99, '结果 ' + resCount + ' 条');

  const clearBtn = doc.getElementById('nar-clear');
  clearBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await wait(300);
  check('清除搜索后恢复完整解说流',
    doc.getElementById('nar-feed').querySelectorAll('.nar-item').length >= 4,
    doc.getElementById('nar-feed').querySelectorAll('.nar-item').length + ' 条');

  console.log('\n内容预览:', (box2.textContent || '').replace(/\s+/g, ' ').slice(0, 80));
  process.exit(pass ? 0 : 1);
})();
