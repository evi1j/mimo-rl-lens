# mimo-rl-lens

抓取小米 [MiMo-V2.6 公开训练直播](https://mimo.xiaomi.com/rl/) 的强化学习训练数据，在本地看板上实时展示，
并让 AI 告诉你**这些指标该怎么看**。

> 使用手册（怎么跑、怎么看图、常见问题）在 [`deploy/README.md`](deploy/README.md)。
> 这份 README 面向改代码的人。

## 它在解决什么

1. **看得到** —— 官方页面只有原始数字和曲线，2000+ 项指标混在一起，看不出哪个重要。
2. **看得懂** —— 点任意指标就有讲解：这是什么、图怎么看、现在的数在说什么、什么情况要警惕。
3. **讲得准** —— AI 讲解会自己查本地指标库（真实数值、历史序列、训练状态、离线评测），
   而不是凭固定文案编。数据变了，讲解也跟着变。
4. **问得到** —— 右下角的 AI 训练教练可以随便问，它自己决定查哪些数据，
   既能讲 RL 训练原理，也能落到这块板上的真实数字；多轮追问，还知道你现在在看哪张图。

## 快速开始

```bash
node src/server.js      # 打开 http://127.0.0.1:8787
```

**跑服务**不需要装任何东西：存档用 SQLite，Node ≥22.5 上有内置的 `node:sqlite`，
零第三方依赖。Node 太旧时由 `node-sqlite3-wasm` 兜底（纯 WebAssembly，不用编译），
那种机器才需要 `npm install`。还要能访问 `https://mimo.xiaomi.com/rl/`。

**改代码**才需要 `npm install` —— 装的是 jsdom（测试要在 Node 里加载前端页面），
属于 `devDependencies`，不会进分发包。

第一次克隆仓库后跑一次：

```bash
npm install             # 装测试用的 jsdom（只开发用，跑服务不用）
npm run setup           # 登记 git 钩子目录（见「开发约定」）
```

Node 版本要求写在 `package.json` 的 `engines` 里（`>=22.5`，低于它也能跑，
只是要靠 wasm 兜底，所以 npm 只警告不拦），`.nvmrc` 里写的是 `22`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 起服务（= `node src/server.js`） |
| `npm test` | 跑全部回归（`scripts/run-tests.js`，16 组用例、400+ 项断言） |
| `npm run setup` | 一次性配置：`core.hooksPath` 指向 `.githooks/`；缺 `config.json` 时从模板生成 |
| `npm run build` | 构建 `dist/`（打包分发时才需要） |
| `npm run build:check` | 看 `dist/` 是否落后于源码 |
| `npm run build:zip` | 构建并打包 `dist.zip` |
| `npm run config:check` | 检查配置模板是否漏了本机 `config.json` 里的新配置项 |
| `npm run config:example` | 把本机新增的配置项补进 `config.example.json` |

## 架构

```
浏览器 ──► src/server.js ──► 上游 https://mimo.xiaomi.com/rl/
              │              （5 秒缓存，礼貌轮询）
              ├─► 静态页面 public/
              ├─► src/store.js ──► data/board.db (SQLite)
              └─► src/llm.js ──► 你的 OpenAI 兼容接口（可选，默认关闭）
```

**数据落库**：代理 `/api/series`、`/api/benchmarks` 时旁路写入 SQLite，浏览即缓存；
轮询时只在 step 变化时抓。指标库是 5 张窄表
（`series(run,tag,step,v,wall)`、`tag_meta`、`bench`、`bench_meta`、`run_state`，
外加早期就有的 `metrics`/`narrator`/`meta`），
指标从 2000 涨到 5000、评测从 3 个涨到 10 个都只加行、不改表。

**AI 讲解**：模型拿到 4 个 function calling 工具自己决定查什么 ——
`list_metrics`（检索指标）、`query_series`（查历史序列）、`run_status`（训练状态）、
`query_bench`（离线评测），最多 3 轮。界面按产生顺序分段显示：查询决策（按轮分组）
→ 思考过程 → 正文，全部流式吐出。

三类图都能讲，且数各有出处，所以前端按 key 前缀取数、后端按 `kind` 换讲解大纲
（讲评测分数和讲训练指标，该说的话不一样）：

| 讲解对象 | key | 数据来源 | 大纲要点 |
|---|---|---|---|
| 精选指标 | `dynsam/avg@n` | 上游 pins（常驻） | 这个数现在说明什么 |
| 离线评测基准 | `bench:deepswe` | 上游 benchmarks | 不参与梯度更新，只做泛化检验 |
| 指标库指标 | `tag:actor/lr` | 浏览时按需落库 | 先确认它存在、再查历史才开口 |

指标库里那几百个原始指标没有预先写好的文案，所以「指标库」这一类的固定讲解只做
定位（它属于哪一类、名字怎么读），逐项解读交给 AI —— 模型必须先用 `list_metrics`
确认它存在、再用 `query_series` 查它的历史，不许凭名字猜。

**AI 训练教练**（右下角悬浮球）：和「讲解一张图」不同，它是一段对话 ——
你随口问，它自己决定查什么。复用同一台机器（工具轮 → 流式正文轮 → 分层重试），
三处关键差异写在 `src/coach.js` 头部：

| | 图表讲解 | AI 教练 |
|---|---|---|
| 轮次 | 单轮，关掉就结束 | 多轮；一个会话一段，内容全传（上下文见下） |
| 工具 | 4 个（讲一张图不需要翻旧账） | 6 个，多 `search_notes`（历史解说）与 `db_overview`（库覆盖范围） |
| 首轮 tool_choice | `required`（必须先读数） | `auto`（问「什么是 GRPO」不该被逼着查库） |
| 成稿门槛 | 200 字（讲不完整要重跑） | 60 字；但模型**自然收尾**时降到 12 字 |

教练那条「自然收尾就放行」是必需的：用户要求「只把问过的问题列出来，别的别说」时，
模型照办写了两行、三十来字，按 60 字判就成了「没答出来」，重试三次甩给用户一个红框 ——
而它第一次就答对了。所以判定看的是**模型怎么结束的**（`finish_reason`），不只是字数：
`stop` 且有内容 → 收下；`length`（撞上 max_tokens 截断）或几乎没写 → 才重跑。

它还能拿到「你此刻在看什么」（视图 + 打开着的图表 + run），由前端 `app.js` 通过
`window.MIMO.getContext()` 提供；抽屉顶部那个开关可以关掉，关掉后后端一个字都收不到。

**对话按会话落库**（`coach_msg` 表 + `coach_session` 表），所以刷新页面能接着聊
（见下面「会话与上下文压缩」）。只存纯文本 `{ role, content, sid }`：
思考过程与工具调用每轮都会重新生成，存下来既占地方，又会把上一轮查到的旧数字
带回下一轮（数字应当现查）。只写思考、正文空白的那轮不落库，否则刷新回来会看到
一条空回答。每个会话各留最近 200 条。

抽屉顶部「清空」是**两态确认**：点一次变成「再点一次」，3 秒不理自己复原 ——
比 `confirm()` 好的地方是它不打断操作，而且 jsdom 里能测（`confirm` 根本不存在）。
清空清的是当前会话（连它的摘要一起清，摘要是这些消息的压缩版，留着就是脏数据），
否则刷新一下旧对话又回来了。

### 会话与上下文压缩（`src/session.js`）

一段对话 = 一个 `sid`。抽屉顶部可以「＋ 新对话」、从下拉里切回任意一段；
后端按 sid 取历史、按 sid 存摘要，彼此互不串台。老库升级时已有的消息会归到
`s_legacy` 这段（标题「此前的对话」），不会消失。

**会话内的内容全传** —— 不再像以前那样「只带最近 8 条、每条砍到 1200 字」。
代价是上下文会涨，所以提前算账（`src/session.js`）：

| 环节 | 做法 |
|---|---|
| 估算 | 没有分词器，只能估：中文约 1 字 1 token、其余约 3.6 字 1 token，每条再加 4 token 角色开销。宁可估大（估大只是提前压，估小才会把请求撑爆） |
| 水位 | `used = 系统提示词 + 摘要 + 历史 + 本轮问题 + 预留`（预留 = 本轮生成 + 工具返回，最多占窗口一半）。`/api/coach` 开头会推一条 `{"context":{...}}`，前端右上角显示百分比 |
| 主动压缩 | 到窗口 75%（`llm.coachCompressAt`）就压：把「还没压过的消息」里除最近 6 条之外的部分交给模型写成摘要，存进 `coach_session.summary`，并记下压到哪一条为止（`summary_upto`）。下一轮发的就是**摘要 + 之后的原文** |
| 触发时机 | ① 收尾后（后台，不等它）：这一轮聊完发现快到线，立刻压，下一轮一上来就是干净的；② 开跑前（兜底）：后台那次没压成时再压一次 |
| 兜底 | 压缩没赶上、又真装不下，才按预算丢最旧的几条（正常是 0 条，丢了会在水位条里显示） |

**原文永远不动**：压缩只改「发给模型那一份」，界面照旧显示完整对话 ——
摘要挂在会话上（`summary` / `summary_upto`），消息原封不动留在 `coach_msg` 里。
摘要是滚动累积的：第二次压的时候，旧摘要会作为输入一起给模型，
否则更早的内容就永久丢了。

四项都可在 `config.json` 的 `llm` 段调：`coachContextWindow`（窗口 token，接口不返回真值，
只能自己填）、`coachCompressAt`（水位比例）、`coachKeepMsgs`（压完保留几条原文）、
`coachSummaryChars`（摘要字数上限）。

**回答范围与拒答**（`src/coach.js` 的 `COACH_SYSTEM`，两件事配套）：教练只答三类 ——
板上数据、RL 训练本身、这块板怎么用。范围外的（写辞职信、通用闲聊、看不到训练代码）
走**拒答话术**：一句话说清答不了，紧接着给一个它答得了的方向，二三十字收住，
不说教、不写「作为一个人工智能…」、不反复道歉。
少了拒答，模型遇到范围外的问题会硬答（编）或长篇解释为什么答不了；
少了范围，拒答就没有判断依据。

`/api/coach` 与 `/api/explain` 共用同一套 NDJSON 事件协议
（`think` / `tool` / `delta` / `notice` / `restart` / `done` / `error`），
所以前端那套流式渲染是两边共用的思路。

**回答的排版**：教练正文在前端做一次轻量渲染（`public/coach.js` 的 `rich()`），只认五样 ——
`### 小标题`、行首「- 」列表、`**加粗**`、markdown 表格、markdown 代码块。
这五样是**前后端约定**，要动必须两边一起动：只改前端模型不会输出，只改提示词语法会原样露出。
表格识别要求两道条件齐全（该行以竖线开头 **且** 下一行是 `|---|` 分隔行），
免得正文里偶发的竖线被误判；列数以表头为准，缺列补空、多列截掉。
代码块要求成对的 ``` 单独成行，未闭合的围栏会被降级成普通段落，不会把后续正文全吃成等宽块。

**渲染的已知边界**（想扩之前先看这里）：有序列表 `1.`、嵌套列表缩进、行内链接、斜体、
LaTeX 都不渲染，会原样显示。另外渲染只发生在收尾那一次 ——
流式期间上屏的是纯文本，所以表格/代码块在生成途中先以源码形态出现，收尾才成形。
三个落点里只有教练抽屉做 markdown：讲解抽屉（`#gl-ai-out`）是 `pre-wrap` 纯文本，
解说流的 `lesson` 是 `esc` 后塞进单个 `<p>`（换行会被折叠）。

**分层重试**：网络/5xx/超时在原地重试；正文为空只重跑正文轮，已查到的数据不重查；
流中途断连且已吐出足够内容就收下并标注不完整，不为结尾几个字重烧一次生成。

## 目录结构

```
src/             服务端源码
  server.js        主服务：反代上游、静态托管、/api/*、流式讲解接口
  paths.js         根目录探测（源码在 src/ 下，分发包是扁平的，见下）
  sqlite.js        SQLite 驱动适配（内置 node:sqlite / wasm 兜底，抹平 API 差异）
  store.js         SQLite 存档层（建表、落库、查询）
  llm.js           AI 客户端：工具定义、流式讲解、分层重试
  coach.js         AI 训练教练：教练提示词、多轮历史与上下文组装
public/          前端：index.html + app.js + glossary.js（词库）+ narrator*.js（规则解说）
                 + coach.js（教练抽屉）+ style.css
test/            回归用例（15 个 *-test.js + 一个子进程夹具）
scripts/         开发与运维脚本：run-tests（统一入口）、sync-dist 构建、
                 gen-config-example 模板提取、setup、rewrite-pending、几个 probe-*
deploy/          分发包专属材料：使用者 README、start.command、start.bat
.githooks/       提交钩子（pre-commit：自动补配置模板）
config.example.json  配置模板（入库）；config.json 是本机真实配置（不入库）
```

源码在 `src/` 下，但**分发包里是扁平的**（`dist/server.js` 与 `dist/public/` 同级）——
使用者是双击 `start.command` 的人，不该让他去 `src/` 里找入口。构建时 `src/*.js`
会被拷到 `dist/` 根层。

代价是两级目录层级不一致：`__dirname` 在源码里指向 `项目根/src`、在分发包里指向
`dist/`，差一层。所以**所有跨目录的路径都必须走 `src/paths.js` 的 `at()`**
（`at('config.json')`、`at('public')`、`at('data')`），它按"public/ 跟谁同级谁就是根"
判断根目录。别在 `src/` 下写裸 `__dirname` 去取这些文件，那只在开发时对。

## 配置

复制模板再填：

```bash
cp config.example.json config.json
```

```json
{ "llm": { "enabled": true, "baseUrl": "http://127.0.0.1:8090/v1",
           "apiKey": "你的key", "model": "模型名" } }
```

保存即生效，不用重启。AI 不可用会自动回落到内置规则引擎，页面不会空白。

### 端口与监听地址

```json
{ "server": { "port": 8787, "host": "0.0.0.0" } }
```

`host` 填 `0.0.0.0` 时局域网内其他设备也能访问，填 `127.0.0.1` 只允许本机。
**这一项是唯一需要重启才生效的配置**（端口只能在启动时绑定）。

优先级：`PORT` / `HOST` 环境变量 > `config.json` > 内置默认（8787 / 0.0.0.0）。
想临时换个端口试试不用改文件：`PORT=8799 node src/server.js`。
端口写错（`"8787abc"`、`70000`）不会崩，会回退 8787 并在启动时打印提示。

`config.json` 已在 `.gitignore` 里（含真实 API key，绝不入库）。
新增配置项后提交一次代码，钩子会自动把新键补进 `config.example.json`（值脱敏：密钥留空、`enabled` 写 false）。

## 开发约定

- **改前端静态资源要升版本号**：`public/index.html` 里 `app.js?v=21`、`style.css?v=21` 这类
  查询串，改了 `public/` 下的文件就 +1，否则用户浏览器一直用缓存。
- **提交钩子**：`.githooks/pre-commit` 会在提交时把本机 `config.json` 的新配置项补进模板，
  并进同一笔提交。新克隆的机器要跑一次 `npm run setup` 才会生效。
- **`dist/` 不入库**：它是构建产物，只在要打包分发时手动 `npm run build:zip` 生成。
  源码的版本管理和部署产物的生成是两件事，别再绑在一起。
- **构建时的依赖处理**：项目只用 Node 内置模块，唯一的第三方是**可选**兜底包
  `node-sqlite3-wasm`（Node <22.5 的机器才用得上，见「存档驱动」）。所以正常
  情况下不需要 `node_modules`，使用者也不用 `npm install`；构建脚本在本机装了兜底包时
  会把它一起拷进 `dist/node_modules`，旧 Node 的机器解压即用。
  构建脚本真正要操心的是**内部模块**——
  它从入口 `src/server.js` 递归解析 `require` 自动得出要拷贝哪些根级模块，
  不靠手写清单（以前写死四个文件，新加模块就会漏进 dist，一跑就 MODULE_NOT_FOUND）。
  构建完还会校验一遍：dist 里每个 `require`、页面每个 `src`/`href` 的目标文件都得存在，
  缺了就报错并挡住打包。
- **存档驱动**：存档只走 SQLite，没有 JSON 兜底。驱动由 `sqlite.js` 按顺序挑：
  先试 Node 内置的 `node:sqlite`（≥22.5，零依赖）；没有就用 npm 包
  `node-sqlite3-wasm`（纯 wasm，不需要编译环境）。两个都没有时存档停用——
  看板照常跑，但历史不落盘，启动日志会打印「升 Node / npm install」两条路。
  两个驱动 API 不同（wasm 版参数打包成数组、语句要手动 finalize、不支持 WAL），
  差异都在 `sqlite.js` 里抹平，`store.js` 只当它是 `node:sqlite`。
  wasm 版还额外处理一件事：碰到 WAL 模式的库（新 Node 跑过、或进程被强杀留下的）
  会自动降级为普通模式打开，WAL 文件另存留底 —— 否则它连打都打不开。
- **依赖分两类**：`optionalDependencies` 是给**使用者**的（Node 太旧时的 wasm 兜底，
  装不上也不影响）；`devDependencies` 是给**开发者**的（jsdom，跑测试用），
  不进 `dist.zip`。`package-lock.json` 已入库 —— 本项目是应用不是库，
  提交 lockfile 才能保证别人装到的兜底包版本跟本地验证过的一致。
- **测试**：改完跑 `npm test`（= `node scripts/run-tests.js`）。AI 相关的用例用本地
  mock 服务，不依赖外网模型。用例都在 `test/`，由 `scripts/run-tests.js` 串行跑完再
  汇总，失败不中断；只跑一组用 `node scripts/run-tests.js --only=store`，
  `--list` 看有哪些，`--all` 连需要真实模型的 `ai-prompt-test` 一起跑。
  找不到 jsdom 时入口会提前提示（跑 `npm install` 即可），不用手工设 `NODE_PATH`。
  `server-config-test` 永远排在最后，它会真起服务占端口，并停掉占用 8787 的进程
  （要验证兜底端口），跑完记得重启开发服务。

## 里程碑

`v1.0.0` → `v1.1.0` → `v1.2.0` → `v1.2.1` → `v1.3.0` → `v1.3.1` → `pre-ai-explain`（接入 AI 前的基线）
→ `v1.4.0`（AI 讲解 + 本地指标库 + function calling）
→ `v1.5.0`（讲解覆盖到离线评测基准与指标库的全部图表）
→ `v1.6.0`（AI 训练教练：悬浮球对话、多轮追问、可关的看板上下文）
→ `v1.6.1`（教练支持 markdown 表格：横向对比不再挤成一段文字）
→ `v1.6.2`（教练支持 markdown 代码块：命令与配置片段保留缩进与换行）
→ `v1.6.3`（教练滚动体验；「答成了没有」改用结束原因判定，简短回答不再被误判失败）
→ `v1.6.4`（提示词划定回答范围与拒答话术：范围外不再硬答或长篇解释）
→ `v1.6.5`（教练对话落库：刷新后接着聊；抽屉顶部两态确认的「清空」）。
→ `v1.7.0`（会话管理：一段对话一个 sid，可开新对话与切回；会话内内容全传，
到窗口 75% 主动压缩成滚动摘要，原文照旧完整显示）。
→ `v1.7.1`（工具轮的思考改为随到随显示；对话区自动跟到底部不再掉队；输入框加高；
滚动条统一成跟主题走的一套）。

回退到某个版本：`git checkout v1.4.0`。注意 `git push` 默认不带 tag，推里程碑要 `git push --tags`。

## 说明

第三方个人项目，与小米官方无关。数据全部来自公开的直播接口，只读不写。
