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
const PRICE_COLUMN_HEADER = "Price";
const DATE_COLUMN_HEADER = "Scrape_Date";
const SKU_COLUMN_HEADER = "SKU_Identifier";

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

// 检查登录状态的函数
async function checkLoginStatus(page) {
    try {
        // 尝试访问京东个人中心页面检查登录状态
        await page.goto('https://home.jd.com/', { waitUntil: "domcontentloaded", timeout: 15000 });
        
        // 京东登录状态检查
        const loginIndicators = [
            '.user-info', // 用户信息区域
            '.nickname',  // 用户名元素
            '[href*="passport.jd.com/logout"]' // 退出登录链接
        ];
        
        for (const indicator of loginIndicators) {
            try {
                await page.locator(indicator).waitFor({ timeout: 3000 });
                return true; // 找到登录状态标识，返回已登录
            } catch (e) {
                continue; // 未找到当前标识，尝试下一个
            }
        }
        return false;
    } catch (e) {
        console.log(`   [警告] 检查登录状态时发生错误: ${e.message}`);
        return null; 
    }
}

// 显示登录信息问题提示
function showLoginIssueHelp() {
    console.log("\n=============================================");
    console.log("          检测到可能的登录信息问题           ");
    console.log("=============================================");
    console.log("1. 请检查浏览器用户数据目录配置是否正确。");
    console.log("2. 若路径正确但仍有问题，可能是登录状态已过期:");
    console.log("   - 请删除用户数据目录下的所有文件");
    console.log("   - 重新运行脚本，会自动打开浏览器手动登录");
    console.log("=============================================\n");
}

