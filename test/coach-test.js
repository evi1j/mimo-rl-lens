/* AI 训练教练（站点右下角悬浮球 + 对话抽屉）
   1) 后端：教练提示词的硬约束（必须查数据、不许编、六个工具）、工具集拆分
      （讲解仍只开放 4 个，教练开放 6 个）、历史截断与上下文注入、重试策略
   2) 路由：/api/coach 的参数校验（缺 question / 方法不对），这两种情况
      在校验阶段就返回，不会打到模型
   3) 前端：悬浮球与抽屉、发送一轮、流式渲染（含轻量排版与转义）、多轮追问
      带动历史、「参考当前页面」开关关掉后不再上报 context
   AI 流在这一层拦下造流，不碰真实模型、不烧 token。
   用法：node test/coach-test.js   （需 8787 上跑着服务） */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const vc = new VirtualConsole();
vc.on('jsdomError', function (e) { console.log('[jsdomError]', e && e.message); });

const DIR = path.join(__dirname, '..', 'public');
const BASE = process.env.BASE || 'http://127.0.0.1:8787/';
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* ================================================================
   一、后端：提示词、工具集、组装逻辑（纯本地，不起 jsdom）
   ================================================================ */
const coach = require('../src/coach.js');
const llm = require('../src/llm.js');

console.log('\n=== 教练提示词 ===');
const S = coach.COACH_SYSTEM;
check('点明身份是训练教练', /AI 教练/.test(S));
check('要求「数字必须来自工具」', /必须来自工具返回/.test(S));
check('禁止凭印象编造', /绝不凭印象编|绝不能编造/.test(S));
check('引用指标名前要先确认存在', /list_metrics/.test(S) && /确认它/.test(S));
check('要求先查数据再回答（数据类问题）', /就先查数据再回答/.test(S));
check('概念题可以不查（auto 的提示词侧配合）', /纯概念问题/.test(S));
check('要求术语照用并当场解释', /术语照用/.test(S) && /当场解释/.test(S));
check('禁止生活比喻代替解释', /禁止用/.test(S) && /比喻/.test(S));
check('给出排版约定，包含空行分段与列表',
  /空行分段/.test(S) && /行首「- 」做列表项/.test(S));
check('排版约定放开了表格，并规定「首尾竖线 + 表头下一行分隔行」的写法',
  /\| --- \| --- \|/.test(S) && /首尾都要竖线/.test(S) && /列控制在 4 列以内/.test(S));
check('排版约定允许代码块，并规定 ``` 必须单独成行',
  /```bash/.test(S) && /开头和结尾的 ``` 必须单独成行/.test(S));
