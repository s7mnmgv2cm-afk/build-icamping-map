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

// 🧹 超強純化：只留最核心營地名 (例如 "富柿山星空景觀農場" -> "富柿山")
function getCoreName(name) {
  if (!name) return '';
  return name
    .replace(/[\-\|\—\–\_\(\)\（\）\s]+/g, '')
    .replace(/(露營區|露營場|休閒農場|景觀農場|農場|露營|營地|區)/g, '')
    .trim()
    .toLowerCase();
}

async function buildIcampingMap() {
  console.log('⚡ 啟動 Playwright 靈敏模式對接愛露營...');

  // 1. 抓取未綁定的 Supabase 營地
  const { data: dbCampsites, error: dbError } = await supabase
    .from('campsites')
    .select('id, name')
    .is('icamping_id', null);

  if (dbError || !dbCampsites) {
    console.error('❌ 抓取 Supabase 營地失敗:', dbError?.message);
    process.exit(1);
  }

  if (dbCampsites.length === 0) {
    console.log('🎉 所有營地皆已完成 icamping_id 綁定！');
    return;
  }

  console.log(`📋 尚有 ${dbCampsites.length} 個未綁定營地，開始載入愛露營資料...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
  });
  const page = await context.newPage();

  const storeMap = new Map(); // { "愛露營名稱" -> "store_id" }

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

  console.log('🌐 開啟愛露營首頁滾動預載...');
  await page.goto('https://m.icamping.app/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

  // 滾動頁面觸發更多載入
  await page.evaluate(() => window.scrollBy(0, 1000));
  await page.waitForTimeout(2000);

  // 抓取頁面上所有包含 /store/xxxx 的連結與標題
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

  console.log(`✅ 首頁快取獲取到 ${storeMap.size} 個營地，開始進行超靈敏配對...`);

  let matchCount = 0;

  for (let i = 0; i < dbCampsites.length; i++) {
    const dbCamp = dbCampsites[i];
    let matchedStoreId = null;
    const coreDbName = getCoreName(dbCamp.name);

    // A. 先從快取記憶體進行模糊比對
    for (const [icampingName, storeId] of storeMap.entries()) {
      const coreIcampingName = getCoreName(icampingName);

      if (
        dbCamp.name.includes(icampingName) ||
        icampingName.includes(dbCamp.name) ||
        (coreDbName.length >= 2 && coreIcampingName.includes(coreDbName)) ||
        (coreIcampingName.length >= 2 && coreDbName.includes(coreIcampingName))
      ) {
        matchedStoreId = storeId;
        break;
      }
    }

    // B. 若快取未命中，直接透過 Playwright 在愛露營進行站內精準搜尋
    if (!matchedStoreId && coreDbName.length >= 2) {
      try {
        const searchUrl = `https://m.icamping.app/store/search?q=${encodeURIComponent(coreDbName)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // 解析搜尋結果頁面上的第一個營地連結
        const searchLinks = await page.$$eval('a[href*="/store/"]', (els) =>
          els.map((el) => el.href)
        ).catch(() => []);

        for (const href of searchLinks) {
          const match = href.match(/\/store\/([a-zA-Z0-9]+)/);
          if (match && match[1] && match[1] !== 'search') {
            matchedStoreId = match[1];
            break;
          }
        }
      } catch (e) {}
    }

    // C. 若成功匹配，寫入 Supabase
    if (matchedStoreId) {
      matchCount++;
      console.log(`🎯 [${matchCount}] 成功綁定: [${dbCamp.name}] ➡️ icamping_id: [${matchedStoreId}]`);

      await supabase
        .from('campsites')
        .update({ icamping_id: matchedStoreId })
        .eq('id', dbCamp.id);
    }
  }

  await browser.close();

  console.log(`\n🎉 預建完成！本次成功為 ${matchCount} 個營地綁定愛露營 icamping_id！`);
}

buildIcampingMap().catch((err) => {
  console.error('💥 執行失敗:', err);
  process.exit(1);
});
