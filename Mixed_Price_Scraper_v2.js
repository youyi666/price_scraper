// =============================================================================
// Mixed_Price_Scraper_v2.1.js (京东 & 拼多多 & 淘系 三合一优化版)
//
// 更新日志 (v2.1):
// 1. [JD优化] 移除预检流程，直接启动。遇到登录页自动暂停等待人工操作 (同PDD逻辑)。
// 2. [Taobao优化] 缺少 auth.json 时自动弹窗引导登录，登录成功后自动保存凭证并继续任务。
// =============================================================================

const { chromium } = require('playwright'); // 标准版 (JD/PDD)
const { chromium: chromiumExtra } = require('playwright-extra'); // 增强版 (Taobao)
const stealth = require('puppeteer-extra-plugin-stealth')();
chromiumExtra.use(stealth); // 启用隐身插件

const exceljs = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// ================= [全局配置区] =================
const BASE_DIR = path.dirname(__filename);
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const CSV_OUTPUT_PATH = path.join(BASE_DIR, 'price_monitoring_results.csv');
// [新增] 统一截图储存文件夹
const SCREENSHOT_DIR = path.join(BASE_DIR, 'price_screenshots'); 
// 如果文件夹不存在，预先创建
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);
// 淘宝登录凭证路径
const TAOBAO_AUTH_PATH = path.join(BASE_DIR, 'auth.json'); 

// 加载 config.json
let config;
try {
    if (fs.existsSync(CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } else {
        config = { 
            paths: { excel_task_file: 'tasks.xlsx' },
            browser_settings: { edge_executable_path: '', edge_user_data_dir: './jd_user_data' }
        };
        console.warn("⚠️ 未找到 config.json，使用默认配置。");
    }
} catch (e) {
    console.error("❌ 读取 config.json 失败。");
    process.exit(1);
}

const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, config.paths.excel_task_file);
const JD_USER_DATA_DIR = config.browser_settings.edge_user_data_dir;
const PDD_USER_DATA_DIR = path.join(BASE_DIR, 'pdd_auth_data');
const BROWSER_EXEC_PATH = config.browser_settings.edge_executable_path;

// ================= [公共工具函数] =================

