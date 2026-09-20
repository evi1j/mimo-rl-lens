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

## 快速开始

```bash
node server.js          # 打开 http://127.0.0.1:8787
```

零第三方依赖，**不用 npm install**。需要 Node 22.5+（用到内置的 `node:sqlite`），
且能访问 `https://mimo.xiaomi.com/rl/`。

第一次克隆仓库后跑一次：

```bash
npm run setup           # 登记 git 钩子目录（见「开发约定」）
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 起服务（= `node server.js`） |
| `npm test` | 跑全部回归（9 个测试脚本，200+ 项断言） |
| `npm run setup` | 一次性配置：`core.hooksPath` 指向 `.githooks/`；缺 `config.json` 时从模板生成 |
| `npm run build` | 构建 `dist/`（打包分发时才需要） |
| `npm run build:check` | 看 `dist/` 是否落后于源码 |
| `npm run build:zip` | 构建并打包 `dist.zip` |
| `npm run config:check` | 检查配置模板是否漏了本机 `config.json` 里的新配置项 |
| `npm run config:example` | 把本机新增的配置项补进 `config.example.json` |

## 架构

```
浏览器 ──► server.js ──► 上游 https://mimo.xiaomi.com/rl/
              │              （5 秒缓存，礼貌轮询）
              ├─► 静态页面 public/
              ├─► store.js ──► data/board.db (SQLite)
              └─► llm.js ──► 你的 OpenAI 兼容接口（可选，默认关闭）
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

**分层重试**：网络/5xx/超时在原地重试；正文为空只重跑正文轮，已查到的数据不重查；
流中途断连且已吐出足够内容就收下并标注不完整，不为结尾几个字重烧一次生成。

## 目录结构

```
server.js        主服务：反代上游、静态托管、/api/*、流式讲解接口
store.js         SQLite 存档层（建表、落库、查询）
llm.js           AI 客户端：工具定义、流式讲解、分层重试
public/          前端：index.html + app.js + glossary.js（词库）+ narrator*.js（规则解说）+ style.css
tools/           开发/测试脚本（sync-dist 构建、gen-config-example 模板提取、setup、各 *-test）
deploy/          分发包专属材料：使用者 README、start.command、start.bat
.githooks/       提交钩子（pre-commit：自动补配置模板）
config.example.json  配置模板（入库）；config.json 是本机真实配置（不入库）
```

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
想临时换个端口试试不用改文件：`PORT=8799 node server.js`。
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
- **测试**：改完跑 `npm test`。AI 相关的测试用本地 mock 服务，不依赖外网模型。
  `server-config-test` 排在最后，它会真起服务占端口，并停掉占用 8787 的进程
  （要验证兜底端口），跑完记得重启开发服务。

## 里程碑

`v1.0.0` → `v1.1.0` → `v1.2.0` → `v1.2.1` → `v1.3.0` → `v1.3.1` → `pre-ai-explain`（接入 AI 前的基线）
→ `v1.4.0`（AI 讲解 + 本地指标库 + function calling）。

回退到某个版本：`git checkout v1.4.0`。注意 `git push` 默认不带 tag，推里程碑要 `git push --tags`。

## 说明

第三方个人项目，与小米官方无关。数据全部来自公开的直播接口，只读不写。
