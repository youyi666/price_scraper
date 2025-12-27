// JD_run_jingdong_scraper.js
// Node.js version of JD_run_jingdong_scraper.py
// Requires: npm install playwright exceljs sqlite3 luxon

const { chromium } = require('playwright');
const exceljs = require('exceljs');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// --- 配置区 (从 config.json 文件动态加载) ---
const BASE_DIR = path.dirname(__filename);
const config_path = path.join(BASE_DIR, 'config.json');
const config = JSON.parse(fs.readFileSync(config_path, 'utf-8'));

// 读取所有路径配置
const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, config.paths.excel_task_file);
const DB_OUTPUT_PATH = path.join(BASE_DIR, config.paths.db_output);

// 读取浏览器配置
const BROWSER_EXEC_PATH = config.browser_settings.edge_executable_path;
const USER_DATA_DIR = config.browser_settings.edge_user_data_dir;
// --- 配置区结束 ---

const URL_COLUMN_HEADER = "URL";
const PLATFORM_COLUMN_HEADER = "Platform";
const PLATFORM_NAME = "京东";
const SKU_COLUMN_HEADER = "Barcode"; // 逻辑映射：Excel第2列
const LIMIT_PRICE_HEADER = "Limit_Price"; // 逻辑映射：Excel第7列

function setup_database(db_path) {
    const output_dir = path.dirname(db_path);
    if (!fs.existsSync(output_dir)) {
        fs.mkdirSync(output_dir, { recursive: true });
    }
    const db = new sqlite3.Database(db_path);
    db.run(`
        CREATE TABLE IF NOT EXISTS price_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT, Platform TEXT, URL TEXT, SKU_Identifier TEXT,
            Price TEXT, Scrape_Date TEXT, Main_Image_URL TEXT,
            UNIQUE(Platform, URL, SKU_Identifier, Scrape_Date)
        )
    `);
    db.close();
}

