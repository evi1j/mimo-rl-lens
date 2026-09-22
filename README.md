# mimo-rl-lens

抓取小米 [MiMo-V2.6 公开训练直播](https://mimo.xiaomi.com/rl/) 的强化学习训练数据，
在本地看板上实时展示，并让 AI 告诉你**这些指标该怎么看**。

> 这份 README 是给**用它看训练**的人的：怎么跑起来、怎么配。
> 每个版本改了什么在 [`CHANGES.md`](CHANGES.md)；
> 看图的细节、AI 怎么用、常见问题在 [`deploy/README.md`](deploy/README.md)；
> 改代码的事在 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 它能做什么

- **看得到** —— 官方页面只有原始数字和曲线，2000+ 项指标混在一起。这里按重要性重新组织：
  训练指标全景、离线评测、指标库三页，指标随时间落库，随时回看历史。
- **看得懂** —— 点任意指标就有讲解：这是什么、图怎么看、现在的数在说什么、什么情况要警惕。
- **讲得准** —— AI 讲解会自己查本地指标库（真实数值、历史序列、训练状态、离线评测），
  不是凭固定文案编。数据变了，讲解也跟着变。
- **问得到** —— 顶栏右侧的「AI 模型训练教练」可以随便问，多轮追问，
  它还知道你现在在看哪张图（这个可以关）。

上游训练结束后解说会收尾（停在第几步、成绩、一共跑了多久），不会再说「还没结束」。

## 跑起来

### Docker（推荐）

```bash
git clone <本仓库地址> && cd mimo-train-live
cp config.example.json config.json    # 可选：要 AI 讲解才需要，字段见下面「配置」
docker compose -f docker/docker-compose.yml up -d --build
```

然后打开 `http://<宿主机IP>:8787`。

```bash
docker compose -f docker/docker-compose.yml logs -f     # 看日志
docker compose -f docker/docker-compose.yml down        # 停掉
```

**怎么给它配置**。镜像里刻意没有 `config.json`（避免 key 被烤进镜像层），所以要自己送进去，
两条路任选（不配也能跑，只是没有 AI 讲解）：

- **挂配置文件**：把 `docker/docker-compose.yml` 里 `- ../config.json:/app/config.json:ro`
  那行的注释去掉。前提：宿主上这个文件**必须先存在**（不存在的话 Docker 会把它建成目录）。
  挂完改文件**下一次 AI 调用即生效**，不用重启容器。
- **填环境变量**：compose 里的 `LLM_ENABLED` / `LLM_BASE_URL` / `LLM_MODEL` /
  `LLM_API_KEY` 四个空位，填了就以它为准（会盖过配置文件）。**留空 = 不覆盖**，
  交给挂进来的配置文件；注意别填 `LLM_ENABLED=0`，那会把配置文件里的 `enabled: true`
  一起关掉。

**端口**在 compose 里改（`ports` 那一行和 `PORT` 环境变量一起改）。`config.json` 里的
`server.port` 在容器里不管用：容器的 `PORT` 环境变量优先级更高，会把它盖掉。

**历史数据**存在卷里（`board-data` → 容器的 `/app/data`），删容器不丢，要清空才需要
`docker volume rm`。

不想自己构建的话，还有现成的镜像可以直接拉：

```bash
docker pull ghcr.io/evi1j/mimo-rl-lens:latest
docker run -d --name mimo-train-live -p 8787:8787 \
  -v mimo-data:/app/data ghcr.io/evi1j/mimo-rl-lens:latest
```

它同样不含 `config.json`：要配置就加 `-v ./config.json:/app/config.json:ro`，
或者加 `-e LLM_ENABLED=1 -e LLM_BASE_URL=... -e LLM_MODEL=... -e LLM_API_KEY=...`。

### 本机 Node

```bash
node src/server.js      # 打开 http://127.0.0.1:8787
```

**跑服务不需要装任何东西**：存档用 SQLite，Node ≥ 22.5 自带 `node:sqlite`，零第三方依赖。
Node 更旧时才需要 `npm install`（用纯 wasm 的 `node-sqlite3-wasm` 兜底，不用编译）。

另外需要能访问 `https://mimo.xiaomi.com/rl/`。

## 配置

> Docker 部署怎么把配置送进容器，见上面「Docker（推荐）」那节；这里讲的是字段本身。

配置是可选的 —— 不配也能跑，只是没有 AI 讲解（会自动回落到内置规则引擎，页面不空白）。

```bash
cp config.example.json config.json    # 复制模板再填
```

**AI（可选，默认关闭）**：

```json
{ "llm": { "enabled": true, "baseUrl": "http://127.0.0.1:8090/v1",
           "apiKey": "你的key", "model": "模型名" } }
```

任何 OpenAI 兼容接口都行（本地 vLLM / SGLang / Ollama，或在线服务）。保存即生效，不用重启。

**端口与监听地址**：

```json
{ "server": { "port": 8787, "host": "0.0.0.0" } }
```

`host` 填 `0.0.0.0` 时局域网内其他设备也能访问，填 `127.0.0.1` 只允许本机。
**这一项是唯一需要重启才生效的配置**（端口只能在启动时绑定）。

**用环境变量覆盖**（优先级高于 `config.json`）：

- `PORT` / `HOST` —— 临时换个端口：`PORT=8799 node src/server.js`
- `LLM_ENABLED=1` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` —— AI 那四项

`config.json` 含真实 API key，**不入库**（已在 `.gitignore` 里），也**不会进镜像**。

## 数据存在哪

SQLite 库在 `data/board.db`（Docker 里是卷挂载的 `/app/data`）。浏览即缓存：
看过的指标序列、离线评测都落进去，下次打开直接从本地读，也省上游请求。
删掉这个文件就回到空白状态，重新浏览会再攒起来。

## 里程碑

每个版本改了什么记在 [`CHANGES.md`](CHANGES.md)。

## 说明

第三方个人项目，与小米官方无关。数据全部来自公开的直播接口，只读不写。
