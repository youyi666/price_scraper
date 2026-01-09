const { chromium } = require('playwright'); // 标准版 (JD/PDD/Youpin)
const { chromium: chromiumExtra } = require('playwright-extra'); // 增强版 (Taobao)
const stealth = require('puppeteer-extra-plugin-stealth')();
chromiumExtra.use(stealth); // 启用隐身插件

const exceljs = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// ================= [全局配置区] =================

// 1. [全局控制开关] (调试与运行模式设置)
const HEADLESS_MODE = false; // true=无头后台运行, false=显示浏览器窗口

// 2. [静态路径定义] (固定目录结构)
const BASE_DIR = path.dirname(__filename);
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const CSV_OUTPUT_PATH = path.join(BASE_DIR, 'price_monitoring_results.csv');
const SCREENSHOT_DIR = path.join(BASE_DIR, 'price_screenshots');

// 浏览器缓存目录 (统一管理)
const TAOBAO_USER_DATA_DIR = path.join(BASE_DIR, 'browser_profiles', 'taobao_store');
const JD_USER_DATA_DIR     = path.join(BASE_DIR, 'browser_profiles', 'jd_store');
const PDD_USER_DATA_DIR    = path.join(BASE_DIR, 'browser_profiles', 'pdd_store');
// [新增] 有品缓存目录
const YP_USER_DATA_DIR     = path.join(BASE_DIR, 'browser_profiles', 'yp_store');

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
        console.warn("⚠️ 未找到 config.json，使用默认配置。");
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
    console.log(`\n=============================================`);
    console.log(`📦 [阶段一] 启动京东监控任务 (Edge 身份强化版)...`);
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
            if (headerText === '[T]') {
                switchColIndex = colNumber;
            }
        });

        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; 
            
            // [新增] 2. 检查开关状态
            if (switchColIndex !== -1) {
                const switchVal = row.getCell(switchColIndex).value;
                // 如果值存在且不等于 1 (包括字符串 '1')，则跳过
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
                url: finalUrl,
                productName: productName, // [迭代新增] 暂存名称
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
        // [迭代修改] 使用 msedge 渠道并指定 User Data Dir 以强化身份信息
        console.log(`[JD] 正在尝试接管 Edge 浏览器配置: ${JD_USER_DATA_DIR}`);
        browser = await chromium.launchPersistentContext(JD_USER_DATA_DIR, {
            channel: 'msedge', // 明确指定使用 Edge
            headless: HEADLESS_MODE,
            viewport: null, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        });

        const workingPage = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
        const screenshotDir = path.join(BASE_DIR, 'error_screenshots');
        const randomTime = Math.random() * (8000 - 3000) + 3000;
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

        for (let index = 0; index < jd_tasks.length; index++) {
            const task = jd_tasks[index];
            if (!task.url || !task.url.startsWith('http')) continue;
            
            console.log(`--- [JD] (${index + 1}/${jd_tasks.length}) SKU:${task.trueId} | 码:${task.barcode} ---`);
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";

            try {
                // [迭代新增] 随机 User-Agent 注入，进一步降低指纹特征 (可选)
                await workingPage.goto(task.url, { waitUntil: "domcontentloaded", timeout: 60000 });

                // [新增] 登录页检测逻辑 (类似 PDD)
                if (workingPage.url().includes('passport.jd.com') || workingPage.url().includes('safe.jd.com')) {
                    console.log("🛑 [JD] 检测到登录页面，请手动完成登录...");
                    console.log("   (脚本将在页面跳转回商品详情页后自动继续)");
                    // 等待 URL 不包含 passport 或 safe
                    await workingPage.waitForURL(url => !url.toString().includes('passport.jd.com') && !url.toString().includes('safe.jd.com'), { timeout: 0 });
                    console.log("✅ [JD] 登录成功，继续执行...");
                    await workingPage.waitForTimeout(3000); // 缓冲
                }

                console.log("   ⏳ 等待页面渲染 (5s)...");
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
                            // [迭代新增] 抓取前再次确保元素进入视野，防止截图切到空白
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
                            // 先计算 97% 的阈值
                            const alertThreshold = task.limitPrice * 0.97;  
                            if (currentVal < alertThreshold) {
                            price_status = "破价警报";
                            console.log(`   🚨 [破价] ${currentVal} < 警报阈值 ${alertThreshold.toFixed(2)} (原限价: ${task.limitPrice})`);
                            
                                const watermarkText = `\n时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}\nSKU: ${task.trueId}\n现价: ${currentVal} (限: ${task.limitPrice})`;
                            await workingPage.evaluate((text) => {
                                    // 1. 创建样式表
                                    const style = document.createElement('style');
                                    style.innerHTML = `
                                        @keyframes alert-pulse {
                                            0% { background-color: rgba(255, 0, 0, 0.2); }
                                            50% { background-color: rgba(255, 0, 0, 0.6); }
                                            100% { background-color: rgba(255, 0, 0, 0.2); }
                                        }
                                        @keyframes text-shake {
                                            0% { transform: translate(-50%, -50%) scale(1); }
                                            25% { transform: translate(-51%, -51%) scale(1.03); } /* 往左上抖 */
                                            50% { transform: translate(-49%, -49%) scale(1); }    /* 往右下抖 */
                                            75% { transform: translate(-51%, -49%) scale(1.03); } /* 往左下抖 */
                                            100% { transform: translate(-50%, -50%) scale(1); }   /* 回到中心 */
                                        }
                                    `;
                                    document.head.appendChild(style);
                                
                                    // 2. 全屏蒙版
                                    const overlay = document.createElement('div');
                                    overlay.id = 'js-watermark-overlay';
                                    Object.assign(overlay.style, {
                                        position: 'fixed',
                                        top: '10',
                                        left: '0',
                                        width: '100vw',
                                        height: '100vh',
                                        zIndex: '99998',
                                        pointerEvents: 'none',
                                        animation: 'alert-pulse 1s infinite'
                                    });
                                
                                    // 3. 中心警报框
                                    const div = document.createElement('div');
                                    div.id = 'js-watermark-text';
                                    Object.assign(div.style, {
                                        position: 'fixed',
                                        alignItems: 'center',
                                        top: '60%',
                                        left: '50%',
                                        transform: 'translate(-50%, -50%)', // 初始定位
                                        padding: '24px 44px',
                                        backgroundColor: 'rgba(0, 0, 0, 0.85)',
                                        color: '#ff0000',
                                        zIndex: '99999',
                                        border: '8px solid #ff0000',
                                        textAlign: 'center',
                                        boxShadow: '0 0 50px rgba(255, 0, 0, 0.8)',
                                        animation: 'text-shake 0.5s infinite',
                                        pointerEvents: 'none',
                                        // 关键修改：使用 flex 布局确保上下排列不重叠
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '10px' // 两行字之间的间距
                                    });
                                
                                    // 内部 HTML 结构调整
                                    div.innerHTML = `
                                        <div style="font-size: 100px; font-weight: 900; line-height: 1.1; text-shadow: 0 0 10px #ff0000;text-align: center;gap: 10px;">
                                            ⚠️ 破价警报 ⚠️
                                        </div>
                                        <div style="font-size: 28px; color: #fff; font-weight: bold; line-height: 1.1; white-space: pre-wrap; max-width: 800px;text-align: center;">
                                            ${text}
                                        </div>
                                    `;
                                    
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
                Platform: "京东",
                URL: task.url,
                Product_Name: task.productName, // [迭代新增] 存入结果记录
                SKU_Identifier: task.barcode,
                True_SKU_Identifier: task.trueId,
                Price: final_price_str,
                Limit_Price: task.limitPrice,
                Price_Status: price_status,
                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: savedImagePath
            });
            
            // [迭代新增] 随机大间隔：每 8 个任务额外休息 5-10 秒，缓解风控压力
            if (index > 0 && index % 8 === 0) {
                const restTime = Math.floor(Math.random() * 7000) + 5000;
                console.log(`   ☕ 已连续处理8件，随机休息 ${restTime/1000}s...`);
                await workingPage.waitForTimeout(restTime);
            } else {
                await workingPage.waitForTimeout(Math.random() * 2000 + 2000);
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
                                const alertThreshold = refPrice * 0.97;
                                if (currentPrice < alertThreshold) {
                                    status = "破价警报";
                                    console.log(`   🚨 [破价] ID:${matchedId} | ${currentPrice} < 警报阈值 ${alertThreshold.toFixed(2)} (原限价: ${refPrice})`);
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
                    // 兼容多种表头写法：PriceLimit, limit_price, 第7列等
                    const pName = row['ProductName'] || row['商品名称'] || "N/A"; // [迭代新增] 读取商品名称
                    let limit = row['PriceLimit'] || row['Limit_Price'] || row['pricelimit'];
                    let limitVal = limit ? parseFloat(String(limit).replace(/[,￥]/g, '')) : null;
                    
                    tb_tasks.push({
                        url: row['URL'],
                        productName: pName, // [迭代新增] 暂存名称
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
        
        // ★★★ 核心修改：使用 launchPersistentContext 直接接管文件夹 ★★★
        browser = await chromiumExtra.launchPersistentContext(TAOBAO_USER_DATA_DIR, {
            headless: HEADLESS_MODE, // 必须为false以保持指纹一致性
            viewport: null,
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        });

        // 获取第一个页面或新建
        const page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
        const screenshotDir = path.join(BASE_DIR, 'price_screenshots'); // 统一截图目录

        for (let index = 0; index < tb_tasks.length; index++) {
            const task = tb_tasks[index];
            console.log(`--- [Taobao] (${index + 1}/${tb_tasks.length}) ID:${task.trueId} ---`);
            
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";

            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                // 简单的登录检测
                if (page.url().includes('login.taobao') || page.url().includes('login.tmall')) {
                    console.log("🛑 检测到登录页！(因使用持久化配置，通常只需滑动验证)");
                    // 等待用户手动处理，或脚本自动重试
                    await page.waitForTimeout(5000); 
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
            const alertThreshold = task.limitPrice * 0.97;
            if (currentVal < alertThreshold) {
                price_status = "破价警报";
                console.log(`    🚨 [破价] ${currentVal} < 警报阈值 ${alertThreshold.toFixed(2)} (原限价: ${task.limitPrice})`);

                // [迭代新增] 电影级红色警报 UI 注入
                const watermarkText = {
                    title: "🚨 破价警报 🚨",
                    time: `时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}`,
                    sku: `SKU: ${task.trueId}`,
                    detail: `现价: ${currentVal} < 限价: ${task.limitPrice}`
                };
                
                await page.evaluate((info) => {
                    // 1. 样式定义（保留并合并动画）
                    const style = document.createElement('style');
                    style.id = 'js-alert-style';
                    style.innerHTML = `
                        @keyframes alertPulse {
                            0% { background-color: rgba(255, 0, 0, 0.2); }
                            50% { background-color: rgba(255, 0, 0, 0.6); }
                            100% { background-color: rgba(255, 0, 0, 0.2); }
                        }
                        @keyframes textShake {
                            0% { transform: translate(-50%, -50%) rotate(0deg); }
                            10% { transform: translate(-52%, -51%) rotate(-1deg); }
                            30% { transform: translate(-48%, -49%) rotate(1deg); }
                            50% { transform: translate(-51%, -52%) rotate(-1.5deg); }
                            70% { transform: translate(-49%, -48%) rotate(1.5deg); }
                            90% { transform: translate(-51%, -50%) rotate(-0.5deg); }
                            100% { transform: translate(-50%, -50%) rotate(0deg); }
                        }
                    `;
                    document.head.appendChild(style);
                
                    // 2. 全屏背景层 (保留原有功能)
                    const overlay = document.createElement('div');
                    overlay.id = 'js-privacy-watermark';
                    Object.assign(overlay.style, {
                        position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                        zIndex: '99998', pointerEvents: 'none',
                        animation: 'alertPulse 1s infinite',
                        border: '20px solid red', boxSizing: 'border-box'
                    });
                
                    // 3. 中心警报框 (按照目标风格进行功能迭代)
                    const box = document.createElement('div');
                    Object.assign(box.style, {
                        position: 'fixed', 
                        top: '70%', 
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        // 样式迭代：黑底红字风格
                        backgroundColor: 'rgba(0, 0, 0, 0.85)', 
                        color: '#ff0000',
                        padding: '25px 45px', 
                        borderRadius: '0px', // 改为方正风格更有警报感
                        textAlign: 'center', 
                        boxShadow: '0 0 50px rgba(255, 0, 0, 0.8)',
                        border: '8px solid #ff0000', 
                        zIndex: '99999',
                        pointerEvents: 'none',
                        animation: 'textShake 0.5s infinite', // 加快抖动频率
                        // 关键修改：使用 flex 布局确保信息上下排列整齐
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '10px' 
                    });
                
                    // 4. 内部 HTML 结构迭代
                    box.innerHTML = `
                        <div style="font-size: 100px; font-weight: 900; line-height: 1.1; text-shadow: 0 0 10px #ff0000; white-space: nowrap;gap: 10px;">
                            ⚠️ 破价警报 ⚠️
                        </div>
                        <div style="font-size: 28px; color: #fff; font-weight: bold; line-height: 1.1; max-width: 800px; text-align: center;">
                            <div>${info.time}</div>
                            <div>${info.sku}</div>
                            <div>${info.detail}</div>
                        </div>
                
                    `;
                
                    overlay.appendChild(box);
                    document.body.appendChild(overlay);
                }, watermarkText);

                // [保持并迭代] 隐私截图 (四周裁切逻辑)
                const shotName = `${today_str}_TB_${task.barcode}.png`;
                const fullShotPath = path.join(SCREENSHOT_DIR, shotName);

                try {
                    const metrics = await page.evaluate(() => ({
                        width: window.innerWidth,
                        height: window.innerHeight
                    }));

                    // --- 裁切参数定义 ---
                    const CROP_TOP = 300;     // 顶部裁剪
                    const CROP_BOTTOM = 50;  // 底部裁剪
                    const CROP_LEFT = 150;    // 左侧裁剪
                    const CROP_RIGHT = 150;   // 右侧裁剪

                    let clipRegion = undefined;

                    // 安全校验：只有当剩余尺寸为正数时才执行裁切
                    const finalWidth = metrics.width - CROP_LEFT - CROP_RIGHT;
                    const finalHeight = metrics.height - CROP_TOP - CROP_BOTTOM;

                    if (finalWidth > 100 && finalHeight > 100) {
                        clipRegion = {
                            x: CROP_LEFT,
                            y: CROP_TOP,
                            width: finalWidth,
                            height: finalHeight
                        };
                    }

                    await page.screenshot({ 
                        path: fullShotPath,
                        clip: clipRegion 
                    });
                    
                    savedImagePath = fullShotPath;
                    console.log(`    📸 警报截图成功 (四周已裁切: 左右各${CROP_LEFT}px, 上下各${CROP_TOP}px)`);

                } catch (err) {
                    console.error(`    ❌ 截图失败: ${err.message}`);
                    await page.screenshot({ path: fullShotPath, fullPage: true });
                }
                
                // [保持功能] 移除水印及样式
                await page.evaluate(() => { 
                    const el = document.getElementById('js-privacy-watermark'); 
                    const style = document.getElementById('js-alert-style');
                    if(el) el.remove(); 
                    if(style) style.remove();
                });

            } else if (currentVal > task.limitPrice) {
                price_status = "高价待调整";
                console.log(`    📈 [高价] ${currentVal} > ${task.limitPrice}`);
            } else {
                price_status = "价格正常";
            }
        }
    } else { console.log(`    ℹ️ [跳过比价] 无限价`); }
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
                Product_Name: task.productName, // [迭代新增] 存入结果记录
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

    } catch (e) { console.error(`[Taobao] 致命错误: ${e}`); }
    finally {
        // ★★★ 关键：不要关闭 Browser，只关闭 Page，或者什么都不做保留缓存
        // 如果这里 close()，下次启动也很快。为了安全退出，我们选择 close()
        // 因为 PersistentContext 写入磁盘是在运行时实时的或关闭时发生的
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        console.log(`[Taobao] 阶段任务完成。`);
    }
}


// ================= [阶段四：有品模块 (69码文件名对齐 & 截图增强版)] =================

async function runYoupin() {
    console.log(`\n=============================================`);
    console.log(`📦 [阶段四] 启动小米有品监控任务 (69码命名对齐版)...`);
    console.log(`=============================================`);

    const PLATFORM_NAME = "米家有品";
    const { devices } = require('playwright');
    const iPhoneXR = devices['iPhone XR'];

    // --- 内部辅助函数：页面清理 ---
    async function cleanupPage(page) {
        try {
            const nuisanceSelectors = ['#lib10-opapp-wrap', '.m-header-download-banner', '.openAppDialog', '.m-detail-back-top'];
            await page.evaluate((selectors) => {
                selectors.forEach(selector => {
                    const el = document.querySelector(selector);
                    if (el) el.remove();
                });
            }, nuisanceSelectors);
        } catch (error) {}
    }

    // --- 内部辅助函数：价格抓取 ---
    async function grabPrice(page) {
        let priceText = "Not Found";
        try {
            const presalePriceLocator = page.locator('[aria-label^="预售到手价"]');
            const finalPriceLocator = page.locator('[aria-label^="到手价"]');
            const regularPriceLocator = page.locator('[aria-label^="￥"]');

            let priceAriaLabel = "";
            if (await presalePriceLocator.count() > 0) {
                priceAriaLabel = await presalePriceLocator.first().getAttribute('aria-label');
            } else if (await finalPriceLocator.count() > 0) {
                priceAriaLabel = await finalPriceLocator.first().getAttribute('aria-label');
            } else if (await regularPriceLocator.count() > 0) {
                priceAriaLabel = await regularPriceLocator.first().getAttribute('aria-label');
            }

            if (priceAriaLabel) {
                const priceMatch = priceAriaLabel.match(/(\d+(\.\d+)?)/);
                if (priceMatch) priceText = priceMatch[0];
            }
            return priceText;
        } catch (priceError) { return "Error"; }
    }

    // 1. 读取任务 (B列=69码/条形码, D列=URL, E列=指令, G列=限价)
    let yp_tasks = [];
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0];

        let switchColIndex = -1;
        worksheet.getRow(1).eachCell((cell, colNumber) => {
            if (cell.text && cell.text.trim() === '[T]') switchColIndex = colNumber;
        });

        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            if (switchColIndex !== -1 && row.getCell(switchColIndex).value != 1) return;

            const platform = row.getCell(1).text ? row.getCell(1).text.trim() : '';
            if (platform !== PLATFORM_NAME && platform !== "有品") return;

            const barcode = row.getCell(2).text ? row.getCell(2).text.trim() : 'N/A'; // Column B (69码)
            const urlCellValue = row.getCell(4).value; // Column D (URL)
            const skuInstruction = row.getCell(5).text ? row.getCell(5).text.trim() : ''; // Column E (SKU指令)
            
            let finalUrl = (typeof urlCellValue === 'object' && urlCellValue?.hyperlink) ? urlCellValue.hyperlink : urlCellValue;
            
            yp_tasks.push({
                url: finalUrl,
                barcode: barcode,
                productName: row.getCell(3).text ? row.getCell(3).text.trim() : 'N/A',
                skuTask: skuInstruction, 
                limitPrice: parsePriceToFloat(row.getCell(7).value)
            });
        });
        console.log(`[Youpin] 任务加载完成: ${yp_tasks.length} 条。`);
    } catch (e) {
        console.log(`❌ [Youpin] 读取任务失败: ${e.message}`);
        return;
    }

    if (yp_tasks.length === 0) return;

    let browser = null;
    let new_records = [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');

    try {
        browser = await chromium.launchPersistentContext(YP_USER_DATA_DIR, {
            channel: 'msedge', headless: HEADLESS_MODE, ...iPhoneXR,
            args: ['--disable-blink-features=AutomationControlled']
        });
        const page = browser.pages()[0];
        
        for (let index = 0; index < yp_tasks.length; index++) {
            const task = yp_tasks[index];
            if (!task.url) continue;

            console.log(`--- [Youpin] (${index + 1}/${yp_tasks.length}) 69码: ${task.barcode} ---`);
            
            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await cleanupPage(page);
                await page.waitForTimeout(1000); 

                // 2. 触发 SKU 弹窗
                const buyBtnSelectors = ['text=/^立即(购买|抢购)$/', 'text="领券购买"', 'text="到货通知"', 'text=/^支付定金/', 'text="加入购物车"', '.m-detail-footer-btns .btn-item'];
                let isFound = false;
                for (const selector of buyBtnSelectors) {
                    const btn = page.locator(selector).first();
                    if (await btn.isVisible()) {
                        await btn.scrollIntoViewIfNeeded();
                        await btn.click({ force: true });
                        isFound = true; break;
                    }
                }
                if (isFound) await page.waitForTimeout(1500);

                const subTasks = (task.skuTask || '').split(';').map(t => t.trim()).filter(t => t !== '');
                const currentTasks = subTasks.length > 0 ? subTasks : ['default'];

                for (const currentTaskStr of currentTasks) {
                    let final_price_str = "Not Found";
                    let price_status = "未知";
                    let savedImagePath = "";

                    // 3. 执行 SKU 点击指令
                    if (currentTaskStr !== 'default') {
                        for (const step of currentTaskStr.split(',').map(s => s.trim())) {
                            let targetText = step, targetIndex = 0; 
                            const match = step.match(/(.+)\[(\d+)\]$/);
                            if (match) { targetText = match[1].trim(); targetIndex = parseInt(match[2], 10); }
                            const stepLocator = page.getByText(targetText, { exact: true });
                            if (await stepLocator.count() > targetIndex) {
                                await stepLocator.nth(targetIndex).click({ force: true });
                                await page.waitForTimeout(500);
                            }
                        }
                    }

                    await page.waitForTimeout(800); 
                    final_price_str = await grabPrice(page);

                    if (final_price_str !== "Not Found" && final_price_str !== "Error") {
                        const currentVal = parsePriceToFloat(final_price_str);
                        
                        // --- 【核心修正】截图命名使用 task.barcode (69码) ---
                        const shotName = `${today_str}_YP_${task.barcode}_${Date.now()}.png`;
                        const fullPath = path.join(SCREENSHOT_DIR, shotName);
                        
                        let isAlert = false;
                        if (task.limitPrice && currentVal && currentVal < (task.limitPrice * 0.97)) {
                            isAlert = true; price_status = "破价警报";
                            await page.evaluate((info) => {
                                const div = document.createElement('div'); div.id = 'js-watermark-yp';
                                Object.assign(div.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', padding: '30px', backgroundColor: 'rgba(0, 0, 0, 0.9)', color: '#ff0000', border: '6px solid #ff0000', zIndex: '99999', textAlign: 'center', fontSize: '22px', fontWeight: 'bold' });
                                div.innerHTML = `⚠️ 破价警报 ⚠️<br><div style="color:white; font-size:16px; margin-top:10px;">69码: ${info.barcode}<br>现价: ${info.price} / 限价: ${info.limit}</div>`;
                                document.body.appendChild(div);
                            }, { price: currentVal, limit: task.limitPrice, barcode: task.barcode });
                        } else if (currentVal && task.limitPrice && currentVal > task.limitPrice) {
                            price_status = "高价待调整";
                        } else { price_status = "价格正常"; }

                        await page.screenshot({ path: fullPath });
                        savedImagePath = fullPath;
                        if (isAlert) await page.evaluate(() => document.getElementById('js-watermark-yp')?.remove());
                    }

                    // 4. 数据存入记录 (保持列对齐)
                    new_records.push({
                        Platform: "米家有品",
                        URL: task.url,
                        Product_Name: task.productName,
                        SKU_Identifier: task.barcode,      // CSV 第 4 列：69码
                        True_SKU_Identifier: currentTaskStr, // CSV 第 5 列：点击指令
                        Price: final_price_str,
                        Limit_Price: task.limitPrice,
                        Price_Status: price_status,
                        Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                        Main_Image_URL: savedImagePath
                    });
                }
            } catch (err) { console.log(`   [Error] ${err.message.split('\n')[0]}`); }
        }
    } finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        console.log(`[Youpin] 阶段任务完成。`);
    }
}


// ================= [全局控制开关] =================

// ★★★ 调试开关区 ★★★
const RUN_CONFIG = {
    JD: true,      // 京东开关
    PDD: true,     // 拼多多开关
    TAOBAO: true,  // 淘系开关
    YOUPIN: true   // [新增] 有品开关
};

// ================= [阶段五：全局数据修正 (安全时间围栏版)] =================

/**
 * 读取CSV，智能识别列位置，仅修正【今天】产生的数据
 */
async function fixPriceStatus() {
    console.log(`\n=============================================`);
    console.log(`⚖️ [阶段五] 启动全局比价修正 (安全时间围栏版)...`);
    console.log(`=============================================`);

    if (!fs.existsSync(CSV_OUTPUT_PATH)) {
        console.log("❌ 结果文件不存在，无法修正。");
        return;
    }

    // 1. 获取“今天”的日期字符串 (格式 YYYY-MM-DD)
    // 注意：这里用的是本地时间，确保和脚本抓取的时间一致
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`; // 例如 "2026-01-05"

    console.log(`📅 锁定修正范围: 仅处理日期包含 [${todayStr}] 的记录`);

    // 2. 读取文件
    const fileContent = fs.readFileSync(CSV_OUTPUT_PATH, 'utf8');
    const lines = fileContent.trim().split('\n');
    
    if (lines.length < 2) {
        console.log("⚠️ CSV记录不足，跳过修正。");
        return; 
    }

    const headerLine = lines[0];

    // 3. 简单的 CSV 解析器
    const parseLine = (line) => {
        const pattern = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/; 
        return line.split(pattern).map(v => v.replace(/^"|"$/g, '').trim());
    };

    // 4. --- 精确列索引定位 (基于表头) ---
    // 定义我们需要的字段名称
    let idx_sku = -1;
    let idx_price = -1;
    let idx_status = -1;
    let idx_date = -1;
    let idx_platform = 0; // 默认为0

    // 优先方案：解析第一行（表头），根据名称动态定位
    if (lines.length > 0) {
        // 去除可能的引号和空白
        const headerCols = lines[0].split(',').map(c => c.trim().replace(/^"|"$/g, '')); 
        
        // 查找对应列名的索引
        idx_sku = headerCols.indexOf('SKU_Identifier');      // 对应列2
        idx_price = headerCols.indexOf('Price');             // 对应列4
        idx_status = headerCols.indexOf('Price_Status');     // 对应列6
        idx_date = headerCols.indexOf('Scrape_Date');        // 对应列7
        idx_platform = headerCols.indexOf('Platform');
    }

    // 兜底方案：如果表头没找到（比如CSV没有表头），则强制使用标准结构
    // 结构依据: Platform,URL,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date...
    if (idx_sku === -1 || idx_price === -1) {
        console.log("   ⚠️ 表头识别失败，切换至强制标准索引...");
        idx_platform = 0;
        idx_sku = 2;    // SKU_Identifier
        idx_price = 4;  // Price
        idx_status = 6; // Price_Status
        idx_date = 7;   // Scrape_Date
    }

    console.log(`   🎯 列索引锁定 -> SKU:[${idx_sku}] | 价格:[${idx_price}] | 状态:[${idx_status}] | 日期:[${idx_date}]`);

    // 5. 解析并筛选【今天】的数据
    let rows = [];
    let todayRowsIndices = []; // 记录哪些行属于今天 (方便回写)

    for (let i = 1; i < lines.length; i++) {
        const cols = parseLine(lines[i]);
        if (cols.length <= idx_status) continue; 
        
        const rowDate = cols[idx_date] || "";
        const rowSku = String(cols[idx_sku]).trim();
        const rowPrice = parseFloat(cols[idx_price]);
        const rowStatus = cols[idx_status];
        const rowPlatform = cols[idx_platform];

        const rowObj = {
            rawCols: cols,
            lineIndex: i, // 记住原始行号
            sku: rowSku,
            price: rowPrice,
            status: rowStatus,
            platform: rowPlatform,
            isToday: rowDate.includes(todayStr) // ★ 核心判断：是否是今天的数据
        };

        rows.push(rowObj);
    }

    // 6. 仅在【今天】的数据范围内，计算最低价
    const todaySkuMinPriceMap = {}; 
    
    rows.forEach(row => {
        if (!row.isToday || !row.sku || isNaN(row.price)) return; // 跳过历史数据
        
        if (!todaySkuMinPriceMap[row.sku]) {
            todaySkuMinPriceMap[row.sku] = row.price;
        } else {
            if (row.price < todaySkuMinPriceMap[row.sku]) {
                todaySkuMinPriceMap[row.sku] = row.price;
            }
        }
    });

    // 7. 遍历并修正 (只修正今天的)
    let fixCount = 0;
    
    rows.forEach(row => {
        // 安全锁：如果不是今天的数据，直接跳过，绝对不改
        if (!row.isToday) return;

        const isAlert = row.status && row.status.includes('破价'); 

        if (isAlert && todaySkuMinPriceMap[row.sku] !== undefined) {
            const minPrice = todaySkuMinPriceMap[row.sku];

            // 逻辑：如果 我的价格 > 今天全网最低价
            // 容差 0.01
            if (row.price > minPrice + 0.01) {
                const newStatus = "破价(跟随竞对)";
                
                // 修改内存数据
                row.rawCols[idx_status] = newStatus;
                
                console.log(`   🔧 [修正] ${row.platform} (码:${row.sku}) | 现价:${row.price} > 今日最低:${minPrice} -> 改判为:跟随`);
                fixCount++;
            }
        }
    });

    // 8. 回写文件
    if (fixCount > 0) {
        const escapeCsv = (str) => {
            if (str === null || str === undefined) return "";
            const s = String(str).replace(/"/g, '""');
            if (s.search(/("|,|\n|\r)/g) >= 0) return `"${s}"`;
            return s;
        };

        // 重新组装内容
        // 注意：这里 rows 包含了所有数据（历史+今天），但只有今天的 rawCols 被修改了
        const newContent = [headerLine, ...rows.map(r => r.rawCols.map(escapeCsv).join(','))].join('\n');
        
        try {
            fs.writeFileSync(CSV_OUTPUT_PATH, newContent, 'utf8');
            console.log(`✅ 修正完成！仅更新了今天 (${todayStr}) 的 ${fixCount} 条记录。`);
        } catch (e) {
            console.error(`❌ 文件回写失败: ${e.message}`);
        }
    } else {
        console.log(`✅ 检查完毕，今日数据无需修正。`);
    }
}

// ================= [主控制器] =================

async function main() {
    console.log(`🚀 --- 全平台价格监控脚本启动 (v3.0 All-In-One) ---`);
    console.log(`📂 结果存储位置: ${CSV_OUTPUT_PATH}`);
    console.log(`🔧 当前运行模式: JD[${RUN_CONFIG.JD?'开':'关'}] | PDD[${RUN_CONFIG.PDD?'开':'关'}] | TB[${RUN_CONFIG.TAOBAO?'开':'关'}] | YP[${RUN_CONFIG.YOUPIN?'开':'关'}]`);
    
    init_csv_file();

    if (RUN_CONFIG.JD) await runJD();
    else console.log(`⏭️  [跳过] 京东`);

    if (RUN_CONFIG.PDD) await runPDD();
    else console.log(`⏭️  [跳过] 拼多多`);

    if (RUN_CONFIG.TAOBAO) await runTaobao();
    else console.log(`⏭️  [跳过] 淘宝`);

    if (RUN_CONFIG.YOUPIN) await runYoupin();
    else console.log(`⏭️  [跳过] 有品`);

    console.log(`\n⏳ 所有抓取任务结束，等待文件写入...`);
    await new Promise(r => setTimeout(r, 1500)); 

    // 执行安全修正
    await fixPriceStatus();

    console.log(`\n🎉 --- 全部流程执行完毕 ---`);
}

// 执行入口
main();