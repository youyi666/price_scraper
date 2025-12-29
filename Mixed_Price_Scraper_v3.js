const { chromium } = require('playwright');
const { chromium: chromiumExtra } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromiumExtra.use(stealth);

const exceljs = require('exceljs');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// ================= [1. 全局配置区] =================

const HEADLESS_MODE = false;
const BASE_DIR = path.dirname(__filename);
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const CSV_OUTPUT_PATH = path.join(BASE_DIR, 'price_monitoring_results.csv');
const SCREENSHOT_DIR = path.join(BASE_DIR, 'price_screenshots');

// 浏览器缓存目录 (统一管理)
const PROFILES = {
    "京东": path.join(BASE_DIR, 'browser_profiles', 'jd_store'),
    "拼多多": path.join(BASE_DIR, 'browser_profiles', 'pdd_store'),
    "淘系": path.join(BASE_DIR, 'browser_profiles', 'taobao_store')
};

// 配置文件加载
let globalConfig;
try {
    if (fs.existsSync(CONFIG_PATH)) {
        globalConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } else {
        globalConfig = { paths: { excel_task_file: 'tasks.xlsx' } };
    }
} catch (e) {
    process.exit(1);
}

const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, globalConfig.paths.excel_task_file);

// 初始化目录
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ================= [2. 统一工具函数] =================

/**
 * 注入电影级红色警报 UI 水印 (恢复原淘宝模块行高与布局)
 */
async function injectAlertWatermark(page, info) {
    const watermarkText = {
        title: "🚨 破价警报 🚨",
        time: `时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}`,
        sku: `SKU: ${info.identifier}`,
        detail: `现价: ${info.current} < 限价: ${info.limit}`
    };

    await page.evaluate((info) => {
        const style = document.createElement('style');
        style.id = 'js-alert-style';
        style.innerHTML = `
            @keyframes alertPulse { 0% { background-color: rgba(255, 0, 0, 0.4); } 50% { background-color: rgba(255, 0, 0, 0.7); } 100% { background-color: rgba(255, 0, 0, 0.4); } }
            @keyframes textShake { 0% { transform: translate(-50%, -50%) scale(1); } 50% { transform: translate(-50%, -50%) scale(1.05); } 100% { transform: translate(-50%, -50%) scale(1); } }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'js-alert-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            zIndex: '99998', pointerEvents: 'none', animation: 'alertPulse 1s infinite ease-in-out',
            border: '20px solid red', boxSizing: 'border-box'
        });

        const box = document.createElement('div');
        Object.assign(box.style, {
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            backgroundColor: '#ff0000', color: '#fff', padding: '40px 60px', borderRadius: '15px',
            textAlign: 'center', boxShadow: '0 0 50px rgba(0,0,0,0.8)', border: '5px solid #fff',
            zIndex: '99999', fontFamily: 'sans-serif', animation: 'textShake 0.5s infinite',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '15px'
        });

        box.innerHTML = `
            <div style="font-size: 48px; font-weight: 900; line-height: 1.1; margin-bottom: 10px; text-shadow: 2px 2px 0 #000;">${info.title}</div>
            <div style="font-size: 20px; line-height: 1.2; font-weight: bold;">
                <div>${info.time}</div>
                <div>${info.sku}</div>
                <div style="background: #fff; color: #ff0000; margin-top: 15px; padding: 10px; font-size: 24px; line-height: 1.1;">${info.detail}</div>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }, watermarkText);
}

async function removeWatermark(page) {
    await page.evaluate(() => {
        ['js-alert-overlay', 'js-alert-style'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });
    });
}

