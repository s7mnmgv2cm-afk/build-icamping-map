// 🎯 1. 讀取環境變數
try {
  require('dotenv').config({ path: '.env.local' });
} catch (e) {
  try {
    require('dotenv').config();
  } catch (err) {}
}

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// 2. 初始化 Supabase
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

/**
 * 🧹 名稱正規化
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
 * 🦆 備用精準方案：透過 DuckDuckGo 免費搜尋引擎對照 store_id
 */
async function searchIcampingIdViaSearchEngine(campName) {
  try {
    const query = encodeURIComponent(`site:icamping.app/store/ "${campName}"`);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (res.ok) {
      const html = await res.text();
      // 比對 href 裡面的 /store/xxxx
      const match = html.match(/icamping\.app\/store\/([a-zA-Z0-9]+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch (e) {}
  return null;
}

/**
 * 🚀 主程式
 */
async function buildIcampingMap() {
  console.log('🚀 開始進行全台營地對照愛露營 icamping_id...');

  // 1. 取得 Supabase 營地
  const { data: dbCampsites, error: dbError } = await supabase
    .from('campsites')
    .select('id, name');

  if (dbError || !dbCampsites) {
    console.error('❌ 抓取 Supabase 營地失敗:', dbError?.message);
    process.exit(1);
  }

  console.log(`📋 Supabase 資料庫共有 ${dbCampsites.length} 個營地...`);

  // 2. 啟動 Playwright 嘗試廣域捕捉
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
  });

  const icampingMap = new Map();

  // 監聽 response JSON
  page.on('response', async (response) => {
    try {
      const json = await response.json().catch(() => null);
      if (json) {
        const stores = json.stores || json.data || (Array.isArray(json) ? json : []);
        stores.forEach((s) => {
          if (s.id && s.name) {
            icampingMap.set(s.name.trim(), String(s.id).trim());
          }
        });
      }
    } catch (e) {}
  });

  // 前往熱門頁面觸發清單
  console.log('🌐 正在開啟愛露營熱門頁面預載資料...');
  await page.goto('https://m.icamping.app/', { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});

  // 撈取頁面上現有的 store 連結
  const links = await page.$$eval('a[href*="/store/"]', (els) =>
    els.map((el) => ({
      href: el.href,
      text: el.innerText.trim()
    }))
  ).catch(() => []);

  links.forEach((link) => {
    const match = link.href.match(/\/store\/([a-zA-Z0-9]+)/);
    if (match && match[1] && link.text) {
      icampingMap.set(link.text, match[1]);
    }
  });

  await browser.close();

  console.log(`✅ 廣域預載抓取到 ${icampingMap.size} 個特約紀錄！開始比對寫入...`);

  // 3. 開始比對，若廣域沒對到，自動啟用引擎補充搜尋
  let matchCount = 0;

  for (let i = 0; i < dbCampsites.length; i++) {
    const dbCamp = dbCampsites[i];
    let matchedStoreId = null;
    const cleanDbName = normalizeName(dbCamp.name);

    // 先從廣域快取比對
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

    // 若廣域快取沒比對到，自動進行搜尋引擎精準查詢
    if (!matchedStoreId) {
      matchedStoreId = await searchIcampingIdViaSearchEngine(dbCamp.name);
      if (matchedStoreId) {
        // 稍作停頓避免請求過頻
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (matchedStoreId) {
      matchCount++;
      console.log(`🎯 [${matchCount}/${dbCampsites.length}] 成功綁定: [${dbCamp.name}] ➡️ icamping_id: [${matchedStoreId}]`);

      await supabase
        .from('campsites')
        .update({ icamping_id: matchedStoreId })
        .eq('id', dbCamp.id);
    }
  }

  console.log(`\n🎉 預建完成！成功為 ${matchCount} / ${dbCampsites.length} 個營地綁定愛露營 icamping_id！`);
}

buildIcampingMap().catch((err) => {
  console.error('💥 執行失敗:', err);
  process.exit(1);
});
