// =============================================================================
// JD_run_jingdong_scraper.js (v11.0 修复增强版)
// 功能：
// 1. 京东价格监控，支持限价对比
// 2. 自动标记“破价警报”或“高价待调整”
// 3. 修复 ReferenceError 变量顺序问题
// =============================================================================

const { chromium } = require('playwright');
const exceljs = require('exceljs');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// --- 配置区 (从 config.json 文件动态加载) ---
const BASE_DIR = path.dirname(__filename);
const config_path = path.join(BASE_DIR, 'config.json');

// 简单的容错加载配置
let config;
try {
    config = JSON.parse(fs.readFileSync(config_path, 'utf-8'));
} catch (e) {
    console.error("❌ 无法读取 config.json，请检查文件是否存在。");
    process.exit(1);
}

const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, config.paths.excel_task_file);
const DB_OUTPUT_PATH = path.join(BASE_DIR, config.paths.db_output);
const BROWSER_EXEC_PATH = config.browser_settings.edge_executable_path;
const USER_DATA_DIR = config.browser_settings.edge_user_data_dir;
// --- 配置区结束 ---

const URL_COLUMN_HEADER = "URL";
const PLATFORM_COLUMN_HEADER = "Platform";
const PLATFORM_NAME = "京东";
const SKU_COLUMN_HEADER = "Barcode"; 
const LIMIT_PRICE_HEADER = "Limit_Price"; 

// [数据库] 初始化：包含新字段 Limit_Price 和 Price_Status
function setup_database(db_path) {
    const output_dir = path.dirname(db_path);
    if (!fs.existsSync(output_dir)) {
        fs.mkdirSync(output_dir, { recursive: true });
    }
    const db = new sqlite3.Database(db_path);
    db.run(`
        CREATE TABLE IF NOT EXISTS price_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            Platform TEXT, 
            URL TEXT, 
            SKU_Identifier TEXT,
            Price TEXT, 
            Limit_Price REAL,    -- 新增
            Price_Status TEXT,   -- 新增
            Scrape_Date TEXT, 
            Main_Image_URL TEXT,
            UNIQUE(Platform, URL, SKU_Identifier, Scrape_Date)
        )
    `);
    db.close();
}

// [数据库] 写入：包含新字段
function save_results_to_db(db_path, new_records) {
    if (new_records.length === 0) return;
    const db = new sqlite3.Database(db_path);
    const sql_upsert = `
        INSERT INTO price_data (Platform, URL, SKU_Identifier, Price, Limit_Price, Price_Status, Scrape_Date, Main_Image_URL)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date) 
        DO UPDATE SET Price = excluded.Price, Price_Status = excluded.Price_Status;
    `;
    try {
        db.serialize(() => {
            const stmt = db.prepare(sql_upsert);
            new_records.forEach(record => {
                stmt.run(
                    record.Platform,
                    record.URL,
                    record.SKU_Identifier,
                    record.Price,
                    record.Limit_Price,
                    record.Price_Status,
                    record.Scrape_Date,
                    record.Main_Image_URL
                );
            });
            stmt.finalize();
        });
        console.log(`   💾 数据库操作成功: ${new_records.length} 条记录被插入或更新。`);
    } catch (e) {
        console.log(`   ❌ 写入数据库时发生错误: ${e}`);
    } finally {
        db.close();
    }
}

function parsePriceToFloat(priceStr) {
    if (!priceStr) return null;
    const cleanStr = priceStr.toString().replace(/[^\d.]/g, '');
    const val = parseFloat(cleanStr);
    return isNaN(val) ? null : val;
}

// 登录检查
async function checkLoginStatus(page) {
    try {
        await page.goto('https://home.jd.com/', { waitUntil: "domcontentloaded", timeout: 20000 });
        const currentUrl = page.url();
        if (currentUrl.includes('passport.jd.com') || currentUrl.includes('safe.jd.com')) {
            console.log("   [检测] Cookie可能已失效 (重定向至登录页)。");
            return false;
        }
        const loginIndicators = ['.user-info', '.nickname', '#user-info', '[href*="logout"]'];
        for (const indicator of loginIndicators) {
            try {
                if (await page.locator(indicator).first().isVisible({ timeout: 3000 })) return true; 
            } catch (e) { continue; }
        }
        return false;
    } catch (e) {
        console.log(`   [警告] 网络错误: ${e.message}`);
        return null; 
    }
}

