const fs = require('fs');
const path = require('path');

const inputFile = 'merged_for_ai.txt'; 
const outputDir = './processed_data'; 
const fileCount = 10; 
const minUserTurns = 3; // 关键：用户至少要说 3 句话

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
}

function processData() {
    console.log('正在进行精细化清洗...');
    const content = fs.readFileSync(inputFile, 'utf-8');
    const orderBlocks = content.split(/={10,}/);
    const validOrders = [];
    const urlRegex = /https?:\/\/[^\s\u4e00-\u9fa5]+/g;
    
    // 无意义词库：如果用户只说了这些，判定为低质量
    const uselessWords = ['你好', '在吗', '有人吗', '你好在吗', '。', '？', '[链接]'];

    orderBlocks.forEach(block => {
        const orderIdMatch = block.match(/【订单号】:\s*(\d+-\d+)/);
        if (!orderIdMatch) return;
        const orderId = orderIdMatch[1];

        const userMessages = [];
        const lines = block.split('\n');
        
        lines.forEach(line => {
            if (line.includes('👤用户:')) {
                let msg = line.split('👤用户:')[1]?.trim() || "";
                msg = msg.replace(urlRegex, '[链接]');
                // 过滤掉纯链接和空消息
                if (msg && msg !== '[链接]') {
                    userMessages.push(msg);
                }
            }
        });

        // 核心过滤逻辑改进：
        // 1. 用户发言次数必须 >= minUserTurns
        // 2. 如果用户只说了一句“你好”，即使加上链接也不算有效对话
        const firstMsg = userMessages[0];
        const isUseless = userMessages.length === 1 && uselessWords.includes(firstMsg);

        if (userMessages.length >= minUserTurns && !isUseless) {
            validOrders.push(`订单号: ${orderId}\n用户说: ${userMessages.join(' | ')}`);
        }
    });

    console.log(`清洗完成！`);
    console.log(`符合深度对话条件的订单数: ${validOrders.length}`);

    const itemsPerFile = Math.ceil(validOrders.length / fileCount);
    for (let i = 0; i < fileCount; i++) {
        const chunk = validOrders.slice(i * itemsPerFile, (i + 1) * itemsPerFile);
        if (chunk.length > 0) {
            const fileName = path.join(outputDir, `chunk_${i + 1}.txt`);
            fs.writeFileSync(fileName, chunk.join('\n\n---\n\n'), 'utf-8');
            console.log(`已生成: ${fileName}`);
        }
    }
}

processData();