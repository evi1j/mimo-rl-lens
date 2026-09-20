#!/usr/bin/env node
/* 构建 dist/ —— 只在要打包分发时才跑，平时提交代码不碰它。
 * （源码的版本管理 与 部署产物的生成 是两件事，别再绑在提交钩子上。）
 *
 *   node tools/sync-dist.js            构建（打印改了哪些文件）
 *   node tools/sync-dist.js --check    只检查 dist 是否落后于源码（退出码 1 = 落后）
 *   node tools/sync-dist.js --zip      构建完打包 dist.zip
 *
 * 规矩：
 *   1. dist/config.json 由 config.example.json 脱敏生成（enabled=false、密钥留空），
 *      绝不复制本机 config.json —— 那里有真实 API key。
 *   2. dist/README.md、start.command、start.bat 是分发用的，源码目录没有，不动。
 *   3. public/ 整目录同步：源码里删掉的文件，dist 里也删（--no-prune 可关）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cfgTool = require('./gen-config-example.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 分发版配置里那句给使用者看的说明（dist/config.json 已存在时保留它自己的）
const DIST_COMMENT = 'AI 解说配置。默认关闭（enabled=false）——此时解说全部由内置规则引擎生成，' +
  '展开仍有知识点讲解，页面不会空白。接入自己的 OpenAI 兼容接口后，把 enabled 改为 true ' +
  '并填写 baseUrl / apiKey / model 三项即可，改完无需重启服务。';

/* ── 依赖：第三方为零，内部模块不靠手写清单 ────────────────────────
 * 本项目不用任何 npm 包（只用 http / fs / path / child_process / node:sqlite），
 * 所以没有 node_modules 要打包，使用者也不需要 npm install。
 * 真正会出错的是内部模块：以前 ROOT_FILES 是写死的四个文件，哪天新加一个根级
 * js 被 server.js require 了，构建不会带上它，dist 一跑就 MODULE_NOT_FOUND。
 * 所以改成从入口递归解析 require，并在构建后再校验一遍（见 verifyDistDeps）。 */

/* 解析前先剥掉注释。否则 UMD 头部那种「用法示例」里的 require 会被当成真实依赖
   （narrator-core.js 开头就有一行 Node 示例），报出根本不存在的路径。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1'); // 冒号后的 // 多半是 http://，不当注释
}

/* 从入口出发递归收集本地 require 的模块（只跟相对路径，忽略内置/第三方） */
function collectLocalDeps(entryRel, seen) {
  seen = seen || Object.create(null);
  if (seen[entryRel]) return seen;
  seen[entryRel] = true;
  const buf = readIfExists(path.join(ROOT, entryRel));
  if (buf === null) return seen;
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  const src = stripComments(buf.toString('utf8'));
  while ((m = re.exec(src))) {
    const base = path.dirname(entryRel);
    const rel = path.posix.normalize(base === '.' ? m[1] : base + '/' + m[1]);
    collectLocalDeps(rel, seen);
  }
  return seen;
}

/* 页面引用的静态资源（style.css、各个 js）。外链不管，只校验本地的。 */
function collectHtmlAssets(entryRel) {
  const buf = readIfExists(path.join(ROOT, entryRel));
  if (buf === null) return [];
  const out = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(buf.toString('utf8')))) {
    const u = m[1];
    // 锚点（#overview）、外链、data URI 都不是要打包的文件
    if (u.indexOf('#') === 0 || /^(https?:)?\/\//.test(u) || u.indexOf('data:') === 0) continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) continue; // mailto: 之类的协议
    out.push(u.split('?')[0]); // 去掉 ?v=21 这类版本号查询串
  }
  return out;
}

const ENTRY = 'server.js';
const autoDeps = Object.keys(collectLocalDeps(ENTRY))
  .filter(function (f) { return f.indexOf('public/') !== 0; }); // public/ 整目录同步
// 根级要同步的文件：自动解析出来的模块 + 配置模板（给使用者照着填）
const ROOT_FILES = Array.from(new Set(['config.example.json'].concat(autoDeps)));
// 分发包专属材料的源文件（dist/ 不入库，这些东西得有地方存）
const DEPLOY_FILES = ['README.md', 'start.command', 'start.bat'];
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
// 分发包里的说明与启动脚本，源码目录没有，从 deploy/ 取
DEPLOY_FILES.forEach(function (f) {
  syncFile('deploy/' + f, f);
  if (!CHECK && /\.command$/.test(f)) {
    const dst = path.join(DIST, f);
    if (fs.existsSync(dst)) fs.chmodSync(dst, 0o755); // 双击要能直接跑
  }
});
syncPublic();

/* dist/config.json 由模板脱敏生成 —— 绝不复制本机 config.json（那里有真实 key）。
   模板缺的新配置项由提交钩子负责补（tools/gen-config-example.js），
   这里只负责「把已入库的模板变成能直接跑的分发配置」。 */