function showLoginIssueHelp() {
    console.log("\n=============================================");
    console.log("          登录状态失效或环境已变更           ");
    console.log("=============================================");
    console.log("检测到您可能切换了网络(代理)或Cookie已过期。");
    console.log("脚本已自动弹出浏览器窗口。");
    console.log("请在窗口中：");
    console.log("1. 手动完成登录。");
    console.log("2. 确保看到【个人中心】页面后，回到此处。");
    console.log("3. 按【回车键】继续...");
    console.log("=============================================\n");
}

async function main() {
    console.log(`--- 京东监控脚本 (v11.0 修复增强版) 启动 ---`);
    
    setup_database(DB_OUTPUT_PATH);
    
    // 1. 读取 Excel 任务
    let all_tasks_df;
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0]; 
        if (!worksheet) { console.log(`Excel 文件为空！`); return; }
        
        all_tasks_df = [];
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; 
            const urlCellValue = row.getCell(4).value;
            const barcodeValue = row.getCell(2).text ? row.getCell(2).text.trim() : 'N/A';
            
            // 读取限价 (第7列)
            const limitPriceRaw = row.getCell(7).value;
            let limitPrice = null;
            if (limitPriceRaw) limitPrice = parsePriceToFloat(limitPriceRaw);

            let finalUrl = (typeof urlCellValue === 'object' && urlCellValue?.hyperlink) ? urlCellValue.hyperlink : urlCellValue;

            all_tasks_df.push({
                [PLATFORM_COLUMN_HEADER]: row.getCell(1).value, 
                [URL_COLUMN_HEADER]: finalUrl,
                [SKU_COLUMN_HEADER]: barcodeValue,
                [LIMIT_PRICE_HEADER]: limitPrice
            });
        });
        console.log(`[1/4] 成功读取 ${all_tasks_df.length} 条任务。`);
    } catch (e) {
        console.log(`❌ 读取任务文件失败: ${e}`);
        return;
    }

    const platform_tasks = all_tasks_df.filter(task => task[PLATFORM_COLUMN_HEADER] === PLATFORM_NAME);
    if (platform_tasks.length === 0) return;

    const today_str = DateTime.now().toFormat('yyyy-MM-dd'); // 仅用于截图文件名前缀
    const new_records_this_session = [];
    let loginStatusConfirmed = false; 
    let browser = null;
    
    const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-infobars', '--no-default-browser-check'];

    try {
        // 2. 浏览器启动与登录检查
        console.log("[2/4] 启动浏览器...");
        browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
            executablePath: BROWSER_EXEC_PATH,
            headless: false, 
            viewport: { width: 1920, height: 1080 },
            args: launchArgs,
            slowMo: 50
        });
        
        const page = await browser.newPage();
        console.log("[CHECK] 正在验证登录有效性...");
        const loginStatus = await checkLoginStatus(page);
        
        if (!loginStatus) {
            showLoginIssueHelp();
            await new Promise(resolve => process.stdin.once('data', resolve));
            if (await checkLoginStatus(page)) loginStatusConfirmed = true;
            else console.log("   [警告] 仍未检测到登录，尝试强制执行。");
        } else {
            loginStatusConfirmed = true;
        }

        // 切换无头模式
        if (loginStatusConfirmed) {
            console.log("正在切换至后台运行模式...");
            await page.close();
            await browser.close();
            browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
                executablePath: BROWSER_EXEC_PATH,
                headless: true, // 生产环境建议 True，调试可改 False
                viewport: { width: 1920, height: 1080 },
                args: launchArgs,
                slowMo: 200 
            });
        }

       const screenshotDir = path.join(BASE_DIR, 'error_screenshots');
       if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
       
       console.log(`\n[3/4] 开始抓取 ${platform_tasks.length} 个任务...`);
       const workingPage = await browser.newPage(); 
       
       // 3. 主循环
       for (let index = 0; index < platform_tasks.length; index++) {
           const task = platform_tasks[index];
           const url = task[URL_COLUMN_HEADER];
           const barcode = task[SKU_COLUMN_HEADER];
           const limitPrice = task[LIMIT_PRICE_HEADER];

           if (!url || !url.startsWith('http')) continue;

           console.log(`--- [${index + 1}/${platform_tasks.length}] 69码:${barcode} ---`);

           // 核心修复：先初始化变量
           let final_price_str = "Not Found"; 
           let price_status = "未知";

           try {
               await workingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
               console.log("   ⏳ 等待页面渲染...");
               await workingPage.waitForTimeout(4000);

               // 验证码检测
               const captchaSelectors = ['#captcha_modal', '.captcha-box', 'text="验证一下"', '#J-dj-captcha'];
               for (const sel of captchaSelectors) {
                   if (await workingPage.locator(sel).first().isVisible({timeout: 1000})) { 
                       console.log("   ⚠️ 触发验证，等待5秒...");
                       await workingPage.waitForTimeout(5000); 
                       break;
                   }
               }

               // 价格抓取逻辑
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

               // 核心修复：比价逻辑必须在抓取到 final_price_str 之后
               if (final_price_str !== "Not Found") {
                   console.log(`   💰 抓取价格: ${final_price_str}`);
                   
                   if (limitPrice !== null) {
                       const currentPriceVal = parsePriceToFloat(final_price_str);
                       
                       if (currentPriceVal !== null) {
                           if (currentPriceVal < limitPrice) {
                               price_status = "破价警报";
                               console.log(`   🚨 [破价] 当前 ${currentPriceVal} < 限价 ${limitPrice}，正在截图...`);
                               
                               // 截图逻辑
                               const watermarkText = `【破价警报】\n时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}\n69码: ${barcode}\n限价: ${limitPrice}\n现价: ${currentPriceVal}`;
                               await workingPage.evaluate((text) => {
                                   const div = document.createElement('div');
                                   div.id = 'js-watermark';
                                   Object.assign(div.style, {
                                       position: 'fixed', top: '20%', left: '50%', transform: 'translate(-50%, 0)',
                                       padding: '30px', backgroundColor: 'rgba(200, 0, 0, 0.9)', color: '#fff',
                                       fontSize: '15px', fontWeight: 'bold', zIndex: '10000', borderRadius: '10px',
                                       textAlign: 'center'
                                   });
                                   div.innerText = text;
                                   document.body.appendChild(div);
                               }, watermarkText);

                               const safeBarcode = String(barcode).replace(/[^a-zA-Z0-9]/g, '');
                               const shotName = `${today_str}_${safeBarcode}_${PLATFORM_NAME}.png`;
                               await workingPage.screenshot({ path: path.join(screenshotDir, shotName) });
                               console.log(`   📸 截图已保存: ${shotName}`);

                               await workingPage.evaluate(() => { const el = document.getElementById('js-watermark'); if(el) el.remove(); });
                           
                           } else if (currentPriceVal > limitPrice) {
                               price_status = "高价待调整";
                               console.log(`   📈 [高价] 当前 ${currentPriceVal} > 限价 ${limitPrice}`);
                           } else {
                               price_status = "价格正常";
                           }
                       }
                   }
               } else {
                   price_status = "抓取失败";
                   console.log(`   ❌ 未找到价格`);
                   await workingPage.screenshot({ path: path.join(screenshotDir, `fail_${index}.png`), fullPage: false });
               }

           } catch (e) {
               console.log(`   [出错] ${e.message.split('\n')[0]}`);
               final_price_str = "Error";
               price_status = "脚本错误";
           }
           
           // 构建入库数据
           const current_timestamp = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
           let new_record = {
               'Platform': task[PLATFORM_COLUMN_HEADER], 
               'URL': url, 
               'SKU_Identifier': barcode,
               'Price': final_price_str, 
               'Limit_Price': limitPrice,    
               'Price_Status': price_status, 
               'Scrape_Date': current_timestamp,
               'Main_Image_URL': null
           };

           new_records_this_session.push(new_record);
           await workingPage.waitForTimeout(2000); 
       }

    } catch (e) {
        console.log(`严重错误: ${e}`);
    } finally {
        if (browser) await browser.close();
        save_results_to_db(DB_OUTPUT_PATH, new_records_this_session);
        console.log(`[完成] 所有任务已结束。`);
    }
}

main();