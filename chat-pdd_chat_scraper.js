/**
 * Pinduoduo Chat Log Scraper (拼多多聊天记录抓取 - 专家版)
 * * 功能：
 * 1. 自动登录（复用 Profile）
 * 2. 根据 OrderID 智能推算日期范围
 * 3. 抓取全量聊天记录（自动翻页）
 * 4. 输出结构化 JSON 文件
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx'); // 需要安装: npm install xlsx
const { DateTime } = require('luxon'); // 需要安装: npm install luxon

// ================= [配置区域] =================
// 1. 任务 Excel 文件路径 (请确保表头包含 'OrderID')
const EXCEL_TASK_PATH = path.join(__dirname, 'tasks-chat.xlsx'); 

// 2. 结果保存目录
const OUTPUT_DIR = path.join(__dirname, 'chat_logs');

// 3. 浏览器缓存路径 (与之前的脚本保持一致，复用登录状态)
const USER_DATA_DIR = path.join(__dirname, 'browser_profiles', 'pdd_store');

// 4. 目标网址
const TARGET_URL = 'https://mms.pinduoduo.com/mms-chat/search?msfrom=mms_sidenav';

// ================= [辅助工具函数] =================

// 初始化目录
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// 随机延迟 (拟人化)
const randomDelay = (min = 1000, max = 3000) => {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

/**
 * 核心算法：从订单号推算日期范围
 * 假设订单号前6位是 YYMMDD，例如 251206-xxx -> 2025-12-06
 * 如果解析失败，默认返回最近3个月
 */
function calculateDateRange(orderId) {
    try {
        const idStr = String(orderId).trim();
        // 尝试提取前6位数字
        const datePart = idStr.substring(0, 6);
        
        // 简单校验是否为数字
        if (/^\d{6}$/.test(datePart)) {
            const year = '20' + datePart.substring(0, 2);
            const month = datePart.substring(2, 4);
            const day = datePart.substring(4, 6);
            
            const orderDate = DateTime.fromISO(`${year}-${month}-${day}`);
            
            if (orderDate.isValid) {
                // 策略：开始时间 = 订单日期 - 30天，结束时间 = 订单日期 + 60天 (覆盖售后)
                const start = orderDate.minus({ days: 30 }).toFormat('yyyy-MM-dd');
                const end = orderDate.plus({ days: 60 }).toFormat('yyyy-MM-dd');
                return `${start} ~ ${end}`;
            }
        }
    } catch (e) {
        console.warn(`   ⚠️ 无法从订单号 [${orderId}] 解析日期，使用默认范围。`);
    }

    // 默认回退方案：最近3个月
    const end = DateTime.now().toFormat('yyyy-MM-dd');
    const start = DateTime.now().minus({ months: 3 }).toFormat('yyyy-MM-dd');
    return `${start} ~ ${end}`;
}

// ================= [主逻辑] =================

