/* 本地 OpenAI 兼容接口调用层（仅服务端使用）
   配置来源优先级：环境变量 > config.json > 内置默认值
   任何一步失败都返回 null，由调用方回落到规则文案。 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULTS = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:8090/v1',
  apiKey: '',
  model: '',
  temperature: 0.3,
  timeoutMs: 120000,
  maxTokens: 2500, // 推理型模型会先输出一大段思考，额度给小了正文 JSON 会被截断
  reasoningEffort: 'medium', // 开思考时固定 medium：思考过长会拖慢响应并挤占正文额度
  maxItemsPerPoll: 3,
  // 讲解（explain）单独一套：它要求输出更长（三段约 400 字），思考挤占更严重。
  // 实测同一模型讲一个指标：不传 effort 时思考约 1338 字、正文被挤到只剩 183 字；
  // 传 low 时思考降到约 480 字、正文 359 字且更快出字。minimal 本服务不支持（400）。
  explainMaxTokens: 4000,
  explainReasoningEffort: 'low',
};

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    // 配置文件缺失或损坏都不致命，走默认值
  }
  const c = Object.assign({}, DEFAULTS, file.llm || {});
  if (process.env.LLM_BASE_URL) c.baseUrl = process.env.LLM_BASE_URL;
  if (process.env.LLM_API_KEY) c.apiKey = process.env.LLM_API_KEY;
  if (process.env.LLM_MODEL) c.model = process.env.LLM_MODEL;
  if (process.env.LLM_ENABLED) c.enabled = process.env.LLM_ENABLED !== '0';
  return c;
}

/* 运行状态，供 /api/narrator 展示在页面上 */
const status = {
  enabled: false,
  baseUrl: '',
  model: '',
  ok: false,
  lastOkAt: null,
  lastError: null,
  generated: 0,
  failed: 0,
};

function setStatus(patch) {
  Object.assign(status, patch);
}

async function request(cfg, method, urlPath, body) {
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + urlPath;
  const res = await fetch(url, {
    method: method,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + (cfg.apiKey || 'sk-no-key'),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 25000),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
    throw new Error('HTTP ' + res.status + ' ' + detail);
  }
  return res.json();
}

async function listModels(cfg) {
  const j = await request(cfg, 'GET', '/models');
  const arr = (j && j.data) || [];
  return arr.map((m) => m.id || m.name).filter(Boolean);
}

let modelCache = null; // { baseUrl, model } —— 跟着 baseUrl 走，换服务就重新解析

async function resolveModel(cfg) {
  if (cfg.model) return cfg.model;
  if (modelCache && modelCache.baseUrl === cfg.baseUrl) return modelCache.model;
  const models = await listModels(cfg);
  if (!models.length) throw new Error('接口未返回任何模型');
  modelCache = { baseUrl: cfg.baseUrl, model: models[0] };
  return modelCache.model;
}

async function chat(cfg, messages) {
  const model = await resolveModel(cfg);
  const body = {
    model: model,
    messages: messages,
    temperature: Number(cfg.temperature) || 0.3,
    // 限长很关键：推理型模型会先吐一大段思考，额度给小了正文 JSON 会被截断
    max_tokens: Number(cfg.maxTokens) || 2500,
    stream: false,
  };
  // 只在显式配置时才传思考强度。实测：不传时思考量最少、响应最快（约 214 token / 17s），
  // 传 medium 会翻倍（约 584 token / 34s），high 本服务不支持（400）。
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
  const j = await request(cfg, 'POST', '/chat/completions', body);
  const choice = j && j.choices && j.choices[0];
  const content = choice && choice.message && choice.message.content;
  return { text: String(content || ''), model: model };
}

/* 从模型输出里尽量抠出 JSON；模型爱说废话时也不至于全丢 */
function extractJSON(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (e2) { return null; }
    }
    return null;
  }
}

