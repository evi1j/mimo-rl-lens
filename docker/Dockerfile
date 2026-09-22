# MiMo-V2.6 RL 训练实时看板 —— 镜像
#
# 构建（必须在仓库根目录执行，因为上下文要包含 src/ 与 public/）：
#     docker build -f docker/Dockerfile -t mimo-train-live:latest .
# 运行：
#     docker run -d --name mimo-train-live -p 8787:8787 -v mimo-data:/app/data mimo-train-live:latest
# 更省事的做法是用同目录的 docker-compose.yml。

# Node 必须 ≥22.5（内置 node:sqlite 用来存档）；22.13 起不用再加
# --experimental-sqlite，所以用 22 这个大版本标签就够。要锁死小版本就改成
# docker build --build-arg NODE_VERSION=22.22 ...
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

LABEL org.opencontainers.image.title="mimo-train-live" \
      org.opencontainers.image.description="MiMo-V2.6 强化学习训练实时看板：指标曲线 + 图表 AI 讲解 + AI 训练教练" \
      org.opencontainers.image.licenses="UNLICENSED"

# 容器里一律监听 0.0.0.0 —— 宿主只听本机的话由 -p 127.0.0.1:8787:8787 控制。
# PORT / HOST 只是默认值，docker run -e 或 compose 的 environment 可随时覆盖。
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    TZ=Asia/Shanghai

WORKDIR /app

# 只拷运行必需的三样：服务端源码、前端页面、包描述。
# 刻意不拷 config.json —— 里面可能有真实 API key，运行时用挂载或环境变量给
# （AI 那几项都支持 LLM_* 环境变量），绝不进镜像层。
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

# 不做 npm install：运行时依赖为零。
# 存档走 Node 内置的 node:sqlite，唯一的 optionalDependencies（node-sqlite3-wasm）
# 是给 Node <22.5 兜底用的，这里用不到。真要装再自己加一行：
#   RUN npm install --omit=dev --include=optional --no-audit --no-fund
# devDependencies（jsdom）只测试用，绝不能进镜像。

# 数据目录：应用把 SQLite 库写在 /app/data/board.db（指标、解说、教练对话都在里面）。
# 先建好并把整个 /app 的属主改成 node，后面挂 volume 时容器里的进程才写得了。
RUN mkdir -p /app/data && chown -R node:node /app

# 官方镜像自带 uid 1000 的 node 用户，不用 root 跑服务。
USER node

EXPOSE 8787
VOLUME ["/app/data"]

# 首页返回 200 就算活着。镜像里没有 curl / wget，用 node 自己探。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8787) + '/', function (r) { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', function () { process.exit(1); })"

CMD ["node", "src/server.js"]
