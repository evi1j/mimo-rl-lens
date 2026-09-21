/* 本地 OpenAI 兼容接口调用层（仅服务端使用）
   配置来源优先级：环境变量 > config.json > 内置默认值
   任何一步失败都返回 null，由调用方回落到规则文案。 */

const fs = require('fs');
const path = require('path');
const { at } = require('./paths.js');

const CONFIG_FILE = at('config.json');

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
  // 工具轮：给 AI 配本地查询工具，让它自己决定查什么
  explainUseTools: true,
  toolMaxTokens: 800, // 工具轮只要输出 tool_calls，不需要长文本
  /* 重试（分层，不是整条重来）：
     讲解链路有两段——工具轮查数据、正文轮写讲解。任何一段都可能被网络抖动、
     上游 5xx、思考吃满额度（正文空）、流中途断连打断。整条重跑代价最大：
     查到的数据要再查一遍、观众要多等一倍时间。所以按环节分别重试。
     下面三项都可在 config.json 的 llm 段覆盖。 */
  retryMax: 2,             // 单个请求在「还没吐出任何内容」时的重试次数
  bodyAttempts: 3,         // 正文轮最多尝试几次（含首次）；3 = 首次 + 2 次重试
  enoughChars: 200,        // 正文到这个字数就算讲成了；不到就判定不完整再试
  retryBackoffMs: 800,     // 重试间隔基数，逐次翻倍
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

