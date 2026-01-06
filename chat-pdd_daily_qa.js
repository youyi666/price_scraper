/**
 * 拼多多每日专项质检爬虫 (Chat Pagination Mode) - 聊天记录翻页修正版
 * * 场景：按商品ID搜索 -> 左侧是用户列表 -> 右侧是该用户的聊天记录（多页）。
 * * 修复：
 * 1. 翻页逻辑移入“单个用户处理”流程内部。
 * 2. 自动合并该用户所有页码的聊天记录。
 * 3. 针对 Beast UI 分页按钮的深度点击修复。
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// ================= [配置区域] =================
// 在此处修改你要查询的商品ID
const TARGET_GOODS_ID = '862873034610'; 

// 结果保存路径
const OUTPUT_DIR = path.join(__dirname, 'daily_qa_logs');
// 浏览器缓存路径
const USER_DATA_DIR = path.join(__dirname, 'browser_profiles', 'pdd_store');
// 目标网址
const TARGET_URL = 'https://mms.pinduoduo.com/mms-chat/search?msfrom=mms_sidenav';

// 初始化目录
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// ================= [辅助函数] =================

const randomDelay = (min = 1000, max = 2000) => 
    new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

function getYesterdayRange() {
    // 根据你的截图，你可能是在查当天或特定日期，这里为了灵活，保留昨天逻辑
    // 你也可以手动修改这里返回特定日期，例如 '2026-01-04 ~ 2026-01-04'
    const yesterday = DateTime.now().minus({ days: 1 }).toFormat('yyyy-MM-dd');
    return `${yesterday} ~ ${yesterday}`;
}

// ================= [主逻辑] =================

async function runDailyCheck() {
    console.log(`🚀 [启动] 每日专项质检爬虫 (针对聊天记录翻页)...`);

    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        channel: 'msedge', 
        headless: false,
        viewport: null,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        // 1. 打开页面 & 登录检查
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        if (page.url().includes('login')) {
            console.log("🛑 检测到未登录，请手动扫码...");
            await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
            console.log("✅ 登录成功...");
        }

        // --- 步骤 A: 切换查询模式 & 输入 ID ---
        console.log("👉 切换到 [按商品ID查询]...");
        const radioLabel = page.locator('label').filter({ hasText: '按商品id查询' }).first();
        await radioLabel.click();
        await randomDelay();

        console.log(`⌨️ 输入商品ID: ${TARGET_GOODS_ID}`);
        const idInput = page.locator('input[placeholder*="商品ID"], input[placeholder*="请输入"]'); 
        await idInput.first().fill(TARGET_GOODS_ID);
        await randomDelay();

        // --- 步骤 B: 设置日期 (根据截图，你需要特定日期范围) ---
        // 注意：这里默认是昨天，如果需要截图里的 2026-01-04，请去 getYesterdayRange 修改
        const dateRange = getYesterdayRange(); 
        console.log(`📅 设置日期范围: ${dateRange}`);
        await page.evaluate(({ selector, val }) => {
            const el = document.querySelector(selector);
            if (el) {
                el.removeAttribute('readonly');
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }
        }, { selector: 'input[data-testid="beast-core-rangePicker-htmlInput"]', val: dateRange });
        await randomDelay();

        // --- 步骤 C: 查询 ---
        console.log("🔍 点击查询...");
        await page.locator('button').filter({ hasText: '查询' }).first().click();
        
        // 等待左侧列表加载
        try {
            await page.waitForSelector('.cs-list .user-item', { timeout: 8000 });
        } catch (e) {
            console.log("⚠️ 未找到用户列表，可能是没有记录。");
            await context.close();
            return;
        }

        // --- 步骤 D: 遍历用户 (外层循环) ---
        // 注意：这里假设左侧用户列表通过滚动加载或已全部显示
        const userItems = await page.locator('.cs-list .user-item').all();
        console.log(`\n👥 发现 ${userItems.length} 个用户，开始逐个处理...`);

        let totalUsersProcessed = 0;

        for (let i = 0; i < userItems.length; i++) {
            const userItem = userItems[i];
            const userNameEl = userItem.locator('.user-name');
            let userName = await userNameEl.innerText();
            userName = userName.trim().replace(/[\\/:*?"<>|]/g, '_');

            console.log(`\n👉 [用户 ${i + 1}/${userItems.length}] 处理中: ${userName}`);
            
            // 1. 点击用户，加载聊天
            try { await userItem.click({ timeout: 2000 }); } catch(e) { await userItem.evaluate(el => el.click()); }
            await randomDelay(1000, 2000); // 等待右侧加载

            // ==========================================
            // 👇👇👇 聊天记录翻页逻辑 (内层循环) 👇👇👇
            // ==========================================
            let hasNextChatPage = true;
            let chatPageNum = 1;
            let allMessagesForUser = [];

            while (hasNextChatPage) {
                console.log(`   📄 正在抓取聊天记录第 ${chatPageNum} 页...`);

                // 2. 抓取当前页数据
                const pageMessages = await scrapeCurrentChat(page, userName);
                if (pageMessages.length > 0) {
                    allMessagesForUser.push(...pageMessages);
                    console.log(`      + 捕获 ${pageMessages.length} 条消息`);
                }

                // 3. 检查是否有“下一页” (针对聊天记录的分页)
                // 截图显示分页在右下角
                const nextBtn = page.locator('li[data-testid="beast-core-pagination-next"]');
                
                // 检查是否存在且未禁用
                if (await nextBtn.count() === 0) {
                    // 没有分页条，说明只有一页
                    hasNextChatPage = false; 
                } else {
                    const classAttr = await nextBtn.getAttribute('class') || '';
                    if (classAttr.toLowerCase().includes('disabled')) {
                        console.log("      ✅ 聊天记录已到最后一页。");
                        hasNextChatPage = false;
                    } else {
                        // 执行翻页
                        console.log("      🔄 点击下一页 (聊天记录)...");
                        const innerIcon = nextBtn.locator('.beast-core-icon, i, svg').first();
                        if (await innerIcon.count() > 0) {
                            await innerIcon.click({ force: true });
                        } else {
                            await nextBtn.click({ force: true });
                        }
                        
                        await page.waitForTimeout(2500); // 等待新消息加载
                        
                        // 简单验证：页码是否变了？
                        const activePage = await page.locator('li[class*="PGT_pagerItemActive"]').innerText().catch(()=>'');
                        if (parseInt(activePage) === chatPageNum) {
                            console.log("      ⚠️ 翻页似乎未生效，防止死循环，停止翻页。");
                            hasNextChatPage = false;
                        } else {
                            chatPageNum++;
                        }
                    }
                }
            }

            // 4. 保存该用户的所有数据
            if (allMessagesForUser.length > 0) {
                // 去重 (防止翻页重复抓取边界数据)
                const uniqueMsgs = Array.from(new Set(allMessagesForUser.map(a => JSON.stringify(a))))
                    .map(s => JSON.parse(s));
                
                const dateStr = DateTime.now().toFormat('yyyyMMdd');
                const fileName = `${dateStr}_${userName}_${TARGET_GOODS_ID}.json`;
                fs.writeFileSync(path.join(OUTPUT_DIR, fileName), JSON.stringify(uniqueMsgs, null, 2));
                console.log(`   💾 已保存 ${uniqueMsgs.length} 条记录 -> ${fileName}`);
                totalUsersProcessed++;
            } else {
                console.log("   ⚠️ 该用户无有效聊天记录。");
            }
        }

        console.log(`\n🎉 全部完成！已处理 ${totalUsersProcessed} 个用户。`);

    } catch (e) {
        console.error("❌ 错误:", e);
    } finally {
        await page.waitForTimeout(3000);
        await context.close();
    }
}

/**
 * 抓取当前可见的聊天内容
 */
async function scrapeCurrentChat(page) {
    // 稍微等待消息元素加载
    try {
        await page.waitForSelector('.message-item', { timeout: 2000 });
    } catch(e) { return []; }

    const msgElements = await page.locator('.message-item').all();
    const chatData = [];

    for (const msg of msgElements) {
        const data = await msg.evaluate(el => {
            const nameEl = el.querySelector('.message-name');
            const timeEl = el.querySelector('.message-time');
            const textEl = el.querySelector('.message-text');
            const imgEl = el.querySelector('.message-body img');
            const isSystem = el.classList.contains('system-message');

            let role = '客服';
            const rawName = nameEl ? nameEl.innerText.trim() : '未知';
            if (isSystem) role = '系统';
            else if (rawName.includes('*') || rawName.includes('子')) role = '用户';
            
            let content = '';
            let type = 'text';

            if (imgEl) {
                content = imgEl.src;
                type = 'image';
            } else if (textEl) {
                content = textEl.innerText.trim();
            }

            return {
                time: timeEl ? timeEl.innerText.trim() : '',
                role: role,
                name: rawName,
                type: type,
                content: content
            };
        });
        chatData.push(data);
    }
    return chatData;
}

runDailyCheck(); bn