check('表格之外的结构仍然禁用（一级标题 / 其他 markdown）',
  /不要用 # 一级标题/.test(S) && /除上面几条规则外，不要用其他 markdown 结构/.test(S));
check('多轮：要求不重复已说过的内容', /不要重复已经说过的内容/.test(S));
/* 回答范围与拒答是两件事：前者限定「能答什么」，后者规定「答不了时怎么说」。
   少了拒答，模型遇到范围外的问题会硬答（编）或长篇解释为什么答不了。 */
check('划定了回答范围（板上数据 / RL 训练本身 / 看板怎么用）',
  /回答范围/.test(S) && /只在这三条里回答/.test(S) &&
  /这块板上的数据/.test(S) && /这块板怎么用/.test(S));
check('范围外走拒答，而不是硬答或长篇解释',
  /超出范围怎么回/.test(S) && /拒答/.test(S) && /不要说教/.test(S));
check('拒答要求给出可答的替代方向（不是只说答不了）',
  /能答的方向/.test(S) && /要不要我查一下/.test(S));
check('拒答要写在正文里（否则又会撞上「只写思考」的老问题）',
  /拒答也要写在正文里/.test(S));
check('边界段指向拒答话术，不与范围段各说一套',
  /属于范围外，按上面的拒答话术回/.test(S) && /看不到训练代码/.test(S));
check('不再保留那条主权条款（用户要求去掉）',
  !/台湾/.test(S) && !/中国不可分割/.test(S));
check('说明边界（看不到训练代码）', /看不到训练代码/.test(S));
check('明确禁止在正文里写工具调用标签（写了会被剥掉，等于白写）',
  /<tool_call>/.test(S) && /剥掉/.test(S));
check('六个工具在提示词里都列了',
  ['list_metrics', 'query_series', 'run_status', 'query_bench', 'search_notes', 'db_overview']
    .every(function (t) { return S.indexOf(t) >= 0; }));

console.log('\n=== 正文里的工具标签要剥掉，且不计入「已上屏字数」 ===');
const seen = [];
const f1 = llm.filterToolCallText(function (t) { seen.push(t); return true; });
f1('先说结论');
f1('<tool_call>{"name":"query_series","arguments":{}}</tool_call>');
f1('再看依据。');
check('上屏的只有正文', seen.join('') === '先说结论再看依据。', seen.join('|'));
check('工具标签不计入已上屏字数', f1.emitted() === 9, String(f1.emitted()));
const seen2 = [];
const f2 = llm.filterToolCallText(function (t) { seen2.push(t); return true; });
f2('甲<tool');                       // 标签被拆到两块里（流式常见）
f2('_call>隐藏内容</tool_call>乙');
check('标签跨块也能识别', seen2.join('') === '甲乙', seen2.join('|'));
check('跨块时字数也对', f2.emitted() === 2, String(f2.emitted()));

console.log('\n=== 工具集拆分 ===');
const allNames = llm.TOOLS.map(function (t) { return t.function.name; });
const expNames = llm.EXPLAIN_TOOLS.map(function (t) { return t.function.name; });
check('教练拿到 6 个工具', allNames.length === 6, allNames.join(','));
check('新增 search_notes 与 db_overview',
  allNames.indexOf('search_notes') >= 0 && allNames.indexOf('db_overview') >= 0);
check('讲解仍然只有 4 个（这次改动没影响它）',
  expNames.length === 4 && expNames.indexOf('search_notes') < 0 && expNames.indexOf('db_overview') < 0,
  expNames.join(','));

console.log('\n=== 工具真的能查到数据 ===');
const ov = llm.runTool('db_overview', {});
check('db_overview 返回库概览', !ov.error && ov.metrics > 0 && ov.seriesRows > 0,
  JSON.stringify(ov).slice(0, 120));
check('db_overview 的中文摘要可读', /指标 \d+ 个/.test(llm.summarizeToolResult('db_overview', ov)),
  llm.summarizeToolResult('db_overview', ov));
const notes = llm.runTool('search_notes', { limit: 3 });
check('search_notes 能取到解说记录', !notes.error && notes.count > 0, JSON.stringify(notes).slice(0, 120));
check('记录的 lesson 被截断（不把旧解说整段捞回来）',
  !notes.error && notes.notes.every(function (n) { return (n.lesson || '').length <= 240; }));
const bad = llm.runTool('nope', {});
check('未知工具的报错里带上可用清单', /没有名为 nope/.test(bad.error) && /search_notes/.test(bad.error), bad.error);

console.log('\n=== 组装这一轮要发给模型的消息 ===');
const mk = function (n, role) { return { role: role || 'user', content: '内容' + n }; };
const many = [];
for (let i = 0; i < 20; i++) many.push(mk(i, i % 2 ? 'assistant' : 'user'));
const m1 = coach.buildMessages({ question: '训练到第几步了', history: many });
check('system 在最前、本轮问题在最后',
  m1[0].role === 'system' && m1[m1.length - 1].role === 'user');
/* 会话内的内容全传：不再按「最近 8 条、每条砍到 1200 字」裁。
   长度改由 src/session.js 管 —— 快到窗口 75% 就先压摘要，下一轮发「摘要 + 之后的原文」，
   只有压缩没赶上、又真装不下，才按预算丢最旧的（见 coach-session-test.js）。 */
check('20 条历史一条不少地传上去', m1.length === 1 + 20 + 1, '共 ' + m1.length + ' 条');
check('本轮问题单独成一条（不会和历史里的重复）',
  m1[m1.length - 1].content.indexOf('问题：训练到第几步了') >= 0,
  m1[m1.length - 1].content.slice(0, 60));

const m2 = coach.buildMessages({
  question: 'q', history: [{ role: 'tool', content: '不该进来' }, { role: 'user', content: 'ok' }],
});
check('非法角色（tool）被过滤掉', !m2.some(function (m) { return m.role === 'tool'; }));

const longHist = coach.buildMessages({
  question: 'q', history: [{ role: 'assistant', content: 'x'.repeat(5000) }],
});
const longMsg = longHist.filter(function (m) { return m.role === 'assistant'; })[0];
check('5000 字的单条原样传（不再砍到 1200 字）',
  longMsg.content.length === 5000, String(longMsg.content.length));
const hugeMsg = coach.buildMessages({
  question: 'q', history: [{ role: 'user', content: 'y'.repeat(20000) }],
})[1];
check('单条长到离谱时才裁（一条把整个窗口吃掉就没得聊了）',
  hugeMsg.content.length < 20000 && hugeMsg.content.length <= coach.COACH_MSG_MAX_CHARS + 24,
  String(hugeMsg.content.length));

console.log('\n=== 看板上下文注入 ===');
const mCtx = coach.buildMessages({
  question: '这个为什么掉', history: [],
  context: { view: 'metrics', chart: 'tag:actor/entropy_loss', chartName: '策略熵', run: 'pro' },
});
const uCtx = mCtx[mCtx.length - 1].content;
check('带上视图', /指标库视图/.test(uCtx), uCtx.split('\n')[0]);
check('带上正打开的图表（用可读名，不是裸 key）', /策略熵/.test(uCtx) && uCtx.indexOf('tag:actor') < 0, uCtx);
check('带上 run', /pro/.test(uCtx));
const mNo = coach.buildMessages({
  question: '这个为什么掉', history: [],
  context: { view: 'metrics', chart: 'tag:actor/lr', chartName: '学习率' },
  useContext: false,
});
check('开关关掉后一个字都不带',
  mNo[mNo.length - 1].content.indexOf('[看板现状]') < 0, mNo[mNo.length - 1].content);
const mNone = coach.buildMessages({ question: 'q', history: [] });
check('没有上下文时也不报错、不加空块', mNone[mNone.length - 1].content === '问题：q',
  mNone[mNone.length - 1].content);

console.log('\n=== 重试策略：越往后越催它出正文 ===');
const st0 = coach.coachStrategy(0, { explainMaxTokens: 4000 }, 'low');
const st1 = coach.coachStrategy(1, { explainMaxTokens: 4000 }, 'low');
const st2 = coach.coachStrategy(2, { explainMaxTokens: 4000 }, 'low');
check('第一次用配置里的思考强度', st0.effort === 'low' && st0.maxTokens === 4000);
check('第二次去掉思考强度并加额度', st1.effort === null && st1.maxTokens > st0.maxTokens);
check('第三次再加大额度并补一句「直接给结论」', st2.maxTokens > st1.maxTokens && /直接输出/.test(st2.extra || ''));
check('教练的成稿门槛比讲解低（一句话回答也算答成了）',
  coach.COACH_MIN_CHARS < 200, String(coach.COACH_MIN_CHARS));
/* 用户明确要求简短输出时（「只把之前问过的问题列出来，别的别说」），
   模型照办就会低于 60 字 —— 只按字数判会把它打成失败、重试三次甩个红框。 */
check('自然收尾时另有一个宽容门槛，且远低于常规门槛',
  coach.COACH_MIN_STOP_CHARS > 0 && coach.COACH_MIN_STOP_CHARS < coach.COACH_MIN_CHARS / 2,
  coach.COACH_MIN_STOP_CHARS + ' vs ' + coach.COACH_MIN_CHARS);
check('不再保留「限定输出范围时严格照办」那条（并入回答范围与拒答）',
  !/严格照办/.test(S));

/* ================================================================
   二、路由：参数校验（这两种请求到不了模型）
   ================================================================ */
(async function () {
  console.log('\n=== /api/coach 参数校验 ===');
  const bad1 = await fetch(new URL('api/coach', BASE), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  const j1 = await bad1.json().catch(function () { return {}; });
  check('缺 question → 400', bad1.status === 400, bad1.status + ' ' + JSON.stringify(j1));
  check('错误说明是人话', /缺少 question/.test(j1.error || ''), j1.error);

  const bad2 = await fetch(new URL('api/coach', BASE), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
  });
  check('body 不是 JSON → 400', bad2.status === 400, String(bad2.status));

  const bad3 = await fetch(new URL('api/coach', BASE), { method: 'GET' });
  check('GET → 405', bad3.status === 405, String(bad3.status));

  const bad4 = await fetch(new URL('api/coach', BASE), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x'.repeat(4100) }),
  });
  check('超长问题 → 400', bad4.status === 400, String(bad4.status));

  /* ================================================================
     三、前端交互（jsdom）
     ================================================================ */
  console.log('\n=== 对话历史：落库的读取与清空 ===');
  const h1 = await fetch(new URL('api/coach/history', BASE), { headers: { 'x-test': '1' } });
  const jh = await h1.json().catch(function () { return {}; });
  check('GET /api/coach/history 返回 msgs 数组', h1.status === 200 && Array.isArray(jh.msgs),
    h1.status + ' ' + JSON.stringify(jh).slice(0, 60));
  const cl1 = await fetch(new URL('api/coach/clear', BASE));
  check('清空必须走 POST（GET 是 405，避免误触就清掉整段对话）', cl1.status === 405, String(cl1.status));

  console.log('\n=== 前端：悬浮球与抽屉 ===');

  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: BASE, virtualConsole: vc,
  });
  const { window } = dom;
  const doc = window.document;

  let pkgs = [];          // 每次 /api/coach 的 payload
  let streamDelay = 0;    // 让流「慢」一点，好在生成途中检查按钮状态
  let restoreMsgs = [];   // GET api/coach/history 返回什么（模拟「上次没聊完的对话」）
  let clearCalls = 0;     // 调了几次 api/coach/clear
  let created = 0;        // 开了几段新会话
  /* 会话列表：先给一段现成的，前端应当回到这一段（而不是每次刷新都开新的） */
  let sessList = [
    { sid: 's1', title: '熵的问题', created: 1, updated: 2, msgs: 2, summary: '', compressCnt: 0 },
  ];
  /* 一行一个 JSON —— NDJSON 的硬性约定。两条 delta 必须各自成行，
     挤在一行里 JSON.parse 会失败，前端会整行丢掉（第一版就是这么翻车的）。 */
  const ND = [
    /* 上下文水位：后端每轮开头推一条，前端拿它显示百分比。
       压缩是后端悄悄做的，用户得看见才知道「更早的对话被压成摘要了」。 */
    '{"context":{"sid":"s1","used":12000,"window":32768,"pct":37,"trigger":24576,' +
      '"ratio":0.75,"compressed":1,"justCompressed":false,"dropped":0,"msgs":2,"summary":true}}',
    '{"think":"先看训练到第几步了","phase":"tool","round":1}',
    '{"tool":{"name":"run_status","args":{},"summary":"pro 第30步","round":1}}',
    '{"think":"拿到数据了，组织回答","phase":"main","round":0}',
    '{"delta":"### 当前进度\\n\\npro 已跑到 **第 30 步**。\\n\\n"}',
    '{"delta":"- 重启 2 次\\n- 累计花费 262 万\\n\\n"}',
    /* 表格与它的「反面样本」：
       —— 以竖线开头但下一行不是分隔行 → 只能当段落（识别要两道条件齐全）；
       —— 真表格里故意让一行缺列（| 熵 | 1.02 |），验证按表头列数补齐。 */
    '{"delta":"| 这行以竖线开头，但下一行不是分隔行\\n\\n### 两个 run 的对照\\n\\n| 指标 | pro | flash |\\n| --- | --- | --- |\\n| **avg@n** | 0.62 | `0.58` |\\n| 熵 | 1.02 |\\n\\n"}',
    /* 代码块：包含反引号、缩进、块内 markdown 字面量（不应被渲染），并测试 HTML 转义 */
    '{"delta":"\\n```bash\\n# 启动 vLLM\\nvllm serve <sft_checkpoint> --tensor-parallel 8 \\\\n\\n# 启动 RL 训练\\npython train_grpo.py \\\\\\\\n  --policy <sft_checkpoint> \\\\\\\\n  --n_samples 8\\n```\\n\\n"}',
    '{"delta":"```\\n未闭合代码块\\n  **这一行不该被加粗**\\n<script>alert(2)</script>\\n"}',
    '{"delta":"<script>alert(1)</script> 这行是用来验证转义的，带一个 `行内码`。"}',
    '{"done":true,"model":"mock-model","toolRounds":1,"attempts":1}',
  ].join('\n') + '\n';

  window.fetch = function (u, opt) {
    const url = new URL(u, BASE).toString();
    const method = (opt && opt.method) || 'GET';
    if (/\/api\/ai\/test$/.test(url)) {
      return Promise.resolve(new Response(
        JSON.stringify({ enabled: true, ok: true, model: 'mock-model' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (/\/api\/coach\/history(\?|$)/.test(url)) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, sid: (url.match(/sid=([^&]*)/) || [, 's1'])[1], msgs: restoreMsgs }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (/\/api\/coach\/sessions$/.test(url)) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, sessions: sessList }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (/\/api\/coach\/session$/.test(url) && method === 'POST') {
      created++;
      const s = { sid: 's-new-' + created, title: '', created: 0, updated: 0, msgs: 0 };
      sessList = [s].concat(sessList);
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, session: s }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (/\/api\/coach\/clear$/.test(url) && method === 'POST') {
      clearCalls++;
      restoreMsgs = [];
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (method === 'POST' && /\/api\/coach$/.test(url)) {
      try { pkgs.push(JSON.parse(opt.body)); } catch (e) { pkgs.push({ parseError: String(e) }); }
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(new Response(ND, {
            status: 200, headers: { 'content-type': 'application/x-ndjson' },
          }));
        }, streamDelay);
      });
    }
    return fetch(url)
      .catch(function (e) { console.log('  [fetch FAIL] ' + url + ' ' + e.message); throw e; });
  };
  window.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };

  ['glossary.js', 'narrator.js', 'app.js', 'coach.js'].forEach(function (f) {
    window.eval(fs.readFileSync(path.join(DIR, f), 'utf8'));
  });
  doc.dispatchEvent(new window.Event('DOMContentLoaded'));
  await sleep(1200);

  const $ = function (id) { return doc.getElementById(id); };
  const click = function (el) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const q = function (sel) { return doc.querySelector(sel); };
  const qa = function (sel) { return Array.from(doc.querySelectorAll(sel)); };

  check('悬浮球在页面上', !!$('coach-fab'));
  check('教练抽屉初始是收起的', $('coach-drawer').hidden === true);
  click($('coach-fab'));
  await sleep(60);
  check('点球打开抽屉', $('coach-drawer').hidden === false);
  check('首次打开有欢迎语（本地文案，不烧 token）',
    /AI 训练教练/.test($('coach-body').textContent) && pkgs.length === 0);
  check('给了快捷问题', qa('.coach-chip').length >= 3, qa('.coach-chip').length + ' 个');
  check('上下文条默认开启并写明会带什么',
    $('coach-ctx-sw').getAttribute('aria-pressed') === 'true' && /在看|在总览|在/.test($('coach-ctx-t').textContent),
    $('coach-ctx-t').textContent);

  console.log('\n=== 前端：发一轮，流式上屏 ===');
  streamDelay = 260;
  const box = $('coach-q');
  box.value = '现在训练状态怎么样？';
  $('coach-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(80);

  check('发出的 payload 带上了本轮问题', pkgs.length === 1 && pkgs[0].question === '现在训练状态怎么样？',
    JSON.stringify(pkgs[0] && pkgs[0].question));
  check('首轮没有历史', Array.isArray(pkgs[0] && pkgs[0].history) && pkgs[0].history.length === 0,
    JSON.stringify(pkgs[0] && pkgs[0].history));
  check('带上了看板上下文', !!(pkgs[0] && pkgs[0].context && pkgs[0].context.view),
    JSON.stringify(pkgs[0] && pkgs[0].context));
  check('生成中：发送键收起、停止键出现',
    $('coach-go').hidden === true && $('coach-stop').hidden === false);
  check('用户消息立刻上屏', /现在训练状态怎么样/.test($('coach-body').textContent));
  check('输入框已清空', box.value === '');

  await sleep(900);

  const out = q('.coach-out');
  check('正文已渲染', !!out && /第 30 步/.test(out.textContent), (out && out.textContent || '').slice(0, 60));
  check('轻量排版生效：小标题与列表都成了真实标签',
    !!q('.coach-out .coach-h') && qa('.coach-out .coach-ul li').length >= 2,
    'h=' + qa('.coach-out .coach-h').length + ' li=' + qa('.coach-out .coach-ul li').length);
  check('**加粗** 被渲染成 <b>', !!q('.coach-out b'));
  check('模型返回的 <script> 被转义（不会真的执行）',
    out.innerHTML.indexOf('<script>') < 0 && out.innerHTML.indexOf('&lt;script&gt;') >= 0);

  console.log('\n=== 前端：markdown 表格 ===');
  check('渲染成真实 <table>（而不是一堆竖线文字）',
    !!q('.coach-out .coach-table') && !!q('.coach-out .coach-tw'));
  check('表头行与分隔行都被吃掉，正文里不残留 |---|---|',
    out.innerHTML.indexOf('---') < 0 && out.textContent.indexOf('---') < 0,
    (out.textContent || '').slice(0, 80));
  check('表头进 <th>、数据进 <td>',
    qa('.coach-table thead th').length === 3 && qa('.coach-table tbody td').length === 6,
    'th=' + qa('.coach-table thead th').length + ' td=' + qa('.coach-table tbody td').length);
  check('缺列的行按表头补齐（行不会参差）',
    qa('.coach-table tbody tr').every(function (tr) { return tr.children.length === 3; }),
    qa('.coach-table tbody tr').map(function (tr) { return tr.children.length; }).join(','));
  check('单元格里的 **加粗** 与 `行内码` 照样生效',
    !!q('.coach-table tbody b') && !!q('.coach-table tbody code'));
  check('单元格里的 HTML 也被转义', q('.coach-table').innerHTML.indexOf('<script>') < 0);
  check('只以竖线开头、没有分隔行的那行仍是段落（两道条件缺一不可）',
    qa('.coach-out .coach-p').some(function (p) { return /这行以竖线开头/.test(p.textContent); }) &&
    !/这行以竖线开头/.test(q('.coach-table') ? q('.coach-table').textContent : ''));
  check('小标题 / 列表 / 表格三种块能共存，且顺序不乱',
    qa('.coach-out .coach-h').length >= 2 && !!q('.coach-out .coach-ul') &&
    out.innerHTML.indexOf('coach-ul') < out.innerHTML.indexOf('coach-tw'),
    'h=' + qa('.coach-out .coach-h').length +
    ' ul@' + out.innerHTML.indexOf('coach-ul') + ' tw@' + out.innerHTML.indexOf('coach-tw'));

  console.log('\n=== 前端：markdown 代码块 ===');
  check('代码块渲染成 <pre><code>',
    qa('.coach-out .coach-pre').length >= 1 && !!q('.coach-out .coach-pre code'),
    'pre=' + qa('.coach-out .coach-pre').length);
  const pre0 = qa('.coach-out .coach-pre')[0];
  check('代码块里的换行与缩进被保留',
    /vllm serve/.test(pre0.textContent) && /\n.*--policy/.test(pre0.textContent),
    pre0.textContent.slice(0, 80).replace(/\n/g, '⏎'));
  check('代码块内的 ** 不被渲染成 <b>',
    !/\*\*/.test(pre0.textContent) && pre0.querySelectorAll('b').length === 0,
    'pre0 b=' + pre0.querySelectorAll('b').length);
  check('代码块里的 HTML 被转义',
    pre0.innerHTML.indexOf('<script>') < 0);
  check('未闭合的 ``` 不会吞掉后续正文（后续行照常排版，而不是整坨变代码块）',
    qa('.coach-out .coach-p').some(function (p) {
      return /这一行不该被加粗/.test(p.textContent) && p.querySelectorAll('b').length === 1;
    }));
  check('只有成对的那段才渲染成代码块',
    qa('.coach-out .coach-pre').length === 1);
  check('行内反引号走 <code>，且不在代码块内部',
    qa('.coach-out .coach-code').length >= 1 &&
    qa('.coach-out .coach-code').every(function (c) { return !c.closest('.coach-pre'); }),
    'coach-code=' + qa('.coach-out .coach-code').length);

  check('查询决策可见：显示调了什么工具、查到什么',
    /训练进度/.test($('coach-body').textContent) && /pro 第30步/.test($('coach-body').textContent));
  check('思考过程可折叠查看', !!q('.coach-think .coach-think-b') &&
    /组织回答/.test(q('.coach-think .coach-think-b').textContent));
  check('跑完恢复：发送键回来、停止键收起',
    $('coach-go').hidden === false && $('coach-stop').hidden === true);

  console.log('\n=== 前端：追问把上一轮带进历史 ===');
  streamDelay = 0;
  box.value = '那评测分数对得上吗？';
  $('coach-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(500);
  const p2 = pkgs[pkgs.length - 1];
  check('第二次请求带上了上一轮', p2.history.length === 2, JSON.stringify(p2.history.map(function (m) { return m.role; })));
  check('历史里是「问 + 答」两条，且答的是上一轮正文',
    p2.history[0].role === 'user' && p2.history[1].role === 'assistant' &&
    /第 30 步/.test(p2.history[1].content), JSON.stringify(p2.history[0]));
  check('本轮问题不在历史里（避免重复一次）',
    p2.history.every(function (m) { return m.content.indexOf('那评测分数对得上吗？') < 0; }));
  check('两条回答各自成块', qa('.coach-msg-ai').length === 3, qa('.coach-msg-ai').length + ' 块');

  console.log('\n=== 前端：可关的上下文 ===');
  click($('coach-ctx-sw'));
  await sleep(40);
  check('点一下变成关闭态',
    $('coach-ctx-sw').getAttribute('aria-pressed') === 'false' && /已关闭/.test($('coach-ctx-t').textContent),
    $('coach-ctx-t').textContent);
  box.value = '那不看页面，纯讲概念：熵坍缩是什么';
  $('coach-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(400);
  const p3 = pkgs[pkgs.length - 1];
  check('关掉后不再上报 context', p3.useContext === false && !p3.context,
    JSON.stringify({ useContext: p3.useContext, context: p3.context }));
  click($('coach-ctx-sw'));
  await sleep(30);
  check('可以再打开', $('coach-ctx-sw').getAttribute('aria-pressed') === 'true');

  console.log('\n=== 前端：快捷问题与关闭 ===');
  click($('coach-fab'));
  await sleep(30);
  // 欢迎语 + 三轮回答 = 4 块；再点球不该又插一条欢迎语
  check('再点球不会重复插欢迎语（已有对话时不重来）',
    qa('.coach-msg-ai').length === 4, qa('.coach-msg-ai').length + ' 块');
  click($('coach-close'));
  await sleep(30);
  check('关闭后抽屉收起', $('coach-drawer').hidden === true);

  console.log('\n=== 前端：刷新后恢复上次的对话 ===');
  /* 库里那份历史是页面加载时（bind）取的。这里直接调 load() 模拟「刷新后重新打开」，
     比再建一个 jsdom 轻，走的是同一条代码路径。 */
  restoreMsgs = [
    { role: 'user', content: '上次问的：熵现在多少' },
    { role: 'assistant', content: '上次答的：**1.02** 左右' },
  ];
  const M = window.MIMO_COACH;
  M.load();
  await sleep(150);
  check('恢复的历史渲染出来了',
    /上次问的/.test($('coach-body').textContent) && /上次答的/.test($('coach-body').textContent),
    $('coach-body').textContent.slice(-60));
  check('有一条「以上是上次的对话」的分隔，新旧一眼能分开', !!q('.coach-sep'));
  check('恢复的正文也走排版渲染（不是纯文本）',
    qa('.coach-msg-ai').some(function (n) { return /上次答的/.test(n.textContent) && !!n.querySelector('b'); }));
  check('恢复的内容进了 msgs，接着问能带上',
    M.msgs.some(function (m) { return /上次问的/.test(m.content); }), M.msgs.length + ' 条');
  box.value = '那现在呢？';
  $('coach-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(400);
  const p4 = pkgs[pkgs.length - 1];
  check('恢复后追问：历史里带着恢复出来的那几条',
    p4.history.some(function (m) { return /上次问的/.test(m.content); }),
    JSON.stringify(p4.history.map(function (m) { return m.role; })));

  console.log('\n=== 前端：清空对话 ===');
  const clr = $('coach-clear');
  check('有对话时清空按钮可用', !!clr && clr.disabled === false);
  click(clr);
  await sleep(40);
  check('点一次只是进入待确认，没有真的清', /再点一次/.test(clr.textContent) && clearCalls === 0,
    clr.textContent + ' clearCalls=' + clearCalls);
  click(clr);
  await sleep(300);
  check('再点一次才真的清，且通知了后端清库', clearCalls === 1, 'clearCalls=' + clearCalls);
  check('界面重置回欢迎语', qa('.coach-msg').length === 1 && /AI 训练教练/.test($('coach-body').textContent),
    qa('.coach-msg').length + ' 块');
  check('msgs 也清空了（后面的追问不会带着旧对话）', M.msgs.length === 0, M.msgs.length + ' 条');
  check('没有对话时按钮禁用', $('coach-clear').disabled === true);
  box.value = '清空之后还能正常问吗';
  $('coach-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(400);
  const p5 = pkgs[pkgs.length - 1];
  check('清空后接着聊：history 从零开始', p5.history.length === 0,
    JSON.stringify(p5.history.map(function (m) { return m.role; })));

  console.log('\n=== 前端：会话（一段对话一个 sid） ===');
  check('下拉里列出了已有的会话', qa('#coach-sess option').length >= 1,
    qa('#coach-sess option').length + ' 项');
  check('默认回到上次那段（不是每次刷新都开新的）', $('coach-sess').value === 's1',
    $('coach-sess').value);
  check('发请求时带上 sid（后端按它取这段的上下文）',
    pkgs[pkgs.length - 1].sid === 's1', String(pkgs[pkgs.length - 1].sid));
  const meter = $('coach-meter');
  check('水位条显示这一轮占窗口的百分比', meter.hidden === false && /上下文\s*37%/.test(meter.textContent),
    meter.hidden + ' / ' + meter.textContent);
  check('悬浮说明里讲清了压缩与摘要（压缩是悄悄做的，得让人看见）',
    /自动压缩/.test(meter.title) && /压缩 \d+ 次/.test(meter.title), meter.title);

  restoreMsgs = [{ role: 'user', content: '老会话里的提问' }];
  click($('coach-new'));
  await sleep(220);
  check('点「＋新对话」会真的去开一段', created === 1 && $('coach-sess').value === 's-new-1',
    'created=' + created + ' value=' + $('coach-sess').value);
  check('新会话是空的：欢迎语 + 快捷问题',
    /AI 训练教练/.test($('coach-body').textContent) && qa('.coach-chip').length >= 3,
    qa('.coach-chip').length + ' 个快捷问题');
  check('新会话不会接着老会话聊', M.msgs.length === 0, M.msgs.length + ' 条');

  $('coach-sess').value = 's1';
  $('coach-sess').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(220);
  check('切回老会话会把它的对话取回来', /老会话里的提问/.test($('coach-body').textContent),
    $('coach-body').textContent.slice(-40));
  check('切回来后 sid 也跟着变（接着在老会话里聊）', M.session() === 's1', M.session());

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  try { dom.window.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('测试异常:', e && e.stack);
  process.exit(1);
});
