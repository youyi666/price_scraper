/**
 * Markdown 批量合并工具
 * 功能：将 output_data 下的所有 content.md 合并为一个文件，供 AI 分析
 */

const fs = require('fs');
const path = require('path');

// ================= 配置区域 =================
const INPUT_DIR = 'output_data';            // 爬虫结果目录
const OUTPUT_FILE = 'merged_for_ai.md';     // 合并后的文件名
// ===========================================

(async () => {
    console.log("🚀 开始合并 Markdown 文件...");

    // 1. 检查输入目录是否存在
    if (!fs.existsSync(INPUT_DIR)) {
        console.error(`❌ 目录 ${INPUT_DIR} 不存在，请先运行爬虫脚本。`);
        return;
    }

    // 2. 获取所有任务文件夹
    // 过滤掉 .DS_Store 或其他非文件夹文件
    const entries = fs.readdirSync(INPUT_DIR, { withFileTypes: true });
    const dirs = entries
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    // 3. 智能排序 (按文件夹名的数字 ID 排序: "1_xxx", "2_xxx", "10_xxx")
    dirs.sort((a, b) => {
        const idA = parseInt(a.split('_')[0]) || 0;
        const idB = parseInt(b.split('_')[0]) || 0;
        return idA - idB;
    });

    console.log(`📦 扫描到 ${dirs.length} 个任务文件夹，准备合并...`);

    // 4. 创建写入流 (比一次性 readFile 更节省内存)
    const writeStream = fs.createWriteStream(OUTPUT_FILE);

    // 写入文件头部的提示词 (Prompt)，帮助 AI 理解这个文件的结构
    const headerPrompt = 
`# 任务汇总文档

以下文档包含了多个政府招标/通知网页的正文内容。
每个任务由 "=== TASK START [ID: X] ===" 开始，由 "=== TASK END ===" 结束。
请根据每个任务的内容，提取关键信息。

--------------------------------------------------

`;
    writeStream.write(headerPrompt);

    let successCount = 0;

    // 5. 遍历并合并
    for (const dirName of dirs) {
        const contentPath = path.join(INPUT_DIR, dirName, 'content.md');
        
        // 检查 content.md 是否存在
        if (fs.existsSync(contentPath)) {
            try {
                const content = fs.readFileSync(contentPath, 'utf-8');
                
                // 提取 ID 和 地区名 (用于 AI 识别)
                const [id, ...regionParts] = dirName.split('_');
                const region = regionParts.join('_');

                // 构造 AI 友好的分隔块
                const separatorHeader = `\n\n==================================================\n` +
                                      `=== TASK START [ID: ${id}] 地区: ${region} ===\n` +
                                      `==================================================\n\n`;
                
                const separatorFooter = `\n\n=== TASK END [ID: ${id}] ===\n`;

                // 写入
                writeStream.write(separatorHeader);
                writeStream.write(content);
                writeStream.write(separatorFooter);

                process.stdout.write(` -> 合并 ID:${id} \r`); // 动态显示进度
                successCount++;
            } catch (e) {
                console.error(`\n❌ 读取 ${dirName} 失败: ${e.message}`);
            }
        } else {
            // 如果只有文件夹但没有 content.md (可能是爬取失败的)，跳过
            // console.warn(`\n⚠️ 跳过 ${dirName}: 未找到 content.md`);
        }
    }

    // 结束写入
    writeStream.end();

    writeStream.on('finish', () => {
        console.log(`\n\n✅ 合并完成！`);
        console.log(`📊 共合并任务: ${successCount} 个`);
        console.log(`💾 输出文件: ${path.resolve(OUTPUT_FILE)}`);
        console.log(`💡 提示: 你现在可以将这个文件发送给 AI 进行分析了。`);
    });

})();