async function runChatScraper() {
    console.log(`🚀 [启动] 拼多多聊天记录抓取任务...`);

    // 1. 读取 Excel 任务
    let tasks = [];
    try {
        if (fs.existsSync(EXCEL_TASK_PATH)) {
            const workbook = XLSX.readFile(EXCEL_TASK_PATH);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(sheet);
            // 过滤出有 OrderID 的行
            tasks = data.filter(row => row['OrderID']).map(row => String(row['OrderID']).trim());
        } else {
            console.error(`❌ 未找到任务文件: ${EXCEL_TASK_PATH}`);
            console.log(`💡 请创建一个 Excel，第一行表头写 'OrderID'，下面填入订单号。`);
            return;
        }
    } catch (e) {
        console.error(`❌ 读取 Excel 失败: ${e.message}`);
        return;
    }

    console.log(`📋 读取到 ${tasks.length} 个待抓取订单。`);

    // 2. 启动浏览器
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        channel: 'msedge', // 使用 Edge 伪装性更好
        headless: false,   // 必须有头，以便观察和调试
        viewport: null,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        // 3. 访问页面并检查登录
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        // 简单检测是否需要登录 (如果页面URL跳转到了login)
        if (page.url().includes('login')) {
            console.log("🛑 检测到未登录，请在浏览器窗口中扫码登录...");
            // 等待直到 URL 不包含 login
            await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
            console.log("✅ 登录成功，继续任务...");
        }

        // 4. 遍历订单列表
        for (let i = 0; i < tasks.length; i++) {
            const orderID = tasks[i];
            console.log(`\n============== 处理订单 (${i + 1}/${tasks.length}): ${orderID} ==============`);

            try {
                // --- 步骤 A: 切换查询模式 (Radio Button) ---
                // 使用模糊文本匹配，比那一长串 class 更稳定
                const radioLabel = page.locator('label').filter({ hasText: '按订单/违规会话编号查询' });
                await radioLabel.click();
                await randomDelay(500, 1000);

                // --- 步骤 B: 输入订单号 ---
                // 定位 placeholder 包含特定文字的 input
                const orderInput = page.locator('input[placeholder*="订单/违规会话编号"]');
                await orderInput.clear();
                await orderInput.fill(orderID);
                await randomDelay(500, 1000);

                // --- 步骤 C: 输入日期范围 (难点) ---
                const dateRangeStr = calculateDateRange(orderID);
                console.log(`   📅 设定时间范围: ${dateRangeStr}`);

                // 尝试定位日期输入框
                const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');
                
                // 【专家技巧】移除 readonly 属性并强制赋值，绕过复杂的日历点击
                await page.evaluate(({ selector, val }) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        el.removeAttribute('readonly'); // 移除只读限制
                        el.value = val; // 强制赋值
                        // 触发 React 的状态更新事件
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                }, { selector: 'input[data-testid="beast-core-rangePicker-htmlInput"]', val: dateRangeStr });

                await randomDelay(1000, 2000);

                // --- 步骤 D: 点击查询 ---
                // 查找页面上的“查询”按钮 (通常是 type=button 或含特定 class)
                const searchBtn = page.locator('button').filter({ hasText: '查询' }).first();
                await searchBtn.click();
                
                console.log(`   ⏳ 等待搜索结果...`);
                // 等待表格加载，或者出现“暂无数据”
                // 等待 .message-item 出现，或者 .no-data 出现，或者超时
                try {
                    await Promise.any([
                        page.waitForSelector('.message-item', { timeout: 5000 }),
                        page.waitForSelector('.result-col-body', { timeout: 5000 })
                    ]);
                } catch (e) {
                    console.log(`   ⚠️ 未找到消息元素，可能无记录或加载超时。`);
                    continue; // 跳过此订单
                }

                // --- 步骤 E: 循环抓取 (翻页) ---
                let allMessages = [];
                let hasNextPage = true;
                let pageCount = 1;

                while (hasNextPage) {
                    console.log(`      📄 正在抓取第 ${pageCount} 页...`);
                    
                    // 等待当前页的消息加载完毕
                    await page.waitForTimeout(1000);

                    // 获取当前页所有消息元素
                    const messageItems = await page.locator('.message-item').all();

                    for (const item of messageItems) {
                        const msgData = await item.evaluate((el) => {
                            // 内部提取逻辑
                            const nameEl = el.querySelector('.message-name');
                            const timeEl = el.querySelector('.message-time');
                            const contentEl = el.querySelector('.message-text');
                            const imgEl = el.querySelector('.message-body img'); // 检查是否有图片
                            const isSystem = el.classList.contains('system-message');

                            const rawName = nameEl ? nameEl.innerText.trim() : '未知';
                            const rawTime = timeEl ? timeEl.innerText.trim() : '';
                            
                            // 判断身份
                            let role = '客服';
                            if (isSystem) role = '系统';
                            else if (rawName.includes('*') || rawName.includes('子')) role = '用户'; // 根据你的描述，用户通常带*
                            
                            // 提取内容 (文本或图片链接)
                            let content = '';
                            let type = 'text';
                            if (imgEl) {
                                content = imgEl.src;
                                type = 'image';
                            } else if (contentEl) {
                                content = contentEl.innerText.trim();
                            }

                            return {
                                time: rawTime,
                                role: role,
                                name: rawName,
                                type: type,
                                content: content
                            };
                        });
                        allMessages.push(msgData);
                    }

                    // --- 翻页逻辑 ---
                    // 定位“下一页”按钮
                    const nextBtn = page.locator('li[data-testid="beast-core-pagination-next"]');
                    
                    // 检查是否存在且未禁用
                    // 注意：拼多多的禁用通常是在 class 里加 disabled，或者内部 icon 变色
                    const isVisible = await nextBtn.isVisible();
                    if (!isVisible) {
                        hasNextPage = false;
                        break;
                    }

                    // 检查 class 列表是否包含禁用状态 (通常是 'disabled' 或 'PGT_disabled')
                    const classList = await nextBtn.getAttribute('class');
                    if (classList && (classList.includes('disabled') || classList.includes('disable'))) {
                        hasNextPage = false;
                        console.log(`      ✅ 已到达最后一页。`);
                    } else {
                        await nextBtn.click();
                        await randomDelay(2000, 3000); // 等待翻页加载
                        pageCount++;
                    }
                }

                // --- 步骤 F: 保存数据 ---
                if (allMessages.length > 0) {
                    // 按时间正序排列 (通常抓取下来是倒序或乱序，取决于网页，这里假设网页是正序，如果不是可以用 sort)
                    // allMessages.sort((a, b) => new Date(a.time) - new Date(b.time));

                    const fileName = path.join(OUTPUT_DIR, `${orderID}_chat.json`);
                    fs.writeFileSync(fileName, JSON.stringify(allMessages, null, 2));
                    console.log(`   💾 已保存 ${allMessages.length} 条记录 -> ${fileName}`);
                } else {
                    console.log(`   ⚠️ 该订单没有抓取到任何聊天记录。`);
                }

            } catch (err) {
                console.error(`   ❌ 处理订单 ${orderID} 时出错:`, err);
                // 截图留证
                await page.screenshot({ path: path.join(OUTPUT_DIR, `error_${orderID}.png`) });
            }

            // 订单间歇休息
            await randomDelay(2000, 4000);
        }

    } catch (err) {
        console.error(`❌ 全局错误:`, err);
    } finally {
        // 关闭前等待一下
        console.log(`🎉 任务全部完成，3秒后关闭浏览器...`);
        await page.waitForTimeout(3000);
        await context.close();
    }
}

// 执行
runChatScraper();