/**
 * 政府/公众号文章通用爬虫脚本 (AI 友好版)
 * 功能：自动识别正文、下载图片/附件、生成 Markdown
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const TurndownService = require('turndown'); // 需要 npm install turndown

// ================= 配置区域 =================
const INPUT_FILE = 'guobutask_list.json'; // 你的任务列表文件
const OUTPUT_DIR = 'output_data';         // 结果保存目录
const TIMEOUT = 60000;                    // 单个页面超时时间 (ms)
// ===========================================

// 初始化 Markdown 转换服务
const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
});

// 辅助函数：创建目录
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// 辅助函数：下载文件 (使用 Node.js 原生 https，避免浏览器下载的不确定性)
async function downloadFile(url, savePath) {
    return new Promise((resolve, reject) => {
        if (!url || !url.startsWith('http')) {
            resolve(false);
            return;
        }

        const file = fs.createWriteStream(savePath);
        const request = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            rejectUnauthorized: false // 忽略部分政府网站 SSL 证书过期问题
        }, (response) => {
            if (response.statusCode !== 200) {
                fs.unlink(savePath, () => {});
                resolve(false);
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(true);
            });
        });

        request.on('error', (err) => {
            fs.unlink(savePath, () => {});
            resolve(false);
        });
        
        request.setTimeout(15000, () => {
            request.destroy();
            fs.unlink(savePath, () => {});
            resolve(false);
        });
    });
}

// 核心逻辑：智能抓取单个任务
async function processTask(browser, task) {
    const taskDirName = `${task.id}_${task.region.replace(/[\\/:*?"<>|]/g, '')}`;
    const taskPath = path.join(OUTPUT_DIR, taskDirName);
    const imagesDir = path.join(taskPath, 'images');
    const filesDir = path.join(taskPath, 'files');

    ensureDir(taskPath);
    ensureDir(imagesDir);
    ensureDir(filesDir);

    console.log(`\n=== 正在处理 [ID:${task.id}] ${task.region} ===`);
    console.log(` -> URL: ${task.url}`);

    const context = await browser.newContext({
        ignoreHTTPSErrors: true, // 忽略 SSL 错误
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        
        // 针对微信公众号的特殊处理 (懒加载图片)
        if (task.url.includes('weixin.qq.com')) {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 500;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 200);
                });
            });
            await page.waitForTimeout(2000);
        } else {
            // 普通政府网站稍微等待一下动态加载
            await page.waitForTimeout(2000);
        }

        // === 1. 智能定位正文区域 ===
        // 定义常见的正文容器选择器优先级
        const contentSelectors = [
            '#js_content',           // 微信公众号
            '.article-content',      // 通用 CMS
            '.view',                 // 通用 CMS
            '.zoom',                 // 很多老旧政府网站
            '#zoom',                 // 很多老旧政府网站
            '.main-content',
            '.detail_content',
            '.wz_content',
            'div[class*="content"]', // 模糊匹配
            'div[id*="content"]',
            'article'
        ];

        let contentHandle = null;
        for (const selector of contentSelectors) {
            // 尝试查找并在页面内判断该元素是否可见且包含足够文本
            const found = await page.$(selector);
            if (found && await found.isVisible()) {
                const text = await found.innerText();
                if (text.length > 50) { // 确保不是空壳
                    contentHandle = found;
                    console.log(` -> ✅ 智能锁定正文区域: ${selector}`);
                    break;
                }
            }
        }

        // 如果找不到特定容器，回退到 body (虽然杂乱，但总比没有好)
        if (!contentHandle) {
            console.log(` -> ⚠️ 未找到特定正文容器，将抓取整个 body`);
            contentHandle = await page.$('body');
        }

        // === 2. 提取并处理正文 HTML ===
        // 我们需要获取 HTML 来转换成 Markdown，同时处理其中的图片链接
        let contentHTML = await contentHandle.innerHTML();
        
        // 解析 HTML 提取图片和附件链接
        // 注意：这里我们使用正则简单提取，然后在 Node 端下载，比在浏览器内下载更可控
        const imgRegex = /<img[^>]+src="([^">]+)"/g;
        const fileRegex = /<a[^>]+href="([^">]+\.(pdf|doc|docx|xls|xlsx|zip|rar))"[^>]*>([^<]+)<\/a>/gi;

        let match;
        let downloadedImages = 0;
        let downloadedFiles = 0;

        // --- 处理图片 ---
        // 为了不破坏 contentHTML 字符串的索引，我们先收集需要替换的列表
        const imgReplacements = [];
        while ((match = imgRegex.exec(contentHTML)) !== null) {
            let imgUrl = match[1];
            // 处理相对路径
            if (!imgUrl.startsWith('http')) {
                const urlObj = new URL(task.url);
                imgUrl = new URL(imgUrl, urlObj.origin).href;
            }

            const imgExt = path.extname(imgUrl).split('?')[0] || '.jpg';
            const imgName = `img_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${imgExt}`;
            const savePath = path.join(imagesDir, imgName);

            // 存入待下载列表
            imgReplacements.push({ original: match[1], fullUrl: imgUrl, localPath: `images/${imgName}`, savePath: savePath });
        }

        for (const imgItem of imgReplacements) {
            const success = await downloadFile(imgItem.fullUrl, imgItem.savePath);
            if (success) {
                // 在 Markdown 转换前，将 HTML 里的 src 替换为本地相对路径
                contentHTML = contentHTML.replace(imgItem.original, imgItem.localPath);
                downloadedImages++;
            }
        }

        // --- 处理附件 ---
        // 附件通常作为链接存在，我们下载它，并更新 Markdown 里的链接
        const fileReplacements = [];
        // 重置正则索引
        // 注意：简单的正则可能无法处理所有复杂的 HTML 属性，但在纯脚本中比引入 cheerio 更轻量
        while ((match = fileRegex.exec(contentHTML)) !== null) {
            let fileUrl = match[1];
            const linkText = match[3];

             // 处理相对路径
             if (!fileUrl.startsWith('http')) {
                const urlObj = new URL(task.url);
                // 简单的相对路径处理，可能需要根据 <base> 标签优化，但大多数情况足够
                fileUrl = new URL(fileUrl, task.url).href;
            }

            const fileExt = path.extname(fileUrl).split('?')[0];
            // 清理文件名中的非法字符
            const safeName = linkText.replace(/[\\/:*?"<>|]/g, '_').trim() || `file_${Date.now()}`;
            const fileName = `${safeName}${fileExt}`;
            const savePath = path.join(filesDir, fileName);

            fileReplacements.push({ original: match[1], fullUrl: fileUrl, localPath: `files/${fileName}`, savePath: savePath });
        }

        for (const fileItem of fileReplacements) {
            const success = await downloadFile(fileItem.fullUrl, fileItem.savePath);
            if (success) {
                contentHTML = contentHTML.replace(fileItem.original, fileItem.localPath);
                downloadedFiles++;
            }
        }

        // === 3. 生成 Markdown ===
        const markdown = turndownService.turndown(contentHTML);
        
        // 组装最终文件内容
        const pageTitle = await page.title();
        const finalContent = `# ${pageTitle}\n\n` +
            `> 来源: ${task.region}\n` +
            `> 原文链接: ${task.url}\n` +
            `> 截止时间: ${task.deadline || '未知'}\n` +
            `> 抓取时间: ${new Date().toLocaleString()}\n\n` +
            `---\n\n` +
            `${markdown}`;

        fs.writeFileSync(path.join(taskPath, 'content.md'), finalContent);
        
        // 保存元数据 JSON
        fs.writeFileSync(path.join(taskPath, 'metadata.json'), JSON.stringify(task, null, 2));

        console.log(` -> 💾 已保存: content.md`);
        console.log(` -> 🖼️ 下载图片: ${downloadedImages} 张`);
        console.log(` -> 📎 下载附件: ${downloadedFiles} 个`);

    } catch (e) {
        console.error(`❌ [ID:${task.id}] 处理失败:`, e.message);
        // 记录错误日志
        fs.appendFileSync('error.log', `[${new Date().toISOString()}] ID:${task.id} URL:${task.url} Error:${e.message}\n`);
    } finally {
        await context.close();
    }
}

// 主入口
(async () => {
    console.log("🚀 启动政府/公众号数据采集器...");
    
    // 1. 读取任务列表
    let tasks = [];
    try {
        const rawData = fs.readFileSync(INPUT_FILE, 'utf-8');
        tasks = JSON.parse(rawData);
        console.log(`📦 读取到 ${tasks.length} 个任务`);
    } catch (e) {
        console.error(`❌ 无法读取配置文件 ${INPUT_FILE}:`, e.message);
        return;
    }

    // 2. 启动浏览器
    const browser = await chromium.launch({ 
        headless: false // 建议开启有头模式，方便观察，部署时可改为 true
    });

    // 3. 串行执行任务 (避免并发过高被封)
    for (const task of tasks) {
        await processTask(browser, task);
        // 随机等待 2-5 秒，模拟人类浏览，防止封锁
        const delay = Math.floor(Math.random() * 3000) + 2000;
        console.log(`☕ 休息 ${delay/1000} 秒...`);
        await new Promise(r => setTimeout(r, delay));
    }

    await browser.close();
    console.log("\n✅ 所有任务处理完毕！请查看 output_data 目录。");
})();