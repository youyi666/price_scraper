// =============================================================================
// setup-auth.js (全平台账号维护器 - v3.0 最终版)
// 功能：选择性打开 淘宝 / 京东 / 拼多多 的专用浏览器窗口进行人工维护。
// =============================================================================

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// 定义统一存储路径
const BASE_DIR = __dirname;
const PROFILES = {
    '1': {
        name: '淘宝 (Taobao)',
        path: path.join(BASE_DIR, 'browser_profiles', 'taobao_store'),
        url: 'https://taobao.com/'
    },
    '2': {
        name: '京东 (JD.com)',
        path: path.join(BASE_DIR, 'browser_profiles', 'jd_store'),
        url: 'https://jd.com/'
    },
    '3': {
        name: '拼多多 (Pinduoduo)',
        path: path.join(BASE_DIR, 'browser_profiles', 'pdd_store'),
        url: 'https://mms.pinduoduo.com/' // 商家后台登录页
    }
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

(async () => {
    console.log('\n🔧 --- 全平台账号维护模式 (v3.0) ---');
    console.log('请选择要维护的账号环境：');
    console.log(' [1] 淘宝 (Taobao/Tmall)');
    console.log(' [2] 京东 (JD.com)');
    console.log(' [3] 拼多多 (Pinduoduo)');
    
    rl.question('\n请输入序号 (1-3): ', async (answer) => {
        const choice = answer.trim();
        const target = PROFILES[choice];

        if (!target) {
            console.log('❌ 输入无效，脚本退出。');
            process.exit(1);
        }

        console.log(`\n🚀 正在启动 [${target.name}] 浏览器环境...`);
        console.log(`📂 数据路径: ${target.path}`);

        // 确保目录存在
        if (!fs.existsSync(target.path)) {
            fs.mkdirSync(target.path, { recursive: true });
            console.log('🆕 已新建全新的浏览器配置文件夹。');
        }

        // 启动持久化浏览器
        const context = await chromium.launchPersistentContext(target.path, {
            headless: false,
            viewport: null,
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        });

        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        
        // 自动打开对应平台的登录页
        try {
            console.log(`   正在打开登录页: ${target.url}`);
            await page.goto(target.url);
        } catch (e) {
            console.log('⚠️ 页面加载超时，请手动输入网址。');
        }

        console.log('\n✅ 浏览器已打开！');
        console.log('--------------------------------------------------');
        console.log(`   正在维护: ${target.name}`);
        console.log('   请手动完成登录、手机验证码处理等操作。');
        console.log('   完成后，【直接关闭浏览器窗口】即可自动保存。');
        console.log('--------------------------------------------------');

        context.on('close', () => {
            console.log(`\n🎉 [${target.name}] 维护结束，状态已保存。`);
            process.exit(0);
        });
    });
})();