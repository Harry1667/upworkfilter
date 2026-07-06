// 本機刷新看門狗 — 輪詢伺服器的 refresh_queue,有任務就自動跑 npm run refresh 幫你把數據刷新。
// 用法:npm run refresh:watch(要先跑過 /open-gstack-browser 並登入 Upwork,同 refresh-live.js 需求)。
// 迴圈:GET /api/refresh-queue/next → 有 id 就 spawn node src/refresh-live.js <id>(繼承 stdio,等跑完)
//       → 不論成功失敗都 POST /api/refresh-queue/done(避免壞案卡死佇列,失敗只印警告)→ 有任務間隔 5 秒、沒任務睡 20 秒。
// Ctrl+C 可停。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* ignore */ }

const REFRESH_URL = (process.env.REFRESH_URL || 'http://upworkfilter.looptw.com').replace(/\/$/, '');
const KEY = process.env.INGEST_KEY || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拿佇列裡最舊一筆待刷新的案(沒有就回 null)
async function fetchNext() {
  const r = await fetch(`${REFRESH_URL}/api/refresh-queue/next?key=${encodeURIComponent(KEY)}`);
  const j = await r.json().catch(() => ({}));
  return j.id || null;
}

// 標記完成(不論這案刷新成功或失敗都要標,避免壞案一直卡在佇列頂端)
async function markDone(id) {
  try {
    await fetch(`${REFRESH_URL}/api/refresh-queue/done?key=${encodeURIComponent(KEY)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    });
  } catch (e) { console.error(`⚠️ 標記案 ${id} 完成失敗:${e.message}`); }
}

// 開子行程跑 refresh-live.js,繼承 stdio 讓使用者看得到 gstack 的即時輸出
function runRefresh(id) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'refresh-live.js'), id], { stdio: 'inherit', cwd: ROOT });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', (e) => { console.error(`⚠️ 執行 refresh-live 失敗:${e.message}`); resolve(false); });
  });
}

let running = true;
process.on('SIGINT', () => { console.log('\n👋 看門狗停止。'); running = false; process.exit(0); });

async function main() {
  if (!KEY) console.warn('⚠️ .env 沒設 INGEST_KEY,佇列 API 可能會被拒。');
  console.log(`📡 刷新看門狗啟動,輪詢 ${REFRESH_URL}/api/refresh-queue/next(Ctrl+C 停止)`);
  while (running) {
    let id = null;
    try { id = await fetchNext(); } catch (e) { console.error(`⚠️ 查詢佇列失敗:${e.message}`); }
    if (!id) { await sleep(20000); continue; }
    console.log(`\n🌐 抓到刷新任務:案 ${id}`);
    const ok = await runRefresh(id);
    if (!ok) console.error(`⚠️ 案 ${id} 刷新失敗(gstack 沒開/沒登入/頁面變了?),已跳過避免卡住佇列。`);
    await markDone(id);
    await sleep(5000);
  }
}

main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