async function requestOnce(cfg, method, urlPath, body) {
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

/* 哪些错误值得原样再试一次：网络类、限流、服务端错误。
   4xx（尤其 400）不重试——那是参数问题，原样重试只会再错一次，
   要交给上层换参数（比如去掉 reasoning_effort）。 */
function isRetryable(e) {
  const m = String((e && e.message) || e);
  if (/HTTP (429|500|502|503|504)/.test(m)) return true;
  if (/fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ETIME|EAI_AGAIN|socket hang up|terminated|network|timed out|timeout|aborted/i.test(m)) return true;
  return false;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function backoffMs(i, cfg) {
  const base = Number(cfg && cfg.retryBackoffMs) || 800;
  return Math.round(base * Math.pow(2, i));
}

/* 非流式请求：失败就退避重试，上限 retryMax 次。 */
async function request(cfg, method, urlPath, body) {
  const tries = Math.max(0, Number(cfg.retryMax) || 0);
  let last = null;
  for (let i = 0; i <= tries; i++) {
    try {
      return await requestOnce(cfg, method, urlPath, body);
    } catch (e) {
      last = e;
      if (i === tries || !isRetryable(e)) break;
      console.log('ai: 请求失败（' + String(e.message || e).slice(0, 60) + '），' +
        backoffMs(i, cfg) + 'ms 后重试 ' + (i + 1) + '/' + tries);
      await sleep(backoffMs(i, cfg));
    }
  }
  throw last;
}

/* 流式请求：只在「连接阶段」重试（fetch 报错或非 2xx）。
   一旦开始读流就可能有内容已经推给前端，这时再重连会把内容重复一遍，
   所以流读到一半断开不在这里重试，交给上层按「已吐出多少」决定要不要重跑。 */
async function streamFetch(cfg, body, tries) {
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  let last = null;
  for (let i = 0; i <= tries; i++) {
    try {
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
      return res;
    } catch (e) {
      last = e;
      if (i === tries || !isRetryable(e)) break;
      console.log('ai: 流式连接失败（' + String(e.message || e).slice(0, 60) + '），' +
        backoffMs(i, cfg) + 'ms 后重试 ' + (i + 1) + '/' + tries);
      await sleep(backoffMs(i, cfg));
    }
  }
  throw last;
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

/* 讲解提示词分两截拼：
     EXPLAIN_BASE    三类共用的原则、工具说明、输出格式要求
     EXPLAIN_OUTLINE 按 data.kind 换的开场句与三段式大纲
   为什么必须分：讲一个训练指标、讲一套离线评测基准、讲指标库里某个没有
   文案的原始指标，该说的话完全不同 —— 前者重点是「这个数现在说明什么」，
   基准要讲清「它不参与训练、只做泛化检验」，而指标库指标连「它是什么」
   都得先查了才知道。用同一套大纲会让模型对着评测分数讲训练机制。 */
const EXPLAIN_BASE = [
  '核心原则：',
  '- 重点放在「这些数字现在说明了什么」，而不是重新定义被讲的对象。',
  '  static 里已经写过的定义不要复述，观众看过了。',
  '- 禁止用「就像考试一样」「好比练车」这类生活比喻代替解释。直接讲机制、讲因果、讲设计取舍。',
  '- 术语照用（rollout、advantage、on-policy、熵坍缩、KL、重要性采样…），',
  '  首次出现时当场解释它在干什么。术语本身就是知识点，不要为了「通俗」而回避。',
  '- 只使用 data 里给的数字，或你用工具查回来的数字。没有的不要编，也不要臆测没给出信息的原因。',
  '- 语气平实，不煽情，不用「值得注意的是」「综上所述」这类套话。',
  '',
  '你有工具可以查真实数据，优先级高于 data 里预置的摘要：',
  '- list_metrics：按名字检索指标。**引用任何指标名前先用它确认存在**，不要凭记忆写名字。',
  '- query_series：查某个指标每一步的历史值。data 里只有最近若干步，要看趋势/拐点/波动范围就用它。',
  '- run_status：查训练进度、阶段、每步样本规模、累计花费，用来判断「现在训练到哪了」。',
  '- query_bench：查评测分数，把训练指标和最终效果连起来看。',
  '工具返回 error 就是没查到——换名字或换个角度，绝不能编造没查到的数据。',
  '',
  '查数据只在开讲前的工具阶段进行，请把要用的数据一次查全。',
  '开写正文后不要再请求查数据，也不要输出任何标签、代码或工具调用格式，只写自然段落。',
  '最终给观众的讲解必须出现在 content/正文字段里；reasoning_content 只放你的内部推导，观众看不到它。',
].join('\n');

const EXPLAIN_OUTLINE = {
  metric: [
    '你是大模型强化学习（RL）训练看板的讲解员。观众点开了某个训练指标，已经读过它的固定讲解',
    '（在 static 字段里），现在想听你结合「此刻的真实数据」再讲一遍。',
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
  ].join('\n'),

  bench: [
    '你是大模型强化学习（RL）训练看板的讲解员。观众点开了某套离线评测基准的图表，',
    'data.series 里是各个 run 在这套题上的分数随训练步的变化，static.desc 是它的固定说明。',
    '现在想听你结合「此刻的真实分数」再讲一遍。',
    '',
    '有一层关系必须讲透：这套分数不参与梯度更新。它是每隔若干步拿当时的存档点去跑一遍标准题，',
    '作用是对泛化做独立检验 —— 训练奖励涨而这里不动，说明模型在拟合训练分布而不是真的变强。',
    '另外评测点是离散的（每隔若干步一次），不要当成连续曲线去解读某一次的小波动。',
    '',
    '输出三段纯文本，段落之间空一行。不要 markdown 标题符号、不要列表符号、不要代码块。',
    '',
    '第 1 段：各 run 现在跑多少分。逐条说清最新分数、相对第一次评测累计涨了多少、',
    '  最近一次是涨还是跌，以及这个分数落在历史区间（min~max）的什么位置。',
    '第 2 段：从机制上解释这套题在考什么能力、分数为什么是这种走势。',
    '  同一张图上的多个 run 用同一套方法不同配置跑，互为对照，把它们的差异放在一起说。',
    '  需要看训练侧是否同步变化时，用 query_series 查对应训练指标再下判断。',
    '第 3 段：接下来该盯什么。什么样算健康（稳步抬升、偶尔平台），什么要警惕（长期横盘、',
    '  run 之间差距持续拉大），以及为什么不同基准之间涨落不同步是正常的。',
    '',
    '每段 2~4 句，全文不超过 400 字。多用具体分数，不要只说「稳步提升」。',
  ].join('\n'),

  tag: [
    '你是大模型强化学习（RL）训练看板的讲解员。观众点开了指标库里的一个训练指标。',
    '这些是 trainer 上报的原始监控量，总共几百个，绝大多数没有预先写好的讲解',
    '（static 为 null，data.metric 是它在指标库里的真实名字）。',
    '',
    '所以这次比讲常规指标多两道工序，请按顺序做：',
    '1) 用 list_metrics 按 data.metric 检索，确认这个指标确实存在，并看清它的同类指标',
    '   —— 同一前缀的往往是一族，知道同族还有谁才能说清它在监控什么。',
    '2) 用 query_series 查它的历史序列。**这一步不能省**：data.recent 只有最近十几步，',
    '   不足以判断趋势、拐点和正常波动范围。',
    '3) 如果它和训练进度或算力开销有关（耗时、吞吐、token 量这类），用 run_status 拿到',
    '   当前步数与阶段做参照。',
    '',
    '输出三段纯文本，段落之间空一行。不要 markdown 标题符号、不要列表符号、不要代码块。',
    '',
    '第 1 段：说清这个指标度量什么（从名字的路径层级和同族指标推断，把推断依据说出来），',
    '  以及它现在的数值状态——当前值、变化方向、在你查到的历史区间里处于什么位置。',
    '第 2 段：从机制上解释这个量由什么决定、为什么会这样波动，和哪些环节有因果关系，',
    '  异常时通常意味着什么。',
    '第 3 段：接下来该盯什么。它该和哪个主指标配套看（例如耗时类要和吞吐类一起看），',
    '  什么范围算正常、什么情况值得去查。',
    '',
    '每段 2~4 句，全文不超过 400 字。名字里的层级信息（前缀路径）是理解它的关键线索。',
  ].join('\n'),
};

/* 按 data.kind 选大纲；缺 kind（老前端缓存、手工调用）时按单个指标处理 */
function explainSystem(payload) {
  const kind = (payload && payload.kind) || 'metric';
  return EXPLAIN_BASE + '\n\n' + (EXPLAIN_OUTLINE[kind] || EXPLAIN_OUTLINE.metric);
}

/* ================================================================
   查询工具（function calling）
   让模型自己决定要查什么，而不是我们猜它要什么。
   数据来自本地 SQLite（store.js），所以完全离线、不额外打上游。
   ================================================================ */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_metrics',
      description: '按名字检索可用指标，返回准确的指标名、单位和含义。引用任何指标名前都要先用它确认存在，避免写错名字。不传 q 时返回看板置顶的重点指标。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '指标名前缀或片段，如 dynsam、actor、timing_s/rollout。前缀越短命中越多。' },
          limit: { type: 'integer', description: '最多返回多少条，默认 30，上限 200' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_series',
      description: '查询某个指标每一步的历史数值，用来看趋势、拐点、波动范围、最高最低出现在第几步。',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '指标名，必须先经 list_metrics 确认存在' },
          run: { type: 'string', description: '训练任务 pro 或 flash；不传则同时返回两个 run' },
          from: { type: 'integer', description: '只看第几步之后的数据，可选' },
        },
        required: ['tag'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_status',
      description: '查询训练任务的整体状态：当前第几步、进度百分比、阶段、重启次数、每步训练样本数、每步 prompt 数、累计花费。用来判断训练进行到什么阶段、规模多大。',
      parameters: {
        type: 'object',
        properties: {
          run: { type: 'string', description: 'pro 或 flash；不传则返回全部' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_bench',
      description: '查询离线评测分数（每个评测在每个训练步的得分），用来把训练过程指标和最终效果联系起来。不传 bench 时返回有哪些评测。',
      parameters: {
        type: 'object',
        properties: {
          bench: { type: 'string', description: '评测名，如 deepswe；不传返回评测列表' },
          run: { type: 'string', description: 'pro 或 flash' },
        },
        required: [],
      },
    },
  },
];

const MAX_TOOL_ROUNDS = 3;     // 工具轮上限，防止模型绕圈子
const SERIES_MAX_POINTS = 80;  // 序列最多回传多少点，超过就等距抽样

/* 序列太长时等距抽样，首末点必留 */
function samplePoints(rows) {
  if (rows.length <= SERIES_MAX_POINTS) return rows;
  const out = [];
  for (let i = 0; i < SERIES_MAX_POINTS; i++) {
    out.push(rows[Math.round(i * (rows.length - 1) / (SERIES_MAX_POINTS - 1))]);
  }
  return out;
}

/* 给前端看的一行摘要，不要把整个结果塞过去 */
function summarizeToolResult(name, res) {
  if (!res) return '无返回';
  if (res.error) return '没查到：' + String(res.error).slice(0, 80);
  if (name === 'list_metrics') return '匹配到 ' + res.count + ' 个指标';
  if (name === 'query_series') {
    return res.tag + '（' + res.run + '）' + res.points + ' 个数据点' + (res.sampled ? '，已抽样' : '');
  }
  if (name === 'run_status') {
    return (res.runs || []).map(function (r) {
      return r.run + ' 第' + r.step + '步' + (r.progress != null ? ' 进度' + (r.progress * 100).toFixed(1) + '%' : '');
    }).join('，');
  }
  if (name === 'query_bench') return (res.rows || []).length + ' 条评测分数';
  return '已返回';
}

/* 真正执行工具。查不到必须返回明确 error —— 让模型换名字重试，
   而不是静默失败后硬编一个不存在的指标出来。 */
function runTool(name, args) {
  let store;
  try { store = require('./store.js'); } catch (e) { return { error: '本地数据层不可用' }; }
  args = args || {};

  if (name === 'list_metrics') {
    const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
    const rows = store.searchTags(String(args.q || ''), { limit: lim });
    if (!rows.length) {
      return { error: '没有匹配到任何指标（q="' + String(args.q || '') + '"）。换更短的前缀再试，如 dynsam、actor、timing_s、critic。' };
    }
    return {
      count: rows.length,
      metrics: rows.map(function (r) {
        return { tag: r.tag, unit: r.unit || '', descr: r.descr || '' };
      }),
    };
  }

  if (name === 'query_series') {
    const tag = String(args.tag || '');
    if (!tag) return { error: '缺少 tag 参数' };
    const rows = store.querySeries(args.run || null, tag, args.from != null ? Number(args.from) : null);
    if (!rows.length) {
      return { error: '库里没有 ' + tag + ' 的历史数据（run=' + (args.run || '全部') + '）。先用 list_metrics 确认准确名字，或换个 run 试试。' };
    }
    return {
      tag: tag, run: args.run || 'pro+flash', points: rows.length,
      sampled: rows.length > SERIES_MAX_POINTS,
      series: samplePoints(rows).map(function (r) { return [r.step, r.v]; }),
    };
  }

  if (name === 'run_status') {
    const rows = store.queryRunState(args.run || null);
    if (!rows.length) return { error: '库里还没有训练状态快照' };
    return {
      runs: rows.map(function (r) {
        return {
          run: r.run, step: r.step, progress: r.progress, phase: r.phase,
          restarts: r.restarts, trained_step: r.trained_step,
          prompts_per_step: r.prompts_per_step, cost_so_far: r.cost_so_far,
        };
      }),
    };
  }

  if (name === 'query_bench') {
    const rows = store.queryBench(args.bench || null, args.run || null);
    if (!rows.length) return { error: '没有匹配的评测数据（bench=' + (args.bench || '全部') + '）' };
    return { bench: args.bench || 'all', count: rows.length, rows: rows };
  }

  return { error: '没有名为 ' + name + ' 的工具。可用：list_metrics、query_series、run_status、query_bench' };
}

/* 兜底：个别情况下模型会在正文里写 <tool_call>…</tool_call> 标签（它想再查数据
   但没被允许）。这类标签对观众毫无意义，直接剥掉。流式会把标签拆到多个 chunk，
   所以要把「可能是标签开头但还没收全」的尾部扣住等下一块。 */
const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';

function filterToolCallText(onDelta) {
  let drop = false;
  let hold = '';
  return function (chunk) {
    let s = hold + String(chunk == null ? '' : chunk);
    hold = '';
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (!drop) {
        const a = s.indexOf('<', i);
        if (a < 0) { out += s.slice(i); break; }
        out += s.slice(i, a);
        const tail = s.slice(a);
        if (tail.indexOf(TOOL_CALL_OPEN) === 0) { drop = true; i = a + TOOL_CALL_OPEN.length; }
        else if (tail.length < TOOL_CALL_OPEN.length && TOOL_CALL_OPEN.indexOf(tail) === 0) {
          hold = tail; break; // 像标签开头但没收全，扣住等下一块再判断
        } else { out += '<'; i = a + 1; }
      } else {
        const b = s.indexOf(TOOL_CALL_CLOSE, i);
        if (b < 0) {
          const tail = s.slice(i);
          hold = TOOL_CALL_CLOSE.indexOf(tail) === 0 ? tail : '';
          break;
        }
        i = b + TOOL_CALL_CLOSE.length;
        drop = false;
      }
    }
    if (!out) return true;
    return onDelta(out) !== false;
  };
}

/* 非流式调用，只为了拿到 tool_calls。工具轮必须非流式——要先收完调用参数才能执行。 */
async function toolChat(cfg, messages, toolChoice) {
  const model = await resolveModel(cfg);
  const body = {
    model: model,
    messages: messages,
    tools: TOOLS,
    temperature: 0, // 这一轮只要它选对工具和参数，不需要创造性
    max_tokens: Number(cfg.toolMaxTokens) || 800,
    stream: false,
  };
  if (toolChoice) body.tool_choice = toolChoice;
  const j = await request(cfg, 'POST', '/chat/completions', body);
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  return { calls: (msg && msg.tool_calls) || [], content: (msg && msg.content) || '', model: model };
}

/* 流式工具轮：既要拿到 tool_calls，也要把「决定查什么」的思考逐块吐给前端。
   实测：该模型流式下约 0.5s 就开始吐 reasoning_content，tool_calls 要到 3s 左右
   才发出来。非流式等于让用户对着空白干等整段，还白白丢掉这段思考。
   增量累积：arguments 是分块到达的字符串，必须按 index 拼接后才是完整 JSON。 */
async function streamToolChat(cfg, messages, toolChoice, onThink) {
  const model = await resolveModel(cfg);
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model,
    messages: messages,
    tools: TOOLS,
    temperature: 0, // 这一轮只要它选对工具和参数，不需要创造性
    // 流式下思考也占额度，比非流式给足一些，免得思考写完 tool_calls 被截断
    max_tokens: Number(cfg.toolMaxTokens) || 1200,
    stream: true,
  };
  if (toolChoice) body.tool_choice = toolChoice;
  const res = await streamFetch(cfg, body, Math.max(0, Number(cfg.retryMax) || 0));

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let stop = false;
  const calls = {};
  let content = '';
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
        if (typeof d.content === 'string' && d.content) content += d.content;
        const tcs = d.tool_calls || [];
        for (const tc of tcs) {
          const i = tc.index || 0;
          if (!calls[i]) calls[i] = { id: '', name: '', args: '' };
          if (tc.id) calls[i].id += tc.id;
          const fn = tc.function || {};
          if (fn.name) calls[i].name += fn.name;
          if (typeof fn.arguments === 'string') calls[i].args += fn.arguments;
        }
      }
      if (stop) break;
    }
  } finally {
    if (stop) { try { await reader.cancel(); } catch (e) { /* ignore */ } }
  }
  const list = Object.keys(calls).sort(function (a, b) { return Number(a) - Number(b); })
    .map(function (k) {
      return {
        id: calls[k].id,
        function: { name: calls[k].name, arguments: calls[k].args },
      };
    });
  return { calls: list, content: content, model: model, aborted: stop };
}

