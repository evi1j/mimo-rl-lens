#!/usr/bin/env node
/* 把源码同步到 dist/ —— 手动 cp 容易漏文件，也容易误覆盖 dist 独有的东西。
 *
 *   node tools/sync-dist.js            同步（打印改了哪些文件）
 *   node tools/sync-dist.js --check    只检查不同步，有差异就退出码 1（给 hook/CI 用）
 *   node tools/sync-dist.js --zip      同步完顺手打包 dist.zip
 *
 * 规矩：
 *   1. dist/config.json 是脱敏版（enabled=false、key 留空），永远不覆盖 ——
 *      本机 config.json 里有真实 key，复制过去等于泄露。
 *   2. dist/README.md、start.command、start.bat 是分发用的，源码目录没有，不动。
 *   3. public/ 整目录同步：源码里删掉的文件，dist 里也删（--no-prune 可关）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 根级要同步的文件
const ROOT_FILES = ['llm.js', 'server.js', 'store.js', 'config.example.json'];
// public/ 下参与同步的后缀（其余如 .map、临时文件不动）
const PUB_EXT = ['.js', '.css', '.html', '.svg', '.png', '.ico', '.json'];

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const ZIP = argv.includes('--zip');
const PRUNE = !argv.includes('--no-prune');

const changed = [];   // 内容变了
const added = [];     // dist 里还没有
const removed = [];   // 源码删了，dist 里要删
const same = [];

function readIfExists(p) {
  try { return fs.readFileSync(p); } catch (e) { return null; }
}

function syncFile(srcRel, dstRel) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(DIST, dstRel);
  const sBuf = readIfExists(src);
  if (sBuf === null) {
    if (fs.existsSync(dst)) {
      removed.push(dstRel);
      if (!CHECK) fs.unlinkSync(dst);
    }
    return;
  }
  const dBuf = readIfExists(dst);
  if (dBuf === null) {
    added.push(dstRel);
    if (!CHECK) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    return;
  }
  if (sBuf.equals(dBuf)) { same.push(dstRel); return; }
  changed.push(dstRel);
  if (!CHECK) fs.copyFileSync(src, dst);
}

function syncPublic() {
  const srcDir = path.join(ROOT, 'public');
  const dstDir = path.join(DIST, 'public');
  const srcNames = fs.readdirSync(srcDir).filter(function (n) {
    return !n.startsWith('.') && PUB_EXT.includes(path.extname(n));
  });
  srcNames.forEach(function (n) { syncFile('public/' + n, 'public/' + n); });

  if (!PRUNE) return;
  // 源码里已经没有、但 dist 里还留着的旧文件（比如改名后的老 js）
  const dstNames = fs.existsSync(dstDir) ? fs.readdirSync(dstDir) : [];
  dstNames.forEach(function (n) {
    if (n.startsWith('.') || !PUB_EXT.includes(path.extname(n))) return;
    if (srcNames.includes(n)) return;
    removed.push('public/' + n);
    if (!CHECK) fs.unlinkSync(path.join(dstDir, n));
  });
}

ROOT_FILES.forEach(function (f) { syncFile(f, f); });
syncPublic();

/* dist/config.json 必须保持脱敏。源文件里若开了 AI，只提醒不同步。 */
function configGuard() {
  const srcCfg = path.join(ROOT, 'config.json');
  const dstCfg = path.join(DIST, 'config.json');
  if (!fs.existsSync(srcCfg)) return null;
  let s;
  try { s = JSON.parse(fs.readFileSync(srcCfg, 'utf8')); } catch (e) { return null; }
  const leak = !!(s && s.llm && (s.llm.apiKey || s.llm.enabled));
  if (!leak) return null;
  const dstOk = fs.existsSync(dstCfg);
  return dstOk
    ? 'config.json 未同步（本机配置含 API key，dist 保留脱敏版）'
    : 'config.json 未同步，且 dist/config.json 不存在 —— 请手动放一份脱敏版';
}
const guardMsg = configGuard();

const n = changed.length + added.length + removed.length;

if (CHECK) {
  if (n === 0) {
    console.log('dist 已是最新（' + same.length + ' 个文件一致）');
  } else {
    console.log('dist 落后于源码，需要同步 ' + n + ' 个文件：');
    changed.forEach(function (f) { console.log('  改  ' + f); });
    added.forEach(function (f) { console.log('  增  ' + f); });
    removed.forEach(function (f) { console.log('  删  ' + f); });
  }
  if (guardMsg) console.log('  · ' + guardMsg);
  process.exit(n === 0 ? 0 : 1);
}

if (n === 0) {
  console.log('dist 无需同步（' + same.length + ' 个文件一致）');
} else {
  console.log('已同步 ' + n + ' 个文件：');
  changed.forEach(function (f) { console.log('  改  ' + f); });
  added.forEach(function (f) { console.log('  增  ' + f); });
  removed.forEach(function (f) { console.log('  删  ' + f); });
}
if (guardMsg) console.log('· ' + guardMsg);

if (ZIP) {
  const out = path.join(ROOT, 'dist.zip');
  try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (e) { /* ignore */ }
  execFileSync('zip', ['-r', '-q', 'dist.zip', 'dist'], { cwd: ROOT, stdio: 'inherit' });
  console.log('· 已打包 dist.zip');
}
