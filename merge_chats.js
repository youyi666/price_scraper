/**
 * 聊天记录聚合助手
 * 功能：将散乱的 JSON 合并为 AI 可读的文本，并生成 Excel 基础表
 */
const fs = require('fs');
const path = require('path');

// 配置路径
const INPUT_DIR = path.join(__dirname, 'chat_logs');
const OUTPUT_FILE_TXT = path.join(__dirname, 'merged_for_ai.txt');
const OUTPUT_FILE_CSV = path.join(__dirname, 'chat_summary.csv');

// 辅助函数：转义 CSV 内容
function escapeCsv(str) {
    if (!str) return '';
    return '"' + String(str).replace(/"/g, '""').replace(/\n/g, ' ') + '"';
}

async function mergeFiles() {
    console.log("🚀 开始聚合聊天记录...");

    if (!fs.existsSync(INPUT_DIR)) {
        console.error("❌ 找不到 chat_logs 文件夹！");
        return;
    }

    const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.json'));
    console.log(`📋 发现 ${files.length} 个记录文件。`);

    let aiTextContent = "";
    let csvContent = "\uFEFF订单号,对话轮数,是否含有图片,用户最后一句,完整对话(简略)\n";

    for (const file of files) {
        const orderId = file.replace('_chat.json', '');
        const filePath = path.join(INPUT_DIR, file);
        
        try {
            const chatData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            // 1. 准备给 AI 看的文本格式
            aiTextContent += `\n================================\n`;
            aiTextContent += `【订单号】: ${orderId}\n`;
            aiTextContent += `【对话概览】:\n`;
            
            let userLastMsg = "";
            let hasImage = "否";
            let simpleLog = "";

            chatData.forEach(msg => {
                // 格式化：[时间] [角色]: 内容
                const roleTag = msg.role === '用户' ? '👤用户' : (msg.role === '系统' ? '🤖系统' : '👩‍💼客服');
                const content = msg.type === 'image' ? '[图片]' : msg.content;
                
                // 给 AI 的文本（过滤掉系统废话，保留关键交互）
                if (msg.role !== '系统') {
                    aiTextContent += `${msg.time} ${roleTag}: ${content}\n`;
                }

                // 给 CSV 的统计数据
                if (msg.role === '用户' && msg.type === 'text') userLastMsg = content;
                if (msg.type === 'image') hasImage = "是";
                if (msg.role !== '系统') simpleLog += `${roleTag}:${content} | `;
            });

            // 2. 准备 CSV 行
            const row = [
                escapeCsv(orderId),
                chatData.length,
                hasImage,
                escapeCsv(userLastMsg),
                escapeCsv(simpleLog.substring(0, 300)) // Excel限制长度，截取一下
            ].join(",");
            csvContent += row + "\n";

        } catch (e) {
            console.error(`❌ 处理文件 ${file} 出错: ${e.message}`);
        }
    }

    // 写入文件
    fs.writeFileSync(OUTPUT_FILE_TXT, aiTextContent);
    fs.writeFileSync(OUTPUT_FILE_CSV, csvContent);

    console.log(`\n✅ 聚合完成！`);
    console.log(`1. AI 分析专用文件: ${OUTPUT_FILE_TXT} (请直接拖给 AI)`);
    console.log(`2. Excel 统计表格: ${OUTPUT_FILE_CSV} (可用 Excel 打开)`);
}

mergeFiles();