async function main() {
    /**主执行函数 (v10.5 - 稳定回归版)*/
    console.log(`--- 京东监控脚本 (v10.5 - 稳定回归版) 启动 ---`);
    
    setup_database(DB_OUTPUT_PATH);
    console.log(`[PREP] 数据库 '${DB_OUTPUT_PATH}' 已准备就绪。`);
    
    let all_tasks_df;
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0]; 

        if (!worksheet) {
            console.log(`错误: 打开了 Excel 文件，但没有找到任何工作表！`);
            return;
        }
        all_tasks_df = [];

        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header

            const urlCellValue = row.getCell(4).value;
            let finalUrl = ''; 

            if (typeof urlCellValue === 'object' && urlCellValue !== null && urlCellValue.hyperlink) {
                finalUrl = urlCellValue.hyperlink;
            } else {
                finalUrl = urlCellValue;
            }

            all_tasks_df.push({
                [PLATFORM_COLUMN_HEADER]: row.getCell(1).value, 
                [URL_COLUMN_HEADER]: finalUrl 
            });
        });
        console.log(`[1/4] 成功从 '${EXCEL_TASK_FILE_PATH}' 读取 ${all_tasks_df.length} 条总任务。`);
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log(`致命错误: 任务文件未找到! 请检查路径: '${EXCEL_TASK_FILE_PATH}'`);
        } else {
            console.log(`错误: 读取任务文件时出错: ${e}`);
        }
        return;
    }

    const platform_tasks = all_tasks_df.filter(task => task[PLATFORM_COLUMN_HEADER] === PLATFORM_NAME);
    if (platform_tasks.length === 0) {
        console.log(`任务文件中没有找到平台为“${PLATFORM_NAME}”的任务，脚本结束。`);
        return;
    }
    console.log(`   筛选出 ${platform_tasks.length} 条 “${PLATFORM_NAME}” 平台的任务。`);
    
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');
    const new_records_this_session = [];
    let loginStatusConfirmed = false; 

    let browser = null;
    try {
        console.log("[2/4] 正在根据配置启动专用浏览器...");
        
        // 第一次启动：有头模式，用于检查/手动登录
        browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
            executablePath: BROWSER_EXEC_PATH,
            headless: false, 
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
            viewport: { width: 1920, height: 1080 },
            args: [
              '--disable-blink-features=AutomationControlled', 
              '--no-sandbox', 
              '--disable-dev-shm-usage' 
            ],
            slowMo: 100, 
            javaScriptEnabled: true,
            stylesheetEnabled: true
        });
        
        const page = await browser.newPage();
        console.log("SUCCESS: 专用浏览器启动并接管成功。");

        // [检查登录状态]
        console.log("[CHECK] 正在检查京东登录状态...");
        const loginStatus = await checkLoginStatus(page);
        
        if (loginStatus === false) {
            console.log("   [警告] 未检测到有效的京东登录状态!");
            showLoginIssueHelp(); 
            
            console.log("请在打开的浏览器中手动登录京东账号，登录完成后按回车键继续...");
            await new Promise(resolve => process.stdin.once('data', resolve));
            
            const recheckStatus = await checkLoginStatus(page);
            if (!recheckStatus) {
                console.log("   [错误] 仍然未检测到登录状态，可能导致抓取失败!");
            } else {
                console.log("   [成功] 已检测到登录状态，继续执行任务...");
                loginStatusConfirmed = true;
            }
        } else if (loginStatus === null) {
            console.log("   [警告] 登录状态检查过程中出现问题");
            showLoginIssueHelp();
        } else {
            console.log("   [成功] 已检测到有效的京东登录状态");
            loginStatusConfirmed = true;
        }

        // [切换模式] 如果已确认登录，切换为无头模式
        if (loginStatusConfirmed) {
            console.log("切换到无头模式以提高效率...");
            await page.close();
            await browser.close();
            
            browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
                executablePath: BROWSER_EXEC_PATH,
                headless: true, // 开启无头模式
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
                viewport: { width: 1920, height: 1080 },
                args: [
                  '--disable-blink-features=AutomationControlled',
                  '--no-sandbox',
                  '--disable-dev-shm-usage'
                ],
                slowMo: 100,
                javaScriptEnabled: true,
                stylesheetEnabled: true
            });
        }

       // --- 创建截图文件夹 ---
       const screenshotDir = path.join(BASE_DIR, 'error_screenshots');
       if (!fs.existsSync(screenshotDir)) {
           fs.mkdirSync(screenshotDir);
       }
       
       console.log(`\n[3/4] 开始批量抓取 (共 ${platform_tasks.length} 个任务)...`);

       const workingPage = await browser.newPage(); 
       
       // [回滚操作] 移除了 v10.4 中导致页面被京东拦截的 addInitScript 伪装代码
       // 保持环境与老版本一致
       
       for (let index = 0; index < platform_tasks.length; index++) {
           const task = platform_tasks[index];
           const url = task[URL_COLUMN_HEADER];

           if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;

           console.log(`--- [${index + 1}/${platform_tasks.length}] 处理: ${url.substring(0, 40)}... ---`);

           let new_record = {
               'Platform': task[PLATFORM_COLUMN_HEADER], 'URL': url, 'SKU_Identifier': 'default',
               'Price': 'Error', 'Scrape_Date': today_str, 'Main_Image_URL': null
           };

           try {
               // [回滚操作] 移除了导致循环跳转的“首页热身”步骤
               
               // 1. 访问页面
               await workingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

               // ================== [功能保留] 验证码自动检测与等待 ==================
               const captchaSelectors = [
                   '#captcha_modal', 
                   '.captcha-box', 
                   'text="验证一下"', 
                   'text="拖动滑块"', 
                   'text="访问频繁"',
                   '#J-dj-captcha'
               ];

               let isCaptchaDetected = false;
               for (const selector of captchaSelectors) {
                   try {
                       const el = workingPage.locator(selector).first();
                       if (await el.isVisible({ timeout: 1000 })) { 
                           isCaptchaDetected = true;
                           break; 
                       }
                   } catch (e) {}
               }

               if (isCaptchaDetected) {
                   console.log("\n🔴🔴🔴 警告：检测到【验证码】拦截！🔴🔴🔴");
                   console.log(">>> 请立即在浏览器窗口中，手动完成滑动/点击验证。");
                   console.log(">>> 脚本正在等待验证框消失...");

                   // 循环检测，直到验证码消失
                   for (let i = 0; i < 300; i++) {
                       let stillExist = false;
                       for (const selector of captchaSelectors) {
                           try {
                               if (await workingPage.locator(selector).first().isVisible({timeout: 200})) {
                                   stillExist = true;
                                   break;
                               }
                           } catch(e) {}
                       }

                       if (!stillExist) {
                           console.log("✅ 验证已通过！脚本继续执行...");
                           await workingPage.waitForTimeout(3000); 
                           break;
                       }
                       await workingPage.waitForTimeout(1000);
                       if (i % 5 === 0) process.stdout.write("."); 
                   }
                   console.log("\n"); 
               }
               // =================================================================

               // 2. 模拟操作
               await workingPage.mouse.wheel(0, Math.random() * 500);
               await workingPage.waitForTimeout(Math.random() * 1000 + 500);

               // 3. 检测跳转
               const currentUrl = workingPage.url();
               if (currentUrl.includes('www.jd.com') && !currentUrl.includes('item.jd.com')) {
                   console.log(`   [失效] 商品发生跳转 (可能已删除)`);
                   new_record['Price'] = "Redirected/Invalid";
                   new_records_this_session.push(new_record);
                   continue;
               }

               // 4. 检测下架
               const pageText = await workingPage.evaluate(() => document.body.innerText);
               if (pageText.includes('该商品已下架') || pageText.includes('商品已结束')) {
                   console.log(`   [状态] 商品已下架`);
                   new_record['Price'] = "Item Removed";
                   await workingPage.screenshot({ path: path.join(screenshotDir, `removed_row_${index + 1}.png`) });
                   new_records_this_session.push(new_record);
                   continue;
               }

               // 5. [关键修复] 抓取价格 (使用老版本逻辑)
               let final_price = "Not Found";
               const selectors_to_try = [
                   ["#J_FinalPrice .price", "促销价"], 
                   [".J-presale-price", "预售价"],
                   [".p-price .price", "日常价"],
                   [".price", "通用价格"]
               ];

               for (const [selector, price_type] of selectors_to_try) {
                   try {
                       const price_element = await workingPage.locator(selector).first();
                       if (await price_element.isVisible()) {
                            const price_text = await price_element.textContent();
                            if (price_text && /\d/.test(price_text)) { // 确保包含数字
                                final_price = price_text.trim();
                                console.log(`   [OK] 抓取成功 (${price_type}): ${final_price}`);
                                break;
                            }
                       }
                   } catch (e) { continue; }
               }

               if (final_price !== "Not Found") {
                   // 成功
               } else {
                   console.log(`   [警告] 未找到价格，截图留证...`);
                   const shotPath = path.join(screenshotDir, `error_row_${index + 1}.png`);
                   await workingPage.screenshot({ path: shotPath, fullPage: false });
               }

               new_record['Price'] = final_price;

           } catch (e) {
               console.log(`   [出错] ${e.message.split('\n')[0]}`);
               new_record['Price'] = "Script Error";
           }
           
           new_records_this_session.push(new_record);
       }

    } catch (e) {
        console.log(`\n--- 浏览器启动或任务循环中发生严重错误 ---: ${e}`);
        console.log(`提示：请检查 config.json 中的浏览器路径和用户数据目录是否正确。`);
    } finally {
        if (browser) {
            console.log("\n正在关闭浏览器...");
            await browser.close();
        }
        
        console.log("\n[4/4] 正在执行最终保存操作...");
        save_results_to_db(DB_OUTPUT_PATH, new_records_this_session);
        console.log(`[SUCCESS] 脚本执行完毕。本次抓取的 ${new_records_this_session.length} 条记录已成功同步至数据库。`);
    }
}

main();