function parsePriceToFloat(str) {
    if (!str || typeof str === 'number') return str;
    const val = parseFloat(String(str).replace(/[^\d.]/g, ''));
    return isNaN(val) ? null : val;
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function initCsvFile() {
    if (!fs.existsSync(CSV_OUTPUT_PATH)) {
        const header = "\uFEFFPlatform,URL,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date,Main_Image_URL\n";
        fs.writeFileSync(CSV_OUTPUT_PATH, header, 'utf8');
    }
}

async function loadExcelTasks() {
    const tasks = [];
    const workbook = new exceljs.Workbook();
    await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
    const sheet = workbook.worksheets[0];
    
    let headers = {};
    sheet.getRow(1).eachCell((cell, col) => { headers[cell.text.trim()] = col; });

    sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const switchVal = row.getCell(headers['[T]']).value;
        if (switchVal != 1) return;

        tasks.push({
            platform: row.getCell(headers['Platform']).text.trim(),
            url: row.getCell(headers['URL']).hyperlink || row.getCell(headers['URL']).text.trim(),
            barcode: row.getCell(headers['Barcode'] || headers['ProductID'] || headers['SKU_Identifier'] || 2).text.trim(),
            limitPrice: parsePriceToFloat(row.getCell(headers['Limit_Price'] || headers['PriceLimit'] || 7).value)
        });
    });
    return tasks;
}

// ================= [3. 平台核心适配器] =================

/**
 * 京东逻辑 (守恒：详情页抓取 + True ID 提取)
 */
async function crawlJD(page, task) {
    await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // 恢复 True ID 提取
    let trueSkuId = "N/A";
    const match = task.url.match(/\/(\d+)\.html/);
    if (match) trueSkuId = match[1];
    else { const match2 = task.url.match(/sku=(\d+)/); if (match2) trueSkuId = match2[1]; }
    task.trueSkuId = trueSkuId;

    if (page.url().includes('passport.jd.com') || page.url().includes('safe.jd.com')) {
        await page.waitForURL(url => !url.href.includes('passport.jd.com') && !url.href.includes('safe.jd.com'), { timeout: 0 });
    }
    
    await sleep(5000);
    const priceSelectors = ["#J_FinalPrice .price", ".J-presale-price", ".p-price .price", ".price"];
    for (const sel of priceSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible()) return (await el.textContent()).trim();
    }
    return "Not Found";
}

/**
 * 淘系逻辑 (守恒：SKU 智能选择 + 二次确认确认 + 结算页隐私截图)
 */
/**
 * 淘系逻辑 (严格守恒：完全恢复 v2.6 版按钮检测逻辑)
 */
async function crawlTaobao(page, task) {
    // 1. 进入页面并提取 ID
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const idMatch = task.url.match(/[?&]id=(\d+)/);
    task.trueSkuId = idMatch ? idMatch[1] : "N/A";

    await page.evaluate(() => window.scrollBy(0, 300));
    
    // 2. 清理遮挡 (恢复原脚本 clearObstructions 功能)
    const closeSelectors = ['.mui-dialog-close', '.sufei-dialog-close', 'button[aria-label="Close"]', '.rax-view[role="button"]'];
    for (const sel of closeSelectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({timeout: 500})) await el.click({ force: true });
        } catch (e) {}
    }

    // 3. SKU 智能选择 (完全恢复 v2.6 逻辑)
    const rowSelectors = ['dl.tm-sale-prop', 'ul.J_TSaleProp', 'div[class*="skuItem"]', 'div[class*="propRow"]'];
    for (const rowSel of rowSelectors) {
        const rows = await page.locator(rowSel).all();
        for (const row of rows) {
            try {
                // 检查是否已有选中项
                const isSelected = await row.locator('.tb-selected, .tm-selected, [class*="selected"], [aria-checked="true"]').count() > 0;
                if (!isSelected) {
                    // 排除 disabled 和 out-of-stock
                    const options = row.locator('li:not([class*="disabled"]):not([class*="out-of-stock"]) a, li:not([class*="disabled"]) span, button:not([disabled])');
                    if (await options.count() > 0) {
                        await options.first().click({ force: true });
                        await sleep(800); 
                    }
                }
            } catch (e) {}
        }
    }
    
    await sleep(2000); // 等待页面价格联动更新

    // 4. 购买按钮点击 (恢复原脚本 v2.1/v2.6 所有选择器)
    const buySelectors = [
        'text="立即购买"', 
        'text="领券购买"', 
        'text="立即抢购"', 
        '#J_LinkBuy', 
        '[class*="buyBtn"]', 
        '[class*="Buy--buyBtn"]', 
        'div[class*="Actions--left"] button' // 原脚本特有的备用选择器
    ];

    let clicked = false;
    for (const selector of buySelectors) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({timeout: 2000})) {
                await btn.click({ timeout: 3000, force: true });
                console.log(`   👆 已点击: ${selector}`);
                clicked = true;
                break;
            }
        } catch (e) {}
    }

    if (!clicked) return "No Buy Button";

    // 5. SKU 二次确认逻辑 (处理弹窗确认)
    await sleep(1500);
    const confirmSelectors = [
        '.sku-info .btn-ok', 
        'button[class*="sku--sure"]', 
        'div[class*="sku-wrapper"] button',
        'div[role="dialog"] button:has-text("确定")', 
        'div[role="dialog"] button:has-text("确认")'
    ];
    for (const sel of confirmSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({timeout: 1000})) {
            await btn.click({ force: true });
            await sleep(1000);
            break;
        }
    }

    // 6. 结算页价格抓取 (恢复原脚本多级选择器)
    try {
        await page.waitForURL(url => url.href.includes('buy.taobao') || url.href.includes('buy.tmall'), { timeout: 15000 });
        const priceSelectors = [
            '.trade-price-integer',                     
            '[class*="totalPrice_num"]',                
            '[class*="realPay-price"]',
            '//p[text()="实付款"]/following-sibling::div//span[contains(@class, "price")]'
        ];

        for (const sel of priceSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 5000 })) {
                const txt = await el.textContent();
                if (txt && /\d/.test(txt)) return txt.trim();
            }
        }
    } catch (e) {
        // 抓取失败时保留错误现场截图，以便调试 (遵循原脚本思想)
        const errPath = path.join(SCREENSHOT_DIR, `Error_Stuck_${task.trueSkuId}.png`);
        await page.screenshot({ path: errPath });
        return "Jump Failed";
    }
    return "Not Found";
}