const SYSTEM_PROMPT = [
  '你是大模型强化学习（RL）训练看板的解说员。观众是 AI 初学者，但他们的目标是真正学会知识点，不是听个热闹。',
  '',
  '核心原则：',
  '- 直接讲机制、讲因果、讲设计取舍。禁止用「就像考试一样」「好比练车」这类生活比喻来代替解释。',
  '- 术语照用（rollout、advantage、on-policy、checkpoint、MoE、熵坍缩…），但第一次出现时当场解释它在干什么。',
  '  术语本身就是知识点，不要为了「通俗」而回避它。',
  '- 讲「为什么这么设计」，而不只是「发生了什么」。能点出「牺牲了 A 换来了 B」最好。',
  '- 只使用 context / current_state 里给的数字，不确定就别编。',
  '',
  '给你一条训练监控事件（含规则版文案和原始数值 context），输出三段：',
  '',
  '1) text —— 一句话说清「发生了什么」。保留关键数字，禁止新增。不超过 70 字。',
  '2) why —— 2~3 句讲清「机制上为什么会发生、影响什么、要不要紧」。',
  '   要给出可判断的依据（指标的定义、正常范围、该看趋势还是单点），不要情绪安抚。不超过 150 字。',
  '3) lesson —— 教学段落，重点。借这次具体事件讲透一个背后的知识点。要求：',
  '   - 从本次事件出发，落到通用原理：这个机制叫什么、解决什么问题、代价是什么；',
  '   - 用真实术语并当场解释；讲清因果链或设计取舍；',
  '   - 能给数学直觉就给（例如 advantage 是组内相对分，全对全错时组内方差为 0，梯度随之归零）；',
  '   - 3~5 句，不超过 260 字；',
  '   - 纯状态播报没什么可教时，lesson 返回空字符串。',
  '',
  '可讲的方向（挑最贴合本次事件的一个讲透，不要贪多罗列）：',
  '   - GRPO 组内相对优势：同题采样 n 次用组内均值当基线，省掉独立 critic 网络；',
  '   - pr0/pr1 组内方差为 0 导致 advantage 归零、梯度消失；动态采样筛掉这类无效样本；',
  '   - rollout 与 training 分离：生成引擎与训练框架吞吐不匹配，故做异步流水线；',
  '   - 策略陈旧 staleness 与 TIS 截断重要性采样：用旧权重生成的数据如何校正分布偏移；',
  '   - checkpoint 存档：存权重、优化器状态与数据游标，所以崩了不等于白练；',
  '   - on-policy 与监督微调的本质区别：RL 数据由模型自己生成；',
  '   - 可验证奖励 vs 奖励模型、reward hacking 风险；熵坍缩；MoE 稀疏激活的收益与代价；',
  '   - avg@n 与 pass@k 评测指标的区别；一步为何几小时（长轨迹、attention 的 O(n²)）；花费构成。',
  '',
  'context 是本次事件前后的原始数值；current_state 是两个训练任务此刻的整体状况。',
  '需要举例或补充背景时可引用 current_state 里的数字，但不要说成是本次事件造成的变化。',
  '严格只输出 JSON：{"text":"...","why":"...","lesson":"..."}，不要任何解释、不要 markdown 代码块。',
].join('\n');

/* 一次完整的「调用 + 解析」。超时/网络抖动自动重试一次。 */
async function attempt(cfg, messages) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const out = await chat(cfg, messages);
      const parsed = extractJSON(out.text);
      if (!parsed || !parsed.text) {
        // 排查用：LLM_DEBUG=1 时打印模型原始返回，看是空、被截断还是格式不对
        if (process.env.LLM_DEBUG) {
          console.log('[llm-debug] 原始返回长度=' + String(out.text).length +
            '，内容=' + JSON.stringify(String(out.text).slice(0, 600)));
        }
        throw new Error('返回不是合法 JSON：' + String(out.text).slice(0, 80));
      }
      return {
        text: String(parsed.text).slice(0, 220),
        why: String(parsed.why || '').slice(0, 400),
        lesson: String(parsed.lesson || '').slice(0, 600),
        model: out.model,
      };
    } catch (e) {
      lastErr = e;
      const msg0 = String(e.message || e);
      const retryable = isModelError(e)
        || /aborted|timeout|fetch failed|ECONN|ETIMEDOUT|socket/i.test(msg0)
        // 空返回/正文被截断：换一次随机性常常就成功了，值得重试
        || /不是合法 JSON/i.test(msg0);
      if (i === 0 && retryable) {
        console.log('ai: 第 1 次失败（' + String(e.message || e).slice(0, 60) + '），重试一次');
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function isModelError(e) {
  return /model not found|invalid_model|unknown model|does not exist|no such model/i.test(String((e && e.message) || e));
}

/* 生成解说。失败一律返回 null —— 调用方保留规则文案，页面不空。
   snapshot 是此刻两个 run 的整体状态，供 AI 举例/补充背景用（可省略）。 */
async function narrate(event, snapshot) {
  const cfg = loadConfig();
  setStatus({ enabled: !!cfg.enabled, baseUrl: cfg.baseUrl });
  if (!cfg.enabled) {
    setStatus({ ok: false, lastError: '未启用（config.json 里 llm.enabled=false）' });
    return null;
  }

  const userPayload = {
    level: event.level,
    run: event.run || null,
    official: !!event.official,
    规则文案: event.text,
    规则解读: event.why || '',
    context: event.ctx || null,
    current_state: snapshot || null,
  };
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(userPayload, null, 1) },
  ];

  try {
    const out = await attempt(cfg, messages);
    setStatus({ ok: true, model: out.model, lastOkAt: Date.now() / 1000, lastError: null, generated: status.generated + 1 });
    return out;
  } catch (e) {
    // 模型没启/改名了：自动换一个当前可用的模型重试，避免整条链路哑掉
    if (isModelError(e)) {
      try {
        const models = await listModels(cfg);
        const alt = models.filter((m) => m !== cfg.model)[0];
        if (alt) {
          console.log(`ai: 模型 ${cfg.model} 不可用，自动改用 ${alt}`);
          const out = await attempt(Object.assign({}, cfg, { model: alt }), messages);
          setStatus({ ok: true, model: out.model, lastOkAt: Date.now() / 1000, lastError: null, generated: status.generated + 1 });
          return out;
        }
      } catch (e2) {
        // 换模型也失败，落到下面统一报错
      }
    }
    setStatus({
      ok: false,
      lastError: String(e.message || e).slice(0, 160),
      failed: status.failed + 1,
    });
    return null;
  }
}

