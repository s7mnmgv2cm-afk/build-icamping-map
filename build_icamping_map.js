try {
  require('dotenv').config({ path: '.env.local' });
} catch (e) {
  try {
    require('dotenv').config();
  } catch (err) {}
}

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = 
  process.env.SUPABASE_SERVICE_ROLE_KEY || 
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 錯誤：找不到 Supabase URL 或 API Key！');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

// 🧹 營地名稱純化（去除「營地」、「露營區」等通用詞，提高比對命中率）
function cleanName(name) {
  if (!name) return '';
  return name
    .replace(/[\-\|\—\–\_\(\)\（\）\s]+/g, '')
    .replace(/(露營區|露營場|農場|休閒農場|露營|營地)/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 🚀 從愛露營 API 直接下載全台熱門區域的特約營地地圖
 */
async function fetchIcampingStoreList() {
  const storeMap = new Map(); // { '愛露營名稱' -> 'store_id' }
  const keywords = ['露營', '農場', '山', '森林', '苗栗', '新竹', '南投', '宜蘭', '台中', '屏東', '花蓮', '嘉義', '高雄', '桃園'];

  console.log('🌐 正在向愛露營 API 發送全站特約營地地圖下載...');

  for (const kw of keywords) {
    try {
      // 模擬行動端 API 請求
      const url = `https://m.icamping.app/api/v1/stores?q=${encodeURIComponent(kw)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://m.icamping.app/'
        }
      });

      if (res.ok) {
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          const stores = json.stores || json.data || (Array.isArray(json) ? json : []);
          stores.forEach((s) => {
            const sId = s.id || s.store_id || s.code;
            const sName = s.name || s.title;
            if (sId && sName) {
              storeMap.set(sName.trim(), String(sId).trim());
            }
          });
        } catch (e) {
          // 若傳回非 JSON，說明觸發頁面，則從 HTML 解析 /store/xxxx
          const matches = [...text.matchAll(/href=["']\/store\/([a-zA-Z0-9]+)["'][^>]*>([^<]+)/g)];
          matches.forEach(m => {
            if (m[1] && m[2]) storeMap.set(m[2].trim(), m[1].trim());
          });
        }
      }
    } catch (e) {}
  }

  return storeMap;
}

async function buildIcampingMap() {
  console.log('⚡ 啟動全台營地 icamping_id 記憶體對照...');

  // 1. 抓取尚未綁定 icamping_id 的 Supabase 營地
  const { data: dbCampsites, error: dbError } = await supabase
    .from('campsites')
    .select('id, name')
    .is('icamping_id', null);

  if (dbError || !dbCampsites) {
    console.error('❌ 抓取 Supabase 營地失敗:', dbError?.message);
    process.exit(1);
  }

  if (dbCampsites.length === 0) {
    console.log('🎉 所有營地皆已完成 icamping_id 綁定，無需更新！');
    return;
  }

  console.log(`📋 尚有 ${dbCampsites.length} 個未綁定營地...`);

  // 2. 抓取愛露營全站營地清單
  const icampingMap = await fetchIcampingStoreList();
  console.log(`✅ 成功建立愛露營 ${icampingMap.size} 個特約營地對照字典！開始比對...`);

  // 3. 在記憶體中快速雙向模糊比對
  let matchCount = 0;

  for (const dbCamp of dbCampsites) {
    let matchedStoreId = null;
    const dbClean = cleanName(dbCamp.name);

    for (const [icampingName, storeId] of icampingMap.entries()) {
      const icampingClean = cleanName(icampingName);

      // 滿足以下任一條件即判定比對成功：
      if (
        dbCamp.name === icampingName ||
        icampingName.includes(dbCamp.name) ||
        dbCamp.name.includes(icampingName) ||
        (dbClean.length >= 2 && icampingClean.includes(dbClean)) ||
        (icampingClean.length >= 2 && dbClean.includes(icampingClean))
      ) {
        matchedStoreId = storeId;
        break;
      }
    }

    if (matchedStoreId) {
      matchCount++;
      console.log(`🎯 [${matchCount}] 成功綁定: [${dbCamp.name}] ➡️ icamping_id: [${matchedStoreId}]`);

      await supabase
        .from('campsites')
        .update({ icamping_id: matchedStoreId })
        .eq('id', dbCamp.id);
    }
  }

  console.log(`\n🎉 預建完成！本次成功為 ${matchCount} 個營地綁定愛露營 icamping_id！`);
}

buildIcampingMap().catch((err) => {
  console.error('💥 執行失敗:', err);
  process.exit(1);
});
