@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MiMo-V2.6 RL 实时看板

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js。请先安装 Node 22 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo 当前 Node 版本：
node -v
echo.

set URL=http://127.0.0.1:8787
echo 看板地址： %URL%
echo 即将自动打开浏览器。关掉本窗口即停止服务。
echo.

rem 延迟 3 秒打开浏览器，等服务先起来
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" %URL%"

node server.js

echo.
echo 服务已停止。
pause
