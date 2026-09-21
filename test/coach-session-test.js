/* 教练的会话管理与上下文压缩
   1) 会话：sid 隔离（各存各的消息与摘要）、切换、清空、删除
   2) 上下文：会话内的内容全传（不再只带 8 条），token 估算与水位
   3) 主动压缩：到水位线就压一次摘要，下一轮发「摘要 + 之后的原文」，
      而消息原文原封不动留在库里（界面显示的还是完整对话）
   模型调用全部在本文件里 mock 掉 —— 这里要测的是「什么时候压、压完发什么」，
   不是模型压得好不好。临时库，不碰真实对话。
   用法：node test/coach-session-test.js */
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = path.join(os.tmpdir(), 'mtl-coach-sess-' + process.pid + '.db');
process.env.MIMO_DB_FILE = tmp;
const store = require(path.join(__dirname, '..', 'src', 'store.js'));
const session = require(path.join(__dirname, '..', 'src', 'session.js'));
const coach = require(path.join(__dirname, '..', 'src', 'coach.js'));
const llm = require(path.join(__dirname, '..', 'src', 'llm.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/* 把模型调用换成假的实现：压缩要跑，但不能真去烧 token。
   session.js 调的是 llm.xxx（取属性发生在调用那一刻），所以这里换掉即可。
   cfg 也一并换成小窗口 —— 这样「装不下」的场景不用造几万字。 */
const realCfg = llm.loadConfig();
let summaryReply = '';
let summaryCalls = 0;
function mockModel(opts) {
  const c = Object.assign({}, realCfg, opts || {}, { enabled: true });
  llm.loadConfig = function () { return c; };
  llm.resolveModel = async function () { return 'mock-model'; };
  llm.request = async function (cfg, method, urlPath, body) {
    summaryCalls++;
    lastCompressBody = body;
    return { choices: [{ message: { content: '<think>先理一遍</think>' + summaryReply } }] };
  };
}
let lastCompressBody = null;
function unmockModel() {
  llm.loadConfig = function () { return realCfg; };
  delete llm.resolveModel;
  delete llm.request;
}

const SID = 's-test-1';

console.log('\n=== token 估算（没有分词器，只能估） ===');
check('空文本是 0', session.estTokens('') === 0);
check('中文大约 1 字 1 token', session.estTokens('你好') === 2, String(session.estTokens('你好')));
check('英文按 3.6 字 1 token 折算', session.estTokens('abcd') === 2, String(session.estTokens('abcd')));
check('同样的字数，中文比英文费 token',
  session.estTokens('你好世界') > session.estTokens('abcd'));
check('一组消息要算上每条的角色开销',
  session.estMsgs([{ content: '你好' }, { content: '你好' }]) === 2 + 4 + 2 + 4,
  String(session.estMsgs([{ content: '你好' }])));

console.log('\n=== 窗口与水位线 ===');
const k = session.ctxConfig({});
check('默认窗口 32768', k.window === 32768, String(k.window));
check('水位线是窗口的 75%', k.trigger === Math.round(32768 * 0.75), String(k.trigger));
check('预留里含本轮生成与工具返回（不在 history 里，但同样占窗口）', k.reserve > 4000, String(k.reserve));
check('窗口可以配', session.ctxConfig({ coachContextWindow: 8000 }).window === 8000);
check('水位比例可以配',
  session.ctxConfig({ coachContextWindow: 8000, coachCompressAt: 0.6 }).trigger === 4800,
  String(session.ctxConfig({ coachContextWindow: 8000, coachCompressAt: 0.6 }).trigger));
check('水位比例写错（>1 或 0）时回落默认，不会变成「永不压缩」',
  session.ctxConfig({ coachCompressAt: 1.5 }).trigger === Math.round(32768 * 0.75) &&
  session.ctxConfig({ coachCompressAt: 0 }).trigger === Math.round(32768 * 0.75));

const small = session.measure({
  systemText: '系统提示词', summary: '', history: [{ content: '你好' }], questionText: '训练到第几步',
}, {});
check('短对话远不到水位线', small.over === false, JSON.stringify(small));
check('给前端的百分比按整个窗口算', small.pct > 0 && small.pct < 100, String(small.pct));

const bigHist = [];
for (let i = 0; i < 200; i++) bigHist.push({ content: '第 ' + i + ' 轮的问答内容，'.repeat(20) });
const bigSt = session.measure({
  systemText: '系'.repeat(2000), summary: '', history: bigHist, questionText: '问题',
}, {});
check('长对话会越过水位线', bigSt.over === true, JSON.stringify(bigSt));
check('越过水位线就是要压了', session.needsCompress(bigSt, {}) === true);

console.log('\n=== 按预算挑历史：能装下就全装 ===');
const h10 = [];
for (let i = 0; i < 10; i++) h10.push({ role: 'user', content: '第 ' + i + ' 条' });
const fitAll = session.fitHistory(h10, 100000);
check('装得下时一条不丢', fitAll.dropped === 0 && fitAll.kept.length === 10);
const fitTiny = session.fitHistory(h10, 30);
check('装不下时丢的是最旧的，留下最近的',
  fitTiny.dropped > 0 && /第 9 条/.test(fitTiny.kept[fitTiny.kept.length - 1].content),
  JSON.stringify(fitTiny.kept.map(function (m) { return m.content; })));
check('再小的预算也至少留一条（最近的）', fitTiny.kept.length >= 1);
check('丢掉的条数算得对', fitTiny.dropped === 10 - fitTiny.kept.length);

console.log('\n=== 组消息：会话内的内容全传 ===');
const many = [];
for (let i = 0; i < 20; i++) many.push({ role: i % 2 ? 'assistant' : 'user', content: '内容' + i });
const plan = coach.buildPlan({ question: '训练到第几步了', history: many });
check('20 条历史一条不少（不再截到 8 条）',
  plan.msgs.length === 1 + 20 + 1, '共 ' + plan.msgs.length + ' 条');
check('system 在最前、本轮问题在最后',
  plan.msgs[0].role === 'system' && plan.msgs[plan.msgs.length - 1].role === 'user');
check('水位里记着这一轮带了几条', plan.stats.history > 0 && plan.msgs.length === 22);
const planNoSum = coach.buildPlan({ question: 'q', history: [] });
check('没有摘要时 system 就是原始提示词（不带摘要标记）',
  planNoSum.msgs[0].content === coach.COACH_SYSTEM);

console.log('\n=== 摘要注入 ===');
const planSum = coach.buildPlan({ question: 'q', history: many, summary: '更早聊过熵坍缩' });
check('摘要挂在 system 里，不占一条对话消息',
  planSum.msgs[0].role === 'system' && planSum.msgs.length === 22 &&
  /更早聊过熵坍缩/.test(planSum.msgs[0].content));
check('摘要前后有明确标记（模型知道那不是它说过的话）',
  /\[更早对话的摘要/.test(planSum.msgs[0].content) && /\[摘要结束\]/.test(planSum.msgs[0].content));
check('提醒它别直接引用摘要里的旧数字',
  /重新查/.test(planSum.msgs[0].content));
check('摘要也计入水位', planSum.stats.summary > 0, String(planSum.stats.summary));
check('摘要更长时水位更高',
  coach.buildPlan({ question: 'q', history: many, summary: '摘'.repeat(2000) }).stats.used >
  planSum.stats.used);

console.log('\n=== 单条超长：掐头去尾，不是硬砍 ===');
const clipped = coach.clipMsg('前'.repeat(9000) + '尾巴');
check('裁到上限以内', clipped.length <= coach.COACH_MSG_MAX_CHARS + 24, String(clipped.length));
check('头尾都留着（结论常在开头，数据常在结尾）',
  /^前{10}/.test(clipped) && /尾巴$/.test(clipped));
check('中间有省略标记', /省略/.test(clipped));
check('没超上限的原文原样返回', coach.clipMsg('短') === '短');
const planClip = coach.buildPlan({ question: 'q', history: [{ role: 'user', content: 'x'.repeat(20000) }] });
check('超长的单条进 messages 前已被裁过',
  planClip.msgs[1].content.length < 20000, String(planClip.msgs[1].content.length));

console.log('\n=== 会话：sid 把对话隔开 ===');
check('存档可用', store.enabled === true, store.reason || '');
const other = 's-test-2';
store.ensureCoachSession(SID, '熵的问题');
store.ensureCoachSession(other, '评测的问题');
for (let i = 0; i < 4; i++) {
  store.saveCoachMsg(i % 2 ? 'assistant' : 'user', SID + ' 的第 ' + i + ' 条', SID);
}
store.saveCoachMsg('user', '另一段的话', other);
check('按 sid 取到自己的消息',
  store.coachHistory(SID, 50).length === 4 && store.coachHistory(other, 50).length === 1,
  store.coachHistory(SID, 50).length + ' / ' + store.coachHistory(other, 50).length);
check('不会串到别的会话',
  store.coachHistory(other, 50).every(function (m) { return m.content.indexOf(SID) < 0; }));
check('消息带 id（摘要要记「压到哪一条为止」）',
  typeof store.coachHistory(SID, 1)[0].id === 'number');
check('会话列表带条数',
  store.coachSessions(10).filter(function (s) { return s.sid === SID; })[0].msgs === 4);
check('清空只清这一段',
  store.clearCoachMsg(SID) === true && store.coachHistory(SID, 50).length === 0 &&
  store.coachHistory(other, 50).length === 1);

console.log('\n=== 压缩：到水位就压，压的是「发给模型的那份」 ===');
mockModel({ coachContextWindow: 8000, coachCompressAt: 0.75, coachKeepMsgs: 2 });
const SID2 = 's-compress';
store.ensureCoachSession(SID2, '长对话');
for (let i = 0; i < 10; i++) store.saveCoachMsg('user', '第 ' + i + ' 个问题：' + '内'.repeat(300), SID2);

const before = session.prepareTurn({ sid: SID2, questionText: '接着问', systemText: '系统' });
check('压之前：10 条原文全在', before.history.length === 10, before.history.length + ' 条');
check('压之前：水位已过线（该压了）', before.stats.over === true, JSON.stringify(before.stats));
check('还没压过', before.stats.compressed === 0);

summaryReply = '摘要：问过第 0~7 个问题。';
(async function () {
  const r = await session.compressSession(SID2);
  check('压成功了', r && r.ok === true, JSON.stringify(r));
  check('模型收到的是原文（不是已经压过的摘要）',
    !!lastCompressBody && /第 0 个问题/.test(JSON.stringify(lastCompressBody.messages)));
  check('思考标签被剥掉了（摘要正文里不该有 <think>）',
    r.summary.indexOf('<think>') < 0 && /^摘要/.test(r.summary), r.summary);
  check('最近 2 条留作原文，压的是前面的 8 条', r.msgs === 8 && r.kept === 2,
    '压 ' + r.msgs + ' 留 ' + r.kept);
  check('压完 token 明显下降', r.after < r.before, r.before + ' → ' + r.after);

  const after = session.prepareTurn({ sid: SID2, questionText: '接着问', systemText: '系统' });
  check('下一轮发的是「摘要 + 之后的原文」',
    after.history.length === 2 && !!after.summary && /^摘要/.test(after.summary),
    after.history.length + ' 条 + 摘要 ' + (after.summary || '').slice(0, 12));
  check('下一轮的水位降下来了', after.stats.used < before.stats.used,
    before.stats.used + ' → ' + after.stats.used);
  check('压过一次会被记着', after.stats.compressed === 1, String(after.stats.compressed));
  check('原文一条没少（界面显示的还是完整对话）',
    store.coachHistory(SID2, 200).length === 10, store.coachHistory(SID2, 200).length + ' 条');
  check('记下了「压到哪一条为止」', after.summaryUpto > 0, String(after.summaryUpto));

  /* 第二轮压缩：旧摘要要并进去，不能丢 */
  for (let i = 10; i < 18; i++) store.saveCoachMsg('user', '第 ' + i + ' 个问题：' + '内'.repeat(300), SID2);
  summaryReply = '摘要：问过第 0~15 个问题。';
  summaryCalls = 0;
  const r2 = await session.compressSession(SID2);
  check('再压一次照样成功（摘要是滚动累积的）', r2 && r2.ok === true, JSON.stringify(r2));
  check('旧摘要作为输入一起给了模型（否则旧内容就永久丢了）',
    !!lastCompressBody && /问过第 0~7 个问题/.test(JSON.stringify(lastCompressBody.messages)));
  check('压缩次数累加', store.getCoachSession(SID2).compressCnt === 2,
    String(store.getCoachSession(SID2).compressCnt));

  console.log('\n=== 压缩的边界 ===');
  const few = 's-few';
  store.ensureCoachSession(few, '短对话');
  store.saveCoachMsg('user', '只有一条', few);
  const r3 = await session.compressSession(few);
  check('消息太少时不压（压了没意义，还白花一次调用）',
    r3.ok === false && r3.why === 'too-few', JSON.stringify(r3));
  const off = llm.loadConfig;
  llm.loadConfig = function () { return Object.assign({}, realCfg, { enabled: false }); };
  const r4 = await session.compressSession(SID2);
  check('AI 没启用时不压，也不报错', r4.ok === false && r4.why === 'ai-disabled', JSON.stringify(r4));
  llm.loadConfig = off;

  summaryReply = '';
  // 上一步已经压到只剩 2 条未压的消息，正好等于「保留条数」—— 再添几条才有可压的
  for (let i = 18; i < 22; i++) store.saveCoachMsg('user', '第 ' + i + ' 个问题：' + '内'.repeat(300), SID2);
  const r5 = await session.compressSession(SID2);
  check('模型返回空时不写摘要（空摘要比没摘要更糟）',
    r5.ok === false && r5.why === 'empty', JSON.stringify(r5));
  summaryReply = '摘要：问过第 0~7 个问题。';

  console.log('\n=== 收尾后的后台压缩 ===');
  const bg = 's-bg';
  store.ensureCoachSession(bg, '后台');
  for (let i = 0; i < 10; i++) store.saveCoachMsg('user', '第 ' + i + ' 个：' + '内'.repeat(300), bg);
  const p = session.scheduleCompress(bg);
  check('过线了就会排一次压缩（不等它，所以返回的是 Promise）', !!p && typeof p.then === 'function');
  const rb = await p;
  check('后台那次压成了', rb && rb.ok === true, JSON.stringify(rb));
  const short = 's-bg-short';
  store.ensureCoachSession(short, '很短');
  store.saveCoachMsg('user', '一句话', short);
  /* 短会话换回默认窗口再判：8000 的小窗口下光预留就占掉一半，
     任何会话都会判成过线 —— 那是真的装不下，不是误判。 */
  mockModel({ coachContextWindow: 32768 });
  check('没过线就不压（不浪费调用）', session.scheduleCompress(short) === null);
  mockModel({ coachContextWindow: 8000, coachCompressAt: 0.75, coachKeepMsgs: 2 });

  console.log('\n=== 清空 / 删除会话 ===');
  store.clearCoachMsg(SID2);
  const cleared = store.getCoachSession(SID2);
  check('清空会连摘要一起清（摘要是这些消息的压缩版，留着就是脏数据）',
    !cleared.summary && cleared.summaryUpto === 0);
  check('删会话会连消息一起删',
    store.deleteCoachSession(bg) === true && store.coachHistory(bg, 50).length === 0 &&
    !store.getCoachSession(bg));

  console.log('\n=== 压缩提示词 ===');
  const cm = session.compressMessages('旧摘要', [
    { role: 'user', content: '熵现在多少' },
    { role: 'assistant', content: '1.02' },
  ], 1200);
  const cmText = JSON.stringify(cm);
  check('旧摘要作为输入带上了', /旧摘要/.test(cmText));
  check('每条消息的原文都在（它就是要读原文）', /熵现在多少/.test(cmText) && /1\.02/.test(cmText));
  check('标了是谁说的', /对方/.test(cmText) && /教练/.test(cmText));
  check('要求保留数字与指标名，不许改数', /照抄|不许四舍五入/.test(session.COMPRESS_SYSTEM));
  check('要求把旧摘要并进来', /并进来/.test(session.COMPRESS_SYSTEM));
  check('限定字数', /字数|字以内/.test(cmText) || /1200/.test(cmText));
  check('剥思考标签', session.stripThink('<think>想</think>正文') === '正文',
    session.stripThink('<think>想</think>正文'));

  unmockModel();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  [tmp, tmp + '-wal', tmp + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('测试异常:', e && e.stack);
  process.exit(1);
});
