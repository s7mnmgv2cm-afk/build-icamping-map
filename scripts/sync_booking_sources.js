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

// ⛔ 社群與高防護網站黑名單（不去撞牆）
const SOCIAL_BLACKLIST = [
  'facebook.com', 'fb.com', 'instagram.com', 'youtube.com',
  'tiktok.com', 'twitter.com', 'x.com', 'dcard.tw', 'ptt.cc'
];

/**
 * 🕸️ 深度抓取網頁內容 (去除 HTML，保留純文字)
 */
async function fetchDeepPageContent(url) {
  try {
    const res = await fetch(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
      },
      signal: AbortSignal.timeout(4000) // 4 秒超時，避免卡死
    });
    
    if (!res.ok) return '';
    const html = await res.text();
    
    // 粗略去除 script, style 與 HTML 標籤
    const cleanText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
      
    return cleanText.substring(0, 1000); // 只取前 1000 字
  } catch (e) {
    return '';
  }
}

/**
 * 🕵️ 步驟一：抓取 DuckDuckGo 搜尋結果與第一個非社群網址的深度內容
 */
async function fetchSearchData(campName) {
  const resultData = { snippets: '', deepContent: '', deepUrl: '' };
  
  try {
    const query = encodeURIComponent(`"${campName}" 露營 預約 訂位 LINE`);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) return resultData;
    const html = await res.text();

    const snippets = [];
    const searchLinks = [];
    
    // 萃取 Snippet 與對應的 href
    const regex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const rawUrl = match[1];
      const cleanSnippet = match[2].replace(/<[^>]+>/g, '').trim();
      
      // 解碼 DuckDuckGo 的跳轉 URL
      let actualUrl = rawUrl;
      if (rawUrl.includes('uddg=')) {
        try { actualUrl = decodeURIComponent(rawUrl.split('uddg=')[1].split('&')[0]); } catch (e) {}
      }

      snippets.push(cleanSnippet);
      searchLinks.push({ url: actualUrl, snippet: cleanSnippet });
    }
    
    resultData.snippets = snippets.join('\n').substring(0, 1000);

    // 嘗試尋找前 5 名內，第一個不是社群媒體的網址進行「深度抓取」
    for (let i = 0; i < Math.min(5, searchLinks.length); i++) {
      const link = searchLinks[i];
      const isBlacklisted = SOCIAL_BLACKLIST.some(domain => link.url.includes(domain));
      
      if (!isBlacklisted && link.url.startsWith('http')) {
        console.log(`   🔗 發現非社群網址，進入深度抓取: ${link.url.substring(0, 50)}...`);
        const deepContent = await fetchDeepPageContent(link.url);
        if (deepContent.length > 100) {
          resultData.deepContent = deepContent;
          resultData.deepUrl = link.url;
          break; // 抓到一個成功的就夠了，退出迴圈
        }
      }
    }

    return resultData;
  } catch (e) {
    console.log(`⚠️ [${campName}] 搜尋失敗: ${e.message}`);
    return resultData;
  }
}

/**
 * 🧠 步驟二：Gemini 分析
 */
async function parseBookingInfoWithAI(campsite, searchData) {
  const prompt = `
你是一個台灣露營區資訊結構化專家。請分析以下營地的【網路最新搜尋摘要】與【深度網頁內容】，判斷真實的訂位管道與聯絡方式。

【營地名稱】：${campsite.name}
【原資料庫電話】：${campsite.phone || '無'}

【搜尋結果摘要】：
"""
${searchData.snippets}
"""

【深度網頁內容 (來源: ${searchData.deepUrl || '無'})】：
"""
${searchData.deepContent}
"""

分析邏輯：
1. 優先從「深度網頁內容」與「摘要」中尋找「官方 LINE」、「LINE ID 為 @xxx」，並設定 booking_type 為 line 及提取 line_id。
2. 若網址或內容顯示為愛露營 (icamping) 或 露營樂 (easycamp)，請設定對應的 booking_type。
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
    });

    return JSON.parse(response.text.replace(/```json|```/g, '').trim());
  } catch (err) {
    return null;
  }
}

function randomDelay(minMs = 1500, maxMs = 3000) {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs));
}

async function main() {
  console.log('🤖 啟動 [搜尋引擎 + 深度抓取 + LLM] 營地訂位管道自動分析系統...');

  const { data: campsites, error } = await supabase
    .from('campsites')
    .select('id, name, phone')
    .is('booking_type', null);

  if (error || !campsites) {
    console.error('❌ 抓取 Supabase 失敗:', error?.message);
    process.exit(1);
  }

  console.log(`📋 共有 ${campsites.length} 個營地待 AI 分析...`);

  for (let i = 0; i < campsites.length; i++) {
    const camp = campsites[i];
    
    // A. 廣度搜尋與深度抓取
    const searchData = await fetchSearchData(camp.name);
    
    if (!searchData.snippets) {
      console.log(`⚪ [${i + 1}/${campsites.length}] [${camp.name}] 缺乏足夠搜尋結果，略過。`);
      await randomDelay();
      continue;
    }

    // B. AI 分析
    const result = await parseBookingInfoWithAI(camp, searchData);

    if (result) {
      console.log(`🎯 [${i + 1}/${campsites.length}] [${camp.name}] ➡️ 管道: ${result.booking_type}, LINE: ${result.line_id || '無'}`);

      // C. 更新資料庫
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

  console.log('\n🎉 [深度分析版] 所有營地訂位管道更新完畢！');
}

main();
