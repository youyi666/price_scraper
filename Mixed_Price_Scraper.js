// =============================================================================
// Mixed_Price_Scraper.js (京东 & 拼多多 融合增强版 v1.2)
// 迭代日志：
// 1. [JD优化] 页面加载等待延长至 5s，遭遇验证码等待延长至 10s (人工介入窗口)。
// 2. [数据结构] CSV 新增 [True_SKU_Identifier] 列。
// 3. [数据源] [SKU_Identifier] 统一取自 Excel 第二列 (Barcode/ProductID)。
// 4. [数据源] 京东 True_SKU 取 URL 数字，拼多多 True_SKU 取 goods_id。
// =============================================================================

const { chromium } = require('playwright');
const exceljs = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// ================= [全局配置区] =================
const BASE_DIR = path.dirname(__filename);
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const CSV_OUTPUT_PATH = path.join(BASE_DIR, 'price_monitoring_results.csv');

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
        // [修改] 新增 True_SKU_Identifier 列
        const header = "\uFEFFPlatform,URL,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date,Main_Image_URL\n";
        fs.writeFileSync(CSV_OUTPUT_PATH, header, 'utf8');
        console.log(`🆕 已创建新的结果文件 (含新列): ${CSV_OUTPUT_PATH}`);
    }
}

