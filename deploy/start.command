#!/bin/bash
# MiMo-V2.6 RL 实时看板 — macOS / Linux 启动脚本
# 用法：双击，或在终端里 ./start.command（需要先 chmod +x start.command）
# 两种目录布局都能跑：分发包是扁平的（server.js 在本目录），
# 源码仓库里入口在 src/ 下 —— 下面会自己判断，不用改脚本。
cd "$(dirname "$0")" || exit 1
# 站到项目根：分发包里本文件就在根；源码仓库里它在 deploy/ 下，得退一级。
# 标志是 public/ —— 和 src/paths.js 的判断规则一致（谁跟 public/ 同级，谁就是根）。
[ -d "public" ] || cd .. || exit 1

URL="http://127.0.0.1:${PORT:-8787}"

# 1) 找 Node
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "[错误] 没找到 Node.js。请先安装 Node 22 或更高版本：https://nodejs.org"
  echo "       装好后重新运行本文件。"
  read -r -p "按回车键关闭..."
  exit 1
fi

# 2) 版本检查：22.5 起才内置 node:sqlite
MAJOR=$("$NODE" -p "process.versions.node.split('.')[0]" 2>/dev/null)
MINOR=$("$NODE" -p "process.versions.node.split('.')[1]" 2>/dev/null)
if [ -z "$MAJOR" ] || [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 5 ]; }; then
  echo "[提示] 当前 Node 版本 $("$NODE" -v)，建议 22.5 或更高（内置 node:sqlite，什么都不用装）。"
  echo "       仍会尝试启动：低版本会自动改用 node-sqlite3-wasm 兜底（压缩包里已带）。"
  echo "       万一启动日志提示缺这个包，在本目录执行：npm install node-sqlite3-wasm"
  echo
fi

# 3) 已在跑就直接开浏览器
if curl -s --noproxy '*' -m 2 -o /dev/null "$URL"; then
  echo "看板已经在运行了，直接打开浏览器。"
else
  echo "正在启动看板（端口 ${PORT:-8787}）..."
  # 入口还差一层：分发包是扁平的（server.js），源码仓库里收在 src/ 下。
  ENTRY="server.js"
  [ -f "$ENTRY" ] || ENTRY="src/server.js"
  if [ ! -f "$ENTRY" ]; then
    echo "[错误] 在 $(pwd) 下没找到入口（试过 server.js 和 src/server.js）。"
    echo "       请把本文件放在看板目录里再运行 —— 压缩包要整个解压，别只拖出这一个文件。"
    read -r -p "按回车键关闭..."
    exit 1
  fi
  "$NODE" "$ENTRY" &
  for i in $(seq 1 30); do
    sleep 0.5
    curl -s --noproxy '*' -m 2 -o /dev/null "$URL" && break
  done
fi

# 4) 跨平台打开浏览器
if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
else
  echo "请手动在浏览器打开：$URL"
fi

echo
echo "看板地址：$URL"
echo "关掉这个终端窗口，看板就会停止。下次再看，重新运行 start.command 即可。"
echo
wait
