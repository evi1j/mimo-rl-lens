/* 用当前 SYSTEM_PROMPT 对一条构造事件试跑一次 AI 解说，用来检查 prompt 实际效果。
   用法：node tools/ai-prompt-test.js
   不影响看板服务，也不会写库。 */
const llm = require('../llm.js');

/* 挑一个最能体现「知识点」的事件：满分率飙升——
   背后是 advantage 方差归零、梯度消失，纯机制，没法靠比喻糊弄过去。 */
const ev = {
  level: 'warn',
  run: 'flash',
  text: 'flash 的满分率升到 32.5%。',
  why: '满分率是 n 次尝试全部答对的题占比。这类题组内方差为 0，advantage 恒为 0，梯度归零，算力白烧。',
  ctx: {
    run: 'flash',
    before: { step: 24, value: 0.6154, phase: 'rollout', cost: 1234567, pr0: 0.152, pr1: 0.201, restarts: 3, passrate: 0.42 },
    after: { step: 24, value: 0.6154, phase: 'rollout', cost: 1280000, pr0: 0.149, pr1: 0.325, restarts: 3, passrate: 0.44 },
  },
};

const snap = {
  flash: { step: 24, phase: 'rollout', cost: 1280000, pr1: 0.325 },
  pro: { step: 31, phase: 'training', cost: 2100000, pr1: 0.28 },
};

llm.narrate(ev, snap).then((r) => {
  if (!r) {
    console.log('AI 返回 null。内部状态（含真实报错）：');
    console.log(JSON.stringify(llm.status, null, 2));
    process.exit(1);
  }
  console.log('模型:', r.model);
  console.log('\n[text]\n' + r.text);
  console.log('\n[why]\n' + r.why);
  console.log('\n[lesson]\n' + r.lesson);
}).catch((e) => { console.error('失败:', e.message); process.exit(1); });
