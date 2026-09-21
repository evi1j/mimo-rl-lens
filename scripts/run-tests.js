#!/usr/bin/env node
/* 统一测试入口：串行跑 test/ 下的用例，跑完汇总，退出码 0 / 1。
 *
 *   node scripts/run-tests.js              跑默认这批（全是本地 mock，不依赖外网模型）
 *   node scripts/run-tests.js --only=store 只跑名字里含 store 的用例
 *   node scripts/run-tests.js --all        连需要真实模型的用例一起跑
 *   node scripts/run-tests.js --list       只列出有哪些用例
 *
 * 为什么不再用 package.json 里那一长串 &&：
 *   · 加一个用例就得改 package.json，而且改动藏在一行里看不出来
 *   · 前一个失败就中断，后面的情况全看不见
 *   · 没法只跑其中一组
 *
 * 跟用例之间只有一个契约：用例自己 process.exit(非 0) 就算失败。
 * 失败不中断 —— 一次把所有问题都列出来，最后统一给退出码。
 *
 * 注意：store / metrics / glossary / views / dom 这几组要连 8787 上跑着的看板服务；
 * server-config-test 会真起服务、并停掉占着 8787 的进程，所以永远排在最后。 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const TIMEOUT_MS = 5 * 60 * 1000; // 单个用例最多跑 5 分钟，卡住别把 CI 拖死

/* 顺序即执行顺序。server-config-test 必须在最后（它会停掉 8787）。 */
const CASES = [
  { file: 'sqlite-driver-test.js', desc: 'SQLite 驱动：内置/wasm 双路、跨驱动读库、WAL 自救' },
  { file: 'store-test.js', desc: '指标仓库：series / tag_meta / bench / run_state（需 8787）' },
  { file: 'ai-retry-test.js', desc: 'AI 分层重试：请求级 / 正文级 / 断连' },
  { file: 'metrics-test.js', desc: '前端指标全景与抽屉（jsdom，需 8787）' },
  { file: 'glossary-test.js', desc: '词库与知识点渲染（jsdom，需 8787）' },
  { file: 'glossary-charts-test.js', desc: 'benchmark 与指标库图表的 AI 讲解接入（jsdom，需 8787）' },
  { file: 'views-test.js', desc: '各视图与导航（jsdom，需 8787）' },
  { file: 'ai-tool-test.js', desc: 'AI function calling 工具定义与调用' },
  { file: 'explain-prompt-test.js', desc: '讲解提示词按 kind 分流（纯本地）' },
  { file: 'ai-explain-test.js', desc: 'AI 讲解端到端（本地 mock 服务）' },
  { file: 'ai-retry-ui-test.js', desc: '重跑时旧内容收缩成折叠块（jsdom）' },
  { file: 'dom-test.js', desc: '页面整体 DOM：存档状态条、解说搜索（jsdom，需 8787）' },
  { file: 'server-config-test.js', desc: '端口/监听地址配置（真起服务，会停掉 8787）' },
  { file: 'ai-prompt-test.js', desc: '拿真实模型试跑一次 prompt 效果', needsModel: true },
];

function hasJsdom() {
  try {
    require.resolve('jsdom');
    return true;
  } catch (e) {
    try {
      require.resolve('jsdom', { paths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean) });
      return true;
    } catch (e2) { return false; }
  }
}

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const all = argv.includes('--all');
const list = argv.includes('--list');

const picked = CASES.filter(function (c) {
  if (c.needsModel && !all && !only) return false; // 默认不跑要真实模型的
  if (only && c.file.indexOf(only) < 0) return false;
  return true;
});

if (list) {
  console.log('可用用例（' + CASES.length + ' 个）：');
  CASES.forEach(function (c) {
    console.log('  ' + (c.needsModel ? '[需真实模型] ' : '            ') + c.file + '  — ' + c.desc);
  });
  process.exit(0);
}

if (!picked.length) {
  console.log('--only=' + only + ' 没匹配到任何用例。用 --list 看看有哪些。');
  process.exit(1);
}

if (!hasJsdom()) {
  console.log('注意：没找到 jsdom，用到它的用例会以 MODULE_NOT_FOUND 失败。');
  console.log('      它已经写在 devDependencies 里，在本目录执行：npm install');
  console.log('      （装在别的目录时：NODE_PATH=<那个 node_modules> npm test）');
}

console.log('跑 ' + picked.length + ' / ' + CASES.length + ' 个用例' + (only ? '（--only=' + only + '）' : '') + '\n');

const results = [];
let failed = 0;

picked.forEach(function (c, i) {
  const file = path.join(TEST_DIR, c.file);
  if (!fs.existsSync(file)) {
    console.log('[' + (i + 1) + '/' + picked.length + '] 跳过 ' + c.file + '（文件不见了）');
    results.push({ file: c.file, ok: false, why: '文件不存在', ms: 0 });
    failed++;
    return;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    stdio: 'inherit',   // 用例自己的输出直接透出，别藏起来
    timeout: TIMEOUT_MS,
  });
  const ms = Date.now() - t0;
  let ok = r.status === 0;
  let why = '';
  if (r.error && r.error.code === 'ETIMEDOUT') { ok = false; why = '超过 ' + TIMEOUT_MS / 1000 + ' 秒被掐掉'; }
  else if (r.status !== 0) { why = '退出码 ' + r.status + (r.signal ? ' / 信号 ' + r.signal : ''); }
  if (!ok) failed++;

  console.log('[' + (i + 1) + '/' + picked.length + '] ' + (ok ? 'ok   ' : 'FAIL ') + c.file +
    '  ' + (ms / 1000).toFixed(1) + 's' + (why ? '  -> ' + why : '') + '\n');
  results.push({ file: c.file, ok: ok, why: why, ms: ms });
});

console.log('—— 汇总 ——');
results.forEach(function (r) {
  console.log('  ' + (r.ok ? 'ok   ' : 'FAIL ') + r.file + (r.why ? '  -> ' + r.why : ''));
});
const passed = results.length - failed;
console.log('\n' + passed + ' / ' + results.length + ' 个用例通过' +
  (failed ? '，' + failed + ' 个失败' : '，全部通过'));
if (!failed && !all) {
  console.log('（ai-prompt-test 需要真实模型，默认不跑；要跑加 --all）');
}
process.exit(failed ? 1 : 0);
