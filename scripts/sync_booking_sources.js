// scripts/sync_booking_sources.js
try {
  require('dotenv').config({ path: '.env.local' });
} catch (e) {
  try {
    require('dotenv').config();
  } catch (err) {}
}

const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai'); // 使用官方最新 Gemini SDK

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function parseBookingInfoWithAI(campsite) {
  const prompt = `
你是一個露營區資訊結構化專家。請分析以下營地的介紹與備註文本，判斷真實的訂位管道與聯絡方式：

【營地名稱】：${campsite.name}
【營地簡介與公告】：
"""
${campsite.description \vert{}\vert{} ''}${campsite.notes || ''}
"""

請嚴格輸出 JSON 格式（不要包含 markdown ```json 標記）：
{
  "booking_type": "icamping" | "easycamp" | "line" | "phone" | "official_site" | "unknown",
  "line_id": "LINE ID (例如 @634gbjvj，若無則為 null)",
  "phone": "電話號碼 (若無則為 null)",
  "booking_url": "訂位網址或 Line 連結 (若無則為 null)",
  "rules_summary": ["重點規定1", "重點規定2"]
}
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // 速度極快且免費額度充足
      contents: prompt,
    });

    const cleanJsonText = response.text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanJsonText);
  } catch (err) {
    console.error(`❌ AI 解析 [${campsite.name}] 失敗:`, err.message);
    return null;
  }
}

async function main() {
  console.log('🧠 啟動 LLM 營地訂位管道自動分析...');

  // 撈取尚未經過 AI 分析的營地
  const { data: campsites, error } = await supabase
    .from('campsites')
    .select('id, name, description, notes')
    .is('booking_type', null);

  if (error || !campsites) {
    console.error('❌ 抓取 Supabase 失敗:', error?.message);
    process.exit(1);
  }

  console.log(`📋 共有 ${campsites.length} 個營地待分析...`);

  for (const camp of campsites) {
    const result = await parseBookingInfoWithAI(camp);

    if (result) {
      console.log(`🎯 [${camp.name}] 分析成功 ➡️ 管道: ${result.booking_type}, LINE: ${result.line_id}`);

      // 寫回 Supabase 資料庫
      await supabase
        .from('campsites')
        .update({
          booking_type: result.booking_type,
          line_id: result.line_id,
          phone: result.phone || camp.phone,
          booking_url: result.booking_url,
          rules_summary: result.rules_summary
        })
        .eq('id', camp.id);
    }

    // 稍微停頓避開 API 流速限制
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('🎉 所有營地訂位管道分析完畢！');
}

main();