function append_results_to_csv(records) {
    if (!records || records.length === 0) return;
    
    let csvContent = "";
    records.forEach(r => {
        const escapeCsv = (field) => {
            if (field === null || field === undefined) return "";
            const str = String(field).replace(/"/g, '""');
            if (str.search(/("|,|\n|\r)/g) >= 0) {
                return `"${str}"`;
            }
            return str;
        };

        const line = [
            escapeCsv(r.Platform),
            escapeCsv(r.URL),
            escapeCsv(r.SKU_Identifier),      // Excel中的 ProductID/Barcode
            escapeCsv(r.True_SKU_Identifier), // URL中的实际ID
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

// ================= [阶段一：京东模块] =================

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
            // [修改] 获取 Excel 第二列作为 SKU_Identifier
            const barcodeValue = row.getCell(2).text ? row.getCell(2).text.trim() : 'N/A';
            const limitPriceRaw = row.getCell(7).value;
            
            let limitPrice = null;
            if (limitPriceRaw) limitPrice = parsePriceToFloat(limitPriceRaw);

            let finalUrl = (typeof urlCellValue === 'object' && urlCellValue?.hyperlink) ? urlCellValue.hyperlink : urlCellValue;

            // [修改] 提取 JD URL 中的数字 ID
            let trueSkuId = "N/A";
            if (typeof finalUrl === 'string') {
                const match = finalUrl.match(/\/(\d+)\.html/);
                if (match) trueSkuId = match[1];
                else {
                    // 备用匹配
                    const match2 = finalUrl.match(/sku=(\d+)/);
                    if (match2) trueSkuId = match2[1];
                }
            }

            jd_tasks.push({
                url: finalUrl,
                barcode: barcodeValue, // CSV: SKU_Identifier
                trueId: trueSkuId,     // CSV: True_SKU_Identifier
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
        // 1. 登录检查
        console.log("[JD] 启动浏览器检查登录...");
        browser = await chromium.launchPersistentContext(JD_USER_DATA_DIR, {
            executablePath: BROWSER_EXEC_PATH,
            headless: false, 
            viewport: { width: 1920, height: 1080 },
            args: launchArgs,
            slowMo: 50
        });

        const page = await browser.newPage();
        
        async function checkLoginStatus(p) {
            try {
                await p.goto('https://home.jd.com/', { waitUntil: "domcontentloaded", timeout: 20000 });
                const currentUrl = p.url();
                if (currentUrl.includes('passport.jd.com') || currentUrl.includes('safe.jd.com')) return false;
                const loginIndicators = ['.user-info', '.nickname', '#user-info', '[href*="logout"]'];
                for (const indicator of loginIndicators) {
                    if (await p.locator(indicator).first().isVisible({ timeout: 3000 })) return true;
                }
                return false;
            } catch (e) { return null; }
        }

        let isLogged = await checkLoginStatus(page);
        if (!isLogged) {
            console.log("\n⚠️ [JD] 登录状态失效，请手动登录，成功后按回车继续...");
            await new Promise(resolve => process.stdin.once('data', resolve));
        }
        
        await page.close();
        await browser.close();
        
        // 2. 抓取阶段
        console.log("[JD] 开始执行抓取 (保持窗口开启)...");
        browser = await chromium.launchPersistentContext(JD_USER_DATA_DIR, {
            executablePath: BROWSER_EXEC_PATH,
            headless: false, 
            viewport: { width: 1920, height: 1080 },
            args: launchArgs
        });

        const workingPage = await browser.newPage();
        const screenshotDir = path.join(BASE_DIR, 'error_screenshots');
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

        // ----------------- 请替换从这里开始的 for 循环 -----------------
        for (let index = 0; index < jd_tasks.length; index++) {
            const task = jd_tasks[index];
            if (!task.url || !task.url.startsWith('http')) {
                continue;
            }

            console.log(`--- [JD] (${index + 1}/${jd_tasks.length}) SKU:${task.trueId} | 码:${task.barcode} ---`);
            console.log(`   🔗 访问: ${task.url}`);

            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = ""; // [新增] 用于存储截图路径

            try {
                await workingPage.goto(task.url, { waitUntil: "domcontentloaded", timeout: 60000 });
                
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

                if (final_price_str !== "Not Found") {
                    console.log(`   💰 抓取价格: ${final_price_str}`);
                    if (task.limitPrice !== null) {
                        const currentVal = parsePriceToFloat(final_price_str);
                        if (currentVal !== null) {
                            if (currentVal < task.limitPrice) {
                                price_status = "破价警报";
                                console.log(`   🚨 [破价] ${currentVal} < 限价 ${task.limitPrice}`);
                                
                                // [新增 1] 注入水印逻辑
                                const watermarkText = `【破价警报】\n时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}\nSKU: ${task.trueId}\n现价: ${currentVal} (限: ${task.limitPrice})`;
                                await workingPage.evaluate((text) => {
                                    const div = document.createElement('div');
                                    div.id = 'js-watermark';
                                    Object.assign(div.style, {
                                        position: 'fixed', top: '10%', left: '50%', transform: 'translate(-50%, 0)',
                                        padding: '20px', backgroundColor: 'rgba(255, 0, 0, 0.9)', color: '#fff',
                                        fontSize: '16px', fontWeight: 'bold', zIndex: '99999', borderRadius: '10px',
                                        textAlign: 'center', boxShadow: '0 0 10px rgba(0,0,0,0.5)', pointerEvents: 'none'
                                    });
                                    div.innerText = text;
                                    document.body.appendChild(div);
                                }, watermarkText);

                                // [新增 2] 截图并记录路径
                                const shotName = `${today_str}_${task.trueId}_JD.png`;
                                const fullShotPath = path.join(screenshotDir, shotName);
                                await workingPage.screenshot({ path: fullShotPath });
                                
                                // 保存路径到变量，供CSV写入使用
                                savedImagePath = fullShotPath;
                                console.log(`   📸 截图已保存至: ${fullShotPath}`);

                                // 截图后移除水印（可选，防止影响页面）
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
                    // 失败也截图
                    const failShotPath = path.join(screenshotDir, `fail_${index}.png`);
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
                // [修改] 此处写入刚才记录的本地路径，无截图则为空
                Main_Image_URL: savedImagePath || "" 
            });
            
            await workingPage.waitForTimeout(2000);
        }
        // ----------------- for 循环结束 -----------------

    } catch (e) {
        console.error(`[JD] 严重错误: ${e}`);
    } finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        console.log(`[JD] 阶段任务完成。`);
    }
}

// ================= [阶段二：拼多多模块] =================

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
    let limitMap = {}; // 修改为存储对象: id -> {limit, barcode}
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
                    
                    // 读取限价
                    let limit = row['PriceLimit'] || row['Limit_Price']; 
                    let limitVal = -1;
                    if (limit) {
                        if (typeof limit === 'string') limitVal = parseFloat(limit.replace(/[,￥]/g, ''));
                        else limitVal = limit;
                    }

                    // [修改] 读取 Excel 第二列 (ProductID/Barcode)
                    // 尝试匹配常见表头，如果找不到则用N/A
                    let barcodeVal = row['ProductID'] || row['Barcode'] || row['Product ID'] || row['SKU'] || "N/A";

                    limitMap[rawId] = {
                        limit: limitVal,
                        barcode: barcodeVal
                    };
                }
            }
        });
        ids = [...new Set(ids)];
        console.log(`[PDD] 读取到 ${ids.length} 个商品ID。`);
    } catch (e) {
        console.error(`❌ [PDD] 读取 Excel 失败: ${e}`);
        return;
    }

    if (ids.length === 0) return;

    let browser = null;
    let new_records = [];

    try {
        const context = await chromium.launchPersistentContext(PDD_USER_DATA_DIR, {
            headless: false,
            channel: 'msedge', 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
            viewport: null
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
                                matchedId = id;
                                break;
                            }
                        }

                        const imgLocator = cells[1].locator('img').first();
                        const mainImgUrl = (await imgLocator.count() > 0) ? await imgLocator.getAttribute('src') : "";

                        if (matchedId && currentPrice > 0) {
                            const info = limitMap[matchedId];
                            const refPrice = info.limit;
                            const barcode = info.barcode; // [修改] 使用 Excel 中的 ProductID

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
                                SKU_Identifier: barcode, // [修改] Excel ProductID
                                True_SKU_Identifier: matchedId, // [修改] goods_id
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
                if (classAttr.includes('disabled')) {
                    hasNextPage = false;
                } else {
                    await nextBtn.click();
                    await randomDelay(2000, 3000);
                    pageNum++;
                }
            } else {
                hasNextPage = false;
            }
        }

    } catch (e) {
        console.error(`[PDD] 错误: ${e}`);
    } finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        console.log(`[PDD] 阶段任务完成。`);
    }
}

// ================= [主控制器] =================

async function main() {
    console.log(`🚀 --- 全平台价格监控脚本启动 (v1.2 Enhanced) ---`);
    console.log(`📂 结果存储位置: ${CSV_OUTPUT_PATH}`);
    
    init_csv_file();

    await runJD();
    await runPDD();

    console.log(`\n✅ 所有任务已结束。请检查 CSV 文件。`);
}

main();