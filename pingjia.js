// =============================================================================
// 拼多多评价管理后台爬虫 (v2.1 增强版)
// 迭代记录：
// v2.0: 修复内容抓取错位、评分统计错误
// v2.1: 解除翻页限制、新增“好评有礼”返现状态抓取
// =============================================================================

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ================= [配置区域] =================
// 【重要】请替换为您后台“评价管理”页面的实际网址
const TARGET_URL = "https://mms.pinduoduo.com/goods/evaluation/index?msfrom=mms_sidenavt"; 

// 抓取页数 (已修改：由 5 改为 9999，实现实质上的无限翻页，直到最后一页停止)
const MAX_PAGES = 9999; 
const USER_DATA_DIR = path.join(__dirname, 'pdd_auth_data');
// =============================================

// 辅助函数：从 style 属性中提取 background-image 的 URL
function extractUrlFromStyle(styleStr) {
    if (!styleStr) return "";
    const match = styleStr.match(/url\(["']?(.*?)["']?\)/);
    return match ? match[1] : "";
}

// 辅助函数：随机延迟
const randomDelay = (min = 1000, max = 3000) => {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

async function run() {
    console.log(`\n🚀 启动持久化爬虫 (Node.js版 v2.1)...`);
    console.log(`📂 登录凭证将保存在: ${USER_DATA_DIR}`);
    
    // 启动浏览器
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false, 
        channel: 'msedge', // 如果报错找不到浏览器，请改为 'chrome' 或注释掉此行
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
        viewport: null 
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        await page.goto(TARGET_URL);

        // === 登录检查 ===
        console.log('🕵️  检查登录状态...');
        await page.waitForTimeout(2000);
        if (page.url().includes('login') || (await page.locator('.login-content').count()) > 0) {
            console.log("🛑【检测到未登录】");
            console.log("   请在弹出的浏览器中手动扫码。");
            console.log("   脚本正在等待您登录成功并跳转...");

            // 无限等待，直到 URL 不再包含 'login' (即跳转到了后台)
            await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
            console.log("✅ 登录成功！");
        } else {
            console.log("⚡ 已自动登录！");
        }

        const TARGET_GOODS_ID = "862873034610"; // 目标ID
        
        console.log(`\n🔍 [筛选模式] 正在锁定商品 ID: ${TARGET_GOODS_ID}`);

        try {
            // 1. 【精准定位】输入框
            const filterInput = page.locator('[data-tracking-click-viewid="product_id_input"] input');
            await filterInput.waitFor({ state: 'visible', timeout: 5000 });
            await filterInput.clear();
            await filterInput.fill(TARGET_GOODS_ID);
            console.log("   ✅ 已填入商品ID");

            // 2. 【精准定位】查询按钮
            const queryBtn = page.locator('button[type="submit"]', { hasText: '查询' });
            await queryBtn.waitFor({ state: 'visible', timeout: 5000 });
            await queryBtn.click();
            console.log("   ✅ 已点击查询按钮，等待列表刷新...");

            // 3. 等待数据加载
            await page.waitForTimeout(3000); 
            
        } catch (err) {
            console.error("   ❌ 筛选操作失败:", err.message);
            console.log("   ⚠️ 将尝试直接抓取当前列表...");
        }
        // ============================================================

        let allReviews = [];

        // === 循环抓取 ===
        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            console.log(`\n🔄 正在分析第 ${pageNum} 页...`);

            try {
                // 等待每一行的容器加载
                await page.waitForSelector('tbody[data-testid="beast-core-table-middle-tbody"]', { timeout: 8000 });
            } catch (e) {
                console.log("⚠️ 页面加载超时或已无数据。");
                break;
            }

            // 获取所有评价块 (tbody)
            const reviewBlocks = await page.locator('tbody[data-testid="beast-core-table-middle-tbody"]').all();
            console.log(`   - 发现 ${reviewBlocks.length} 条数据`);

            for (const block of reviewBlocks) {
                try {
                    // 1. 提取订单编号
                    const orderDiv = block.locator("div", { hasText: "订单编号：" }).first();
                    const orderText = await orderDiv.innerText();
                    const orderId = orderText.split("：")[1]?.trim() || "未知订单";

                    // 2. 提取买家昵称
                    const nickDiv = block.locator("div", { hasText: "买家昵称：" }).first();
                    const nickText = await nickDiv.innerText();
                    const nickname = nickText.split("：")[1]?.trim() || "匿名";

                    // 3. 提取评分
                    const starsCount = await block.locator("svg[data-testid='beast-core-icon-star_filled']").count();
                    let rating = starsCount > 0 ? Math.min(starsCount, 5) : 5;

                    // 4. 提取评价内容
                    const contentWrapper = block.locator("div[class*='logic_reviewWrapper']").first();
                    let content = "";
                    
                    if (await contentWrapper.count() > 0) {
                        content = await contentWrapper.locator("div").first().innerText();
                    } else {
                        content = "（用户未填写文字评价）";
                    }

                    // 二次清洗：防止依然抓到"用户评价分"
                    if (content.includes("用户评价分") || content.includes("被点赞数")) {
                         content = await contentWrapper.locator("div").nth(1).innerText();
                         if (content.includes("用户评价分")) content = ""; 
                    }

                    // 5. 提取 SKU
                    const skuLocator = block.locator(".logic_specsWrapper__1qPqd span").first();
                    const sku = (await skuLocator.count()) > 0 ? await skuLocator.innerText() : "默认规格";

                    // 6. 提取时间
                    const timeLocator = block.locator("div[class*='logic_replyTime']").first();
                    const timeStr = (await timeLocator.count()) > 0 ? await timeLocator.innerText() : "";

                    // 7. 提取图片
                    let images = [];
                    const imgElements = await block.locator("i[class*='logic_imgList']").all();
                    for (const imgEl of imgElements) {
                        const styleAttr = await imgEl.getAttribute("style");
                        const imgUrl = extractUrlFromStyle(styleAttr);
                        if (imgUrl) images.push(imgUrl);
                    }

                    // 8. 【新增】提取好评有礼/返现信息
                    // 使用 class* 模糊匹配 'review_reward_info_rewardTag' 以应对后缀哈希变化
                    const rewardLocator = block.locator("div[class*='review_reward_info_rewardTag']").first();
                    let rewardInfo = "无"; // 默认为无
                    if (await rewardLocator.count() > 0 && await rewardLocator.isVisible()) {
                        rewardInfo = await rewardLocator.innerText();
                        // 去除可能包含的换行符
                        rewardInfo = rewardInfo.replace(/[\r\n]/g, "").trim(); 
                    }

                    // 打印预览
                    console.log(`     [${rating}星] ${nickname} | 返现: ${rewardInfo} | ${content.substring(0, 15)}...`);

                    allReviews.push({
                        id: orderId,
                        nickname: nickname,
                        sku: sku,
                        rating: rating,
                        content: content,
                        images: images,
                        reward_info: rewardInfo, // 新增字段
                        time: timeStr
                    });

                } catch (err) {
                    continue;
                }
            }

            // --- 翻页逻辑 ---
            // 1. 定位“下一页”按钮
            const nextBtn = page.locator('li[data-testid="beast-core-pagination-next"]');

            // 2. 检查按钮是否存在
            if (await nextBtn.count() > 0 && await nextBtn.isVisible()) {
                
                // 3. 检查是否被禁用 (到达最后一页)
                const classAttr = await nextBtn.getAttribute("class") || "";
                
                if (classAttr.includes("disabled") || classAttr.includes("PGT_disabled")) {
                    console.log("   🏁 已到达最后一页 (按钮变灰)，停止抓取。");
                    break;
                }

                // 4. 点击翻页
                console.log("   👉 点击下一页...");
                await nextBtn.click();

                // 5. 等待数据加载
                await randomDelay(3000, 5000); 

            } else {
                console.log("   ⚠️ 未找到分页按钮 (可能是单页或选择器不匹配)，结束。");
                break;
            }
        }

        // 保存文件
        if (allReviews.length > 0) {
            const outputPath = path.join(__dirname, 'reviews.json');
            fs.writeFileSync(outputPath, JSON.stringify(allReviews, null, 2), 'utf8');
            console.log(`\n🎉 抓取完成！共 ${allReviews.length} 条数据。`);
            console.log(`📂 数据已保存至: ${outputPath}`);
        } else {
            console.log("\n⚠️ 未抓取到数据。");
        }

    } catch (error) {
        console.error("❌ 错误:", error);
    } finally {
        await context.close();
    }
}

run();