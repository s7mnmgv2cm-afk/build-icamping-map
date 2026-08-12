try {
  require('dotenv').config({ path: '.env.local' });
} catch (e) {
  try {
    require('dotenv').config();
  } catch (err) {}
}

const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 錯誤：找不到 Supabase URL 或 SERVICE_ROLE_KEY！');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * 🧠 讓 Gemini 直接使用 Google 搜尋引擎尋找答案
 */
async function parseBookingInfoWithAI(campsite) {
  const prompt = `
你是一個台灣露營區資訊結構化專家。請使用你的 Google 搜尋能力，查詢【${campsite.name} 露營區】最新的預約與訂位方式。
請特別留意搜尋結果或官方 Facebook 中是否有提到「官方 LINE」、「LINE ID 為 @xxx」、或是使用「愛露營」、「露營樂」等平台。

【原資料庫電話參考】：${campsite.phone || '無'}

分析邏輯：
1. 優先判斷是否有「官方 LINE」，並提取 line_id。若有，booking_type 設為 line。
2. 若使用愛露營 (icamping) 或 露營樂 (easycamp)，請設定對應的 booking_type。
3. 若都沒有，但有電話，請設為 phone。
4. 若資訊太少無法判斷，設為 unknown。

請嚴格輸出 JSON 格式（不要包含 markdown \`\`\`json 標記）：
{
  "booking_type": "icamping" | "easycamp" | "line" | "phone" | "official_site" | "unknown",
  "line_id": "LINE ID (例如 @634gbjvj，若無則為 null)",
  "phone": "電話號碼 (請結合原電話與搜尋結果更新，若無則為 null)",
  "booking_url": "訂位網址或 Line 連結 (若無則為 null)"
}
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        // 🌟 核心關鍵：直接開啟 Gemini 的 Google 搜尋工具！
        tools: [{ googleSearch: {} }], 
        temperature: 0.1, // 降低隨機性，提高資訊準確度
      }
    });

    const cleanJsonText = response.text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanJsonText);
  } catch (err) {
    console.error(`❌ AI 解析 [${campsite.name}] 失敗:`, err.message);
    return null;
  }
}

// 🛡️ 輕微延遲避免觸發 API 頻率限制
function randomDelay(minMs = 1500, maxMs = 3000) {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs));
}

async function main() {
  console.log('🤖 啟動 [原廠 Google 搜尋 + LLM] 營地訂位自動分析系統...');

  const { data: campsites, error } = await supabase
    .from('campsites')
    .select('id, name, phone')
    .is('booking_type', null);

  if (error || !campsites) {
    console.error('❌ 抓取 Supabase 失敗:', error?.message);
    process.exit(1);
  }

  if (campsites.length === 0) {
    console.log('🎉 所有營地皆已完成訂位管道分析，無需更新！');
    return;
  }

  console.log(`📋 共有 ${campsites.length} 個營地待 AI 分析...`);

  for (let i = 0; i < campsites.length; i++) {
    const camp = campsites[i];
    
    // 將繁重的工作全部交給帶有搜尋能力的 Gemini
    const result = await parseBookingInfoWithAI(camp);

    if (result) {
      console.log(`🎯 [${i + 1}/${campsites.length}] [${camp.name}] ➡️ 管道: ${result.booking_type}, LINE: ${result.line_id || '無'}`);

      // 更新資料庫
      await supabase
        .from('campsites')
        .update({
          booking_type: result.booking_type,
          line_id: result.line_id,
          phone: result.phone || camp.phone,
          booking_url: result.booking_url
        })
        .eq('id', camp.id);
    }

    await randomDelay(1500, 3000);
  }

  console.log('\n🎉 [Google 搜尋原生版] 所有營地訂位管道更新完畢！');
}

main();
