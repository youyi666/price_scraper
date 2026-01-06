import json
import glob
import pandas as pd
from datetime import datetime
from openai import OpenAI

# ================= 配置区域 =================
API_KEY = "sk-5ce512e159c64ce7a67b838828dd4f88"  # 替换你的 Key
BASE_URL = "https://api.deepseek.com"
MODEL_NAME = "deepseek-chat"
DATA_FOLDER = "./daily_qa_logs"
MIN_MSG_COUNT = 6  # 过滤阈值
# ===========================================

client = OpenAI(api_key=API_KEY, base_url=BASE_URL)

def get_cs_nickname(messages):
    """提取接待客服的昵称"""
    for msg in messages:
        if msg['role'] == '客服':
            return msg.get('name', '未知客服')
    return "未知客服"

def calculate_time_metrics(messages):
    """计算平均响应时间（秒）"""
    total_response_time = 0
    response_count = 0
    last_user_time = None
    
    for msg in messages:
        try:
            dt = datetime.strptime(msg['time'], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue

        if msg['role'] == '用户':
            last_user_time = dt
        elif msg['role'] == '客服' and last_user_time:
            diff = (dt - last_user_time).total_seconds()
            if diff < 3600: 
                total_response_time += diff
                response_count += 1
            last_user_time = None 
            
    avg_time = round(total_response_time / response_count, 1) if response_count > 0 else 0
    return avg_time

def format_chat_for_llm(messages):
    text = ""
    for msg in messages:
        if msg['role'] == '系统':
            if "催促" in msg['content']:
                text += f"【系统警告】：{msg['content']}\n"
        else:
            content = "[图片]" if msg['type'] == 'image' else msg['content']
            text += f"{msg['role']}({msg['name']}): {content}\n"
    return text

def is_valid_dialogue(messages):
    if len(messages) <= MIN_MSG_COUNT:
        return False
    roles = {msg['role'] for msg in messages}
    return '用户' in roles and '客服' in roles

def analyze_with_ai(chat_text):
    """
    更新后的Prompt，要求返回细分维度的分数
    """
    system_prompt = """
    你是一位资深的电商客服质检专家。请阅读对话，从以下维度打分（1-10分）并简评：
    
    1. **attitude_score (服务态度)**：是否热情、礼貌、有同理心？(10=非常完美, 1=极差)
    2. **skill_score (销售技巧/专业度)**：是否解决问题、主动推销、引导下单？(10=非常完美, 1=极差)
    3. **total_score (综合得分)**：整体表现权重分。
    
    返回 JSON 格式：
    {
        "attitude_score": 9,
        "skill_score": 7,
        "total_score": 8,
        "summary": "态度很好但未主动推销",
        "missing_point": "未引导关联购买滤芯",
        "coaching_advice": "建议在解决问题后顺带提一句'现在滤芯有活动'。"
    }
    """
    
    try:
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": chat_text}
            ],
            response_format={ "type": "json_object" }
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        print(f"AI分析出错: {e}")
        return {
            "attitude_score": 0, "skill_score": 0, "total_score": 0, 
            "summary": "Error", "missing_point": "", "coaching_advice": ""
        }

def write_dataframe_block(writer, sheet_name, title, df, start_row):
    """辅助函数：在Excel中写入带标题的小表格块"""
    if df.empty:
        return start_row
    
    # 写入标题
    pd.DataFrame([title]).to_excel(writer, sheet_name=sheet_name, startrow=start_row, index=False, header=False)
    # 写入数据
    df.to_excel(writer, sheet_name=sheet_name, startrow=start_row + 1, index=False)
    # 返回下一行的位置（留出2行空行）
    return start_row + len(df) + 4

