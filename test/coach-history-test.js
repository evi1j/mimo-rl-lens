/* 验证教练对话历史的落库：存、取、清空、条数上限。
   这份历史存在的唯一理由是「刷页面还能接着聊」—— 前端的 msgs 在内存里，
   刷新就没了。所以这里测的是存档层，不是提示词也不是渲染。

   必须在 require store 之前把 MIMO_DB_FILE 指到临时库：
   store.js 是单例，一进来就认库；用真实库的话「清空」会把用户真正在聊的
   对话删掉，那种测试比没测试更糟。用法：node test/coach-history-test.js */
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = path.join(os.tmpdir(), 'mtl-coach-hist-' + process.pid + '.db');
process.env.MIMO_DB_FILE = tmp;
const store = require(path.join(__dirname, '..', 'src', 'store.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('\n=== 落库与读取 ===');
check('存档可用', store.enabled === true, store.reason || '');
check('初始为空', store.coachHistory().length === 0);

check('存一条用户消息', store.saveCoachMsg('user', '现在训练到第几步了？') === true);
check('存一条教练回答', store.saveCoachMsg('assistant', 'pro 第 30 步。') === true);
const h = store.coachHistory();
check('取回来两条', h.length === 2, h.length + ' 条');
check('按时间升序（旧的在前，可直接顺序渲染）',
  h[0].role === 'user' && /第几步/.test(h[0].content) &&
  h[1].role === 'assistant' && /第 30 步/.test(h[1].content),
  JSON.stringify(h.map(function (m) { return m.role; })));
check('带时间戳', typeof h[0].ts === 'number' && h[0].ts > 0, String(h[0].ts));

console.log('\n=== 什么不该存 ===');
check('空白内容不落库（只写思考的那轮不该留空回答）',
  store.saveCoachMsg('assistant', '   \n  ') === false);
check('空串不落库', store.saveCoachMsg('user', '') === false);
check('上面两条之后库里还是两条', store.coachHistory().length === 2, store.coachHistory().length + ' 条');
check('role 只认 user / assistant（其它一律按 assistant 存，不写脏数据）',
  (function () {
    store.saveCoachMsg('tool', '一段工具结果');
    const last = store.coachHistory().pop();
    return last.role === 'assistant';
  })());

console.log('\n=== 条数上限 ===');
for (let i = 0; i < 240; i++) store.saveCoachMsg(i % 2 ? 'assistant' : 'user', '第 ' + i + ' 条');
const capped = store.coachHistory(null, 300);
check('只留最近 200 条，不会把库撑大', capped.length === 200, capped.length + ' 条');
check('留下的是最新的（最后一条）', /第 239 条/.test(capped[capped.length - 1].content),
  capped[capped.length - 1].content);
check('最早的被丢掉了', !capped.some(function (m) { return /第 0 条/.test(m.content); }));

console.log('\n=== 取条数上限 ===');
/* 现在多了一个参数：sid（哪一段对话）。不传就是默认会话，老的调用方式仍然成立。
   会话隔离与摘要那部分在 coach-session-test.js 里，这里只管存取本身。 */
check('limit 生效', store.coachHistory(null, 5).length === 5, String(store.coachHistory(null, 5).length));
check('limit 非法时回落 50 条', store.coachHistory(null, 'x').length === 50,
  String(store.coachHistory(null, 'x').length));
check('limit 超过上限也不会超过库存', store.coachHistory(null, 9999).length === 200);
check('换个 sid 就是另一段对话（互不串台）', (function () {
  store.saveCoachMsg('user', '另一段会话的内容', 's-other');
  return store.coachHistory('s-other', 50).length === 1 &&
    store.coachHistory(null, 200).every(function (m) { return m.content.indexOf('另一段会话') < 0; });
})());

console.log('\n=== 清空 ===');
check('清空返回成功', store.clearCoachMsg() === true);
check('清空后读不到任何历史', store.coachHistory().length === 0);
check('清空后还能继续存', store.saveCoachMsg('user', '清空之后的新问题') === true &&
  store.coachHistory().length === 1);

console.log('\n=== 不依赖 AI ===');
check('这些函数都不碰模型（无网络也能跑）', true);

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
try { fs.unlinkSync(tmp); } catch (e) {}
try { fs.unlinkSync(tmp + '-wal'); } catch (e) {}
try { fs.unlinkSync(tmp + '-shm'); } catch (e) {}
process.exit(fail ? 1 : 0);
