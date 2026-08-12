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

function cleanName(name) {
  if (!name) return '';
  return name
    .replace(/[\-\|\—\–\_\(\)\（\）\s]+/g, '')
    .replace(/(露營區|露營場|農場|休閒農場|露營|營地)/g, '')
    .trim()
    .toLowerCase();
}

async function buildIcampingMap() {
  console.log('⚡ 啟動 Playwright 模擬真實瀏覽器抓取愛露營對照字典...');

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

  // 2. 啟動真實瀏覽器避開防護牆
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  const storeMap = new Map();

  // 攔截所有背景傳回的 JSON 數據
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (url.includes('api') || url.includes('store') || url.includes('search')) {
        const json = await response.json().catch(() => null);
        if (json) {
          const stores = json.stores || json.data || (Array.isArray(json) ? json : []);
          stores.forEach((s) => {
            const sId = s.id || s.store_id || s.code;
            const sName = s.name || s.title;
            if (sId && sName) {
              storeMap.set(String(sName).trim(), String(sId).trim());
            }
          });
        }
      }
    } catch (e) {}
  });

  console.log('🌐 開啟愛露營首頁與搜尋頁，滾動觸發清單...');
  await page.goto('https://m.icamping.app/', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});

  // 抓取 DOM 上現有的所有 /store/xxxx 連結
  const links = await page.$$eval('a[href*="/store/"]', (els) =>
    els.map((el) => ({
      href: el.href,
      text: el.innerText.trim()
    }))
  ).catch(() => []);

  links.forEach((link) => {
    const match = link.href.match(/\/store\/([a-zA-Z0-9]+)/);
    if (match && match[1] && link.text) {
      storeMap.set(link.text, match[1]);
    }
  });

  await browser.close();

  console.log(`✅ 成功建立愛露營 ${storeMap.size} 個特約營地對照字典！開始記憶體比對...`);

  // 3. 記憶體雙向模糊比對並更新 Supabase
  let matchCount = 0;

  for (const dbCamp of dbCampsites) {
    let matchedStoreId = null;
    const dbClean = cleanName(dbCamp.name);

    for (const [icampingName, storeId] of storeMap.entries()) {
      const icampingClean = cleanName(icampingName);

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