/* 工具轮：让模型先用工具查数据，再写正文。返回实际跑了几轮。
   任何一步失败都降级为「不查工具直接讲」，绝不把整条讲解链路打断。 */
async function toolPhase(cfg, messages, onTool, onThink) {
  let rounds = 0;
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
    /* 一轮 = 模型想一次 + 紧接着的若干次调用。把它编号带给前端，
       前端才能把「决策 → 调用」按轮分组，而不是把同轮的几次调用拆成几组。 */
    const rn = i + 1;
    const onThinkR = onThink ? function (t, ph) { return onThink(t, ph || 'tool', rn); } : null;
    const onToolR = onTool ? function (info) {
      return onTool(Object.assign({ round: rn }, info));
    } : null;
    let out;
    try {
      // 工具轮单独压低超时：它应当秒回，不该占满讲解的时间预算
      out = await streamToolChat(
        Object.assign({}, cfg, { timeoutMs: 30000 }),
        messages,
        rounds === 0 ? 'required' : 'auto',
        onThinkR
      );
    } catch (e) {
      // 流式工具轮不通（服务不支持 / 参数不认）就退回非流式，别直接放弃查数据
      console.log('ai explain: 流式工具轮不可用（' + String(e.message || e).slice(0, 60) + '），回退非流式');
      try {
        out = await toolChat(
          Object.assign({}, cfg, { timeoutMs: 30000 }),
          messages,
          rounds === 0 ? 'required' : 'auto'
        );
      } catch (e2) {
        console.log('ai explain: 工具调用不可用（' + String(e2.message || e2).slice(0, 60) + '），改为直接讲解');
        return rounds;
      }
    }
    if (out.aborted) return rounds; // 客户端已断开
    const calls = out.calls || [];
    if (!calls.length) return rounds; // 模型不查了，直接写正文

    messages.push({ role: 'assistant', content: out.content || '', tool_calls: calls });
    for (const c of calls) {
      const fn = c.function || {};
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch (e) { args = {}; }
      const res = runTool(fn.name, args);
      if (onToolR && onToolR({
        name: fn.name, args: args, summary: summarizeToolResult(fn.name, res),
      }) === false) return rounds; // 客户端已断开
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(res) });
    }
    rounds++;
  }
  return rounds;
}