function init_csv_file() {
    if (!fs.existsSync(CSV_OUTPUT_PATH)) {
        const header = "\uFEFFPlatform,URL,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date,Main_Image_URL\n";
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

// ================= [阶段一：京东模块 (简化版)] =================

async function runJD() {
    console.log(`\n=============================================`);
    console.log(`📦 [阶段一] 启动京东监控任务...`);
    console.log(`=============================================`);

    const PLATFORM_NAME = "京东";
    
    let jd_tasks = [];
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0]; 
        
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; 
            const platform = row.getCell(1).text ? row.getCell(1).text.trim() : '';
            if (platform !== PLATFORM_NAME) return;

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
                url: finalUrl,
                barcode: barcodeValue,
                trueId: trueSkuId,
                limitPrice: limitPrice
            });
        });
        console.log(`[JD] 读取到 ${jd_tasks.length} 个任务。`);
    } catch (e) {
        console.log(`❌ [JD] 读取任务文件失败: ${e}`);
        return;
    }

    if (jd_tasks.length === 0) return;

    const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-infobars', '--no-default-browser-check'];
    let browser = null;
    let new_records = [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');

    try {
        // [修改] 直接启动，不检查状态
        console.log("[JD] 启动浏览器 (直接模式)...");
        browser = await chromium.launchPersistentContext(JD_USER_DATA_DIR, {
            executablePath: BROWSER_EXEC_PATH, 
            headless: false, // 保持 false 以便人工介入
            viewport: { width: 1920, height: 1080 }, 
            args: launchArgs
        });

        const workingPage = await browser.newPage();
        const screenshotDir = path.join(BASE_DIR, 'error_screenshots');
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

        for (let index = 0; index < jd_tasks.length; index++) {
            const task = jd_tasks[index];
            if (!task.url || !task.url.startsWith('http')) continue;

            console.log(`--- [JD] (${index + 1}/${jd_tasks.length}) SKU:${task.trueId} | 码:${task.barcode} ---`);
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";

            try {
                await workingPage.goto(task.url, { waitUntil: "domcontentloaded", timeout: 60000 });
                
                // [新增] 登录页检测逻辑 (类似 PDD)
                if (workingPage.url().includes('passport.jd.com') || workingPage.url().includes('safe.jd.com')) {
                    console.log("🛑 [JD] 检测到登录页面，请手动完成登录...");
                    console.log("   (脚本将在页面跳转回商品详情页后自动继续)");
                    // 等待 URL 不包含 passport 或 safe
                    await workingPage.waitForURL(url => !url.toString().includes('passport.jd.com') && !url.toString().includes('safe.jd.com'), { timeout: 0 });
                    console.log("✅ [JD] 登录成功，继续执行...");
                    await workingPage.waitForTimeout(2000); // 缓冲
                }

                console.log("   ⏳ 等待页面渲染 (5s)...");
                await workingPage.waitForTimeout(5000); 

                // 验证码检测
                const captchaSelectors = ['#captcha_modal', '.captcha-box', 'text="验证一下"', '#J-dj-captcha'];
                for (const sel of captchaSelectors) {
                    if (await workingPage.locator(sel).first().isVisible({timeout: 1000})) {
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
                                
                                const watermarkText = `【破价警报】\n时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}\nSKU: ${task.trueId}\n现价: ${currentVal} (限: ${task.limitPrice})`;
                                await workingPage.evaluate((text) => {
                                    const div = document.createElement('div');
                                    div.id = 'js-watermark';
                                    Object.assign(div.style, {
                                        position: 'fixed', top: '10%', left: '50%', transform: 'translate(-50%, 0)',
                                        padding: '20px', backgroundColor: 'rgba(255, 0, 0, 0.9)', color: '#fff',
                                        fontSize: '18px', fontWeight: 'bold', zIndex: '99999', borderRadius: '10px',
                                        textAlign: 'center', boxShadow: '0 0 10px rgba(0,0,0,0.5)', pointerEvents: 'none'
                                    });
                                    div.innerText = text;
                                    document.body.appendChild(div);
                                }, watermarkText);

                                const shotName = `${today_str}_JD_${task.trueId}.png`;
                                const fullShotPath = path.join(SCREENSHOT_DIR, shotName); // 使用全局统一文件夹
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
                Platform: "京东",
                URL: task.url,
                SKU_Identifier: task.barcode,
                True_SKU_Identifier: task.trueId,
                Price: final_price_str,
                Limit_Price: task.limitPrice,
                Price_Status: price_status,
                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: savedImagePath
            });
            await workingPage.waitForTimeout(2000);
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
            const p = row['Platform'] ? row['Platform'].trim() : '';
            if (p === '拼多多') {
                const rawId = extractIdFromInput(row['URL']);
                if (rawId) {
                    ids.push(rawId);
                    let limit = row['PriceLimit'] || row['Limit_Price']; 
                    let limitVal = -1;
                    if (limit) {
                        if (typeof limit === 'string') limitVal = parseFloat(limit.replace(/[,￥]/g, ''));
                        else limitVal = limit;
                    }
                    let barcodeVal = row['ProductID'] || row['Barcode'] || row['Product ID'] || row['SKU'] || "N/A";
                    limitMap[rawId] = { limit: limitVal, barcode: barcodeVal };
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
            headless: false, channel: 'msedge', args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], viewport: null
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
        
        // 定义常见的 SKU 行容器选择器
        // 1. Tmall/Taobao 标准: dl.tm-sale-prop, ul.J_TSaleProp
        // 2. 新版/天猫超市: div[class*="sku-info"], div[class*="propRows"]
        const rowSelectors = [
            'dl.tm-sale-prop', 
            'ul.J_TSaleProp', 
            'div[class*="skuItem"]', 
            'div[class*="propRow"]'
        ];

        let skuFound = false;

        for (const rowSel of rowSelectors) {
            const rows = await page.locator(rowSel).all();
            if (rows.length > 0) {
                skuFound = true;
                for (const row of rows) {
                    try {
                        // 检查该行是否已有选中项 (类名通常含 selected)
                        const isSelected = await row.locator('.tb-selected, .tm-selected, [class*="selected"], [aria-checked="true"]').count() > 0;
                        
                        if (!isSelected) {
                            // 寻找该行第一个可点击的选项
                            // 排除 disabled, out-of-stock
                            const options = row.locator('li:not([class*="disabled"]):not([class*="out-of-stock"]) a, li:not([class*="disabled"]) span, button:not([disabled])');
                            const count = await options.count();
                            
                            if (count > 0) {
                                console.log("      👉 发现未选规格，尝试点击第一个选项...");
                                await options.first().click({ force: true });
                                await sleep(500); // 等待页面响应
                            }
                        }
                    } catch (e) {}
                }
            }
        }
        
        if (!skuFound) {
            // 备用方案：针对非常新的 React 结构，尝试找所有看起来像 SKU 的按钮
            // 如果页面上有“颜色分类”等字样，但没选中
            try {
                const skuText = page.locator('text="颜色分类"');
                if (await skuText.isVisible()) {
                    // 尝试盲点该区域下的第一个按钮
                    // 这里不做过于复杂的逻辑，防止误触
                }
            } catch(e) {}
        }
    }

    // 1. 读取任务 (代码保持不变)
    let tb_tasks = [];
    try {
        if (!fs.existsSync(EXCEL_TASK_FILE_PATH)) { console.error(`❌ 未找到Excel`); return; }
        const workbook = XLSX.readFile(EXCEL_TASK_FILE_PATH);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);
        
        data.forEach(row => {
            const p = row['Platform'] ? row['Platform'].trim() : '';
            if (p === '淘系' || p === '淘宝' || p === '天猫') {
                const url = row['URL'];
                if (url && url.startsWith('http')) {
                    let limit = row['PriceLimit'] || row['Limit_Price']; 
                    let limitVal = null;
                    if (limit) {
                        if (typeof limit === 'string') limitVal = parseFloat(limit.replace(/[,￥]/g, ''));
                        else limitVal = limit;
                    }
                    let barcodeVal = row['ProductID'] || row['Barcode'] || row['SKU'] || "N/A";
                    let trueId = "N/A";
                    const match = url.match(/[?&]id=(\d+)/);
                    if(match) trueId = match[1];

                    tb_tasks.push({
                        url: url,
                        barcode: barcodeVal,
                        trueId: trueId,
                        limitPrice: limitVal
                    });
                }
            }
        });
        console.log(`[Taobao] 读取到 ${tb_tasks.length} 个任务。`);
    } catch(e) { console.error(`❌ [Taobao] Excel 读取失败: ${e}`); return; }

    if (tb_tasks.length === 0) return;

    if (!fs.existsSync(TAOBAO_AUTH_PATH)) {
        console.log(`\n⚠️  [Taobao] 未检测到登录凭证 (auth.json)。`);
        return; 
    }

    let browser = null;
    let new_records = [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');

    try {
        console.log("[Taobao] 启动隐身浏览器...");
        browser = await chromiumExtra.launch({ headless: false }); 
        const context = await browser.newContext({ 
            storageState: TAOBAO_AUTH_PATH,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0'
        });
        const page = await context.newPage();
        const screenshotDir = path.join(BASE_DIR, 'debug_screenshots');
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

        for (let index = 0; index < tb_tasks.length; index++) {
            const task = tb_tasks[index];
            console.log(`--- [Taobao] (${index + 1}/${tb_tasks.length}) ID:${task.trueId} ---`);
            
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";

            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                if (page.url().includes('login')) {
                    console.log("⚠️  Cookie失效，请重新登录...");
                    await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
                    await page.context().storageState({ path: TAOBAO_AUTH_PATH });
                }

                // [操作] 稍微向下滚动
                await page.evaluate(() => window.scrollBy(0, 300));
                
                // [操作] 清理遮挡
                await clearObstructions(page);

                // ★★★ 核心修复：先选择 SKU ★★★
                await autoSelectSKU(page);

                // 随机等待
                const randomWait = Math.random() * 2000 + 1000;
                console.log(`   ⏳ 准备点击购买...`);
                await sleep(randomWait);


                const buySelectors = [
                    'text="立即购买"', 'text="领券购买"', 'text="立即抢购"', 
                    '#J_LinkBuy', '[class*="buyBtn"]', '[class*="Buy--buyBtn"]', 
                    'div[class*="Actions--left"] button'
                ];

                let clicked = false;
                for(const selector of buySelectors) {
                    try {
                        const btn = page.locator(selector).first();
                        if (await btn.isVisible()) {
                            await btn.click({timeout: 3000, force: true});
                            console.log(`   👆 已点击: ${selector}`);
                            clicked = true;
                            break;
                        }
                    } catch(e) {}
                }

                if (!clicked) throw new Error("无购买按钮");

                // [二次防线] 如果点击后没跳转，反而弹出了SKU面板
                try {
                    await sleep(1500);
                    // 查找 "确定" 按钮 (通常在SKU面板底部)
                    // 选择器覆盖：SKU面板内的确定按钮
                    const confirmSelectors = [
                        '.sku-info .btn-ok', 
                        'button[class*="sku--sure"]', 
                        'div[class*="sku-wrapper"] button',
                        'div[role="dialog"] button:has-text("确定")', // 通用弹窗
                        'div[role="dialog"] button:has-text("确认")'
                    ];
                    
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
                    // 截图看卡在哪里
                    await page.screenshot({ path: path.join(screenshotDir, `Error_Stuck_${task.trueId}.png`) });
                    throw new Error("跳转失败 (请检查Error_Stuck截图)");
                }

                

                const priceSelectors = [
                    '.trade-price-integer',                     
                    '[class*="totalPrice_num"]',                
                    '[class*="realPay-price"]',
                    '//p[text()="实付款"]/following-sibling::div//span[contains(@class, "price")]'
                ];

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

                // 结果判断与隐私截图
                if (final_price_str !== "Not Found") {
                    if (task.limitPrice !== null && !isNaN(task.limitPrice)) {
                        const currentVal = parseFloat(final_price_str.replace(/[^\d.]/g, ''));
                        if (!isNaN(currentVal)) {
                            if (currentVal < task.limitPrice) {
                                price_status = "破价警报";
                                console.log(`   🚨 [破价] ${currentVal} < ${task.limitPrice}`);

                                // [新增 1] 注入水印 (位置下移)
                                const watermarkText = `【破价警报】\n时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}\nSKU: ${task.trueId}\n现价: ${currentVal} (限: ${task.limitPrice})`;
                                await page.evaluate((text) => {
                                    const div = document.createElement('div');
                                    div.id = 'js-privacy-watermark';
                                    Object.assign(div.style, {
                                        position: 'fixed', top: '40%', left: '50%', transform: 'translate(-50%, 0)',
                                        padding: '20px', backgroundColor: 'rgba(255, 0, 0, 0.9)', color: '#fff',
                                        fontSize: '18px', fontWeight: 'bold', zIndex: '99999', borderRadius: '10px',
                                        textAlign: 'center', pointerEvents: 'none'
                                    });
                                    div.innerText = text;
                                    document.body.appendChild(div);
                                }, watermarkText);

                                // [新增 2] 隐私截图 (裁切顶部)
                                const shotName = `${today_str}_TB_${task.trueId}.png`;
                                const fullShotPath = path.join(SCREENSHOT_DIR, shotName); // 使用全局统一文件夹
                                
                                // 获取视口大小
                                const viewport = page.viewportSize();
                                const CROP_TOP_HEIGHT = 250; // ★★★ 顶部裁切高度 (像素) ★★★

                                // 仅当页面高度足够时才裁切，否则普通截图
                                const clipRegion = (viewport && viewport.height > CROP_TOP_HEIGHT + 200) ? {
                                    x: 0,
                                    y: CROP_TOP_HEIGHT,
                                    width: viewport.width,
                                    height: viewport.height - CROP_TOP_HEIGHT
                                } : undefined;

                                await page.screenshot({ path: fullShotPath, clip: clipRegion });
                                savedImagePath = fullShotPath;
                                console.log(`   📸 隐私截图已保存 (已避开顶部 ${CROP_TOP_HEIGHT}px).`);
                                
                                // 移除水印
                                // await page.evaluate(() => { const el = document.getElementById('js-privacy-watermark'); if(el) el.remove(); });

                            } else if (currentVal > task.limitPrice) {
                                price_status = "高价待调整";
                                console.log(`   📈 [高价] ${currentVal} > ${task.limitPrice}`);
                            } else {
                                price_status = "价格正常";
                            }
                        }
                    } else { console.log(`   ℹ️ [跳过比价] 无限价`); }
                } else {
                    price_status = "抓取失败";
                }

            } catch(e) {
                console.log(`   [Error] ${e.message.split('\n')[0]}`);
                final_price_str = "Error";
                price_status = "脚本错误";
                // try { await page.screenshot({ path: path.join(debugDir, `Error_Final_${task.trueId}.png`) }); } catch(err){}
            }

            new_records.push({
                Platform: "淘系",
                URL: task.url,
                SKU_Identifier: task.barcode,
                True_SKU_Identifier: task.trueId,
                Price: final_price_str,
                Limit_Price: task.limitPrice,
                Price_Status: price_status,
                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: savedImagePath
            });

            await sleep(2000);
        }

    } catch (e) { console.error(`[Taobao] 严重错误: ${e}`); }
    finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        console.log(`[Taobao] 阶段任务完成。`);
    }
}

// ================= [主控制器] =================

async function main() {
    console.log(`🚀 --- 全平台价格监控脚本启动 (v2.1 Auto-Auth) ---`);
    console.log(`📂 结果存储位置: ${CSV_OUTPUT_PATH}`);
    
    init_csv_file();

    await runJD();
    await runPDD();
    await runTaobao();

    console.log(`\n✅ 所有平台任务已结束。请检查 CSV 文件。`);
}

// ================= [主控制器 (调试优化版)] =================

// ★★★ 调试开关区 ★★★
// 将需要运行的模块设为 true，不需要的设为 false
const RUN_CONFIG = {
    JD: true,      // 京东开关：调试淘宝时设为 false
    PDD: true,     // 拼多多开关：调试淘宝时设为 false
    TAOBAO: true    // 淘系开关：调试时设为 true
};

async function main() {
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

main();