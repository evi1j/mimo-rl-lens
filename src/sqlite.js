'use strict';
/* SQLite 驱动适配层 —— 存档只走 SQLite，不再退回 JSON
 *
 * 两条路，按顺序试：
 *   1) builtin  Node 内置的 node:sqlite（Node ≥22.5；22.5~22.12 之间还要
 *               加 --experimental-sqlite 参数）。零依赖，首选。
 *   2) wasm     npm 包 node-sqlite3-wasm：纯 WebAssembly，不用编译原生模块，
 *               也不需要 Python / Xcode / MSVC 那一套。给 Node 太旧的机器兜底，
 *               部署机上要先 npm install（本仓库把它列为 optionalDependencies）。
 *
 * 两个驱动的 API 不一样，这一层负责抹平：
 *   - 绑定参数：node:sqlite 收变参 run(a,b,c)；wasm 版收「一个」values（数组/对象）
 *   - 语句生命周期：wasm 版必须手动 finalize，否则内存泄漏。这里每次调用后自动收，
 *     下次调用再重新 prepare —— 调用方照旧可以拿住一个 stmt 反复 run。
 *   - 空结果：node:sqlite 的 get() 没命中返回 undefined，wasm 返回 null，统一成 null
 *   - WAL：wasm 的 VFS 不支持 WAL，PRAGMA 会被忽略。不影响正确性，只是少点并发优化
 *
 * 对外形状跟 node:sqlite 一致：db.exec(sql) / db.prepare(sql).{run,get,all}(变参)
 *
 * 测试时可强制指定驱动：MIMO_SQLITE_DRIVER=builtin | wasm | none
 */

const WASM_PKG = 'node-sqlite3-wasm';

const fs = require('fs');

/* 用时再读，方便测试里改环境变量切驱动 */
function forced() {
  return String(process.env.MIMO_SQLITE_DRIVER || '').trim().toLowerCase();
}

/* undefined 统一成 null：SQLite 只认 NULL，两个驱动对 undefined 的态度不一样 */
function norm(args) {
  return args.map(function (v) { return v === undefined ? null : v; });
}

function tryBuiltin() {
  try {
    const m = require('node:sqlite');
    if (m && typeof m.DatabaseSync === 'function') return { name: 'builtin', Ctor: m.DatabaseSync };
    return { name: 'builtin', error: 'node:sqlite 里没有 DatabaseSync' };
  } catch (e) {
    return { name: 'builtin', error: e.message };
  }
}

function tryWasm() {
  try {
    const m = require(WASM_PKG);
    if (m && typeof m.Database === 'function') return { name: 'wasm', Ctor: m.Database };
    return { name: 'wasm', error: '包里没有 Database' };
  } catch (e) {
    return { name: 'wasm', error: '未安装（npm install ' + WASM_PKG + '）：' + e.message };
  }
}

function hint(errs) {
  return '没有可用的 SQLite 驱动，存档不可用。两条路选一条：\n' +
    '  1) 把 Node 升到 22.5 以上 —— 内置 node:sqlite，什么都不用装（推荐）\n' +
    '  2) 在本目录执行：npm install ' + WASM_PKG + '\n' +
    '  （wasm 兜底包是纯 WebAssembly，不需要编译环境）\n' +
    '当前 Node：' + process.version + '\n' +
    errs.map(function (e) { return '  · ' + e.name + '：' + e.error; }).join('\n');
}

/* 选驱动。FORCE='none' 用于测试「两个都没有」时的报错 */
function pick() {
  const force = forced();
  if (force === 'none') throw new Error(hint([]));
  const order = force === 'wasm' ? [tryWasm, tryBuiltin] : [tryBuiltin, tryWasm];
  const errs = [];
  for (const fn of order) {
    const r = fn();
    if (r && r.Ctor) return r;
    errs.push(r);
  }
  throw new Error(hint(errs));
}

/* 探测本机有哪些驱动可用（测试/启动提示用，不建库） */
function probe() {
  const out = { builtin: false, wasm: false, errors: [] };
  [tryBuiltin, tryWasm].forEach(function (fn) {
    const r = fn();
    if (r && r.Ctor) out[r.name] = true;
    else out.errors.push({ name: r.name, error: r.error });
  });
  return out;
}

/* node:sqlite 的包装：参数变参照旧，只是把 undefined 换成 null、空结果统一成 null */
function wrapBuiltin(raw) {
  return {
    exec: function (sql) { raw.exec(sql); },
    prepare: function (sql) {
      const st = raw.prepare(sql);
      return {
        run: function () { return st.run.apply(st, norm([].slice.call(arguments))); },
        get: function () {
          const r = st.get.apply(st, norm([].slice.call(arguments)));
          return r === undefined ? null : r;
        },
        all: function () { return st.all.apply(st, norm([].slice.call(arguments))); },
      };
    },
    close: function () { try { raw.close(); } catch (e) { /* 进程结束即释放 */ } },
  };
}

