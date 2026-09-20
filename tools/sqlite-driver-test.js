/* SQLite 驱动适配层测试
   存档只走 SQLite，但驱动有两条路：
     builtin —— Node 内置 node:sqlite（Node ≥22.5），零依赖
     wasm    —— npm 包 node-sqlite3-wasm，给 Node 太旧的机器兜底
   这里验证「同一个 store，换驱动结果不变」，以及两个都没有时报出可操作的错。
   store.js 是单例，所以每个驱动开一个子进程跑（tools/sqlite-driver-child.js）。
   用法：node tools/sqlite-driver-test.js */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const sqlite = require(path.join(__dirname, '..', 'sqlite.js'));

const ROOT = path.join(__dirname, '..');
const CHILD = path.join(__dirname, 'sqlite-driver-child.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-sqlite-'));

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}
function skipped(name, why) {
  skip++;
  console.log('  skip ' + name + '  -> ' + why);
}

function runChild(driver, dbFile) {
  const outFile = path.join(TMP, 'out-' + driver + '-' + Date.now() + Math.random().toString(36).slice(2, 7) + '.json');
  execFileSync(process.execPath, [CHILD, outFile], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MIMO_SQLITE_DRIVER: driver,
      MIMO_DB_FILE: dbFile,
    }),
    stdio: ['ignore', 'ignore', 'pipe'], // 子进程的日志不进管道，免得污染结果
  });
  const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.unlinkSync(outFile);
  return res;
}

/* 一个驱动跑完后的全部断言 */
function assertDriver(driver, res) {
  const s = res.steps.stats || {};
  check(driver + '：store 建库成功', res.enabled === true && s.enabled === true, JSON.stringify(s));
  check(driver + '：驱动名正确', s.driver === driver, String(s.driver));

  const n = res.steps.narrator || {};
  check(driver + '：解说写入并返回 true', n.write === true, String(n.write));
  check(driver + '：解说文本往返一致', n.text === '驱动往返测试', String(n.text));
  check(driver + '：教学段落往返一致', n.lesson === '两个驱动行为必须一致', String(n.lesson));
  check(driver + '：ctx 里的 JSON 往返一致', n.ctxStep === 12, String(n.ctxStep));
  check(driver + '：aiState 往返一致', n.aiState === 'ok', String(n.aiState));
  check(driver + '：meta 里的非 feed 字段保留', n.prevKept === 1, String(n.prevKept));

  const sr = res.steps.search || [];
  check(driver + '：解说全文检索命中', sr.length === 1 && sr[0] === 'drv-1', JSON.stringify(sr));

  const se = res.steps.series || {};
  check(driver + '：series 写入 6 行', se.written === 6, String(se.written));
  check(driver + '：series 查询 3 行', se.rows === 3, String(se.rows));
  check(driver + '：NULL 不被填 0', se.nullKept === true, String(se.nullKept));
  check(driver + '：0 不被当成 NULL 丢掉', se.zeroKept === true, String(se.zeroKept));
  check(driver + '：wall 时间写入', se.wall === 10.5, String(se.wall));
  check(driver + '：latestStep 取到最新步', se.latest === 3, String(se.latest));

  const tm = res.steps.tagmeta || {};
  check(driver + '：tag_meta 写入并可检索', tm.all === 2, String(tm.all));
  check(driver + '：pinned 指标能被检索到', tm.pinnedHits === 1, String(tm.pinnedHits));

  const me = res.steps.metrics || {};
  check(driver + '：metrics 落库', me.written === 1 && me.rows === 1, JSON.stringify(me));
  check(driver + '：restarts=0 不丢（0 与 NULL 有别）', me.restartsZero === true, String(me.restartsZero));

  const be = res.steps.bench || {};
  check(driver + '：bench 写入 2 行（含一条 NULL）', be.rows === 2, String(be.rows));

  const rs = res.steps.runstate || {};
  check(driver + '：run_state 覆盖写入', rs.rows === 1, String(rs.rows));
  check(driver + '：run_state 里 0 值保留', rs.restarts === 0, String(rs.restarts));

  check(driver + '：checkpoint 不报错', 'checkpoint' in res.steps &&
    !(res.steps.checkpoint || {}).error, JSON.stringify(res.steps.checkpoint));
}

