#!/usr/bin/env node
/* 从本机 config.json 把配置项提取进配置模板 —— 改了配置忘了同步模板是常态，
 * 别人拿到的 example 就会缺字段、只能靠内置默认值跑。
 *
 *   node tools/gen-config-example.js            生成（只写 config.example.json）
 *   node tools/gen-config-example.js --check    只检查，模板落后于本机配置就退出码 1
 *   node tools/gen-config-example.js --from X   指定要提取的配置文件（测试用）
 *
 * 只管模板，不碰 dist —— dist/config.json 是构建产物，由 tools/sync-dist.js 生成。
 *
 * 两条安全规矩：
 *   1. 密钥类字段（key/token/secret/password…）一律置空，enabled 一律写 false。
 *      模板是给别人抄的，绝不能带出本机真实凭证和内网地址。
 *   2. 模板里已有的键**保留模板原值**，只用本机配置补齐缺失的键。
 *      否则会把本机的 baseUrl / model 写进模板，等于泄露本机环境。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'config.example.json');

// 这些键在模板里永远写成空/关，不写本机真实值
const SENSITIVE = /(apikey|api_?key|secret|password|passwd|credential|auth|token)/i;
// 「最大 token 数」不是凭证，别被上面的 token 误伤（踩过：maxTokens 被清空成 ""）
const NOT_SECRET = /(maxtokens|max_tokens|total_tokens|used_tokens)/i;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function isSecretKey(k) {
  if (typeof k !== 'string') return false;
  if (NOT_SECRET.test(k)) return false;
  return SENSITIVE.test(k);
}

function cleanVal(k, v) {
  if (isSecretKey(k)) return '';
  if (k === 'enabled') return false;
  return v;
}

/* 深拷贝并把敏感字段抹掉：给 dist 那种要发出去的配置用 */
function sanitize(obj) {
  return JSON.parse(JSON.stringify(obj, function (k, v) {
    if (k === 'enabled') return false;
    if (isSecretKey(k)) return '';
    return v;
  }));
}

/* 把 live 的结构合并进 base：只补键不覆盖值（除对象递归展开） */
function merge(base, live, prefix, added, differs) {
  Object.keys(live).forEach(function (k) {
    const v = live[k];
    const p = prefix ? prefix + '.' + k : k;
    if (isObj(v)) {
      if (!isObj(base[k])) base[k] = {};
      merge(base[k], v, p, added, differs);
      return;
    }
    if (!(k in base)) {
      base[k] = cleanVal(k, v);
      added.push(p);
    } else if (!isObj(base[k]) && base[k] !== cleanVal(k, v)) {
      // 不覆盖：模板值可能是给新人的默认值，本机值可能是真实环境
      differs.push(p);
    }
  });
}

/* 返回 { added, differs, next } —— 供 CLI 与测试共用 */
function plan(livePath, examplePath) {
  const live = readJson(livePath);
  const example = readJson(examplePath) || {};
  const next = JSON.parse(JSON.stringify(example));
  const added = [], differs = [];
  if (live) merge(next, live, '', added, differs);
  return { live: live, added: added, differs: differs, next: next };
}

module.exports = { readJson, sanitize, cleanVal, plan, EXAMPLE, ROOT };

if (require.main !== module) return;

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const fromIdx = argv.indexOf('--from');
const LIVE = path.resolve(fromIdx >= 0 ? argv[fromIdx + 1] : path.join(ROOT, 'config.json'));

const r = plan(LIVE, EXAMPLE);
if (!r.live) {
  console.error('读不到 ' + LIVE + '（没有本机配置可提取，跳过）');
  process.exit(0);
}

if (CHECK) {
  if (r.added.length === 0) {
    console.log('配置模板已覆盖本机 config.json 的全部配置项');
    if (r.differs.length) console.log('  （值不同的 ' + r.differs.length + ' 项按规矩保留模板原值：' + r.differs.join('、') + '）');
    process.exit(0);
  }
  console.log('配置模板落后：本机 config.json 有 ' + r.added.length + ' 项没进模板');
  r.added.forEach(function (p) { console.log('  缺  ' + p); });
  console.log('  跑 node tools/gen-config-example.js 补齐');
  process.exit(1);
}

if (r.added.length === 0) {
  console.log('配置模板无需更新（已覆盖本机 config.json 的全部配置项）');
  if (r.differs.length) console.log('· 值不同但保留模板原值：' + r.differs.join('、'));
  process.exit(0);
}

fs.writeFileSync(EXAMPLE, JSON.stringify(r.next, null, 2) + '\n');
console.log('已补进 config.example.json ' + r.added.length + ' 项：');
r.added.forEach(function (p) { console.log('  增  ' + p); });
if (r.differs.length) console.log('· 值不同但保留模板原值：' + r.differs.join('、'));
