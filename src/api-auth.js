// `npm run api:auth` — Upwork 官方 API 的 OAuth2 授權(一次),token 存進 session/
//
// 事前準備:到 https://www.upwork.com/developer/keys/ 建一個 API key(app),拿到
//   Client ID / Client Secret,Redirect URI 填:http://localhost:3000/callback
// 然後把它們填進 session/api-credentials.json(本程式會幫你建範本)。
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, '..', 'session');
const CRED_PATH = path.join(SESSION_DIR, 'api-credentials.json');
const TOKEN_PATH = path.join(SESSION_DIR, 'api-tokens.json');

const AUTHORIZE_URL = 'https://www.upwork.com/ab/account-security/oauth2/authorize';
const TOKEN_URL = 'https://www.upwork.com/api/v3/oauth2/token';

function loadCreds() {
  if (!existsSync(CRED_PATH)) {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(
      CRED_PATH,
      JSON.stringify(
        { clientId: '在此填入 Client ID', clientSecret: '在此填入 Client Secret', redirectUri: 'http://localhost:3000/callback' },
        null,
        2
      )
    );
    console.log(`已建立範本:${CRED_PATH}`);
    console.log('請填入 Client ID / Secret(到 https://www.upwork.com/developer/keys/ 申請),再重跑。');
    process.exit(0);
  }
  const c = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
  if (/在此填入/.test(c.clientId)) {
    console.log(`請先在 ${CRED_PATH} 填入真正的 Client ID / Secret。`);
    process.exit(1);
  }
  return c;
}

async function exchangeCode(creds, code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error(`token 交換失敗 ${r.status}: ${await r.text()}`);
  return r.json();
}

function saveTokens(t) {
  const expires_at = Date.now() + (t.expires_in ? t.expires_in * 1000 : 86400000) - 60000;
  writeFileSync(TOKEN_PATH, JSON.stringify({ ...t, expires_at }, null, 2));
  console.log(`✅ token 已存:${TOKEN_PATH}`);
}

async function main() {
  const creds = loadCreds();
  const port = new URL(creds.redirectUri).port || 3000;

  const authUrl =
    `${AUTHORIZE_URL}?response_type=code&client_id=${encodeURIComponent(creds.clientId)}` +
    `&redirect_uri=${encodeURIComponent(creds.redirectUri)}`;

  console.log('\n開啟授權頁(若沒自動開,複製到瀏覽器):\n' + authUrl + '\n');
  exec(`open "${authUrl}"`);

  await new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (!url.pathname.startsWith('/callback')) {
        res.writeHead(404);
        return res.end();
      }
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (!code) {
        res.end('<h2>沒收到 code,請重試</h2>');
        return;
      }
      try {
        const tokens = await exchangeCode(creds, code);
        saveTokens(tokens);
        res.end('<h2>✅ 授權完成,可關掉此頁,回終端機。</h2>');
      } catch (e) {
        res.end('<h2>授權失敗:' + e.message + '</h2>');
        console.error(e.message);
      }
      server.close();
      resolve();
    }).listen(port, () => console.log(`等待授權回呼於 http://localhost:${port}/callback …`));
  });
}

main().catch((e) => {
  console.error('api:auth 失敗:', e.message);
  process.exit(1);
});
