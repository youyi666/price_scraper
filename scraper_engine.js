/**
 * Mixed_Price_Scraper_v3_Full.js
 * 基于 v2.0 原版修改，完整保留所有原逻辑（包括底部的 Debug 模块）。
 * * [修改日志]
 * 1. [System] 引入 IPC 通信，支持 GUI 停止指令。
 * 2. [System] 修正 BASE_DIR 以支持 EXE 打包环境。
 * 3. [JD] 升级为 Stealth 隐身模式，并增加鼠标拟人化操作（防封）。
 * 4. [Global] 动态解析 --headless 参数。
 */

const { chromium } = require('playwright'); // 标准版 (JD/PDD)
const { chromium: chromiumExtra } = require('playwright-extra'); // 增强版 (Taobao)
const stealth = require('puppeteer-extra-plugin-stealth')();
chromiumExtra.use(stealth); // 启用隐身插件

const exceljs = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// ================= [GUI 交互补丁区 (NEW)] =================

// [新增] 动态参数解析
const args = process.argv.slice(2);
const headlessArg = args.find(arg => arg.startsWith('--headless='));
// 默认为 false，如果 GUI 传参则覆盖
const HEADLESS_MODE_DYNAMIC = headlessArg ? headlessArg.split('=')[1] === 'true' : false;

// [新增] 全局停止信号
let shouldStop = false;
process.on('message', (msg) => {
    if (msg === 'STOP') {
        console.log('🛑 [系统] 接收到停止指令，正在安全结束当前任务...');
        shouldStop = true;
    }
});

// [新增] 模拟人类鼠标行为 (防检测核心)
async function simulateHumanBehavior(page) {
    try {
        const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
        // 随机移动 2-4 次
        for (let i = 0; i < randomInt(2, 4); i++) {
            const x = randomInt(100, 700);
            const y = randomInt(100, 600);
            await page.mouse.move(x, y, { steps: randomInt(10, 25) });
            await page.waitForTimeout(randomInt(200, 600));
        }
    } catch (e) { /* 忽略鼠标移动错误 */ }
}

// ================= [全局配置区] =================

// 1. [全局控制开关] (调试与运行模式设置)
// const HEADLESS_MODE = false; // [已注释] 原代码: true=无头后台运行, false=显示浏览器窗口
const HEADLESS_MODE = HEADLESS_MODE_DYNAMIC; // [修改] 使用动态参数

// 2. [静态路径定义] (固定目录结构)
// const BASE_DIR = path.dirname(__filename); // [已注释] 原代码: 不兼容 EXE 环境
const isPkg = typeof process.pkg !== 'undefined';
const BASE_DIR = isPkg ? path.dirname(process.execPath) : __dirname; // [修改] 兼容 EXE

const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const CSV_OUTPUT_PATH = path.join(BASE_DIR, 'price_monitoring_results.csv');
const SCREENSHOT_DIR = path.join(BASE_DIR, 'price_screenshots');

// 浏览器缓存目录 (统一管理)
const TAOBAO_USER_DATA_DIR = path.join(BASE_DIR, 'browser_profiles', 'taobao_store');
const JD_USER_DATA_DIR     = path.join(BASE_DIR, 'browser_profiles', 'jd_store');
const PDD_USER_DATA_DIR    = path.join(BASE_DIR, 'browser_profiles', 'pdd_store');

// 3. [配置文件加载]
let config;
try {
    if (fs.existsSync(CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } else {
        // 默认配置回退
        config = { 
            paths: { excel_task_file: 'tasks.xlsx' },
            browser_settings: { edge_executable_path: '', edge_user_data_dir: './jd_user_data' }
        };
        // console.warn("⚠️ 未找到 config.json，使用默认配置。");
    }
} catch (e) {
    console.error("❌ 读取 config.json 失败。");
    process.exit(1);
}

// 4. [动态路径与初始化] (依赖 config 的变量及副作用)
const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, config.paths.excel_task_file);

// 初始化：如果截图目录不存在，则创建 (副作用逻辑放最后)
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR);
}

// ================= [公共工具函数] =================

function init_csv_file() {
    if (!fs.existsSync(CSV_OUTPUT_PATH)) {
        // [迭代新增] 表头增加 Product_Name
        const header = "\uFEFFPlatform,URL,Product_Name,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date,Main_Image_URL\n";
        fs.writeFileSync(CSV_OUTPUT_PATH, header, 'utf8');
        console.log(`🆕 已创建新的结果文件: ${CSV_OUTPUT_PATH}`);
    }
}