(async function main() {
  console.log('SQLite 驱动适配层测试（' + process.version + '）\n');
  const probe = sqlite.probe();
  console.log('— 本机可用驱动 —');
  console.log('  builtin（内置 node:sqlite）：' + (probe.builtin ? '有' : '没有'));
  console.log('  wasm（' + sqlite.WASM_PKG + '）：' + (probe.wasm ? '有' : '没有'));
  probe.errors.forEach(function (e) { console.log('    · ' + e.name + '：' + e.error); });
  check('至少一个驱动可用', probe.builtin || probe.wasm, JSON.stringify(probe));

  ['builtin', 'wasm'].forEach(function (driver) {
    console.log('\n— 驱动 ' + driver + ' —');
    if (!probe[driver]) {
      skipped(driver + ' 全部用例', driver === 'wasm'
        ? '本机没装 ' + sqlite.WASM_PKG + '（npm install 装上就能跑这些用例）'
        : '本机 Node 没有内置 node:sqlite（<22.5）');
      return;
    }
    const dbFile = path.join(TMP, driver + '.db');
    let res = null;
    try {
      res = runChild(driver, dbFile);
    } catch (e) {
      check(driver + '：子进程跑通', false, String(e.message).slice(0, 300));
      return;
    }
    assertDriver(driver, res);
  });

  /* 换驱动读同一个库：wasm 写的库 builtin 要能读出来（SQLite 文件格式是通用的） */
  console.log('\n— 跨驱动读同一个库 —');
  if (probe.builtin && probe.wasm) {
    const shared = path.join(TMP, 'shared.db');
    runChild('wasm', shared);
    const byBuiltin = runChild('builtin', shared);
    check('wasm 写入的库，builtin 能读回来',
      (byBuiltin.steps.narrator || {}).text === '驱动往返测试',
      JSON.stringify(byBuiltin.steps.narrator));
  } else {
    skipped('跨驱动读同一个库', '两个驱动没同时可用');
  }

  /* WAL 残留的自救：wasm 的 VFS 不支持 WAL，遇到「新 Node 跑过/被强杀」留下的
     WAL 库必须能自己降级打开，而不是抛一句看不懂的 unable to open database file */
  console.log('\n— WAL 库的自救（wasm 驱动）—');
  if (probe.builtin && probe.wasm) {
    const db = path.join(TMP, 'wal.db');
    const script = [
      "process.env.MIMO_SQLITE_DRIVER='builtin';",
      "const sql = require(" + JSON.stringify(path.join(__dirname, '..', 'sqlite.js')) + ");",
      "const h = sql.open(" + JSON.stringify(db) + ");",
      "h.db.exec('PRAGMA journal_mode = WAL');",
      "h.db.exec('CREATE TABLE IF NOT EXISTS t (a INTEGER)');",
      "h.db.prepare('INSERT INTO t VALUES (?)').run(7);",
      "process.exit(0);", // 强退：留下 -wal / -shm，模拟进程被杀
    ].join('\n');
    execFileSync(process.execPath, ['-e', script], { stdio: 'ignore' });
    check('造出了带 WAL 的库', fs.existsSync(db + '-wal'), db);

    process.env.MIMO_SQLITE_DRIVER = 'wasm';
    let h = null;
    let openErr = null;
    try { h = sqlite.open(db); } catch (e) { openErr = e.message; }
    process.env.MIMO_SQLITE_DRIVER = '';
    check('wasm 能打开它（自动降级为普通模式）', !!h, String(openErr));
    if (h) {
      let ping = null;
      try { ping = h.db.prepare('SELECT 1 AS ok').get(); } catch (e) { ping = { error: e.message }; }
      check('降级后能正常执行语句', ping && ping.ok === 1, JSON.stringify(ping));
      h.close();
    }
    check('WAL 原文件被保留（可手工抢救）',
      fs.readdirSync(TMP).some((f) => f.indexOf('-wal.stale-') >= 0),
      fs.readdirSync(TMP).join(','));
  } else {
    skipped('WAL 库的自救', '两个驱动没同时可用');
  }

  /* 两个驱动都没有：必须给出可操作的报错，而不是悄悄退回别的存储 */
  console.log('\n— 两个驱动都不可用 —');
  const dbFile = path.join(TMP, 'none.db');
  const outFile = path.join(TMP, 'out-none.json');
  let err = '';
  let res = null;
  try {
    // stderr 留着：驱动不可用时的报错就打在那儿
    execFileSync(process.execPath, [CHILD, outFile], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { MIMO_SQLITE_DRIVER: 'none', MIMO_DB_FILE: dbFile }),
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    err = String((e && e.stderr) || '');
  }
  try { res = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* 下面统一处理 */ }

  const logs = err + String((res && res.error) || '');
  check('报错里给了两条路：升 Node / npm install',
    /22\.5/.test(logs) && logs.indexOf(sqlite.WASM_PKG) >= 0, logs.slice(0, 200));
  check('没有生成任何存档文件（不悄悄退回 JSON）',
    !fs.existsSync(dbFile) && !fs.existsSync(path.join(TMP, 'narrator.json')), dbFile);
  check('驱动不可用时服务照常跑（store.enabled=false）',
    !!res && res.enabled === false, JSON.stringify(res && res.enabled));
  check('stats() 带出失败原因', !!res && !!res.steps.stats &&
    res.steps.stats.enabled === false && typeof res.steps.stats.reason === 'string',
    JSON.stringify(res && res.steps.stats));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n' + pass + ' 项通过，' + fail + ' 项失败' + (skip ? '，' + skip + ' 项跳过' : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
