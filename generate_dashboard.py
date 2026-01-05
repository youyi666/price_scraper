import json
import glob
import os
import re
from datetime import datetime
from openai import OpenAI

# ================= 配置区域 =================
# 替换你的 DeepSeek 或其他兼容 OpenAI 格式的 API Key
API_KEY = "sk-5ce512e159c64ce7a67b838828dd4f88" 
BASE_URL = "https://api.deepseek.com"
MODEL_NAME = "deepseek-chat"
DATA_FOLDER = "./daily_qa_logs"
OUTPUT_FILENAME = f"客服质检看板_{datetime.now().strftime('%Y%m%d')}.html"
# ===========================================

client = OpenAI(api_key=API_KEY, base_url=BASE_URL)

# HTML 模板 (保持不变，确保前端展示完整)
HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智能客服质检看板 (Token优化版)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
        body { font-family: 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; }
        .chat-bubble-kf { background-color: #2563eb; color: white; border-top-right-radius: 0; }
        .chat-bubble-user { background-color: white; border: 1px solid #e2e8f0; border-top-left-radius: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #f1f5f9; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        .img-preview { max-width: 150px; border-radius: 4px; margin-top: 4px; cursor: pointer; }
    </style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">

    <!-- 顶部导航 -->
    <div class="bg-white border-b px-6 py-4 flex justify-between items-center shadow-sm sticky top-0 z-10">
        <div class="flex items-center gap-3">
            <div class="p-2 bg-blue-600 rounded-lg">
                <i data-lucide="bar-chart-3" class="w-6 h-6 text-white"></i>
            </div>
            <div>
                <h1 class="text-xl font-bold text-slate-800">智能客服质检看板</h1>
                <p class="text-xs text-slate-500">生成时间: __GEN_TIME__</p>
            </div>
        </div>
        <div class="flex gap-4">
            <div class="text-right">
                <p class="text-sm text-slate-500">今日接待</p>
                <p class="font-bold text-xl" id="total-users">-</p>
            </div>
            <div class="h-10 w-px bg-slate-200"></div>
            <div class="text-right">
                <p class="text-sm text-slate-500">平均分</p>
                <p class="font-bold text-xl text-orange-500" id="avg-score">-</p>
            </div>
        </div>
    </div>

    <!-- 主内容区 -->
    <div class="p-6 max-w-[1400px] mx-auto grid grid-cols-12 gap-6">
        
        <!-- 左侧：核心看板 (8列) -->
        <div class="col-span-12 lg:col-span-8 space-y-6">
            
            <div class="grid grid-cols-3 gap-4">
                <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-4">
                    <div class="p-3 bg-red-100 text-red-600 rounded-full"><i data-lucide="alert-triangle" class="w-6 h-6"></i></div>
                    <div><p class="text-sm text-slate-500">需要关注 (黑榜)</p><p class="text-2xl font-bold text-red-600" id="risk-count">-</p></div>
                </div>
                <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-4">
                    <div class="p-3 bg-green-100 text-green-600 rounded-full"><i data-lucide="thumbs-up" class="w-6 h-6"></i></div>
                    <div><p class="text-sm text-slate-500">优秀范例 (红榜)</p><p class="text-2xl font-bold text-green-600" id="excellent-count">-</p></div>
                </div>
                <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-4">
                    <div class="p-3 bg-blue-100 text-blue-600 rounded-full"><i data-lucide="clock" class="w-6 h-6"></i></div>
                    <div><p class="text-sm text-slate-500">平均响应时间</p><p class="text-2xl font-bold text-slate-800" id="avg-time">-</p></div>
                </div>
            </div>

            <div class="bg-white rounded-xl shadow-sm border border-red-100 overflow-hidden">
                <div class="px-6 py-4 border-b border-red-50 bg-red-50/50 flex justify-between items-center">
                    <h2 class="font-bold text-red-800 flex items-center gap-2"><i data-lucide="alert-octagon" class="w-5 h-5"></i> 急需改进 (黑榜 TOP 20)</h2>
                    <span class="text-xs px-2 py-1 bg-white rounded border border-red-200 text-red-600">优先处理</span>
                </div>
                <div id="risk-list" class="divide-y divide-slate-100"></div>
                <div class="bg-red-50/30 p-2 text-center text-xs text-red-400 border-t border-red-100 hidden" id="risk-more">... 仅显示最紧急的 20 条 ...</div>
            </div>

            <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
                <div class="px-6 py-4 border-b border-slate-50 flex justify-between items-center">
                    <h2 class="font-bold text-green-700 flex items-center gap-2"><i data-lucide="check-circle-2" class="w-5 h-5"></i> 优秀范例 (红榜 TOP 20)</h2>
                </div>
                <div id="excellent-list" class="grid grid-cols-1 divide-y divide-slate-100"></div>
            </div>
        </div>

        <!-- 右侧：详情与绩效 (4列) -->
        <div class="col-span-12 lg:col-span-4 space-y-6">
            <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
                <h3 class="font-bold text-slate-800 mb-4 flex items-center gap-2"><i data-lucide="user" class="w-5 h-5 text-blue-500"></i> 昨日绩效概览</h3>
                <div class="overflow-x-auto">
                    <table class="w-full text-sm text-left">
                        <thead class="text-xs text-slate-500 bg-slate-50 uppercase">
                            <tr><th class="px-2 py-2">客服</th><th class="px-2 py-2 text-center">接待</th><th class="px-2 py-2 text-center">均分</th><th class="px-2 py-2 text-right">时效</th></tr>
                        </thead>
                        <tbody id="agent-table" class="divide-y divide-slate-100"></tbody>
                    </table>
                </div>
            </div>

            <div id="chat-detail-container" class="sticky top-24 bg-white rounded-xl shadow-lg border border-blue-200 flex flex-col h-[75vh] hidden">
                <div class="p-4 border-b bg-blue-50/50 flex justify-between items-center rounded-t-xl">
                    <div>
                        <h3 class="font-bold text-slate-800 flex items-center gap-2"><i data-lucide="message-square" class="w-4 h-4"></i> 对话回溯</h3>
                        <p class="text-xs text-slate-500" id="detail-meta">加载中...</p>
                    </div>
                    <button onclick="closeDetail()" class="p-1 hover:bg-slate-200 rounded-full"><i data-lucide="x-circle" class="w-5 h-5 text-slate-400"></i></button>
                </div>
                <div id="detail-messages" class="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50"></div>
                <div class="p-4 border-t bg-white rounded-b-xl border-t-2 border-red-100">
                    <p class="text-xs font-bold text-slate-500 mb-1 flex items-center gap-1"><i data-lucide="bot" class="w-4 h-4"></i> AI 改进建议:</p>
                    <p class="text-sm text-slate-700 font-medium" id="detail-advice">-</p>
                </div>
            </div>

            <div id="empty-state" class="bg-slate-100 rounded-xl border border-dashed border-slate-300 h-40 flex flex-col gap-2 items-center justify-center text-slate-400 text-sm">
                <i data-lucide="mouse-pointer-click" class="w-6 h-6"></i>
                <p>点击左侧红/黑榜查看对话详情</p>
            </div>
        </div>
    </div>

    <script>
        // ================= 数据注入点 =================
        const MOCK_DATA = __JSON_DATA_PLACEHOLDER__; 
        // ============================================

        // 渲染顶部统计
        document.getElementById('total-users').innerText = MOCK_DATA.summary.total_users + "人";
        document.getElementById('avg-score').innerText = MOCK_DATA.summary.avg_score;
        document.getElementById('avg-time').innerText = MOCK_DATA.summary.avg_response_time + "s";
        document.getElementById('risk-count').innerText = MOCK_DATA.summary.risk_count + " 例";
        document.getElementById('excellent-count').innerText = MOCK_DATA.summary.excellent_count + " 例";

        // 渲染列表函数
        function renderList(containerId, items, isRisk) {
            const container = document.getElementById(containerId);
            if(items.length === 0) {
                container.innerHTML = '<div class="p-4 text-center text-slate-400 text-sm">暂无数据</div>';
                return;
            }
            items.forEach(item => {
                const tagHtml = item.tags.map(tag => 
                    `<span class="px-2 py-0.5 text-xs rounded-full font-medium ${isRisk ? 'bg-red-100 text-red-700' : 'bg-blue-50 text-blue-600'}">${tag}</span>`
                ).join('');
                
                const div = document.createElement('div');
                div.className = `p-4 transition-colors cursor-pointer border-l-4 ${isRisk ? 'hover:bg-red-50/50 border-transparent hover:border-red-400' : 'hover:bg-green-50/50 border-transparent hover:border-green-400'}`;
                div.innerHTML = `
                    <div class="flex justify-between items-start mb-2">
                        <div class="flex items-center gap-2">
                            <span class="font-bold text-slate-700">${item.agent}</span>
                            <span class="text-xs text-slate-400">vs</span>
                            <span class="text-sm text-slate-600">${item.customer}</span>
                            ${!isRisk ? `<span class="ml-2 text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full font-bold">${item.score}分</span>` : ''}
                        </div>
                        <div class="flex gap-1">${tagHtml}</div>
                    </div>
                    <p class="text-sm text-slate-600 mb-2 line-clamp-1">${item.summary}</p>
                    ${isRisk ? `<div class="bg-slate-50 p-2 rounded text-xs text-slate-500 relative mt-2"><span class="font-bold text-red-500">建议：</span>${item.advice}</div>` : ''}
                `;
                div.onclick = () => showDetail(item);
                container.appendChild(div);
            });
        }

        const riskItems = MOCK_DATA.details.filter(d => d.score < 6 || d.is_risk).sort((a,b) => a.score - b.score);
        const excellentItems = MOCK_DATA.details.filter(d => d.score >= 8 || d.is_excellent).sort((a,b) => b.score - a.score);
        
        // 【关键修改】只渲染前 20 条，避免 200 条数据把页面撑爆
        renderList('risk-list', riskItems.slice(0, 20), true);
        renderList('excellent-list', excellentItems.slice(0, 20), false);
        
        // 如果数据超过20条，显示提示
        if(riskItems.length > 20) document.getElementById('risk-more').classList.remove('hidden');

        const agentTable = document.getElementById('agent-table');
        MOCK_DATA.agent_stats.sort((a,b) => b.avg_score - a.avg_score).forEach(agent => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-slate-50";
            tr.innerHTML = `<td class="px-2 py-2 font-medium truncate max-w-[100px]">${agent.name}</td><td class="px-2 py-2 text-center text-slate-500">${agent.chats}</td><td class="px-2 py-2 text-center font-bold ${agent.avg_score >= 7 ? 'text-green-600' : 'text-orange-500'}">${agent.avg_score}</td><td class="px-2 py-2 text-right text-slate-500">${agent.avg_time}s</td>`;
            agentTable.appendChild(tr);
        });

        function showDetail(chat) {
            document.getElementById('empty-state').classList.add('hidden');
            document.getElementById('chat-detail-container').classList.remove('hidden');
            document.getElementById('detail-meta').innerText = `${chat.time} | 客户: ${chat.customer} | 客服: ${chat.agent}`;
            document.getElementById('detail-advice').innerText = chat.advice;

            const msgContainer = document.getElementById('detail-messages');
            msgContainer.innerHTML = ''; 
            
            chat.messages.forEach(msg => {
                const isKf = msg.role === '客服';
                let contentHtml = msg.content;
                // 简单的图片处理
                if(msg.type === 'image' || msg.content.includes('http') && (msg.content.endsWith('.jpg') || msg.content.endsWith('.png'))) {
                    const url = msg.type === 'image' ? msg.content : msg.content.match(/https?:\/\/[^\s]+/)[0];
                    contentHtml = `<img src="${url}" class="img-preview" onclick="window.open(this.src)">`;
                }

                const msgDiv = document.createElement('div');
                msgDiv.className = `flex ${isKf ? 'justify-end' : 'justify-start'}`;
                msgDiv.innerHTML = `
                    <div class="max-w-[85%] rounded-lg p-3 text-sm shadow-sm ${isKf ? 'chat-bubble-kf' : 'chat-bubble-user'}">
                        <p class="text-xs opacity-70 mb-1 flex items-center gap-1">
                            ${isKf ? '<i data-lucide="headset" class="w-3 h-3"></i>' : '<i data-lucide="user" class="w-3 h-3"></i>'} 
                            ${msg.role} <span class="opacity-50 ml-2 scale-90">${msg.time.split(' ')[1] || ''}</span>
                        </p>
                        <div class="break-words">${contentHtml}</div>
                    </div>
                `;
                msgContainer.appendChild(msgDiv);
            });
            lucide.createIcons();
        }

        function closeDetail() {
            document.getElementById('chat-detail-container').classList.add('hidden');
            document.getElementById('empty-state').classList.remove('hidden');
        }

        lucide.createIcons();
    </script>
</body>
</html>
"""

def compress_text_for_ai(messages):
    """
    【新增功能】极致压缩上下文，节省 Token 成本
    1. 去除时间戳
    2. 简化角色名 (用户->客, 客服->服)
    3. 替换长链接为 [Link]
    4. 替换图片为 [Img]
    """
    buffer = []
    for m in messages:
        # 跳过系统消息，它们通常不包含对话逻辑
        if m['role'] == '系统': 
            continue
            
        # 1. 角色极简
        role = "客" if m['role'] == '用户' else "服"
        
        # 2. 内容清洗
        content = m['content']
        
        # 替换图片类型
        if m.get('type') == 'image':
            content = "[图片]"
        
        # 替换长链接 (这非常节省Token，链接通常很长)
        if "http" in content:
            # 简单的正则替换，将所有 URL 替换为短标记
            content = re.sub(r'https?://\S+', '[链接]', content)
            
        buffer.append(f"{role}:{content}")
        
    return "\n".join(buffer)

def analyze_chat(chat_content):
    """调用大模型分析，返回结构化 JSON"""
    # 提示词简化，更直接
    prompt = """
    角色：电商质检员。分析对话(客=用户, 服=客服)。
    
    评分(1-10分):
    1-4: 辱骂/推诿/极差
    5-7: 机械/一般
    8-10: 热情/解决快/有销售

    返回JSON:
    {
        "score": int,
        "tags": [str], (例: 响应慢, 答非所问, 辱骂, 熟练, 销售机会),
        "summary": "30字内概括",
        "advice": "改进建议",
        "is_risk": bool, (客诉风险),
        "is_excellent": bool
    }
    """
    
    # 双重保险：截断过长文本
    safe_content = chat_content[:4000] 
    
    try:
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": safe_content}
            ],
            response_format={ "type": "json_object" }
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        print(f"AI 分析出错: {e}")
        return {"score": 5, "tags": ["分析失败"], "summary": "AI服务异常", "advice": "请人工复核", "is_risk": False}

def get_cs_name(messages):
    """获取客服名字"""
    for m in messages:
        if m['role'] == '客服': return m.get('name', '未知客服')
    return '未知客服'

def calculate_time_metrics(messages):
    """计算平均响应时间"""
    total_response_time = 0
    response_count = 0
    last_user_time = None
    
    for msg in messages:
        try:
            dt = datetime.strptime(msg['time'], "%Y-%m-%d %H:%M:%S")
        except: continue
        
        if msg['role'] == '用户':
            last_user_time = dt
        elif msg['role'] == '客服' and last_user_time:
            diff = (dt - last_user_time).total_seconds()
            if diff < 3600: 
                total_response_time += diff
                response_count += 1
            last_user_time = None
            
    return round(total_response_time / response_count, 1) if response_count > 0 else 0

def process_logs():
    files = glob.glob(f"{DATA_FOLDER}/*.json")
    print(f"发现 {len(files)} 个日志文件，开始处理...")
    
    dashboard_data = {
        "summary": { "total_users": 0, "total_messages": 0, "avg_score": 0, "avg_response_time": 0, "risk_count": 0, "excellent_count": 0 },
        "agent_stats": {},
        "details": []
    }
    
    total_score_sum = 0
    total_time_sum = 0
    processed_count = 0
    
    for file_path in files:
        with open(file_path, 'r', encoding='utf-8') as f:
            try:
                data = json.load(f)
            except: 
                print(f"Skipping damaged file: {file_path}")
                continue
            
        if len(data) < 3: continue 
        
        # 1. 基础信息提取
        cs_name = get_cs_name(data)
        customer_id = os.path.basename(file_path).split("_")[1] if "_" in file_path else "Unknown"
        
        # 2. 格式化数据 (优化点：使用压缩函数)
        chat_text_for_ai = compress_text_for_ai(data)
        
        # 3. AI 分析
        print(f"正在分析: {cs_name} vs {customer_id} ...")
        ai_res = analyze_chat(chat_text_for_ai)
        avg_time = calculate_time_metrics(data)
        
        # 4. 全面回溯数据构建 (这里依然保留完整数据给前端，不压缩)
        full_messages = []
        for msg in data:
            if msg['role'] == '系统' and '撤回' not in msg['content']:
                continue 
            
            full_messages.append({
                "role": msg['role'],
                "content": msg['content'],
                "type": msg.get('type', 'text'),
                "time": msg['time']
            })

        # 5. 聚合数据
        dashboard_data["summary"]["total_users"] += 1
        dashboard_data["summary"]["total_messages"] += len(data)
        total_score_sum += ai_res.get('score', 5)
        total_time_sum += avg_time
        processed_count += 1
        
        if ai_res.get('is_risk'): dashboard_data["summary"]["risk_count"] += 1
        if ai_res.get('is_excellent'): dashboard_data["summary"]["excellent_count"] += 1
        
        if cs_name not in dashboard_data["agent_stats"]:
            dashboard_data["agent_stats"][cs_name] = {"chats": 0, "total_score": 0, "total_time": 0}
        dashboard_data["agent_stats"][cs_name]["chats"] += 1
        dashboard_data["agent_stats"][cs_name]["total_score"] += ai_res.get('score', 5)
        dashboard_data["agent_stats"][cs_name]["total_time"] += avg_time
        
        dashboard_data["details"].append({
            "id": os.path.basename(file_path),
            "customer": customer_id,
            "agent": cs_name,
            "score": ai_res.get('score', 0),
            "tags": ai_res.get('tags', []),
            "time": datetime.now().strftime("%Y-%m-%d"),
            "summary": ai_res.get('summary', ''),
            "advice": ai_res.get('advice', ''),
            "is_risk": ai_res.get('is_risk', False),
            "is_excellent": ai_res.get('is_excellent', False),
            "messages": full_messages 
        })

    if processed_count > 0:
        dashboard_data["summary"]["avg_score"] = round(total_score_sum / processed_count, 1)
        dashboard_data["summary"]["avg_response_time"] = round(total_time_sum / processed_count, 1)
        
    agent_list = []
    for name, stats in dashboard_data["agent_stats"].items():
        agent_list.append({
            "name": name,
            "chats": stats["chats"],
            "avg_score": round(stats["total_score"] / stats["chats"], 1),
            "avg_time": round(stats["total_time"] / stats["chats"], 1)
        })
    dashboard_data["agent_stats"] = agent_list

    return dashboard_data

def generate_html(data):
    json_str = json.dumps(data, ensure_ascii=False)
    final_html = HTML_TEMPLATE.replace("__JSON_DATA_PLACEHOLDER__", json_str)
    final_html = final_html.replace("__GEN_TIME__", datetime.now().strftime("%Y-%m-%d %H:%M"))
    
    with open(OUTPUT_FILENAME, 'w', encoding='utf-8') as f:
        f.write(final_html)
    
    print(f"\n✅ 成功生成看板文件: {OUTPUT_FILENAME}")
    print("请用浏览器打开该文件查看。")

if __name__ == "__main__":
    if not os.path.exists(DATA_FOLDER):
        print(f"错误: 找不到数据文件夹 {DATA_FOLDER}")
    else:
        final_data = process_logs()
        generate_html(final_data)