/* SSE 流式读取。逐块解析 `data:` 行：
   推理型模型先吐思考（reasoning_content / reasoning）再吐正文（content），
   两者分开回调，前端只把正文上屏。onDelta/onThink 返回 false 表示客户端已断开，
   立刻停止读取并取消流，不再浪费 token。 */
async function streamChat(cfg, messages, onDelta, onThink, opts) {
  opts = opts || {};
  const model = await resolveModel(cfg);
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model,
    messages: messages,
    temperature: Number(cfg.temperature) || 0.3,
    // 额度由调用方给（重试时会逐次加大），默认取自配置
    max_tokens: Number(opts.maxTokens || cfg.explainMaxTokens) || 4000,
    stream: true,
  };
  // effort 由调用方指定；为空则不传，交给服务默认行为
  if (opts.effort) body.reasoning_effort = opts.effort;
  // 跑过工具轮后必须强制它出正文：否则它可能又去调工具，正文一个字都没有
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  const res = await streamFetch(cfg, body, Math.max(0, Number(cfg.retryMax) || 0));

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let stop = false;
  let chars = 0; // 已吐出的正文字数：流断掉时靠它判断要不要重跑
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
        if (typeof d.content === 'string' && d.content) {
          chars += d.content.length;
          if (onDelta(d.content) === false) { stop = true; break; }
        }
      }
      if (stop) break;
    }
  } catch (e) {
    // 流中途出错：把「已经吐了多少」带给上层，由它决定是重跑还是就此收下
    e.partialChars = chars;
    throw e;
  } finally {
    if (stop) { try { await reader.cancel(); } catch (e) { /* ignore */ } }
  }
  return { model: model, chars: chars, aborted: stop };
}

