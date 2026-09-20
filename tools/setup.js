#!/usr/bin/env node
/* 一次性环境配置：把 git 钩子的查找目录指到仓库里的 .githooks/。
 *
 *   node tools/setup.js      （npm run setup）
 *
 * 为什么需要：git 默认只认 .git/hooks/ 里的钩子，而 .git/ 是本地私有的、
 * 不会随仓库传播 —— 钩子的源文件放在那里的话，别人克隆下来就丢了。
 * 所以钩子源文件放在仓库里的 .githooks/（会入库），再用 git config 告诉
 * git「去这个目录找钩子」。每台机器设一次，之后提交就会自动触发。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOKS = '.githooks';

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

// 不在 git 仓库里就没什么可配的
if (!git(['rev-parse', '--is-inside-work-tree'])) {
  console.log('当前目录不是 git 仓库，跳过钩子配置');
  process.exit(0);
}

if (!fs.existsSync(path.join(ROOT, HOOKS))) {
  console.log('没有 ' + HOOKS + ' 目录，跳过钩子配置');
  process.exit(0);
}

const before = git(['config', '--get', 'core.hooksPath']);
if (before === HOOKS) {
  console.log('钩子已配置：core.hooksPath=' + HOOKS);
} else {
  git(['config', 'core.hooksPath', HOOKS]);
  const after = git(['config', '--get', 'core.hooksPath']);
  if (after === HOOKS) {
    console.log('已配置 git 钩子目录 → ' + HOOKS);
    console.log('  之后每次 git commit 会自动把 config.json 的新配置项补进 config.example.json');
  } else {
    console.error('配置失败，手动执行：git config core.hooksPath ' + HOOKS);
    process.exit(1);
  }
}

// 本机配置不存在就给一份模板副本，省得服务起来后才知道要配
const cfg = path.join(ROOT, 'config.json');
const example = path.join(ROOT, 'config.example.json');
if (!fs.existsSync(cfg) && fs.existsSync(example)) {
  fs.copyFileSync(example, cfg);
  console.log('· 已从 config.example.json 生成 config.json（默认关闭 AI，按需填写）');
}
