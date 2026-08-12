try {
  require('dotenv').config({ path: '.env.local' });
} catch (e) {
  try {
    require('dotenv').config();
  } catch (err) {}
}

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function inspectTable() {
  console.log('🔍 正在檢測 Supabase campsites 資料表真實存在的欄位...');
  
  // 只抓取 1 筆資料，不做任何欄位限制 (select * )
  const { data, error } = await supabase
    .from('campsites')
    .select('*')
    .limit(1);

  if (error) {
    console.error('❌ 讀取失敗:', error.message);
  } else if (data && data.length > 0) {
    console.log('✅ 成功找到資料列！campsites 資料表包含的所有欄位如下：');
    console.log(Object.keys(data[0]));
    console.log('\n📄 範例數據內容：', data[0]);
  } else {
    console.log('⚠️ 資料庫目前為空，無法自動印出欄位名稱。');
  }
}

inspectTable();
