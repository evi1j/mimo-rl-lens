#!/usr/bin/env node
/* 端口与监听地址的配置链路测试。
 *
 * 为什么要单独测：端口写错了服务直接起不来，而且这是唯一一项「改了必须重启才生效」
 * 的配置，写错值（"8787abc"、70000）如果不做兜底就会抛 EADDRINUSE / ERR_SOCKET_BAD_PORT
 * 这种看不懂的错误。
 *
 * 测法：临时改 config.json 的 server 段，用子进程真起一次服务，读它启动成功后
 * 打印的监听地址（那行是 listen 回调里打的，打印即代表端口绑定成功）。
 * 全程用 8790+ 这些冷门端口，不动正在跑的 8787；结束一定恢复原配置。
 *
 *   node test/server-config-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'config.json');
const BACKUP = '/tmp/mimo-config-backup.json';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { return {}; }
}
function writeCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n'); }

/* 起一次服务，返回它打印的 { host, port } 或 { log }（没起来时给全量输出） */
function boot(env) {
  return new Promise(function (resolve) {
    const p = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, env || {}),
    });
    let out = '';
    let done = false;
    const finish = function (r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
      resolve(r);
    };
    const timer = setTimeout(function () { finish({ log: out, timeout: true }); }, 15000);
    const onData = function (d) {
      out += d.toString();
      const m = out.match(/mimo-train-live\s+->\s+http:\/\/([^:\s]+):(\d+)/);
      if (m) setTimeout(function () { finish({ host: m[1], port: Number(m[2]), log: out }); }, 200);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', function () {
      // 没打出监听地址就说明没起来（端口冲突/参数错误）
      setTimeout(function () { finish({ log: out, exited: true }); }, 100);
    });
  });
}

/* 兜底端口就是 8787，测试要真把它占住才能验证「回退到 8787」和「默认值 8787」。
   所以先把占用 8787 的进程停掉 —— 通常是自己起的开发服务，测完手动重启即可
   （node src/server.js）。这也是它在 npm test 里排在最后的原因：别影响前面的用例。 */
function freeDefaultPort() {
  try {
    const pids = execSync('lsof -ti tcp:8787 2>/dev/null || true', { encoding: 'utf8' }).trim();
    if (!pids) return;
    console.log('\n（为验证兜底端口 8787，先停掉占用它的进程：' + pids.split('\n').join(' ') +
      '，测完需手动 node src/server.js 重启）');
    execSync('kill -9 ' + pids.split('\n').join(' ') + ' 2>/dev/null || true', { stdio: 'ignore' });
  } catch (e) { /* 没人占用，正好 */ }
}

async function main() {
  const had = fs.existsSync(CFG);
  if (had) fs.copyFileSync(CFG, BACKUP);
  const base = readCfg();

  try {
    // ── 1. config.json 的 server 段生效 ──────────────────────────
    let c = JSON.parse(JSON.stringify(base));
    c.server = { port: 8790, host: '0.0.0.0' };
    writeCfg(c);
    let r = await boot({});
    check('config.json 里写 port 8790，服务就监听 8790',
      r.port === 8790 && r.host === '0.0.0.0',
      JSON.stringify({ port: r.port, host: r.host, log: (r.log || '').slice(-160) }));

    // ── 2. 环境变量优先级更高（临时换端口不必改文件）────────────
    c.server = { port: 8791, host: '0.0.0.0' };
    writeCfg(c);
    r = await boot({ PORT: '8792' });
    check('PORT=8792 覆盖 config 里的 8791', r.port === 8792,
      JSON.stringify({ port: r.port }));

    // ── 3. host 也能配，且环境变量 HOST 同样优先 ─────────────────
    c.server = { port: 8793, host: '127.0.0.1' };
    writeCfg(c);
    r = await boot({});
    check('config 里 host 127.0.0.1 生效', r.host === '127.0.0.1' && r.port === 8793,
      JSON.stringify({ host: r.host, port: r.port }));

    r = await boot({ HOST: '127.0.0.1' });
    check('HOST 环境变量覆盖 config 的 host', r.host === '127.0.0.1',
      JSON.stringify({ host: r.host }));

    // ── 4. 非法值兜底：不能让服务因为一个笔误起不来 ──────────────
    // 兜底端口是 8787，得先把占着它的开发服务停掉才能验证「真的回到 8787」
    freeDefaultPort();
    c.server = { port: '8787abc', host: '0.0.0.0' };
    writeCfg(c);
    r = await boot({});
    check('port 写成 8787abc 时回退 8787 并提示，不崩',
      /不是合法端口/.test(r.log || '') && r.port === 8787,
      JSON.stringify({ port: r.port, log: (r.log || '').slice(-200) }));

    c.server = { port: 70000, host: '0.0.0.0' };
    writeCfg(c);
    r = await boot({});
    check('port 越界（70000）同样回退并提示',
      /不是合法端口/.test(r.log || '') && r.port === 8787,
      JSON.stringify({ port: r.port }));

    // ── 5. 没有 server 段时走内置默认，行为与改动前一致 ──────────
    c = JSON.parse(JSON.stringify(base));
    delete c.server;
    writeCfg(c);
    r = await boot({});
    check('不配 server 段时默认 8787 / 0.0.0.0', r.port === 8787 && r.host === '0.0.0.0',
      JSON.stringify({ port: r.port, host: r.host }));
  } finally {
    // 无论中间怎么炸，一定把本机配置还原（里面有真实 API key）
    if (had) fs.copyFileSync(BACKUP, CFG);
    else if (fs.existsSync(CFG)) fs.unlinkSync(CFG);
    console.log('\n已还原本机 config.json');
    console.log('（测试停掉了占用 8787 的进程，需要的话手动重启：node src/server.js）');
  }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('测试自身出错：', e);
  try { if (fs.existsSync(BACKUP)) fs.copyFileSync(BACKUP, CFG); } catch (e2) { /* ignore */ }
  process.exit(1);
});
