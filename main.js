const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let scraperProcess = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        backgroundColor: '#1e1e1e',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        autoHideMenuBar: true
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (scraperProcess) scraperProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});

// === 核心逻辑：监听界面指令 ===

// 1. 接收“开始”指令
ipcMain.on('start-task', (event, args) => {
    if (scraperProcess) return; // 防止重复启动

    const { headless } = args;
    const isDev = !app.isPackaged;
    
    // 确定脚本路径：打包后和开发环境路径不同
    const scriptPath = isDev 
        ? path.join(__dirname, 'scraper_engine.js') 
        : path.join(process.resourcesPath, 'scraper_engine.js');

    mainWindow.webContents.send('log-update', `🚀 正在启动引擎...\n📂 脚本路径: ${scriptPath}`);

    // 使用 fork 启动子进程
    // 传递参数: --headless=true/false
    scraperProcess = fork(scriptPath, [`--headless=${headless}`], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    // 监听日志输出 (stdout)
    scraperProcess.stdout.on('data', (data) => {
        const log = data.toString();
        // 发送给界面显示
        mainWindow.webContents.send('log-update', log);
    });

    // 监听错误输出 (stderr)
    scraperProcess.stderr.on('data', (data) => {
        mainWindow.webContents.send('log-update', `🔴 [ERROR] ${data.toString()}`);
    });

    // 监听脚本自我结束
    scraperProcess.on('exit', (code) => {
        mainWindow.webContents.send('task-finished', code);
        scraperProcess = null;
    });

    // 监听 IPC 消息 (比如 'DONE')
    scraperProcess.on('message', (msg) => {
        if (msg === 'DONE') {
            mainWindow.webContents.send('log-update', '✅ 任务圆满完成！');
        }
    });
});

// 2. 接收“停止”指令
ipcMain.on('stop-task', () => {
    if (scraperProcess) {
        // 发送我们在 v3 代码里写的 'STOP' 信号
        scraperProcess.send('STOP'); 
        mainWindow.webContents.send('log-update', '🛑 正在发送停止信号，请等待当前商品处理完毕...');
    }
});