/* 讲解某个指标。payload 由前端组装（含该指标的固定文案与实时数值）。
   onDelta 收到正文片段，onThink 收到思考过程。失败一律抛错，由调用方降级。 */
async function explainMetric(payload, onDelta, onThink, onTool, hooks) {
  const cfg = loadConfig();
  setStatus({ enabled: !!cfg.enabled, baseUrl: cfg.baseUrl });
  if (!cfg.enabled) {
    setStatus({ ok: false, lastError: '未启用（config.json 里 llm.enabled=false）' });
    throw new Error('AI 未启用（config.json 里 llm.enabled=false）');
  }
  const messages = [
    { role: 'system', content: explainSystem(payload) },
    { role: 'user', content: JSON.stringify(payload, null, 1) },
  ];
  const effort = cfg.explainReasoningEffort || 'low';

  /* 先跑工具轮：模型自己决定查什么。失败一律降级成「不查工具直接讲」，
     绝不能把整条讲解链路打断。 */
  let rounds = 0;
  let aborted = false;
  if (cfg.explainUseTools !== false) {
    const onToolSafe = onTool ? function (info) {
      if (onTool(info) === false) { aborted = true; return false; }
      return true;
    } : null;
    // 工具轮的思考标记成 'tool'，前端放进「查询决策」区，跟后面分析数据的思考分开
    const onThinkTool = onThink ? function (t, ph, rn) { return onThink(t, 'tool', rn); } : null;
    rounds = await toolPhase(cfg, messages, onToolSafe, onThinkTool);
    if (rounds) console.log('ai explain: 工具轮 ' + rounds + ' 次，随后生成正文');
    if (aborted) return { model: '', toolRounds: rounds, aborted: true };
  }

  /* 流式轮刻意不再传 tools / tool_choice。
     实测：带 tools 时模型会忍不住继续「要查数据」，而 tool_choice=none 又不给它
     结构化调用，它就退化成在正文里写 <tool_call> 标签——观众看到的是一堆 XML
     而不是讲解。工具结果已经在上下文里，够它用了。 */

  /* 正文轮重试：这里是最容易「白跑一趟」的地方——推理模型把额度全花在思考上，
     正文一个字都没有。每次重试都换一套更保守的参数，而不是原样再来一遍：
     第 1 次失败 → 去掉 reasoning_effort（实测不传时思考最少）并加额度；
     第 2 次失败 → 再加额度，并显式要求「直接给结论，别长篇推导」。
     注意：只重跑正文轮，工具轮查到的数据留在 messages 里不重查。 */
  const attempts = Math.max(1, Number(cfg.bodyAttempts) || 3);
  const enough = Math.max(1, Number(cfg.enoughChars) || 200);
  hooks = hooks || {};
  const notify = function (msg) { if (typeof hooks.onNotice === 'function') hooks.onNotice(msg); };

  let model = '';
  let lastErr = null;
  let switched = false;
  let curCfg = cfg;

  for (let a = 0; a < attempts; a++) {
    const n = a + 1;
    const st = bodyStrategy(a, cfg, effort);
    // 告诉前端：上一次的内容先收起来（不是丢掉），下面接着生成新的
    if (a > 0) {
      if (st.notice) notify(st.notice);
      if (typeof hooks.onRestart === 'function') hooks.onRestart({ attempt: n, reason: st.reason });
    }
    const msgs = st.extra ? messages.concat([{ role: 'user', content: st.extra }]) : messages;
    const onDeltaSafe = filterToolCallText(onDelta || function () { return true; });
    try {
      const r = await streamChat(curCfg, msgs, onDeltaSafe, onThink,
        { effort: st.effort, maxTokens: st.maxTokens });
      model = r.model || model;
      if (r.aborted) return { model: model, toolRounds: rounds, attempts: n, aborted: true };
      if (r.chars >= enough) {
        setStatus({ ok: true, model: model, lastOkAt: Date.now() / 1000, lastError: null, generated: status.generated + 1 });
        return { model: model, toolRounds: rounds, attempts: n };
      }
      lastErr = new Error('正文过短（' + r.chars + ' 字 < ' + enough + '）');
      console.log('ai explain: 第 ' + n + ' 次正文只有 ' + r.chars + ' 字，判定不完整');
    } catch (e) {
      const got = Number(e.partialChars || 0);
      // 断连但已经讲出足够内容：当作讲成了。重跑会让观众把已有的字再看一遍，
      // 而且断的多半只是结尾，为此再烧一次生成不值
      if (got >= enough) {
        console.log('ai explain: 流在第 ' + n + ' 次中断，已吐出 ' + got + ' 字，按可用处理');
        setStatus({ ok: true, model: model, lastOkAt: Date.now() / 1000, lastError: null, generated: status.generated + 1 });
        return { model: model, toolRounds: rounds, attempts: n, truncated: true };
      }
      lastErr = e;
      // 模型名不对：换一个可用的模型再试，不额外消耗退避
      if (isModelError(e) && !switched) {
        try {
          const models = await listModels(curCfg);
          const alt = models.filter((m) => m !== curCfg.model)[0];
          if (alt) {
            console.log('ai explain: 模型 ' + (curCfg.model || '-') + ' 不可用，自动改用 ' + alt);
            curCfg = Object.assign({}, curCfg, { model: alt });
            switched = true;
            continue;
          }
        } catch (e2) { /* 换个模型也失败，按普通错误处理 */ }
      }
      // 400 是参数问题：下一轮本来就会去掉 effort，继续即可；其余不可重试的错误直接放弃
      if (!isRetryable(e) && !/HTTP 400/.test(String(e.message || e))) break;
      console.log('ai explain: 第 ' + n + ' 次生成失败（' + String(e.message || e).slice(0, 60) + '）');
    }
    if (a < attempts - 1) await sleep(backoffMs(a, cfg));
  }

  setStatus({ ok: false, lastError: String((lastErr && lastErr.message) || lastErr).slice(0, 160), failed: status.failed + 1 });
  throw lastErr || new Error('讲解生成失败');
}

/* 正文轮每次尝试的参数：越往后越「催它出正文」。 */
function bodyStrategy(attempt, cfg, effort) {
  const base = Number(cfg.explainMaxTokens) || 4000;
  if (attempt === 0) {
    return { effort: effort, maxTokens: base, reason: '', notice: '' };
  }
  if (attempt === 1) {
    return {
      effort: null, // 实测：不传 effort 时思考量最少，正文最容易被挤出来
      maxTokens: Math.round(base * 1.25),
      reason: 'short',
      notice: '第一次没写出正文，降低思考强度再试一次',
    };
  }
  return {
    effort: null,
    maxTokens: Math.round(base * 1.5),
    reason: 'short',
    notice: '正文仍不完整，最后一次尝试：直接给结论',
    extra: '注意：上一次你只输出了思考、正文几乎没写。' +
      '这一次请直接输出给观众看的讲解正文，250~450 字，不要长篇推导。',
  };
}

module.exports = {
  loadConfig, narrate, probe, status, listModels, explainMetric,
  explainSystem,   // 按 data.kind 产出系统提示词，导出是为了能单独验证分流
  TOOLS, runTool, summarizeToolResult, toolChat,
  isRetryable, bodyStrategy,
};
