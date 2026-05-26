# 部署到 Oracle(固定網址、24h 在線、任何電腦可開)

目標:把 dashboard + /api/ingest 放到你的 Oracle 主機,綁子網域(如 `upwork.你的網域`)+ HTTPS + 登入密碼。
你的電腦關機沒差,擴充套件在任何瀏覽器都能把職缺餵進來。

> 「產生評估網站」按鈕在雲端**改用擴充套件已餵進的資料**(不需 gstack)。本機版仍可 gstack 抓。

---

## 前置
- Oracle 主機(SSH 進得去)、Node 18+、nginx、一個你擁有的網域。
- 先在 DNS 把子網域 A 紀錄指到 Oracle 公網 IP:`upwork.你的網域 → <Oracle IP>`
- Oracle 安全清單 / firewall 開 80、443。

---

## 步驟 1:上傳程式(不含機密)

本機(把 <IP>、路徑換成你的):
```bash
cd ~/Desktop/未命名檔案夾
rsync -av --exclude node_modules --exclude session --exclude '.env' --exclude jobs.db \
  --exclude 'upwork-*-analysis.html' upwork-job-finder/ \
  <user>@<IP>:/opt/upwork-job-finder/
```
> 刻意排除 `session/`、`.env`、`jobs.db` — 機密與本機登入不上傳。

## 步驟 2:Oracle 上安裝

```bash
ssh <user>@<IP>
cd /opt/upwork-job-finder
# 雲端不抓取、不開瀏覽器 → 跳過 playwright 的瀏覽器下載
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
# 若要在雲端產評估網站(analyze),裝 python gRPC:
pip3 install grpcio grpcio-tools
```
> 雲端只跑 web + ingest + analyze(用擴充套件已餵進的資料)。**不需要 gstack、不需要瀏覽器**。
> web 伺服器本身只用 Node 內建模組,playwright 不會被載入。

## 步驟 3:設定機密

```bash
cp deploy/.env.production.example .env.production
nano .env.production       # 填 DASH_PASSWORD、INGEST_KEY、AI_PROXY_TOKEN…
chmod 600 .env.production  # 只有你讀得到
```

## 步驟 4:設成常駐服務(systemd)

```bash
sudo cp deploy/upwork-job-finder.service /etc/systemd/system/
sudo nano /etc/systemd/system/upwork-job-finder.service   # 把 <USER> 改成你的帳號
sudo systemctl daemon-reload
sudo systemctl enable --now upwork-job-finder
systemctl status upwork-job-finder        # 看是否 running
curl -s localhost:8787/api/ingest         # 應回 {"ok":true...}
```

## 步驟 5:nginx + HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/upwork-job-finder.conf
sudo nano /etc/nginx/conf.d/upwork-job-finder.conf   # server_name 改成你的子網域
sudo nginx -t && sudo nginx -s reload
# 申請 HTTPS 憑證(會自動改 nginx 設定加 443 轉址)
sudo certbot --nginx -d upwork.你的網域
```

## 步驟 6:擴充套件指向線上

擴充套件 → Webhook URL 改成:
```
https://upwork.你的網域/api/ingest?key=你在.env.production設的INGEST_KEY
```
其餘照舊。它會把職缺 POST 到雲端 → 自動評分 → 你在任何電腦開
`https://upwork.你的網域`(輸入 dashboard 帳密)就能看。

---

## 更新版本(之後改了程式)
```bash
rsync ... (同步驟1) ...
ssh <user>@<IP> "sudo systemctl restart upwork-job-finder"
```

## 注意
- `jobs.db` 在伺服器上會獨立累積(跟本機那份分開)。想搬本機資料上去可一次性 scp。
- 想關掉公開存取:`sudo systemctl stop upwork-job-finder`。
- 安全:`.env.production` 與資料庫只在伺服器;repo 不含任何機密。