/* wasm 的包装：每次调用自动 finalize，参数打包成数组 */
function wrapWasm(raw) {
  return {
    exec: function (sql) { raw.exec(sql); },
    prepare: function (sql) {
      let st = null;
      const ensure = function () { if (!st) st = raw.prepare(sql); return st; };
      const fin = function () { if (st) { try { st.finalize(); } catch (e) { /* ignore */ } st = null; } };
      return {
        run: function () {
          const s = ensure();
          try { return s.run(norm([].slice.call(arguments))); } finally { fin(); }
        },
        get: function () {
          const s = ensure();
          try { const r = s.get(norm([].slice.call(arguments))); return r || null; } finally { fin(); }
        },
        all: function () {
          const s = ensure();
          try { return s.all(norm([].slice.call(arguments))); } finally { fin(); }
        },
      };
    },
    close: function () { try { raw.close(); } catch (e) { /* ignore */ } },
  };
}

/* wasm 的 VFS 不支持 WAL：库旁边只要留着 -wal / -shm（比如进程被强杀、
   或者 data 目录是从一台新 Node 的机器上拷过来的），它就报
   "unable to open database file"，完全打不开。
   这时候把残留挪走再试一次：主库文件本身是完整的，只是丢了 WAL 里
   还没 checkpoint 的少量新写入 —— 总比整个存档不可用强。
   挪走的文件留着不删，想手工抢救还有得捞。 */
/* 光挪走 -wal 还不够：库文件头里记着「我是 WAL 模式」（第 18/19 字节 = 2），
   wasm 的 VFS 见了这个头就拒绝打开。把这两个字节改回 1（普通 rollback 模式）：
   主库文件本身始终是自洽的（WAL 里只是更新的那几步），所以降级能开，
   代价是丢掉 WAL 里没 checkpoint 的少量新写入 —— 那些文件已经另存，可手工抢救。 */
function demoteWalHeader(file) {
  try {
    const fd = fs.openSync(file, 'r+');
    try {
      const buf = Buffer.alloc(2);
      fs.readSync(fd, buf, 0, 2, 18);
      if (buf[0] !== 2 && buf[1] !== 2) return false; // 本来就不是 WAL 模式
      buf[0] = 1;
      buf[1] = 1;
      fs.writeSync(fd, buf, 0, 2, 18);
      return true;
    } finally { fs.closeSync(fd); }
  } catch (e) { return false; }
}

function moveWalAside(file) {
  let moved = 0;
  ['-wal', '-shm'].forEach(function (suffix) {
    const p = file + suffix;
    if (!fs.existsSync(p)) return;
    try {
      fs.renameSync(p, p + '.stale-' + Date.now());
      moved++;
    } catch (e) { /* 挪不动就算了，下面还会原样报错 */ }
  });
  return moved;
}

/* wasm 驱动是「懒打开」：new Database(file) 永远不报错，真正的问题要等到
   第一次 prepare 才冒出来（比如库边上有 WAL 残留时）。所以开库后先跑一句，
   把失败提前到 open() 里，好让下面的兜底逻辑接得住。 */
function ping(raw) {
  const st = raw.prepare('SELECT 1');
  try { st.get(); } finally { if (typeof st.finalize === 'function') st.finalize(); }
}

/* 打开（必要时创建）一个库文件。两个驱动都不可用时抛错，错误信息里带解决办法 */
function open(file) {
  const d = pick();
  const build = function () {
    const raw = new d.Ctor(file);
    try {
      ping(raw);
    } catch (e) {
      try { raw.close(); } catch (e2) { /* ignore */ }
      throw e;
    }
    return raw;
  };
  let raw = null;
  try {
    raw = build();
  } catch (e) {
    if (d.name !== 'wasm') throw new Error('打不开库文件 ' + file + '（' + (e && e.message || e) + '）');
    // wasm 的 VFS 不支持 WAL：先把 -wal/-shm 另存，再把库头降级成普通模式
    const moved = moveWalAside(file);
    const demoted = demoteWalHeader(file);
    if (!moved && !demoted) throw new Error('打不开库文件 ' + file + '（' + (e && e.message || e) + '）');
    console.warn('sqlite: 这个库是 WAL 模式（多半是用新 Node 跑过、或进程被强杀留下的），' +
      'wasm 驱动读不了 —— 已降级为普通模式，WAL 文件另存为 ' + file + '-wal.stale-*，' +
      '最近少量写入可能丢失');
    raw = build();
  }
  return {
    driver: d.name,
    db: d.name === 'wasm' ? wrapWasm(raw) : wrapBuiltin(raw),
    close: function () { try { raw.close(); } catch (e) { /* ignore */ } },
  };
}

module.exports = { open, pick, probe, WASM_PKG };
