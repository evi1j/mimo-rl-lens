/* 探测本地模型是否支持 OpenAI 风格的 function calling（tools / tool_choice）
   用法：node tools/probe-llm-tools.js
   用来确认「给 AI 配查询工具」这条路在当前模型上走不走得通。 */
const path = require('path');
const cfg = require(path.join(__dirname, '..', 'config.json'));
const base = String(cfg.llm.baseUrl).replace(/\/+$/, '');

const tools = [
  {
    type: 'function',
    function: {
      name: 'query_metric',
      description: '按指标名查询训练序列',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '指标名，例如 dynsam/avg@n' },
          run: { type: 'string', description: 'run 名，pro 或 flash' },
        },
        required: ['tag'],
      },
    },
  },
];

async function ask(label, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.llm.apiKey },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    console.log('--- ' + label + ' --- HTTP ' + res.status + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    if (!j) { console.log('  非 JSON 响应:', txt.slice(0, 300)); return null; }
    if (j.error) { console.log('  error:', JSON.stringify(j.error).slice(0, 300)); return null; }
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    if (!msg) { console.log('  原始:', txt.slice(0, 300)); return null; }
    console.log('  tool_calls:', msg.tool_calls ? JSON.stringify(msg.tool_calls).slice(0, 400) : '（无）');
    console.log('  content:', msg.content ? JSON.stringify(msg.content).slice(0, 160) : '（无）');
    return j;
  } catch (e) {
    console.log('--- ' + label + ' --- 请求失败: ' + e.message);
    return null;
  }
}

(async function () {
  console.log('baseUrl:', base, '| model:', cfg.llm.model);
  await ask('带 tools，tool_choice 默认', {
    model: cfg.llm.model,
    messages: [{ role: 'user', content: '帮我查一下 dynsam/avg@n 在 pro 上的序列' }],
    tools: tools, max_tokens: 800, temperature: 0.2,
  });
  await ask('tool_choice=required', {
    model: cfg.llm.model,
    messages: [{ role: 'user', content: '帮我查一下 dynsam/avg@n 在 pro 上的序列' }],
    tools: tools, tool_choice: 'required', max_tokens: 800, temperature: 0.2,
  });
  await ask('tool_choice 指定函数 + 流式', {
    model: cfg.llm.model,
    messages: [{ role: 'user', content: '帮我查一下 dynsam/avg@n 在 pro 上的序列' }],
    tools: tools, tool_choice: { type: 'function', function: { name: 'query_metric' } },
    max_tokens: 800, temperature: 0.2, stream: true,
  });
})();
