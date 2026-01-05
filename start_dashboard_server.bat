@echo off
title 📊 智能客服质检看板服务器
color 0a

echo =================================================
echo        正在启动看板共享服务 (隔离模式)...
echo        注意：需要电脑已安装 Node.js 环境
echo =================================================

:: 1. 切换到当前脚本所在的文件夹
cd /d "%~dp0"

:: 2. 创建一个临时共享文件夹
:: 目的：把看板文件单独拎出来，防止根目录下的 index.html 导致页面直接跳转，看不到文件列表
:: 同时也避免了把其他无关的爬虫代码暴露给局域网
if not exist "dashboard_share" mkdir "dashboard_share"

:: 3. 同步看板文件 (只复制"客服质检看板"开头的HTML)
echo [状态] 正在同步最新的看板文件到共享目录...
if exist "客服质检看板_*.html" (
    :: /Y 覆盖不提示 /D 只复制更新的文件 >nul 屏蔽成功输出信息保持清爽
    xcopy "客服质检看板_*.html" "dashboard_share\" /Y /D >nul
    echo [成功] 看板文件已准备就绪。
) else (
    echo [提示] 当前目录下还没生成过看板文件，请先运行 Python 脚本生成。
)

echo.
echo [使用说明]
echo 1. 保持此窗口开启。
echo 2. 局域网同事访问下方 IP (如 http://192.168.1.3:8080)。
echo 3. 此时只能看到看板文件列表，点击即可查看，不再受其他 index.html 干扰。
echo.

:: 4. 启动服务器 (指定根目录为 dashboard_share)
:: 这样访问者看到的“根”就是这个只有看板文件的文件夹
call npx http-server "dashboard_share" -p 8080 -c-1 --cors

pause