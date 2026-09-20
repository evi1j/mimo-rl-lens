#!/usr/bin/env node
/* 从本机 config.json 把配置项提取到配置模板 —— 改了配置忘了同步模板是常态，
 * 别人拿到的 example 就会缺字段、只能靠内置默认值跑。
 *
 *   node tools/gen-config-example.js            生成（写 config.example.json + dist/config.json）
 *   node tools/gen-config-example.js --check    只检查，模板落后于本机配置就退出码 1
 *   node tools/gen-config-example.js --from X   指定要提取的配置文件（测试用）
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
const DIST_CFG = path.join(ROOT, 'dist/config.json');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const fromIdx = argv.indexOf('--from');
const LIVE = path.resolve(fromIdx >= 0 ? argv[fromIdx + 1] : path.join(ROOT, 'config.json'));

// 这些键在模板里永远写成空/关，不写本机真实值
const SENSITIVE = /(key|token|secret|password|passwd|credential|auth)/i;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function cleanVal(k, v) {
  if (SENSITIVE.test(k)) return '';
  if (k === 'enabled') return false;
  return v;
}

const added = [];    // 本机有、模板没有 → 补进模板
const differs = [];  // 两边都有但值不同 → 保留模板原值，只是提醒

/* 把 live 的结构合并进 base：只补键不覆盖值（除对象递归展开） */
function merge(base, live, prefix) {
  Object.keys(live).forEach(function (k) {
    const v = live[k];
    const p = prefix ? prefix + '.' + k : k;
    if (isObj(v)) {
      if (!isObj(base[k])) base[k] = {};
      merge(base[k], v, p);
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

const live = readJson(LIVE);
if (!live) {
  console.error('读不到 ' + LIVE + '（没有本机配置可提取，跳过）');
  process.exit(0);
}
const example = readJson(EXAMPLE) || {};
const next = JSON.parse(JSON.stringify(example));
merge(next, live, '');

if (CHECK) {
  if (added.length === 0) {
    console.log('配置模板已覆盖本机 config.json 的全部配置项');
    if (differs.length) console.log('  （值不同的 ' + differs.length + ' 项按规矩保留模板原值：' + differs.join('、') + '）');
    process.exit(0);
  }
  console.log('配置模板落后：本机 config.json 有 ' + added.length + ' 项没进模板');
  added.forEach(function (p) { console.log('  缺  ' + p); });
  console.log('  跑 node tools/gen-config-example.js 补齐');
  process.exit(1);
}

if (added.length === 0) {
  console.log('配置模板无需更新（' + Object.keys(live).length + ' 个顶层配置项已覆盖）');
  if (differs.length) console.log('· 值不同但保留模板原值：' + differs.join('、'));
  process.exit(0);
}

function write(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

write(EXAMPLE, next);
console.log('已补进 config.example.json ' + added.length + ' 项：');
added.forEach(function (p) { console.log('  增  ' + p); });
if (differs.length) console.log('· 值不同但保留模板原值：' + differs.join('、'));

/* dist/config.json 是分发版直接能跑的配置：同结构、但注释是给使用者看的，
   那句 _comment 要留着，只更新配置项。 */
const distOld = readJson(DIST_CFG);
if (distOld) {
  const distNext = JSON.parse(JSON.stringify(next));
  if (typeof distOld._comment === 'string') distNext._comment = distOld._comment;
  Object.keys(distOld).forEach(function (k) { if (!(k in distNext)) distNext[k] = distOld[k]; });
  write(DIST_CFG, distNext);
  console.log('· dist/config.json 同步为同一结构（脱敏：enabled=false、密钥留空）');
}