/* 连通性自检，供 /api/ai/test 与服务端定期重连用。
   会把结果写进 status，页面据此显示「已接入 / 未启用 / 连接失败」。 */
async function probe() {
  const cfg = loadConfig();
  const base = { enabled: !!cfg.enabled, baseUrl: cfg.baseUrl };
  setStatus({ enabled: base.enabled, baseUrl: cfg.baseUrl, lastProbeAt: Date.now() / 1000 });
  if (!base.enabled) {
    setStatus({ ok: false, lastError: '未启用（config.json 里 llm.enabled=false）' });
    return Object.assign(base, { ok: false, error: '未启用' });
  }
  try {
    const models = await listModels(cfg);
    setStatus({ ok: true, lastError: null, model: cfg.model || models[0] || '' });
    return Object.assign(base, { ok: true, models: models, count: models.length });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 200);
    setStatus({ ok: false, lastError: msg });
    return Object.assign(base, { ok: false, error: msg });
  }
}

/* ================================================================
   指标讲解（流式吐字）
   与 narrate 的区别：narrate 是等全部生成完再解析 JSON；
   这里要边生成边回传给前端，所以走 SSE 流、输出纯文本段落。
   ================================================================ */

const EXPLAIN_SYSTEM = [
  '你是大模型强化学习（RL）训练看板的讲解员。观众点开了某个指标，已经读过该指标的固定讲解',
  '（在 static 字段里），现在想听你结合「此刻的真实数据」再讲一遍。',
  '',
  '核心原则：',
  '- 重点放在「这些数字现在说明了什么」，而不是重新定义这个指标。',
  '  static 里已经讲过的定义不要复述，观众看过了。',
  '- 禁止用「就像考试一样」「好比练车」这类生活比喻代替解释。直接讲机制、讲因果、讲设计取舍。',
  '- 术语照用（rollout、advantage、on-policy、熵坍缩、KL、重要性采样…），',
  '  首次出现时当场解释它在干什么。术语本身就是知识点，不要为了「通俗」而回避。',
  '- 只使用 data 里给的数字。没有的数字不要编，也不要臆测没给出信息的原因。',
  '- 语气平实，不煽情，不用「值得注意的是」「综上所述」这类套话。',
  '',
  '输出三段纯文本，段落之间空一行。不要 markdown 标题符号、不要列表符号、不要代码块。',
  '',
  '第 1 段：这个数现在处在什么状态。要结合具体数字——当前值、相对第一步变化了多少、',
  '  在历史最高与最低之间处于什么位置、最近一步往哪个方向走。',
  '第 2 段：从机制上解释为什么会是这样、意味着什么。讲清因果链或设计取舍，',
  '  能给数学直觉就给（例如 advantage 是组内相对分，全对全错时组内方差为 0、梯度归零）。',
  '第 3 段：接下来该盯什么——配套看哪个指标、什么样的变化才算异常、什么情况其实不必紧张。',
  '',
  '每段 2~4 句，全文不超过 400 字。',
].join('\n');

