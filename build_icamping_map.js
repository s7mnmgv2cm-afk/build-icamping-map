// 🎯 1. 嘗試讀取環境變數
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

// 2. 初始化 Supabase 環境變數
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
 * 🧹 工具函式：清理營地名稱
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
 * 🚀 主程式：利用 Playwright 模擬真實瀏覽器爬取愛露營對照表
 */
async function buildIcampingMap() {
  console.log('🚀 啟動 Playwright 模擬真實瀏覽器對接愛露營 (icamping.app)...');

  // 1. 抓取 Supabase 所有營地
  const { data: dbCampsites, error: dbError } = await supabase
    .from('campsites')
    .select('id, name');

  if (dbError || !dbCampsites) {
    console.error('❌ 抓取 Supabase 營地失敗:', dbError?.message);
    process.exit(1);
  }

  console.log(`📋 目前 Supabase 資料庫共有 ${dbCampsites.length} 個營地...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });

  const icampingMap = new Map();

  // 2. 直接監聽頁面所有背景 API 網路請求，自動捕捉 JSON 數據
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/store') || url.includes('/search') || url.includes('/api')) {
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
    }
  });

  // 3. 逐一針對每一個資料庫中的營地進行愛露營站內精準搜尋
  console.log(`🔎 開始進行全台營地精準愛露營 ID 比對...`);

  for (let i = 0; i < dbCampsites.length; i++) {
    const camp = dbCampsites[i];
    try {
      const searchUrl = `https://m.icamping.app/store/search?q=${encodeURIComponent(camp.name)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});

      // 擷取 DOM 上的卡片超連結 (https://m.icamping.app/store/dg535)
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
    } catch (err) {}
  }

  await browser.close();

  console.log(`✅ 愛露營全站捕捉到 ${icampingMap.size} 個特約對照紀錄！開始寫入 Supabase...`);

  // 4. 比對與寫入 Supabase
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
      console.log(`🎯 成功比對: [${dbCamp.name}] ➡️ icamping_id: [${matchedStoreId}]`);

      await supabase
        .from('campsites')
        .update({ icamping_id: matchedStoreId })
        .eq('id', dbCamp.id);
    }
  }

  console.log(`\n🎉 同步完成！成功為 ${matchCount} / ${dbCampsites.length} 個營地綁定愛露營 icamping_id！`);
}

buildIcampingMap().catch((err) => {
  console.error('💥 執行失敗:', err);
  process.exit(1);
});