/**
 * 拼多多逻辑 (批量处理 + 水印迭代)
 */
async function runPDDModule(page, tasks) {
    const MMS_URL = "https://mms.pinduoduo.com/kit/goods-price-management?tool_full_channel=10323_97807";
    await page.goto(MMS_URL);
    if (page.url().includes('login') || (await page.locator('.login-content').count()) > 0) {
        console.log("🛑 [PDD] 请手动登录...");
        await page.waitForURL(url => !url.href.includes('login'), { timeout: 0 });
    }
    await page.waitForSelector('table', { timeout: 20000 });
    
    // 提取任务中所有的 ID
    const extractId = (s) => (s.match(/goods_id=(\d+)/) || [null, s])[1];
    const ids = tasks.map(t => extractId(t.url));

    // 批量填入 ID
    await page.locator('input[placeholder*="多个ID"]').fill(ids.join(' '));
    await page.locator('button', { hasText: '查询' }).first().click();
    await sleep(3000);

    // [修复逻辑] 抓取表格每一行的数据并构建对象数组
    const data = [];
    const rows = await page.locator('tbody[data-testid*="tbody"] tr').all();
    for (const r of rows) {
        const text = await r.innerText();
        const priceText = await r.locator('td').nth(3).innerText();
        const img = await r.locator('img').first().getAttribute('src');
        data.push({ 
            text: text, 
            price: parsePrice(priceText), 
            img: img 
        });
    }
    return data;
}

// ================= [4. 任务调度中心] =================

