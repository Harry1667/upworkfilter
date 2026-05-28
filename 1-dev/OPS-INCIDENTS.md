# Ops 事件紀錄

> 部署在 Oracle(137.131.7.230)+ aaPanel + nginx 上踩過的坑,跟解法。
> 之後再碰類似狀況直接翻這份,不用重新偵錯。

---

## 2026-05-28 · `https://upworkfilter.looptw.com` 被路由到 AgentHub

### 症狀
- `http://upworkfilter.looptw.com` 正常
- `https://upworkfilter.looptw.com` 顯示「選擇使用者登入 AgentHub」(完全錯誤的服務)
- Chrome 因為記住 looptw.com 偏好 https,自動把網址升級成 https → 觸發 bug

### 偵錯
1. 兩個 service port 完全分開(upworkfilter:3012、agentshub:3011)
2. 兩份 nginx config 也分開,server_name 也對
3. 但 SNI 測試發現 nginx 回的憑證是 agentshub 的:
   ```bash
   sudo openssl s_client -connect 127.0.0.1:443 -servername upworkfilter.looptw.com </dev/null 2>/dev/null \
     | openssl x509 -noout -subject
   # subject=CN = agentshub.looptw.com  ← 錯
   ```
4. cert 檔案內容本身正確(`CN=upworkfilter.looptw.com`),conf 也正確
5. 真正原因:**aaPanel 裝完 SSL 沒觸發 nginx reload**,worker 進程還是用舊配置(那時 upworkfilter 沒 SSL,SNI miss 就 fallback 到 agentshub)

### 解法
```bash
sudo nginx -s reload
```

### 教訓
**aaPanel 改 SSL / 改 nginx 設定後,不一定會自動 reload nginx。**
若「配置看起來對但行為異常」,先試 `sudo nginx -t && sudo nginx -s reload`。

---

## 2026-05-28 · `nginx -t` 兩個 protocol options redefined warning

### 症狀
```
nginx: [warn] protocol options redefined for 0.0.0.0:443 in idea.looptw.com.conf:10
nginx: [warn] protocol options redefined for 0.0.0.0:443 in imageanalysis.looptw.com.conf:4
```

### 偵錯
- 17 個 conf 都有 `listen 443`
- 16 個用 `listen 443 ssl http2 ;`,1 個用 `listen 443 ssl;`(就是 idea)
- imageanalysis 的 listen 跟 16 個標準完全一樣,卻也被警告

### 根因
nginx 在同一個 listening socket(`0.0.0.0:443`)上,**只接受第一個 server 設定 protocol options(`ssl`、`http2`)**,後續若用「不同」的 options 會 warn。
但 nginx 有「連鎖效應」:一旦中間某個 conf 用了**不一致**的 options,後續 conf 即使跟「第一個」一致,也會被視為「相對於前一個」重新定義。

→ idea 用 `ssl`(沒 http2)觸發第一個 warning,接著 imageanalysis 雖然回到 `ssl http2`,nginx 還是當成「重新定義」再 warn 一次。

### 解法
只改 idea 對齊標準格式:
```diff
# /www/server/panel/vhost/nginx/idea.looptw.com.conf:10
-    listen 443 ssl;
+    listen 443 ssl http2 ;
```

reload 後兩個 warning 同時消失。

### 教訓
所有 looptw.com 子網域的 `listen 443` 都統一用 `listen 443 ssl http2 ;`(注意 `;` 前有空白,跟 aaPanel 預設一致)。
之後若再加新站,把那行抄過去就好,別自己手寫變體。

---

## 通用 SOP

### 改 nginx 設定後一定要跑
```bash
sudo nginx -t              # 檢查語法 + warning
sudo nginx -s reload       # reload(不會中斷連線)
```

### SSL 行為怪怪的時候測 SNI
```bash
sudo openssl s_client -connect 127.0.0.1:443 -servername <domain> </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer
```
如果 subject 跟 servername 不一致 → nginx 配置或 reload 出問題。

### 看哪些 conf 觸碰特定 port
```bash
sudo grep -rn "listen 443" /www/server/panel/vhost/nginx/
```
