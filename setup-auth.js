const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const userDataDir = path.join(__dirname, 'auth-profile');
const authFilePath = path.join(__dirname, 'auth.json');

(async () => {
    // 1. 清理环境
    if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    if (fs.existsSync(authFilePath)) {
        fs.rmSync(authFilePath);
    }
    console.log('✅ 已清理旧的认证文件，准备开始...');

    // 2. 启动浏览器
    const browserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    });
    
    // 3. 给出明确指令
    console.log('\n🚀 浏览器已为你打开。');
    console.log('--- 请按以下步骤手动操作 ---');
    console.log('   1. 在新打开的浏览器里，访问 https://www.taobao.com 并完成登录。');
    console.log('   2. 登录成功后，再访问 https://sycm.taobao.com/，确保已进入后台。');

    /*
     * 【【【 错误修正处 】】】
     * 下面的多行 console.log 已经被修复，以避免语法错误。
     */
    console.log('\n'); // 打印一个空行
    console.log('   ✅✅✅【最关键一步】✅✅✅');
    console.log('   当您确认已在生意参谋后台并登录成功后，');
    console.log('   请【切换回这个终端窗口】，然后【按一下回车键 (Enter)】...');

    // 4. 等待用户在终端按下回车键
    process.stdin.once('data', async () => {
        try {
            console.log('\n收到命令！正在保存登录状态...');
            // 5. 保存状态
            await browserContext.storageState({ path: authFilePath });
            console.log('🎉 成功！登录状态已保存到 `auth.json` 文件中。');
        } catch (error) {
            console.error('保存状态时出错:', error.message);
        } finally {
            // 6. 自动关闭浏览器并退出脚本
            await browserContext.close();
            console.log('浏览器已自动关闭。');
            process.exit(0);
        }
    });

})();