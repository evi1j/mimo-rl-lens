/* 验证讲解提示词按 kind 分流。
   讲一个精选训练指标、讲一套离线评测基准、讲指标库里某个没有文案的原始
   指标，该说的话完全不同 —— 用同一套大纲会让模型对着评测分数讲训练机制。
   这里只查系统提示词本身，不调模型。
   用法：node test/explain-prompt-test.js */
const path = require('path');
const llm = require(path.join(__dirname, '..', 'src', 'llm.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const metric = llm.explainSystem({ kind: 'metric' });
const bench = llm.explainSystem({ kind: 'bench' });
const tag = llm.explainSystem({ kind: 'tag' });

console.log('\n=== 三份大纲的差异 ===');
check('三种 kind 产出三份不同的提示词',
  new Set([metric, bench, tag]).size === 3);
check('缺 kind 时按单个指标处理（兼容老前端）', llm.explainSystem({}) === metric);
check('未知 kind 也回落到单个指标', llm.explainSystem({ kind: 'nonsense' }) === metric);
check('三种都够长（不是空壳）',
  [metric, bench, tag].every(function (s) { return s.length > 800; }),
  [metric, bench, tag].map(function (s) { return s.length; }).join('/'));

console.log('\n=== 公共部分（三份都要有）===');
check('都声明只看真实数字、不许编',
  [metric, bench, tag].every(function (s) { return /不要编/.test(s); }));
check('都列出四个查询工具',
  [metric, bench, tag].every(function (s) {
    return /list_metrics/.test(s) && /query_series/.test(s) &&
           /run_status/.test(s) && /query_bench/.test(s);
  }));
check('都要求引用指标名前先检索确认',
  [metric, bench, tag].every(function (s) { return /确认存在/.test(s); }));
check('都禁止用生活比喻代替解释',
  [metric, bench, tag].every(function (s) { return /生活比喻/.test(s); }));
check('都限定三段、400 字',
  [metric, bench, tag].every(function (s) { return /三段/.test(s) && /400 字/.test(s); }));
check('都要求正文进 content 字段（不是 reasoning）',
  [metric, bench, tag].every(function (s) { return /reasoning_content/.test(s); }));

console.log('\n=== 单个指标 ===');
check('开场说明是「训练指标」', /观众点开了某个训练指标/.test(metric));
check('不含基准专有的说法', !/不参与梯度更新/.test(metric));
check('不含指标库专有的检索工序', !/这一步不能省/.test(metric));

console.log('\n=== 离线评测基准 ===');
check('点明评测不参与梯度更新', /不参与梯度更新/.test(bench));
check('提醒评测点是离散的、别当连续曲线',
  /离散/.test(bench) && /连续曲线/.test(bench));
check('要求逐条说清各 run 的最新分数与累计变化',
  /最新分数/.test(bench) && /累计涨了多少/.test(bench));
check('要求解释不同基准涨落不同步是正常的',
  /不同步/.test(bench));
check('字段对齐 payload：series 与 static.desc',
  /data\.series/.test(bench) && /static\.desc/.test(bench));

console.log('\n=== 指标库原始指标 ===');
check('写明这一类比常规指标多两道工序', /比讲常规指标多两道工序/.test(tag));
check('第一步要求先检索确认存在', /list_metrics/.test(tag) && /确认这个指标确实存在/.test(tag));
check('第二步强制查历史，并说明为什么不能省',
  /query_series/.test(tag) && /不能省/.test(tag) && /recent 只有最近/.test(tag));
check('提到 data.metric 是它在指标库里的真实名字', /data\.metric/.test(tag));
check('要求把名字的路径层级讲出来', /路径层级|层级信息/.test(tag));
check('第三段要求指明配套看哪个主指标', /配套看/.test(tag));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