function append_results_to_csv(records) {
    if (!records || records.length === 0) return;
    
    let csvContent = "";
    records.forEach(r => {
        const escapeCsv = (field) => {
            if (field === null || field === undefined) return "";
            const str = String(field).replace(/"/g, '""');
            if (str.search(/("|,|\n|\r)/g) >= 0) return `"${str}"`;
            return str;
        };

        const line = [
            escapeCsv(r.Platform),
            escapeCsv(r.URL),
            escapeCsv(r.Product_Name), // [迭代新增] 写入 Product_Name
            escapeCsv(r.SKU_Identifier),      
            escapeCsv(r.True_SKU_Identifier), 
            escapeCsv(r.Price),
            escapeCsv(r.Limit_Price),
            escapeCsv(r.Price_Status),
            escapeCsv(r.Scrape_Date),
            escapeCsv(r.Main_Image_URL)
        ].join(",");
        
        csvContent += line + "\n";
    });

    try {
        fs.appendFileSync(CSV_OUTPUT_PATH, csvContent, 'utf8');
        console.log(`   💾 CSV保存成功: 追加了 ${records.length} 条记录。`);
    } catch (e) {
        console.error(`   ❌ CSV写入失败: ${e.message}`);
    }
}

function parsePriceToFloat(priceStr) {
    if (!priceStr) return null;
    const cleanStr = priceStr.toString().replace(/[^\d.]/g, '');
    const val = parseFloat(cleanStr);
    return isNaN(val) ? null : val;
}

const randomDelay = (min = 1000, max = 3000) => {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

// ================= [阶段一：京东模块 (迭代版 - Edge 接管与精准复位)] =================

async function runJD() {
    // [插入点] 检查停止信号
    if (shouldStop) return;

    console.log(`\n=============================================`);
    console.log(`📦 [阶段一] 启动京东监控任务 (Edge Stealth版)...`);
    console.log(`=============================================`);

    const PLATFORM_NAME = "京东";
    
    let jd_tasks = [];
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0]; 
        
        // [新增] 1. 动态寻找 '[T]' 开关所在的列号
        let switchColIndex = -1;
        const headerRow = worksheet.getRow(1);
        headerRow.eachCell((cell, colNumber) => {
            const headerText = cell.text ? cell.text.trim() : '';
            if (headerText === '[T]') { switchColIndex = colNumber; }
        });

        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; 
            
            // [新增] 2. 检查开关状态
            if (switchColIndex !== -1) {
                const switchVal = row.getCell(switchColIndex).value;
                if (switchVal != 1) return; 
            }

            const platform = row.getCell(1).text ? row.getCell(1).text.trim() : '';
            if (platform !== PLATFORM_NAME) return;
            const productName = row.getCell(3).text ? row.getCell(3).text.trim() : 'N/A'; // [迭代新增] 读取商品名称

            const urlCellValue = row.getCell(4).value;
            const barcodeValue = row.getCell(2).text ? row.getCell(2).text.trim() : 'N/A';
            const limitPriceRaw = row.getCell(7).value;
            let limitPrice = null;
            if (limitPriceRaw) limitPrice = parsePriceToFloat(limitPriceRaw);
            let finalUrl = (typeof urlCellValue === 'object' && urlCellValue?.hyperlink) ? urlCellValue.hyperlink : urlCellValue;

            let trueSkuId = "N/A";
            if (typeof finalUrl === 'string') {
                const match = finalUrl.match(/\/(\d+)\.html/);
                if (match) trueSkuId = match[1];
                else { const match2 = finalUrl.match(/sku=(\d+)/); if (match2) trueSkuId = match2[1]; }
            }

            jd_tasks.push({
                url: finalUrl, productName: productName, // [迭代新增] 暂存名称
                barcode: barcodeValue, trueId: trueSkuId, limitPrice: limitPrice
            });
        });
        console.log(`[JD] 读取到 ${jd_tasks.length} 个任务。`);
    } catch (e) { console.log(`❌ [JD] 读取任务文件失败: ${e}`); return; }

    if (jd_tasks.length === 0) return;

    const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-infobars', '--no-default-browser-check'];
    let browser = null;
    let new_records = [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');

    try {
        console.log(`[JD] 正在尝试接管 Edge 浏览器配置: ${JD_USER_DATA_DIR}`);
        
        // [已注释] 原代码: 使用普通 chromium
        /*
        browser = await chromium.launchPersistentContext(JD_USER_DATA_DIR, {
            channel: 'msedge',
            headless: HEADLESS_MODE,
            viewport: null, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        });
        */

        // [修改] 使用 chromiumExtra (隐身模式) 替代，防止被反爬抓捕
        browser = await chromiumExtra.launchPersistentContext(JD_USER_DATA_DIR, {
            channel: 'msedge', 
            headless: HEADLESS_MODE, 
            viewport: null, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        });

        const workingPage = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
        const screenshotDir = path.join(BASE_DIR, 'error_screenshots');
        
        // [移入循环内] randomTime 应该每次都变
        // const randomTime = Math.random() * (8000 - 3000) + 3000;
        
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

        for (let index = 0; index < jd_tasks.length; index++) {
            // [插入点] 循环内停止检查
            if (shouldStop) {
                console.log('🛑 [JD] 任务被用户终止。');
                break;
            }

            const task = jd_tasks[index];
            if (!task.url || !task.url.startsWith('http')) continue;
            
            console.log(`--- [JD] (${index + 1}/${jd_tasks.length}) SKU:${task.trueId} | 码:${task.barcode} ---`);
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";

            try {
                // [恢复] 随机等待时间 (3-8秒)
                const randomTime = Math.random() * (8000 - 3000) + 3000;

                await workingPage.goto(task.url, { waitUntil: "domcontentloaded", timeout: 60000 });

                // [新增] 模拟人类鼠标操作
                await simulateHumanBehavior(workingPage);

                // [新增] 登录页检测逻辑 (类似 PDD)
                if (workingPage.url().includes('passport.jd.com') || workingPage.url().includes('safe.jd.com')) {
                    console.log("🛑 [JD] 检测到登录页面，请手动完成登录...");
                    console.log("   (脚本将在页面跳转回商品详情页后自动继续)");
                    await workingPage.waitForURL(url => !url.toString().includes('passport.jd.com') && !url.toString().includes('safe.jd.com'), { timeout: 0 });
                    console.log("✅ [JD] 登录成功，继续执行...");
                    await workingPage.waitForTimeout(3000); 
                }

                console.log(`   ⏳ 等待页面渲染 (${(randomTime/1000).toFixed(1)}s)...`);
                await workingPage.waitForTimeout(randomTime);

                // 验证码检测
                const captchaSelectors = ['#captcha_modal', '.captcha-box', 'text="验证一下"', '#J-dj-captcha'];
                for (const sel of captchaSelectors) {
                    if (await workingPage.locator(sel).first().isVisible({timeout: 3000})) {
                        console.log("   ⚠️ 触发验证，等待人工介入 (10s)...");
                        await workingPage.waitForTimeout(10000);
                        break;
                    }
                }

                // 价格抓取
                try {
                    await Promise.any([
                        workingPage.waitForSelector("#J_FinalPrice .price", {timeout: 5000}),
                        workingPage.waitForSelector(".p-price .price", {timeout: 5000})
                    ]);
                } catch(e) {}

                const priceSelectors = ["#J_FinalPrice .price", ".J-presale-price", ".p-price .price", ".price"];
                for (const sel of priceSelectors) {
                    try {
                        const el = workingPage.locator(sel).first();
                        if (await el.isVisible()) {
                            await el.scrollIntoViewIfNeeded(); 
                            const txt = await el.textContent();
                            if (/\d/.test(txt)) { final_price_str = txt.trim(); break; }
                        }
                    } catch (e) {}
                }

                // 结果处理 (含截图水印)
                if (final_price_str !== "Not Found") {
                    console.log(`   💰 抓取价格: ${final_price_str}`);
                    if (task.limitPrice !== null) {
                    const currentVal = parsePriceToFloat(final_price_str);
                        if (currentVal !== null) {
                        if (currentVal < task.limitPrice) {
                            price_status = "破价警报";
                                console.log(`   🚨 [破价] ${currentVal} < 限价 ${task.limitPrice}`);
                            
                                const watermarkText = `\n时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}\nSKU: ${task.trueId}\n现价: ${currentVal} (限: ${task.limitPrice})`;
                            await workingPage.evaluate((text) => {
                                    const style = document.createElement('style');
                                    style.innerHTML = `
                                        @keyframes alert-pulse { 0% { background-color: rgba(255, 0, 0, 0.2); } 50% { background-color: rgba(255, 0, 0, 0.6); } 100% { background-color: rgba(255, 0, 0, 0.2); } }
                                        @keyframes text-shake { 0% { transform: translate(-50%, -50%) scale(1); } 25% { transform: translate(-51%, -51%) scale(1.03); } 50% { transform: translate(-49%, -49%) scale(1); } 75% { transform: translate(-51%, -49%) scale(1.03); } 100% { transform: translate(-50%, -50%) scale(1); } }
                                    `;
                                    document.head.appendChild(style);
                                    const overlay = document.createElement('div');
                                    overlay.id = 'js-watermark-overlay';
                                    Object.assign(overlay.style, { position: 'fixed', top: '10', left: '0', width: '100vw', height: '100vh', zIndex: '99998', pointerEvents: 'none', animation: 'alert-pulse 1s infinite' });
                                    const div = document.createElement('div');
                                    div.id = 'js-watermark-text';
                                    Object.assign(div.style, { position: 'fixed', alignItems: 'center', top: '60%', left: '50%', transform: 'translate(-50%, -50%)', padding: '24px 44px', backgroundColor: 'rgba(0, 0, 0, 0.85)', color: '#ff0000', zIndex: '99999', border: '8px solid #ff0000', textAlign: 'center', boxShadow: '0 0 50px rgba(255, 0, 0, 0.8)', animation: 'text-shake 0.5s infinite', pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' });
                                    div.innerHTML = `<div style="font-size: 100px; font-weight: 900; line-height: 1.1; text-shadow: 0 0 10px #ff0000;text-align: center;gap: 10px;">⚠️ 破价警报 ⚠️</div><div style="font-size: 28px; color: #fff; font-weight: bold; line-height: 1.1; white-space: pre-wrap; max-width: 800px;text-align: center;">${text}</div>`;
                                    document.body.appendChild(overlay);
                                    document.body.appendChild(div);
                            }, watermarkText);

                            const shotName = `${today_str}_JD_${task.barcode}.png`;
                            const fullShotPath = path.join(SCREENSHOT_DIR, shotName);
                            
                            // 截图前强制让主商品图区域可见
                            await workingPage.locator('.product-intro, #itemInfo').first().scrollIntoViewIfNeeded().catch(()=>{});
                            await workingPage.screenshot({ path: fullShotPath });
                            savedImagePath = fullShotPath;
                                console.log(`   📸 截图已保存.`);
                                await workingPage.evaluate(() => { const el = document.getElementById('js-watermark'); if(el) el.remove(); });

                        } else if (currentVal > task.limitPrice) {
                            price_status = "高价待调整";
                                console.log(`   📈 [高价] ${currentVal} > 限价 ${task.limitPrice}`);
                        } else {
                            price_status = "价格正常";
                        }
                    }
                }
                } else {
                    price_status = "抓取失败";
                    console.log(`   ❌ 未找到价格`);
                    const failShotPath = path.join(screenshotDir, `fail_JD_${index}.png`);
                    await workingPage.screenshot({ path: failShotPath });
                    savedImagePath = failShotPath;
                }

            } catch (e) {
                console.log(`   [出错] ${e.message.split('\n')[0]}`);
                final_price_str = "Error";
                price_status = "脚本错误";
            }

            new_records.push({
                Platform: "京东", URL: task.url, Product_Name: task.productName,
                SKU_Identifier: task.barcode, True_SKU_Identifier: task.trueId,
                Price: final_price_str, Limit_Price: task.limitPrice,
                Price_Status: price_status, Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: savedImagePath
            });
            
            // [迭代新增] 随机大间隔
            if (index > 0 && index % 10 === 0) {
                const restTime = Math.floor(Math.random() * 5000) + 5000;
                console.log(`   ☕ 已连续处理10件，随机休息 ${restTime/1000}s...`);
                await workingPage.waitForTimeout(restTime);
            } else {
                await workingPage.waitForTimeout(2000);
            }
        }

    } catch (e) { console.error(`[JD] 严重错误: ${e}`); } 
    finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        console.log(`[JD] 阶段任务完成。`);
    }
}

// ================= [阶段二：拼多多模块 (无变动)] =================
async function runPDD() {
    // [插入点] 检查停止信号
    if (shouldStop) return;

    console.log(`\n=============================================`);
    console.log(`📦 [阶段二] 启动拼多多监控任务...`);
    console.log(`=============================================`);

    const TARGET_URL = "https://mms.pinduoduo.com/kit/goods-price-management?tool_full_channel=10323_97807&msfrom=mms_globalsearch";

    function extractIdFromInput(inputStr) {
        if (!inputStr) return "";
        const str = inputStr.toString().trim();
        if (/^\d+$/.test(str)) return str;
        try {
            const urlObj = new URL(str);
            const id = urlObj.searchParams.get("goods_id");
            if (id) return id;
        } catch (e) {
            const match = str.match(/goods_id=(\d+)/);
            if (match) return match[1];
        }
        return str; 
    }

    let ids = [];
    let limitMap = {}; 
    try {
        if (!fs.existsSync(EXCEL_TASK_FILE_PATH)) {
            console.error(`❌ 未找到文件: ${EXCEL_TASK_FILE_PATH}`);
            return;
        }
        const workbook = XLSX.readFile(EXCEL_TASK_FILE_PATH);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);
        
        data.forEach(row => {
            if (row['[T]'] != 1) return;
            const p = row['Platform'] ? row['Platform'].trim() : '';
            if (p === '拼多多') {
                const rawId = extractIdFromInput(row['URL']);
                if (rawId) {
                    ids.push(rawId);
                    const pName = row['ProductName'] || row['商品名称'] || "N/A"; // [迭代新增] 读取商品名称
                    let limit = row['PriceLimit'] || row['Limit_Price']; 
                    let limitVal = -1;
                    if (limit) {
                        if (typeof limit === 'string') limitVal = parseFloat(limit.replace(/[,￥]/g, ''));
                        else limitVal = limit;
                    }
                    let barcodeVal = row['ProductID'] || row['Barcode'] || row['Product ID'] || row['SKU'] || "N/A";
                    limitMap[rawId] = { limit: limitVal, barcode: barcodeVal, productName: pName }; // [迭代新增] 暂存名称
                    
                }
            }
        });
        ids = [...new Set(ids)];
        console.log(`[PDD] 读取到 ${ids.length} 个商品ID。`);
    } catch (e) { console.error(`❌ [PDD] 读取 Excel 失败: ${e}`); return; }

    if (ids.length === 0) return;

    let browser = null;
    let new_records = [];

    try {
        const context = await chromium.launchPersistentContext(PDD_USER_DATA_DIR, {
            headless: HEADLESS_MODE, channel: 'msedge', args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], viewport: null
        });
        browser = context;
        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        await page.goto(TARGET_URL);
        await page.waitForTimeout(2000);
        if (page.url().includes('login') || (await page.locator('.login-content').count()) > 0) {
            console.log("🛑 [PDD] 请手动登录...");
            await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
        }
        await page.waitForSelector('table[class*="TB_tableWrapper"]', { timeout: 20000 });

        const inputLocator = page.locator('input[placeholder*="多个ID"]');
        await inputLocator.clear();
        await inputLocator.fill(ids.join(' '));
        await page.locator('button', { hasText: '查询' }).first().click();
        
        console.log("⏳ [PDD] 等待查询结果...");
        await page.waitForTimeout(3000);

        let hasNextPage = true;
        let pageNum = 1;

        while (hasNextPage) {
            // [插入点] 循环内停止检查
            if (shouldStop) {
                console.log('🛑 [PDD] 任务被用户终止。');
                break;
            }

            console.log(`\n📄 [PDD] --- 第 ${pageNum} 页 ---`);
            const tbody = page.locator('tbody[data-testid="beast-core-table-middle-tbody"]');
            await page.waitForTimeout(1500);

            if (await tbody.count() > 0) {
                const rows = await tbody.locator('tr').all();
                for (const row of rows) {
                    try {
                        const cells = await row.locator('td').all();
                        if (cells.length < 5) continue;
                        const productInfoText = await cells[1].innerText();
                        const priceText = await cells[3].innerText();
                        
                        let currentPrice = 0;
                        if (priceText) {
                            const matches = priceText.match(/\d+(\.\d+)?/g);
                            if (matches) {
                                const validPrices = matches.map(parseFloat).filter(p => p > 0);
                                if (validPrices.length > 0) currentPrice = validPrices[validPrices.length - 1];
                            }
                        }
                        
                        let matchedId = null;
                        for (const id of Object.keys(limitMap)) {
                            if (productInfoText.includes(id)) {
                                matchedId = id; break;
                            }
                        }

                        const imgLocator = cells[1].locator('img').first();
                        const mainImgUrl = (await imgLocator.count() > 0) ? await imgLocator.getAttribute('src') : "";

                        if (matchedId && currentPrice > 0) {
                            const info = limitMap[matchedId];
                            const refPrice = info.limit;
                            const barcode = info.barcode; 
                            let status = "正常";

                            if (refPrice > 0) {
                                if (currentPrice < refPrice) {
                                    status = "破价警报";
                                    console.log(`   🚨 [破价] ID:${matchedId} | ${currentPrice} < ${refPrice}`);
                                } else if (currentPrice > refPrice) {
                                    status = "高价待调整";
                                    console.log(`   📈 [高价] ID:${matchedId} | ${currentPrice} > ${refPrice}`);
                                }
                            }
                            new_records.push({
                                Platform: "拼多多",
                                URL: `https://mobile.yangkeduo.com/goods.html?goods_id=${matchedId}`,
                                Product_Name: info.productName, // [迭代新增] 存入结果记录
                                SKU_Identifier: barcode, 
                                True_SKU_Identifier: matchedId, 
                                Price: currentPrice,
                                Limit_Price: refPrice > 0 ? refPrice : "",
                                Price_Status: status,
                                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                                Main_Image_URL: mainImgUrl
                            });
                        }
                    } catch (e) { console.error("   ⚠️ 行解析错:", e.message); }
                }
            }
            const nextBtn = page.locator('li[data-testid="beast-core-pagination-next"]');
            if (await nextBtn.count() > 0 && await nextBtn.isVisible()) {
                const classAttr = await nextBtn.getAttribute('class') || "";
                if (classAttr.includes('disabled')) hasNextPage = false;
                else { await nextBtn.click(); await randomDelay(2000, 3000); pageNum++; }
            } else { hasNextPage = false; }
        }

    } catch (e) { console.error(`[PDD] 错误: ${e}`); } 
    finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        console.log(`[PDD] 阶段任务完成。`);
    }
}