/* SSE 流式读取。逐块解析 `data:` 行：
   推理型模型先吐思考（reasoning_content / reasoning）再吐正文（content），
   两者分开回调，前端只把正文上屏。onDelta/onThink 返回 false 表示客户端已断开，
   立刻停止读取并取消流，不再浪费 token。 */
async function streamChat(cfg, messages, onDelta, onThink, effort) {
  const model = await resolveModel(cfg);
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model,
    messages: messages,
    temperature: Number(cfg.temperature) || 0.3,
    // 额度给足：讲解的提示词带固定文案底稿，比解说长得多，
    // 思考一旦吃满额度正文就一个字都出不来（实测过）。
    max_tokens: Number(cfg.explainMaxTokens) || 4000,
    stream: true,
  };
  // effort 由调用方指定；为空则不传，交给服务默认行为
  if (effort) body.reasoning_effort = effort;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + (cfg.apiKey || 'sk-no-key'),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 120000),
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
    throw new Error('HTTP ' + res.status + ' ' + detail);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let stop = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (t.indexOf('data:') !== 0) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        const d = j && j.choices && j.choices[0] && j.choices[0].delta;
        if (!d) continue;
        const think = typeof d.reasoning_content === 'string' ? d.reasoning_content
          : (typeof d.reasoning === 'string' ? d.reasoning : '');
        if (think && onThink && onThink(think) === false) { stop = true; break; }
        if (typeof d.content === 'string' && d.content && onDelta(d.content) === false) { stop = true; break; }
      }
      if (stop) break;
    }
  } finally {
    if (stop) { try { await reader.cancel(); } catch (e) { /* ignore */ } }
  }
  return model;
}

/* 讲解某个指标。payload 由前端组装（含该指标的固定文案与实时数值）。
   onDelta 收到正文片段，onThink 收到思考过程。失败一律抛错，由调用方降级。 */
async function explainMetric(payload, onDelta, onThink) {
  const cfg = loadConfig();
  setStatus({ enabled: !!cfg.enabled, baseUrl: cfg.baseUrl });
  if (!cfg.enabled) {
    setStatus({ ok: false, lastError: '未启用（config.json 里 llm.enabled=false）' });
    throw new Error('AI 未启用（config.json 里 llm.enabled=false）');
  }
  const messages = [
    { role: 'system', content: EXPLAIN_SYSTEM },
    { role: 'user', content: JSON.stringify(payload, null, 1) },
  ];
  const effort = cfg.explainReasoningEffort || 'low';
  try {
    let model;
    try {
      model = await streamChat(cfg, messages, onDelta, onThink, effort);
    } catch (e1) {
      // 有的服务不认某个 reasoning_effort（会返回 400）。这时候还没开始吐字，
      // 去掉该参数重试是安全的，不会把内容重复推给前端。
      if (/HTTP 400/.test(String(e1.message || e1))) {
        console.log('ai explain: reasoning_effort=' + effort + ' 不被支持，去掉后重试');
        model = await streamChat(cfg, messages, onDelta, onThink, null);
      } else {
        throw e1;
      }
    }
    setStatus({ ok: true, model: model, lastOkAt: Date.now() / 1000, lastError: null, generated: status.generated + 1 });
    return { model: model };
  } catch (e) {
    // 模型名不对时自动换一个可用的再试一次
    if (isModelError(e)) {
      try {
        const models = await listModels(cfg);
        const alt = models.filter((m) => m !== cfg.model)[0];
        if (alt) {
          console.log(`ai explain: 模型 ${cfg.model} 不可用，自动改用 ${alt}`);
          const model = await streamChat(Object.assign({}, cfg, { model: alt }), messages, onDelta, onThink, effort);
          setStatus({ ok: true, model: model, lastOkAt: Date.now() / 1000, lastError: null, generated: status.generated + 1 });
          return { model: model };
        }
      } catch (e2) {
        // 换模型也失败，落到下面统一报错
      }
    }
    setStatus({ ok: false, lastError: String(e.message || e).slice(0, 160), failed: status.failed + 1 });
    throw e;
  }
}

module.exports = { loadConfig, narrate, probe, status, listModels, explainMetric };
