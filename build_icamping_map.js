// 🎯 1. 嘗試讀取本機環境變數 (.env 或 .env.local)
try {
  require('dotenv').config({ path: '.env.local' });
} catch (e) {
  try {
    require('dotenv').config();
  } catch (err) {}
}

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws'); // 👈 新增：引入 ws 套件

// 2. 初始化 Supabase 環境變數
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = 
  process.env.SUPABASE_SERVICE_ROLE_KEY || 
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 錯誤：找不到 Supabase URL 或 API Key！請檢查環境變數設定。');
  process.exit(1);
}

// 👈 關鍵修復：傳入 realtime: { transport: WebSocket } 繞過 Node 20 限制
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

/**
 * 🧹 工具函式：簡化與清理營地名稱，提升模糊比對成功率
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .replace(/[\-\|\—\–\_\(\)\（\）\s]+/g, '')
    .replace(/(露營區|露營場|農場|休閒農場|露營|營地)/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 🚀 主程式：預建與比對愛露營全台營地 ID
 */
async function buildIcampingMap() {
  console.log('🚀 開始從 愛露營 (icamping.app) 預建全台營地對照清單...');

  // 1. 抓取 Supabase 資料庫中既有的所有營地資訊
  const { data: dbCampsites, error: dbError } = await supabase
    .from('campsites')
    .select('id, name, region');

  if (dbError || !dbCampsites) {
    console.error('❌ 抓取 Supabase 營地失敗:', dbError?.message);
    process.exit(1);
  }

  console.log(`📋 目前 Supabase 資料庫共有 ${dbCampsites.length} 個營地，準備向愛露營 API 發送查詢...`);

  // 2. 涵蓋全台灣熱門露營縣市與關鍵字
  const searchKeywords = [
    '台南', '高雄', '南投', '台中', '苗栗', 
    '新竹', '宜蘭', '屏東', '花蓮', '台東', '桃園', '嘉義'
  ];
  
  const icampingMap = new Map();

  for (const keyword of searchKeywords) {
    try {
      console.log(`🔎 正在發送愛露營搜尋 API (關鍵字: [${keyword}])...`);
      
      const searchUrl = `https://m.icamping.app/api/v1/stores?q=${encodeURIComponent(keyword)}`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': 'application/json, text/plain, */*'
        }
      });

      if (res.ok) {
        const data = await res.json();
        const stores = data.stores || data.data || (Array.isArray(data) ? data : []);
        
        stores.forEach(store => {
          if (store.id && store.name) {
            icampingMap.set(store.name.trim(), String(store.id).trim());
          }
        });
      }
    } catch (err) {
      console.warn(`⚠️ 關鍵字 [${keyword}] 搜尋發送失敗:`, err.message);
    }
  }

  console.log(`✅ 愛露營全站共抓取到 ${icampingMap.size} 個特約營地！開始進行名稱雙向比對...`);

  // 3. 名稱雙向精準與模糊比對，並更新 Supabase 的 icamping_id 欄位
  let matchCount = 0;

  for (const dbCamp of dbCampsites) {
    let matchedStoreId = null;
    const cleanDbName = normalizeName(dbCamp.name);

    for (const [icampingName, storeId] of icampingMap.entries()) {
      const cleanIcampingName = normalizeName(icampingName);

      if (
        dbCamp.name === icampingName ||
        icampingName.includes(dbCamp.name) ||
        dbCamp.name.includes(icampingName) ||
        (cleanDbName.length >= 2 && cleanIcampingName.includes(cleanDbName)) ||
        (cleanIcampingName.length >= 2 && cleanDbName.includes(cleanIcampingName))
      ) {
        matchedStoreId = storeId;
        break;
      }
    }

    if (matchedStoreId) {
      matchCount++;
      console.log(`🎯 成功比對: [${dbCamp.name}] (${dbCamp.region || '未分區'}) ➡️ icamping_id: [${matchedStoreId}]`);

      const { error: updateErr } = await supabase
        .from('campsites')
        .update({ icamping_id: matchedStoreId })
        .eq('id', dbCamp.id);

      if (updateErr) {
        console.error(`  ❌ 寫入 Supabase 失敗 (${dbCamp.name}):`, updateErr.message);
      }
    }
  }

  console.log(`\n🎉 預建同步完成！成功為 ${matchCount} / ${dbCampsites.length} 個營地綁定愛露營 icamping_id！`);
}

buildIcampingMap().catch(err => {
  console.error('💥 執行嚴重失敗:', err);
  process.exit(1);
});