function save_results_to_db(db_path, new_records) {
    if (new_records.length === 0) return;
    const db = new sqlite3.Database(db_path);
    const sql_upsert = `
        INSERT INTO price_data (Platform, URL, SKU_Identifier, Price, Scrape_Date, Main_Image_URL)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date) 
        DO UPDATE SET Price = excluded.Price;
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
                    record.Scrape_Date,
                    record.Main_Image_URL
                );
            });
            stmt.finalize();
        });
        console.log(`   数据库操作成功: ${new_records.length} 条记录被插入或更新。`);
    } catch (e) {
        console.log(`   写入数据库时发生错误: ${e}`);
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

// 检查登录状态的函数
async function checkLoginStatus(page) {
    try {
        await page.goto('https://home.jd.com/', { waitUntil: "domcontentloaded", timeout: 20000 });
        
        const currentUrl = page.url();
        if (currentUrl.includes('passport.jd.com') || currentUrl.includes('safe.jd.com')) {
            console.log("   [检测] 页面被重定向至登录/验证页，Cookie可能已失效。");
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
        console.log(`   [警告] 检查登录状态时发生网络错误: ${e.message}`);
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
    console.log("1. 手动完成登录或验证码滑动。");
    console.log("2. 确保看到【个人中心】页面后，回到此处。");
    console.log("3. 按【回车键】继续...");
    console.log("=============================================\n");
}

async function main() {
    /**主执行函数 (v10.8 - 慢速稳定版)*/
    console.log(`--- 京东监控脚本 (v10.8 - 慢速稳定版) 启动 ---`);
    
    setup_database(DB_OUTPUT_PATH);
    
    let all_tasks_df;
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0]; 

        if (!worksheet) {
            console.log(`错误: Excel 文件为空！`);
            return;
        }
        all_tasks_df = [];

        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; 

            const urlCellValue = row.getCell(4).value;
            const barcodeValue = row.getCell(2).text ? row.getCell(2).text.trim() : 'N/A';
            const limitPriceRaw = row.getCell(7).value;
            let limitPrice = null;
            if (limitPriceRaw) limitPrice = parsePriceToFloat(limitPriceRaw);

            let finalUrl = ''; 
            if (typeof urlCellValue === 'object' && urlCellValue !== null && urlCellValue.hyperlink) {
                finalUrl = urlCellValue.hyperlink;
            } else {
                finalUrl = urlCellValue;
            }

            all_tasks_df.push({
                [PLATFORM_COLUMN_HEADER]: row.getCell(1).value, 
                [URL_COLUMN_HEADER]: finalUrl,
                [SKU_COLUMN_HEADER]: barcodeValue,
                [LIMIT_PRICE_HEADER]: limitPrice
            });
        });
        console.log(`[1/4] 成功读取 ${all_tasks_df.length} 条任务。`);
    } catch (e) {
        console.log(`错误: 读取任务文件失败: ${e}`);
        return;
    }

    const platform_tasks = all_tasks_df.filter(task => task[PLATFORM_COLUMN_HEADER] === PLATFORM_NAME);
    if (platform_tasks.length === 0) return;

    const today_str = DateTime.now().toFormat('yyyy-MM-dd');
    const new_records_this_session = [];
    let loginStatusConfirmed = false; 

    let browser = null;
    
    // [设置] 浏览器启动通用参数
    const launchArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check'
    ];

    try {
        console.log("[2/4] 启动浏览器...");
        
        // 阶段一：有头模式（登录检查/修复）
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
            if (await checkLoginStatus(page)) {
                console.log("   [成功] 登录状态已修复。");
                loginStatusConfirmed = true;
            } else {
                console.log("   [警告] 仍未检测到登录，将尝试强制执行。");
            }
        } else {
            console.log("   [成功] 登录状态有效。");
            loginStatusConfirmed = true;
        }

        // 阶段二：切换到无头模式
        if (loginStatusConfirmed) {
            console.log("正在切换至后台运行模式...");
            await page.close();
            await browser.close();
            
            browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
                executablePath: BROWSER_EXEC_PATH,
                headless: true,
                viewport: { width: 1920, height: 1080 },
                args: launchArgs,
                // [修改] 增加全局慢速，让每个动作变慢
                slowMo: 200 
            });
        }

       const screenshotDir = path.join(BASE_DIR, 'error_screenshots');
       if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
       
       console.log(`\n[3/4] 开始抓取 ${platform_tasks.length} 个任务 (启用慢速等待)...`);

       const workingPage = await browser.newPage(); 
       
       for (let index = 0; index < platform_tasks.length; index++) {
           const task = platform_tasks[index];
           const url = task[URL_COLUMN_HEADER];
           const barcode = task[SKU_COLUMN_HEADER];
           const limitPrice = task[LIMIT_PRICE_HEADER];

           if (!url || !url.startsWith('http')) continue;

           console.log(`--- [${index + 1}/${platform_tasks.length}] 69码:${barcode} ---`);

           let new_record = {
               'Platform': task[PLATFORM_COLUMN_HEADER], 'URL': url, 'SKU_Identifier': barcode,
               'Price': 'Error', 'Scrape_Date': today_str, 'Main_Image_URL': null
           };

           try {
               // [修改] 导航时放宽超时时间
               await workingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

               // [核心新增] 强制等待页面渲染 (固定等待 4 秒)
               // 这是解决“太快”最有效的方法
               console.log("   ⏳ 等待页面渲染 (4s)...");
               await workingPage.waitForTimeout(4000);

               // [核心新增] 模拟滚动触发懒加载（已禁用）
               // await workingPage.evaluate(() => {
               //     window.scrollTo(0, document.body.scrollHeight / 3);
               // });
               // await workingPage.waitForTimeout(1000);

               // --- 验证码/拦截检测 ---
               const captchaSelectors = ['#captcha_modal', '.captcha-box', 'text="验证一下"', 'text="访问频繁"', '#J-dj-captcha'];
               let isCaptcha = false;
               for (const sel of captchaSelectors) {
                   if (await workingPage.locator(sel).first().isVisible({timeout: 1000})) { isCaptcha = true; break; }
               }
               if (isCaptcha) {
                   console.log("   ⚠️ 触发验证，等待自动恢复/人工介入...");
                   await workingPage.waitForTimeout(5000); 
               }

               // --- 价格抓取 (优化) ---
               let final_price_str = "Not Found";
               const selectors = [
                   "#J_FinalPrice .price", ".J-presale-price", ".p-price .price", ".price"
               ];

               // [修改] 智能等待：尝试等待价格元素出现，而不是立刻失败
               // Promise.any 只要有一个选择器出现就继续
               try {
                   await Promise.any([
                       workingPage.waitForSelector("#J_FinalPrice .price", {timeout: 5000}),
                       workingPage.waitForSelector(".p-price .price", {timeout: 5000})
                   ]);
               } catch(e) {
                   // 等不到也没关系，后面会再一次 check
               }

               for (const sel of selectors) {
                   try {
                       const el = workingPage.locator(sel).first();
                       if (await el.isVisible()) {
                           const txt = await el.textContent();
                           if (/\d/.test(txt)) { final_price_str = txt.trim(); break; }
                       }
                   } catch (e) {}
               }

               // --- 比价与截图逻辑 ---
               if (final_price_str !== "Not Found") {
                   console.log(`   💰 抓取价格: ${final_price_str}`);
                   
                   if (limitPrice !== null) {
                       const currentPriceVal = parsePriceToFloat(final_price_str);
                       
                       if (currentPriceVal !== null && currentPriceVal < limitPrice) {
                           console.log(`   🚨 [破价] 当前 ${currentPriceVal} < 限价 ${limitPrice}，正在截图...`);
                           
                           // 1. 注入水印
                           const watermarkText = `【破价警报】\n时间: ${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}\n69码: ${barcode}\n限价: ${limitPrice}\n现价: ${currentPriceVal}`;
                           
                           await workingPage.evaluate((text) => {
                               const div = document.createElement('div');
                               div.id = 'js-watermark';
                               Object.assign(div.style, {
                                   position: 'fixed', top: '20%', left: '50%', transform: 'translate(-50%, 0)',
                                   padding: '30px', backgroundColor: 'rgba(200, 0, 0, 0.9)', color: '#fff',
                                   fontSize: '15px', fontWeight: 'bold', zIndex: '10000', borderRadius: '10px',
                                   textAlign: 'center', boxShadow: '0 4px 15px rgba(0,0,0,0.5)'
                               });
                               div.innerText = text;
                               document.body.appendChild(div);
                           }, watermarkText);

                           // 2. 保存截图
                           const safeBarcode = String(barcode).replace(/[^a-zA-Z0-9]/g, '');
                           const shotName = `${today_str}_${safeBarcode}_${PLATFORM_NAME}.png`;
                           await workingPage.screenshot({ path: path.join(screenshotDir, shotName) });
                           console.log(`   📸 截图已保存: ${shotName}`);

                           // 3. 清理水印
                           await workingPage.evaluate(() => { const el = document.getElementById('js-watermark'); if(el) el.remove(); });
                       }
                   }
               } else {
                   console.log(`   ❌ [失败] 页面已加载但未找到价格，保存截图以供调试...`);
                   await workingPage.screenshot({ path: path.join(screenshotDir, `fail_${index}.png`), fullPage: false });
               }

               new_record['Price'] = final_price_str;

           } catch (e) {
               console.log(`   [出错] ${e.message.split('\n')[0]}`);
           }
           
           new_records_this_session.push(new_record);
           // [修改] 任务间歇，休息一下
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