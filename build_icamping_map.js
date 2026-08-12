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

// 🛡️ 隨機模擬 User-Agent 避免被當成機器人
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 🛡️ 隨機延遲工具函式 (模擬人類行為)
function randomDelay(minMs = 300, maxMs = 800) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ⚡ 單一營地安全的對照請求
 */
async function findStoreId(campName) {
  try {
    const query = encodeURIComponent(`site:icamping.app/store/ "${campName}"`);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, {
      headers: { 
        'User-Agent': getRandomUserAgent(),
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/icamping\.app\/store\/([a-zA-Z0-9]+)/);
      if (match && match[1]) return match[1];
    }
  } catch (e) {}
  return null;
}

async function buildIcampingMap() {
  console.log('🛡️ 啟動防封鎖安全版全台營地 icamping_id 對照...');

  // 1. 僅抓取還沒有 icamping_id 的營地
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

  console.log(`📋 尚有 ${dbCampsites.length} 個未綁定營地，開始安全流速對照...`);

  // 🛡️ 安全 Batching：並發 2 個，間隔 400~800ms
  const BATCH_SIZE = 2;
  let matchCount = 0;

  for (let i = 0; i < dbCampsites.length; i += BATCH_SIZE) {
    const batch = dbCampsites.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (dbCamp) => {
        const storeId = await findStoreId(dbCamp.name);
        if (storeId) {
          matchCount++;
          console.log(`🎯 [成功] [${dbCamp.name}] ➡️ icamping_id: [${storeId}]`);
          
          await supabase
            .from('campsites')
            .update({ icamping_id: storeId })
            .eq('id', dbCamp.id);
        }
      })
    );

    // 每次 Batch 執行完畢後隨機休眠 400ms~800ms，徹底避開機器人偵測
    await randomDelay(400, 800);
  }

  console.log(`\n🎉 預建同步完成！本次成功為 ${matchCount} 個營地完成綁定！`);
}

buildIcampingMap().catch((err) => {
  console.error('💥 執行失敗:', err);
  process.exit(1);
});
