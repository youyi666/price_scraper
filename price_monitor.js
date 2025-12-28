// =============================================================================
// 拼多多价格监控脚本 (v2.3 完整修复版)
// 功能：
// 1. 自动翻页抓取所有搜索结果
// 2. 数据库存储 (包含限价、破价/高价状态判断)
// 3. 修复 SyntaxError 和逻辑结构
// =============================================================================

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const sqlite3 = require('sqlite3').verbose();

// ================= [配置区域] =================
const TARGET_URL = "https://mms.pinduoduo.com/kit/goods-price-management?tool_full_channel=10323_97807&msfrom=mms_globalsearch";
const EXCEL_PATH = path.join(__dirname, 'tasks.xlsx');
const USER_DATA_DIR = path.join(__dirname, 'pdd_auth_data');
const DB_PATH = "F:\\price_scraper\\jd_prices.db"; 
// =============================================

// 辅助函数：随机延迟
const randomDelay = (min = 1000, max = 3000) => {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

// 辅助函数：格式化时间戳
function getFormattedTimestamp() {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// 辅助函数：价格提取 (取最后一个有效非零值)
function extractPrice(text) {
    if (!text) return 0;
    const matches = text.match(/\d+(\.\d+)?/g);
    if (!matches) return 0;
    const validPrices = matches.map(parseFloat).filter(p => p > 0);
    if (validPrices.length === 0) return 0;
    return validPrices[validPrices.length - 1];
}

// 辅助函数：ID提取
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

// 核心函数：读取任务
function getTaskDataFromExcel() {
    if (!fs.existsSync(EXCEL_PATH)) {
        console.error(`❌ 未找到文件: ${EXCEL_PATH}`);
        return { ids: [], limitMap: {} };
    }
    const workbook = XLSX.readFile(EXCEL_PATH);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);
    const limitMap = {}; 
    const targetIds = [];

    data.forEach(row => {
        if (row['Platform'] && row['Platform'].trim() === '拼多多') {
            const rawId = extractIdFromInput(row['URL']);
            if (rawId) {
                targetIds.push(rawId);
                let limit = row['PriceLimit'];
                if (limit) {
                    if (typeof limit === 'string') limit = parseFloat(limit.replace(/[,￥]/g, ''));
                    limitMap[rawId] = limit;
                } else {
                    limitMap[rawId] = -1; // 无限价则设为-1
                }
            }
        }
    });
    return { ids: [...new Set(targetIds)], limitMap: limitMap };
}

// 核心函数：数据库写入 (包含新字段 Limit_Price, Price_Status)
function save_results_to_db(db_path, new_records) {
    if (new_records.length === 0) {
        console.log("   ⚠️ 本页无需要保存的记录。");
        return;
    }
    const dbDir = path.dirname(db_path);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const db = new sqlite3.Database(db_path);
    
    // 建表语句 (包含新增列)
    const create_table_sql = `
        CREATE TABLE IF NOT EXISTS price_data (
            Platform TEXT, 
            URL TEXT, 
            SKU_Identifier TEXT, 
            Price REAL, 
            Limit_Price REAL,      -- 新增：限价
            Price_Status TEXT,     -- 新增：状态(破价警报/高价待调整)
            Scrape_Date TEXT, 
            Main_Image_URL TEXT,
            PRIMARY KEY (Platform, URL, SKU_Identifier, Scrape_Date)
        );
    `;

    // [变动] 插入语句增加两列
    const sql_upsert = `
        INSERT INTO price_data (Platform, URL, SKU_Identifier, Price, Limit_Price, Price_Status, Scrape_Date, Main_Image_URL)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date) 
        DO UPDATE SET Price = excluded.Price, Price_Status = excluded.Price_Status;
    `;

    try {
        db.serialize(() => {
            db.run(create_table_sql);
            const stmt = db.prepare(sql_upsert);
            new_records.forEach(r => {
                stmt.run(
                    r.Platform, 
                    r.URL, 
                    r.SKU_Identifier, 
                    r.Price, 
                    r.Limit_Price,   // 新增
                    r.Price_Status,  // 新增
                    r.Scrape_Date, 
                    r.Main_Image_URL
                );
            });
            stmt.finalize();
        });
        console.log(`   💾 [DB] 成功保存 ${new_records.length} 条带有状态判断的记录。`);
    } catch (e) {
        console.log(`   ❌ [DB Error] ${e}`);
    } finally {
        db.close();
    }
}

async function run() {
    console.log(`\n🚀 启动拼多多监控脚本 v2.3 (完整修复版)...`);
    
    const { ids, limitMap } = getTaskDataFromExcel();
    if (ids.length === 0) return console.log("⚠️ 无任务退出。");
    console.log(`📋 监控任务: ${ids.length} 个商品 (基准价已载入)`);

    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        channel: 'msedge', 
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
        viewport: null
    });
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        await page.goto(TARGET_URL);
        
        // 登录检测
        await page.waitForTimeout(2000);
        if (page.url().includes('login') || (await page.locator('.login-content').count()) > 0) {
            console.log("🛑 请手动登录...");
            await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
        }
        
        await page.waitForSelector('table[class*="TB_tableWrapper"]', { timeout: 20000 });

        // 查询
        const inputLocator = page.locator('input[placeholder*="多个ID"]');
        await inputLocator.clear();
        await inputLocator.fill(ids.join(' '));
        await page.locator('button', { hasText: '查询' }).first().click();
        
        console.log("⏳ 等待查询结果...");
        await page.waitForTimeout(3000);

        let hasNextPage = true;
        let pageNum = 1;
        let dbRecords = [];

        while (hasNextPage) {
            console.log(`\n📄 --- 第 ${pageNum} 页 ---`);
            const tbody = page.locator('tbody[data-testid="beast-core-table-middle-tbody"]');
            await page.waitForTimeout(1500);

            if (await tbody.count() > 0) {
                const rows = await tbody.locator('tr').all();
                for (const row of rows) {
                    try {
                        const cells = await row.locator('td').all();
                        if (cells.length < 5) continue;

                        const productInfoText = await cells[1].innerText();
                        const skuInfo = await cells[2].innerText();
                        const priceText = await cells[3].innerText();
                        const currentPrice = extractPrice(priceText);
                        
                        // ID 匹配
                        let matchedId = null;
                        for (const id of Object.keys(limitMap)) {
                            if (productInfoText.includes(id)) {
                                matchedId = id;
                                break;
                            }
                        }

                        // 图片提取
                        const imgLocator = cells[1].locator('img').first();
                        const mainImgUrl = (await imgLocator.count() > 0) ? await imgLocator.getAttribute('src') : "";

                        if (matchedId && currentPrice > 0) {
                            const refPrice = limitMap[matchedId];
                            let status = "正常";
                            let shouldSave = false;

                            if (currentPrice < refPrice) {
                                status = "破价警报";
                                shouldSave = true;
                                console.log(`   🚨 [破价] ID:${matchedId} | 现价:${currentPrice} < 限价:${refPrice}`);
                            } else if (currentPrice > refPrice) {
                                status = "高价待调整";
                                shouldSave = true;
                                console.log(`   📈 [高价] ID:${matchedId} | 现价:${currentPrice} > 限价:${refPrice}`);
                            } 
                            // 价格相等时，如果不希望保存，则 shouldSave 保持 false

                            if (shouldSave) {
                                dbRecords.push({
                                    Platform: "拼多多",
                                    URL: `https://mobile.yangkeduo.com/goods.html?goods_id=${matchedId}`,
                                    SKU_Identifier: `${matchedId} - ${skuInfo}`,
                                    Price: currentPrice,
                                    Limit_Price: refPrice,
                                    Price_Status: status,
                                    Scrape_Date: getFormattedTimestamp(),
                                    Main_Image_URL: mainImgUrl
                                });
                            }
                        }
                    } catch (e) { console.error("   ⚠️ 行解析错:", e.message); }
                }
            }

            // 翻页
            const nextBtn = page.locator('li[data-testid="beast-core-pagination-next"]');
            if (await nextBtn.count() > 0 && await nextBtn.isVisible()) {
                const classAttr = await nextBtn.getAttribute('class') || "";
                if (classAttr.includes('disabled')) {
                    console.log("   🏁 翻页结束。");
                    hasNextPage = false;
                } else {
                    await nextBtn.click();
                    await randomDelay(2000, 3000);
                    pageNum++;
                }
            } else {
                console.log("   🏁 翻页结束 (无按钮)。");
                hasNextPage = false;
            }
        }

        save_results_to_db(DB_PATH, dbRecords);

    } catch (error) {
        console.error("❌ Error:", error);
    } finally {
        console.log("🤖 运行结束。");
    }
}

// 辅助构建记录对象
function createRecord(id, sku, price, img) {
    return {
        Platform: "拼多多",
        URL: `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`,
        SKU_Identifier: `${id} - ${sku}`,
        Price: price,
        Scrape_Date: getFormattedTimestamp(),
        Main_Image_URL: img
    };
}

run();