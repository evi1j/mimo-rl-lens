/* 探测：工具轮能不能改成流式？
   关键看两件事——
   1) SSE 里有没有 reasoning_content（决定「查什么」的思考能不能逐字吐出来）
   2) tool_calls 是怎么分片来的（arguments 增量拼接要按 index 累积）
   用法：node tools/probe-tool-stream.js */
const llm = require('../llm.js');

const cfg = llm.loadConfig();
const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
const body = {
  model: cfg.model || 'qwen3.8-27b-sglang',
  messages: [
    { role: 'system', content: '你是训练看板讲解员。先用工具查数据，再讲解。' },
    { role: 'user', content: '请讲解指标 dynsam/avg@n（平均通过率）。当前末值 0.626。' },
  ],
  tools: llm.TOOLS,
  tool_choice: 'required',
  temperature: 0,
  max_tokens: 2000,
  stream: true,
};

(async () => {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + (cfg.apiKey || ''),
    },
    body: JSON.stringify(body),
  });
  console.log('HTTP', res.status, '| 首字节耗时', Date.now() - t0, 'ms');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let thinkLen = 0, contentLen = 0;
  const calls = {};
  let firstThinkAt = null, firstCallAt = null;
  const chunkKeys = new Set();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const d = s.slice(5).trim();
      if (d === '[DONE]') continue;
      let j;
      try { j = JSON.parse(d); } catch (e) { continue; }
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      const delta = ch.delta || {};
      Object.keys(delta).forEach((k) => chunkKeys.add(k));

      const think = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      if (think) {
        thinkLen += think.length;
        if (firstThinkAt === null) firstThinkAt = Date.now() - t0;
      }
      if (typeof delta.content === 'string' && delta.content) contentLen += delta.content.length;

      const tcs = delta.tool_calls || [];
      for (const tc of tcs) {
        const i = tc.index || 0;
        if (!calls[i]) calls[i] = { id: '', name: '', args: '' };
        if (firstCallAt === null) firstCallAt = Date.now() - t0;
        if (tc.id) calls[i].id += tc.id;
        const fn = tc.function || {};
        if (fn.name) calls[i].name += fn.name;
        if (typeof fn.arguments === 'string') calls[i].args += fn.arguments;
      }
    }
  }

  console.log('delta 出现过的字段:', Array.from(chunkKeys).join(', ') || '(无)');
  console.log('思考长度:', thinkLen, '| 首个思考块于', firstThinkAt, 'ms');
  console.log('正文长度:', contentLen);
  console.log('工具调用数:', Object.keys(calls).length, '| 首个调用块于', firstCallAt, 'ms');
  Object.keys(calls).forEach((k) => {
    console.log('  [' + k + ']', calls[k].name, calls[k].args, '| id:', calls[k].id.slice(0, 12));
  });
  console.log('总耗时', Date.now() - t0, 'ms');
  console.log('');
  console.log(thinkLen > 0
    ? '结论：流式工具轮能拿到思考 —— 可以逐字吐「决定查什么」。'
    : '结论：流式工具轮没有思考 —— 只能沿用非流式，思考①无法上屏。');
})();