def main():
    files = glob.glob(f"{DATA_FOLDER}/*.json")
    valid_reports = []
    
    total_turns = 0
    processed_count = 0

    print(f"开始处理任务，共扫描到 {len(files)} 个文件...")

    for file_path in files:
        with open(file_path, 'r', encoding='utf-8') as f:
            try:
                data = json.load(f)
            except: 
                continue
            
        if not is_valid_dialogue(data):
            continue
            
        chat_text = format_chat_for_llm(data)
        avg_resp_time = calculate_time_metrics(data)
        cs_nickname = get_cs_nickname(data)  # 获取客服昵称
        customer_id = file_path.split("_")[-1].replace(".json", "")
        
        ai_result = analyze_with_ai(chat_text)
        
        processed_count += 1
        total_turns += len(data)
        
        valid_reports.append({
            "客服昵称": cs_nickname,
            "客户ID": customer_id,
            "响应耗时(秒)": avg_resp_time,
            "态度分": ai_result.get('attitude_score', 0),
            "技巧分": ai_result.get('skill_score', 0),
            "综合得分": ai_result.get('total_score', 0),
            "问题摘要": ai_result.get('summary', ''),
            "改进建议": ai_result.get('coaching_advice', ''),
            "完整对话": chat_text
        })
        print(f"[{processed_count}] {cs_nickname} | 综合分:{ai_result.get('total_score')} | 速度:{avg_resp_time}s")

    if not valid_reports:
        print("无有效数据。")
        return

    df = pd.DataFrame(valid_reports)
    
    # === 计算汇总数据 ===
    avg_score = round(df['综合得分'].mean(), 1)
    avg_speed = round(df['响应耗时(秒)'].mean(), 1)
    summary_text = (
        f"【昨日质检日报】\n"
        f"接待人数：{processed_count}人 | 交互消息：{total_turns}条\n"
        f"平均得分：{avg_score}分 | 平均响应：{avg_speed}秒"
    )

    # === 生成各个榜单 ===
    # 1. 响应时间红黑榜 (红榜=时间短，黑榜=时间长)
    df_speed = df.sort_values(by="响应耗时(秒)", ascending=True) # 升序，时间越短越好
    speed_red = df_speed.head(5)[['客服昵称', '响应耗时(秒)', '客户ID', '综合得分']]
    speed_black = df_speed.tail(5).sort_values(by="响应耗时(秒)", ascending=False)[['客服昵称', '响应耗时(秒)', '客户ID', '综合得分']]

    # 2. 服务态度红黑榜 (红榜=分高)
    df_attitude = df.sort_values(by="态度分", ascending=False)
    attitude_red = df_attitude.head(5)[['客服昵称', '态度分', '问题摘要']]
    attitude_black = df_attitude.tail(5).sort_values(by="态度分", ascending=True)[['客服昵称', '态度分', '问题摘要', '改进建议']]

    # 3. 销售技巧红黑榜 (红榜=分高)
    df_skill = df.sort_values(by="技巧分", ascending=False)
    skill_red = df_skill.head(5)[['客服昵称', '技巧分', '问题摘要']]
    skill_black = df_skill.tail(5).sort_values(by="技巧分", ascending=True)[['客服昵称', '技巧分', '问题摘要', '改进建议']]

    # === 写入 Excel ===
    output_file = f"客服质检日报_多维榜单_{datetime.now().strftime('%Y%m%d')}.xlsx"
    
    try:
        with pd.ExcelWriter(output_file, engine='openpyxl') as writer:
            # Sheet 1: 质检总览 (榜单展示)
            row_cursor = 0
            
            # 写入总总结
            pd.DataFrame([summary_text], columns=["日报概览"]).to_excel(writer, sheet_name='质检总览', startrow=row_cursor, index=False)
            row_cursor += 3
            
            # 第一组：响应时间榜
            row_cursor = write_dataframe_block(writer, '质检总览', "⚡【红榜：响应神速 TOP5】", speed_red, row_cursor)
            row_cursor = write_dataframe_block(writer, '质检总览', "🐢【黑榜：响应迟缓 TOP5】(需关注网速或专注度)", speed_black, row_cursor)
            
            # 第二组：服务态度榜
            row_cursor = write_dataframe_block(writer, '质检总览', "❤️【红榜：服务暖心 TOP5】", attitude_red, row_cursor)
            row_cursor = write_dataframe_block(writer, '质检总览', "🖤【黑榜：态度冷漠 TOP5】(需关注情绪管理)", attitude_black, row_cursor)
            
            # 第三组：销售技巧榜
            row_cursor = write_dataframe_block(writer, '质检总览', "🛠️【红榜：金牌销售 TOP5】", skill_red, row_cursor)
            row_cursor = write_dataframe_block(writer, '质检总览', "📉【黑榜：技巧生疏 TOP5】(需加强话术培训)", skill_black, row_cursor)

            # Sheet 2: 明细存档
            df.to_excel(writer, sheet_name='全量明细', index=False)
            
        print(f"\n✅ 报表已生成！包含3大维度红黑榜: {output_file}")
        
    except Exception as e:
        print(f"Excel写入失败: {e}")

if __name__ == "__main__":
    main()