// ================= [阶段三：淘系模块 (v2.6 SKU 智能选择版)] =================

async function runTaobao() {
    // [插入点] 检查停止信号
    if (shouldStop) return;

    console.log(`\n=============================================`);
    console.log(`📦 [阶段三] 启动淘系监控任务 (v2.6 Auto-SKU)...`);
    console.log(`=============================================`);

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // --- 辅助：清理页面遮挡 ---
    async function clearObstructions(page) {
        const closeSelectors = [
            '.mui-dialog-close', '.sufei-dialog-close', 'button[aria-label="Close"]', 
            '.rax-view[role="button"]', 'text="关闭"', 'text="不再提示"', '.ant-modal-close'
        ];
        for (const sel of closeSelectors) {
            try {
                const els = await page.locator(sel).all();
                for (const el of els) {
                    if (await el.isVisible()) {
                        await el.click({ force: true });
                        await sleep(300);
                    }
                }
            } catch (e) {}
        }
    }

    // ★★★ 新增：智能选择 SKU ★★★
    async function autoSelectSKU(page) {
        console.log("   ⚙️ 正在检查并自动选择 SKU...");
        const rowSelectors = ['dl.tm-sale-prop', 'ul.J_TSaleProp', 'div[class*="skuItem"]', 'div[class*="propRow"]'];
        let skuFound = false;

        for (const rowSel of rowSelectors) {
            const rows = await page.locator(rowSel).all();
            if (rows.length > 0) {
                skuFound = true;
                for (const row of rows) {
                    try {
                        const isSelected = await row.locator('.tb-selected, .tm-selected, [class*="selected"], [aria-checked="true"]').count() > 0;
                        if (!isSelected) {
                            const options = row.locator('li:not([class*="disabled"]):not([class*="out-of-stock"]) a, li:not([class*="disabled"]) span, button:not([disabled])');
                            if (await options.count() > 0) {
                                console.log("      👉 发现未选规格，尝试点击第一个选项...");
                                await options.first().click({ force: true });
                                await sleep(500); 
                            }
                        }
                    } catch (e) {}
                }
            }
        }
        
        if (!skuFound) {
            try {
                const skuText = page.locator('text="颜色分类"');
                if (await skuText.isVisible()) {
                    // 备用逻辑
                }
            } catch(e) {}
        }
    }

    // 1. 读取任务
    let tb_tasks = [];
    try {
        if (!fs.existsSync(EXCEL_TASK_FILE_PATH)) { console.error(`❌ 未找到Excel`); return; }
        const workbook = XLSX.readFile(EXCEL_TASK_FILE_PATH);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);
        
        data.forEach(row => {
            if (row['[T]'] != 1) return;
            const p = row['Platform'] ? row['Platform'].trim() : '';
            if (['淘系', '淘宝', '天猫'].includes(p)) {
                if (row['URL']) {
                    const pName = row['ProductName'] || row['商品名称'] || "N/A";
                    let limit = row['PriceLimit'] || row['Limit_Price'] || row['pricelimit'];
                    let limitVal = limit ? parseFloat(String(limit).replace(/[,￥]/g, '')) : null;
                    
                    tb_tasks.push({
                        url: row['URL'], productName: pName,
                        barcode: row['Barcode'] || row['SKU'] || row['SKU_Identifier'] || row['Product ID'] || row['ProductID'] || "N/A",
                        trueId: row['URL'].match(/[?&]id=(\d+)/) ? row['URL'].match(/[?&]id=(\d+)/)[1] : "N/A",
                        limitPrice: limitVal
                    });
                }
            }
        });
        console.log(`[Taobao] 读取到 ${tb_tasks.length} 个任务。`);
    } catch(e) { console.error(`❌ [Taobao] Excel 读取失败: ${e}`); return; }

    if (tb_tasks.length === 0) return;

    let browser = null;
    let new_records = [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');

    try {
        console.log(`[Taobao] 正在接管浏览器配置: ${TAOBAO_USER_DATA_DIR}`);
        
        browser = await chromiumExtra.launchPersistentContext(TAOBAO_USER_DATA_DIR, {
            headless: HEADLESS_MODE, 
            viewport: null,
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        });

        const page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
        const screenshotDir = path.join(BASE_DIR, 'price_screenshots'); 

        for (let index = 0; index < tb_tasks.length; index++) {
            // [插入点] 循环内停止检查
            if (shouldStop) {
                console.log('🛑 [Taobao] 任务被用户终止。');
                break;
            }

            const task = tb_tasks[index];
            console.log(`--- [Taobao] (${index + 1}/${tb_tasks.length}) ID:${task.trueId} ---`);
            
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";

            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                if (page.url().includes('login.taobao') || page.url().includes('login.tmall')) {
                    console.log("🛑 检测到登录页！(因使用持久化配置，通常只需滑动验证)");
                    await page.waitForTimeout(5000); 
                }

                await page.evaluate(() => window.scrollBy(0, 300));
                await clearObstructions(page);
                await autoSelectSKU(page);

                const randomWait = Math.random() * 2000 + 1000;
                console.log(`   ⏳ 准备点击购买...`);
                await sleep(randomWait);

                const buySelectors = ['text="立即购买"', 'text="领券购买"', 'text="立即抢购"', '#J_LinkBuy', '[class*="buyBtn"]', '[class*="Buy--buyBtn"]', 'div[class*="Actions--left"] button'];
                let clicked = false;
                for(const selector of buySelectors) {
                    try {
                        const btn = page.locator(selector).first();
                        if (await btn.isVisible()) {
                            await btn.click({timeout: 3000, force: true});
                            console.log(`   👆 已点击: ${selector}`);
                            clicked = true; break;
                        }
                    } catch(e) {}
                }

                if (!clicked) throw new Error("无购买按钮");

                try {
                    await sleep(1500);
                    const confirmSelectors = ['.sku-info .btn-ok', 'button[class*="sku--sure"]', 'div[class*="sku-wrapper"] button', 'div[role="dialog"] button:has-text("确定")', 'div[role="dialog"] button:has-text("确认")'];
                    for(const sel of confirmSelectors) {
                        const btn = page.locator(sel).first();
                        if (await btn.isVisible()) {
                            console.log("   ⚙️ 再次检测到SKU确认弹窗，点击确认...");
                            await btn.click({force: true});
                            await sleep(1000);
                            break;
                        }
                    }
                } catch(e) {}

                console.log("   🔄 等待跳转结算页...");
                try {
                    await page.waitForURL(url => url.href.includes('buy.taobao') || url.href.includes('buy.tmall'), { timeout: 10000 });
                } catch(e) {
                    throw new Error("跳转失败 (请检查Error_Stuck截图)");
                }

                const priceSelectors = ['.trade-price-integer', '[class*="totalPrice_num"]', '[class*="realPay-price"]', '//p[text()="实付款"]/following-sibling::div//span[contains(@class, "price")]'];
                let priceText = "";
                for (const sel of priceSelectors) {
                    try {
                        const el = page.locator(sel).first();
                        if (await el.isVisible({timeout: 2000})) {
                            priceText = await el.textContent();
                            if (priceText && /\d/.test(priceText)) {
                                priceText = priceText.trim();
                                break;
                            }
                        }
                    } catch(e) {}
                }
                
                if (priceText) {
                    final_price_str = priceText;
                    console.log(`   💰 实付款: ${final_price_str}`);
                } else {
                    console.log(`   ❌ 结算页无法定位价格`);
                }
                    
                if (final_price_str !== "Not Found") {
                    if (task.limitPrice !== null && !isNaN(task.limitPrice)) {
                        const currentVal = parseFloat(final_price_str.replace(/[^\d.]/g, ''));
                        if (!isNaN(currentVal)) {
                            if (currentVal < task.limitPrice) {
                                price_status = "破价警报";
                                console.log(`    🚨 [破价] ${currentVal} < ${task.limitPrice}`);

                                const watermarkText = { title: "🚨 破价警报 🚨", time: `时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}`, sku: `SKU: ${task.trueId}`, detail: `现价: ${currentVal} < 限价: ${task.limitPrice}` };
                                await page.evaluate((info) => {
                                    const style = document.createElement('style');
                                    style.id = 'js-alert-style';
                                    style.innerHTML = `@keyframes alertPulse { 0% { background-color: rgba(255, 0, 0, 0.2); } 50% { background-color: rgba(255, 0, 0, 0.6); } 100% { background-color: rgba(255, 0, 0, 0.2); } } @keyframes textShake { 0% { transform: translate(-50%, -50%) rotate(0deg); } 10% { transform: translate(-52%, -51%) rotate(-1deg); } 30% { transform: translate(-48%, -49%) rotate(1deg); } 50% { transform: translate(-51%, -52%) rotate(-1.5deg); } 70% { transform: translate(-49%, -48%) rotate(1.5deg); } 90% { transform: translate(-51%, -50%) rotate(-0.5deg); } 100% { transform: translate(-50%, -50%) rotate(0deg); } }`;
                                    document.head.appendChild(style);
                                    const overlay = document.createElement('div');
                                    overlay.id = 'js-privacy-watermark';
                                    Object.assign(overlay.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', zIndex: '99998', pointerEvents: 'none', animation: 'alertPulse 1s infinite', border: '20px solid red', boxSizing: 'border-box' });
                                    const box = document.createElement('div');
                                    Object.assign(box.style, { position: 'fixed', top: '70%', left: '50%', transform: 'translate(-50%, -50%)', backgroundColor: 'rgba(0, 0, 0, 0.85)', color: '#ff0000', padding: '25px 45px', borderRadius: '0px', textAlign: 'center', boxShadow: '0 0 50px rgba(255, 0, 0, 0.8)', border: '8px solid #ff0000', zIndex: '99999', pointerEvents: 'none', animation: 'textShake 0.5s infinite', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' });
                                    box.innerHTML = `<div style="font-size: 100px; font-weight: 900; line-height: 1.1; text-shadow: 0 0 10px #ff0000; white-space: nowrap;gap: 10px;">⚠️ 破价警报 ⚠️</div><div style="font-size: 28px; color: #fff; font-weight: bold; line-height: 1.1; max-width: 800px; text-align: center;"><div>${info.time}</div><div>${info.sku}</div><div>${info.detail}</div></div>`;
                                    overlay.appendChild(box);
                                    document.body.appendChild(overlay);
                                }, watermarkText);

                                const shotName = `${today_str}_TB_${task.barcode}.png`;
                                const fullShotPath = path.join(SCREENSHOT_DIR, shotName);

                                try {
                                    const metrics = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
                                    const CROP_TOP = 300, CROP_BOTTOM = 50, CROP_LEFT = 150, CROP_RIGHT = 150;
                                    let clipRegion = undefined;
                                    const finalWidth = metrics.width - CROP_LEFT - CROP_RIGHT;
                                    const finalHeight = metrics.height - CROP_TOP - CROP_BOTTOM;
                                    if (finalWidth > 100 && finalHeight > 100) { clipRegion = { x: CROP_LEFT, y: CROP_TOP, width: finalWidth, height: finalHeight }; }
                                    await page.screenshot({ path: fullShotPath, clip: clipRegion });
                                    savedImagePath = fullShotPath;
                                    console.log(`    📸 警报截图成功`);
                                } catch (err) {
                                    await page.screenshot({ path: fullShotPath, fullPage: true });
                                }
                                await page.evaluate(() => { const el = document.getElementById('js-privacy-watermark'); const style = document.getElementById('js-alert-style'); if(el) el.remove(); if(style) style.remove(); });

                            } else if (currentVal > task.limitPrice) {
                                price_status = "高价待调整";
                                console.log(`    📈 [高价] ${currentVal} > ${task.limitPrice}`);
                            } else {
                                price_status = "价格正常";
                            }
                        }
                    } else { console.log(`    ℹ️ [跳过比价] 无限价`); }
                } else { price_status = "抓取失败"; }
            } catch(e) {
                console.log(`   [Error] ${e.message.split('\n')[0]}`);
                final_price_str = "Error";
                price_status = "脚本错误";
            }

            new_records.push({
                Platform: "淘系", URL: task.url, Product_Name: task.productName,
                SKU_Identifier: task.barcode, True_SKU_Identifier: task.trueId,
                Price: final_price_str, Limit_Price: task.limitPrice,
                Price_Status: price_status, Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: savedImagePath
            });

            await sleep(2000);
        }

    } catch (e) { console.error(`[Taobao] 致命错误: ${e}`); }
    finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        console.log(`[Taobao] 阶段任务完成。`);
    }
}

// ================= [主控制器 (入口)] =================

// ★★★ 核心修改：移除硬编码的开关，改为全量执行或由 GUI 决定 ★★★
async function main() {
    console.log(`🚀 --- 全平台价格监控脚本启动 (v3.2 GUI Ready) ---`);
    console.log(`📂 结果存储位置: ${CSV_OUTPUT_PATH}`);
    console.log(`🔧 运行模式: ${HEADLESS_MODE ? '后台静默' : '前台显示'}`);
    
    init_csv_file();

    // 依次执行，每步都检查 shouldStop
    await runJD();
    if (!shouldStop) await runPDD();
    if (!shouldStop) await runTaobao();

    console.log(`\n✅ 所有任务已结束。请检查 CSV 文件。`);
    
    // 通知父进程任务结束 (如果有)
    if (process.send) process.send('DONE');
}

main();

// ================= [历史遗留代码区 (保留备用)] =================
// [说明] 按照代码守恒原则，原有的 Debug 模式主函数并未删除，仅注释处理。

/*
// ================= [主控制器 (原 v2.3 Debug Mode)] =================

// ★★★ 调试开关区 ★★★
// 将需要运行的模块设为 true，不需要的设为 false
const RUN_CONFIG = {
    JD: true,      // 京东开关：调试淘宝时设为 false
    PDD: true,     // 拼多多开关：调试淘宝时设为 false
    TAOBAO: true    // 淘系开关：调试时设为 true
};

async function main_debug() {
    console.log(`🚀 --- 全平台价格监控脚本启动 (v2.3 Debug Mode) ---`);
    console.log(`📂 结果存储位置: ${CSV_OUTPUT_PATH}`);
    console.log(`🔧 当前运行模式: JD[${RUN_CONFIG.JD ? '开' : '关'}] | PDD[${RUN_CONFIG.PDD ? '开' : '关'}] | TB[${RUN_CONFIG.TAOBAO ? '开' : '关'}]`);
    
    // 初始化CSV文件 (只在第一次运行时检查)
    init_csv_file();

    // 根据开关决定是否执行
    if (RUN_CONFIG.JD) {
        await runJD();
    } else {
        console.log(`⏭️  [跳过] 京东任务已在配置中关闭。`);
    }

    if (RUN_CONFIG.PDD) {
        await runPDD();
    } else {
        console.log(`⏭️  [跳过] 拼多多任务已在配置中关闭。`);
    }

    if (RUN_CONFIG.TAOBAO) {
        await runTaobao();
    } else {
        console.log(`⏭️  [跳过] 淘系任务已在配置中关闭。`);
    }

    console.log(`\n✅ 本次选定任务已结束。请检查 CSV 文件。`);
}

// main_debug();
*/