async function runPlatformTasks(platformName, taskHandler) {
    // 1. 加载并过滤任务
    const allTasks = await loadExcelTasks();
    const tasks = allTasks.filter(t => (platformName === "淘系" ? ["淘宝", "天猫", "淘系"].includes(t.platform) : t.platform === platformName));
    
    if (tasks.length === 0) {
        console.log(`⏭️  跳过 [${platformName}]: 无匹配任务。`);
        return;
    }

    // 2. 准备启动参数 (守恒原则：根据平台动态调整)
    const launchOptions = {
        headless: HEADLESS_MODE,
        viewport: null, // 设为 null 以支持窗口最大化
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    };

    // 拼多多特殊处理：必须使用 Edge 通道
    if (platformName === "拼多多") {
        launchOptions.channel = 'msedge'; 
    }

    // 确定启动引擎：淘系使用增强版，其他使用标准版
    const engine = (platformName === "淘系") ? chromiumExtra : chromium;

    console.log(`\n🚀 启动 [${platformName}] 任务 (共 ${tasks.length} 条)`);
    
    // 3. 启动浏览器 (只声明一次变量名称 context 或 browser)
    const context = await engine.launchPersistentContext(PROFILES[platformName], launchOptions);
    const page = context.pages()[0] || await context.newPage();
    
    const records = [];
    const todayStr = DateTime.now().toFormat('yyyy-MM-dd');

    if (platformName === "拼多多") {
        const pddData = await runPDDModule(page, tasks);
        for (const t of tasks) {
            const gid = (t.url.match(/goods_id=(\d+)/) || [null, t.url])[1];
            const match = pddData.find(d => d.text.includes(gid));
            const curPrice = match ? match.price : null;
            let status = "正常";
            
            if (curPrice && t.limitPrice && curPrice < t.limitPrice) status = "破价警报";
            else if (curPrice && t.limitPrice && curPrice > t.limitPrice) status = "高价待调整";
            else if (!curPrice) status = "未找到价格";

            finalRecords.push({
                Platform: "拼多多",
                URL: t.url,
                SKU_Identifier: t.barcode,
                True_SKU_Identifier: gid,
                Price: curPrice || "N/A",
                Limit_Price: t.limitPrice,
                Price_Status: status,
                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: match?.img || "" // 拼多多不截图，仅保存主图链接
            });
        }
    } else {
        for (const task of tasks) {
            console.log(`   🔎 [${platformName}] 执行中: ${task.barcode}`);
            const priceStr = await taskHandler(page, task);
            const currentPrice = parsePriceToFloat(priceStr);
            let status = "正常", imgPath = "";

            if (currentPrice && task.limitPrice && currentPrice < task.limitPrice) {
                status = "破价警报";
                await injectAlertWatermark(page, { identifier: task.trueSkuId || task.barcode, current: currentPrice, limit: task.limitPrice });
                
                // 恢复原命名前缀
                const platformKey = platformName === "淘系" ? "TB" : "JD";
                const shotName = `${todayStr}_${platformKey}_${task.trueSkuId}.png`;
                imgPath = path.join(SCREENSHOT_DIR, shotName);

                // 恢复淘系隐私裁切
                let clip = (platformName === "淘系") ? { x: 150, y: 250, width: 1920, height: 1080 } : undefined;
                await page.screenshot({ path: imgPath, clip });
                await removeWatermark(page);
            } else if (priceStr === "Jump Failed" || priceStr === "Not Found") {
                status = "抓取失败";
            } else if (currentPrice > task.limitPrice) {
                status = "高价待调整";
            }

            records.push({
                Platform: platformName, URL: task.url, SKU_Identifier: task.barcode,
                True_SKU_Identifier: task.trueSkuId || "N/A", Price: priceStr,
                Limit_Price: task.limitPrice, Price_Status: status,
                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'), Main_Image_URL: imgPath
            });
            await sleep(2000);
        }
    }

    await browser.close();
    saveResultsToCsv(records);
}

function saveResultsToCsv(records) {
    const csvContent = records.map(r => {
        return [r.Platform, r.URL, r.SKU_Identifier, r.True_SKU_Identifier, r.Price, r.Limit_Price, r.Price_Status, r.Scrape_Date, r.Main_Image_URL]
            .map(field => `"${String(field || '').replace(/"/g, '""')}"`).join(',');
    }).join('\n') + '\n';
    fs.appendFileSync(CSV_OUTPUT_PATH, csvContent, 'utf8');
}

// ================= [5. 启动入口] =================

async function main() {
    console.log(`🚀 --- 统一价格监控系统 v3.0 启动 ---`);
    await initCsvFile();
    
    await runPlatformTasks("京东", crawlJD);
    await runPlatformTasks("拼多多", null); 
    await runPlatformTasks("淘系", crawlTaobao);
    
    console.log(`\n✅ 本次监控任务已圆满结束。`);
}

main();