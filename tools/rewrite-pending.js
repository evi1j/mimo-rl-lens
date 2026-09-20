/* 把库里 ai_state='pending' 的解说条目批量交给 AI 重写。
   用处：改了解说风格/提示词后，让历史条目也用新风格重说一遍。
   注意：改完需要重启看板服务，服务才会重新从库里读到新内容。
   用法：node tools/rewrite-pending.js [最多处理几条] */
const path = require('path');
const sqlite = require('../sqlite.js'); // 驱动适配：内置 node:sqlite 或 wasm 兜底
const llm = require('../llm.js');

const DB_PATH = path.join(__dirname, '..', 'data', 'board.db');
const LIMIT = Number(process.argv[2]) || 20;

const db = sqlite.open(DB_PATH).db;
const rows = db.prepare("SELECT * FROM narrator WHERE ai_state='pending' ORDER BY ts DESC LIMIT ?").all(LIMIT);
console.log('待重写条目:', rows.length);

(async () => {
  let ok = 0, fail = 0;
  for (const r of rows) {
    let ctx = null;
    try { ctx = r.ctx ? JSON.parse(r.ctx) : null; } catch (e) { ctx = null; }
    const ev = { level: r.level, run: r.run, official: !!r.official, text: r.text, why: r.why, ctx: ctx };
    console.log('\n处理: ' + String(r.text).slice(0, 45));
    const out = await llm.narrate(ev, null);
    if (!out) {
      db.prepare("UPDATE narrator SET ai_state='skipped', ai_error=? WHERE id=?")
        .run(String(llm.status.lastError || '未知').slice(0, 150), r.id);
      console.log('  失败: ' + String(llm.status.lastError || '').slice(0, 90));
      fail++;
      continue;
    }
    db.prepare('UPDATE narrator SET text=?, why=?, lesson=?, ai=1, ai_state=?, ai_model=? WHERE id=?')
      .run(out.text, out.why, out.lesson, 'done', out.model, r.id);
    console.log('  成功 -> ' + String(out.lesson || '').slice(0, 100).replace(/\n/g, ' '));
    ok++;
  }
  console.log('\n完成：成功 ' + ok + ' 条，失败 ' + fail + ' 条');
  db.close();
})();