function buildDistConfig() {
  const example = cfgTool.readJson(path.join(ROOT, 'config.example.json'));
  if (!example) return 'config.example.json 读不到，跳过 dist/config.json 生成';
  const dst = path.join(DIST, 'config.json');
  const next = cfgTool.sanitize(example);
  const old = cfgTool.readJson(dst);
  // 分发版那句是给使用者看的，跟模板的说明不是一回事，保留它
  next._comment = old && typeof old._comment === 'string' ? old._comment : DIST_COMMENT;
  if (old) Object.keys(old).forEach(function (k) { if (!(k in next)) next[k] = old[k]; });

  const text = JSON.stringify(next, null, 2) + '\n';
  const cur = readIfExists(dst);
  if (cur !== null && cur.toString('utf8') === text) { same.push('config.json'); return null; }
  if (cur === null) added.push('config.json'); else changed.push('config.json');
  if (!CHECK) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, text);
  }
  return null;
}
const cfgBuildMsg = buildDistConfig();

/* 本机 config.json 含真实 key，这里只说明不复制；新配置项该走提交钩子补模板 */
function configGuard() {
  const srcCfg = path.join(ROOT, 'config.json');
  let s = cfgTool.readJson(srcCfg);
  if (!s || !s.llm || !(s.llm.apiKey || s.llm.enabled)) return null;
  return 'config.json 不进 dist（本机配置含 API key，dist 版由模板脱敏生成）';
}
const guardMsg = configGuard();

/* 构建完再校验一遍：dist 里每个 require 和每个页面引用，目标文件都得真的存在。
   这一步是给「清单写漏」兜底的 —— 拷贝到一半被 Ctrl-C、以后新加了模块没被扫到、
   文件名改了但 index.html 没跟着改，都会在这里暴露，而不是等使用者双击才 404。 */
function verifyDistDeps() {
  if (!fs.existsSync(DIST)) return { missing: [], checked: 0 };
  const missing = [];
  let checked = 0;

  const jsFiles = [];
  (function walk(dir) {
    fs.readdirSync(dir).forEach(function (n) {
      if (n.indexOf('.') === 0) return;
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) { if (n !== 'data') walk(p); return; }
      if (path.extname(n) === '.js') jsFiles.push(p);
    });
  })(DIST);

  jsFiles.forEach(function (p) {
    const src = stripComments(fs.readFileSync(p, 'utf8'));
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      checked++;
      if (!fs.existsSync(path.resolve(path.dirname(p), m[1]))) {
        missing.push(path.relative(DIST, p) + ' → ' + m[1]);
      }
    }
  });

  const html = path.join(DIST, 'public', 'index.html');
  if (fs.existsSync(html)) {
    collectHtmlAssets('public/index.html').forEach(function (u) {
      checked++;
      if (!fs.existsSync(path.join(DIST, 'public', u))) {
        missing.push('public/index.html → ' + u);
      }
    });
  }
  return { missing: missing, checked: checked };
}
const depReport = verifyDistDeps();

const n = changed.length + added.length + removed.length;

function say(msg, prefix) {
  String(msg).split('\n').forEach(function (l) { if (l.trim()) console.log(prefix + l.trim()); });
}

/* 依赖校验结果：缺文件是硬错误，必须挡住打包 */
function reportDeps(prefix) {
  if (depReport.missing.length) {
    console.log(prefix + '✗ dist 引用了 ' + depReport.missing.length + ' 个不存在的文件：');
    depReport.missing.forEach(function (m) { console.log(prefix + '    ' + m); });
    return false;
  }
  if (depReport.checked) {
    console.log(prefix + '依赖校验通过：' + depReport.checked +
      ' 处引用全部可解析（零第三方依赖，使用者无需 npm install）');
  }
  return true;
}

if (CHECK) {
  if (n === 0) {
    console.log('dist 已是最新（' + same.length + ' 个文件一致）');
  } else {
    console.log('dist 落后于源码，需要构建 ' + n + ' 个文件：');
    changed.forEach(function (f) { console.log('  改  ' + f); });
    added.forEach(function (f) { console.log('  增  ' + f); });
    removed.forEach(function (f) { console.log('  删  ' + f); });
  }
  if (guardMsg) console.log('  · ' + guardMsg);
  if (cfgBuildMsg) say(cfgBuildMsg, '  · ');
  reportDeps('  · ');
  process.exit(n === 0 && depReport.missing.length === 0 ? 0 : 1);
}

if (n === 0) {
  console.log('dist 无需构建（' + same.length + ' 个文件一致）');
} else {
  console.log('已构建 ' + n + ' 个文件：');
  changed.forEach(function (f) { console.log('  改  ' + f); });
  added.forEach(function (f) { console.log('  增  ' + f); });
  removed.forEach(function (f) { console.log('  删  ' + f); });
}
console.log('· 从入口 ' + ENTRY + ' 解析出 ' + autoDeps.length + ' 个根级模块：' +
  autoDeps.join('、'));
if (guardMsg) console.log('· ' + guardMsg);
if (cfgBuildMsg) say(cfgBuildMsg, '· ');
const depsOk = reportDeps('· ');
if (!depsOk) process.exit(1); // 缺文件的包发出去只会是 404 / MODULE_NOT_FOUND

if (ZIP) {
  const out = path.join(ROOT, 'dist.zip');
  try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (e) { /* ignore */ }
  // 排除运行产物：dist/data 是看板跑起来后落库的 SQLite，不该进分发包
  execFileSync('zip', ['-r', '-q', 'dist.zip', 'dist', '-x', 'dist/data/*', 'dist/.DS_Store'],
    { cwd: ROOT, stdio: 'inherit' });
  console.log('· 已打包 dist.zip');
}
