// 接案助手 — 讀「我的檔案」+ 組各種 AI prompt(求職信 / 客戶回覆 / 作品集建議)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(__dirname, '..', 'profile.json');
const PROFILE_EXAMPLE = path.join(__dirname, '..', 'profile.example.json');

export function loadProfile() {
  // 優先讀使用者編輯過的 profile.json;伺服器首次部署時沒有 → 退回範本
  const f = existsSync(PROFILE_PATH) ? PROFILE_PATH : (existsSync(PROFILE_EXAMPLE) ? PROFILE_EXAMPLE : null);
  if (!f) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}
export function saveProfile(obj) {
  writeFileSync(PROFILE_PATH, JSON.stringify(obj, null, 2));
}

// 能力邊界(可交付項目 + level + 能做/不做 + 紅線 + 規模上限)
// 所有 AI(快篩/大分析/求職信/聊天)共用:讓 AI 判斷案子在不在能力圈、別承諾做不到的事、勝率反映深度。
export function capabilityBrief(p) {
  const skills = (p.capability?.skills || [])
    .map((s) => {
      const bits = [`${s.name}(深度${s.level}/5)`];
      if (s.canDo) bits.push(`能做:${s.canDo}`);
      if (s.cantDo) bits.push(`不做:${s.cantDo}`);
      return `- ${bits.join(';')}`;
    })
    .join('\n');
  if (!skills) return '';
  const redlines = (p.capability?.redlines || []).join('、');
  return `我的可交付能力與邊界(深度 5 精通…1 碰過):\n${skills}` +
    (redlines ? `\n絕不接(紅線,出現即略過):${redlines}` : '') +
    (p.capability?.scaleCeiling ? `\n規模上限:${p.capability.scaleCeiling}` : '');
}

// 把檔案濃縮成 prompt 用的文字
function profileBrief(p) {
  const port = (p.portfolio || []).map((x) => `- ${x.name}(${x.type}):${x.desc}`).join('\n');
  // Profile Agent 從 GitHub 歸納的「真實 repo 證據」— 求職信優先引用這些(有實作可佐證)
  const proven = (p.provenCapabilities || [])
    .map((c) => `- ${c.repo}:${c.capability}${c.url ? `(${c.url})` : ''} [${(c.techs || []).join('/')}]`)
    .join('\n');
  const capBrief = capabilityBrief(p);
  return [
    `姓名:${p.name || ''}`,
    `定位:${p.title || ''}|等級:${p.level || ''}|時薪:$${p.hourlyRate || '?'}`,
    `自介:${p.bio || ''}`,
    `技能:${(p.skills || []).join(', ')}`,
    capBrief,
    `作品集:\n${port}`,
    proven ? `已證明能力(GitHub 真實 repo,優先當證據):\n${proven}` : '',
    // 🌱 經驗存摺 — 已完成的 Upwork/接案實戰(有評價/收入,是最強的社會證明,寫信時優先引用)
    (p.trackRecord || []).length ? `\n🌱 Upwork 實戰戰績(已交付完成、真實發生過 — 這是最強證據,比 GitHub 更打動客戶,適合時優先引用,但**只能講真的、別誇大評價或收入**):\n${(p.trackRecord).slice(0, 6).map((t, i) => {
      const bits = [t.title];
      if (t.rating) bits.push(`${t.rating}★`);
      if (t.skills) bits.push(`技能:${t.skills}`);
      if (t.summary) bits.push(t.summary);
      if (t.review_text) bits.push(`客戶評語:"${String(t.review_text).slice(0, 160)}"`);
      return `[${i + 1}] ${bits.filter(Boolean).join(' — ')}`;
    }).join('\n')}` : '',
    `求職信規則:${(p.coverLetterStyle?.rules || []).join(';')}`,
    // 📌 Lessons — 使用者抓過 AI 錯而存的學習,**強制遵守**,違反 = 嚴重錯誤
    (p.lessons || []).length ? `\n⚠️ Lessons(使用者從過去錯誤累積的硬規則,違反任何一條 = 嚴重錯誤,必須照做):\n${(p.lessons).map((l, i) => `[${i + 1}] ${l}`).join('\n')}` : '',
    // ⭐ Anchors — 使用者人工驗證過的好範例,寫新信時當 voice 校準參考
    (p.anchors || []).length ? `\n⭐ 已驗證範本(這是使用者親自審過 OK 的 cover letter,**新信的 voice / 風格 / 長度感** 要對齊這幾封,別偏離太遠):\n${(p.anchors).slice(0, 3).map((a, i) => `[範本 ${i + 1}${a.job_title ? ' / ' + a.job_title : ''}]\n"""${a.cover_letter}"""`).join('\n\n')}` : ''
  ].filter(Boolean).join('\n');
}

// 🤝 協商手冊 — 刻意獨立於 profileBrief,只在 replyPrompt 注入。
// (守範圍/議價語氣若混進 cover letter,提案會變得防衛、囉嗦,反而扣分)
function negotiationPlaybookBrief(p) {
  const plays = p.negotiationPlays || [];
  if (!plays.length) return '';
  return `\n🤝 協商手冊(實戰驗證過的回覆策略 — 當客戶議價/想擴範圍要你免費做/用模糊形容詞要你猜/貶低你的貢獻/該收尾時,**優先採用對應情境的措辭與判斷**:語氣溫和但有底氣,守住範圍與事實,任何超出已付範圍的東西一律「很樂意做,但是獨立報價的 milestone」):\n${plays.map((pb, i) => `[${i + 1}|${pb.situation}]${pb.note ? ' — ' + pb.note : ''}\n→ "${pb.phrasing}"`).join('\n')}`;
}

function jobBrief(job) {
  return [
    `標題:${job.title || ''}`,
    `預算:${job.budget_text || '未知'}|提案數:${job.proposals_bucket || '?'}|付款驗證:${job.payment_verified ? '是' : '否'}`,
    `客戶:花費 ${job.client_spent_text || '?'}、評分 ${job.client_rating ?? '無'}、聘用率 ${job.client_hire_rate ?? '?'}%`,
    `描述:${(job.description || '').slice(0, 2000)}`
  ].join('\n');
}

// ① 求職信(英文 cover letter) — 套 SOP 5 段結構 + 誠實提弱點
export function coverLetterPrompt(job, p) {
  const hasVideo = /video|loom|record/i.test(job.description || '');
  return `你是 Upwork 接案顧問。根據「我的檔案」與「這個職缺」,寫一封**英文 cover letter**。

我的檔案:
${profileBrief(p)}

職缺:
${jobBrief(job)}

【寫作 SOP — 嚴格遵守】
依案子訊號**精準**選長度(寧短勿長,雇主看不完就跳過):
- **預設用 120-180 字降風險結構**:① hook(依案變化:直接給解法 / 點出 JD 漏掉的細節 / 精準作品命中,**別每封都 "The core problem is..."**) ② I can help by: 3 個具體交付 ③ 一個最相關作品+真實 URL ④ 降風險:**fixed >$200** 提議小額試做、**小案 ≤$200 或時薪** 用「deliver in 24-48h」 ⑤ 一個具體問題 — 雇主在 100 個提案間滑,短而有力 > 長而完整
- 如果 JD 有 **"Please share" / "To Apply" 清單**(明確列 3-5 點要回答) → 用**中長版 200-350 字**,逐條對應 + 結尾 1-2 個誠實 bullet
- 套**長版 1500-2500 字符 5 段結構**的觸發條件(必須同時 ≥ 2 個):
  (a) JD 明確要求 Required Project / 12 點答案 / 自我介紹長版
  (b) JD 列 5+ 項技術或 6+ 項 responsibilities (極詳細的 JD)
  (c) Hourly rate ≥ $30 或 fixed budget ≥ $1000 (高預算才值得長提案)
  (d) JD 要錄影且要在 cover letter 同時答多項問題
- **小時薪 < $20 或預算 < $500 → 永遠用短版**,不要硬寫長

【5 段結構(複雜案才用)】
${hasVideo ? '[第 1 行] 📹 Video answers (3 questions, ~3 min): [LOOM_LINK_HERE]  ← 留 placeholder,使用者自己換\n\n' : ''}[第 1 段] 開場 hook (2-3 句):為什麼這案 = 我的真實工作流。**避免**「I am writing to express...」這類罐頭。

[第 2 段] 2-4 個 bullet 「選擇性誠實」清單(**寧少勿多**):
  ✅ **一定要提的**(只有以下 3 種):
    (a) 客戶會自己發現的差異 — 地區 / 時區不符 / 0 評價(profile 看得到)
    (b) JD 在 **Required** 區塊明確列、但你沒做過的核心技能 — 進面試會穿幫
    (c) JD 提到的陌生產品名 — 主動問「Cowork / Claude Design 是什麼?」= 顯得專業誠實
  ❌ **絕對不要提的**:
    (i) JD 寫 "Preferred" / "Nice to have" 但你沒有的 — 別主動降低自己
    (ii) 你只是經驗短於某數字 — 用作品完整度蓋過,別主動講數字
    (iii) 任何讓客戶懷疑你能不能交差的話(英文不好、還在學…)
  原則:「這個弱點他會自己發現嗎? 會就提,不會就閉嘴。」
  誠實是建立信任,不是自爆把對方推走。

[第 3 段] 2-3 個專案 highlights (• bullet 換行):
  • 名字 — 一句話描述 — 關鍵技術 — live URL (如果有)
  • 選最貼 JD 的、要有 live demo 加分

[第 4 段] How I actually use Claude (如果是 AI 相關案才寫):
  • 講具體做什麼,不要 buzzword
  • 例:「I shipped bilingual READMEs across 26 of my repos in one afternoon using sub-agents」這種具體數字
  • 結尾講「I read every diff before commit. Claude is a senior I pair with, not autocomplete.」

[第 5 段] 收尾:
  Ready to start. GitHub: github.com/${p.githubUser || 'username'}
  Harry

【嚴禁 placeholder】
- 草稿裡**絕對不能**出現 [PORTFOLIO_LINK]、[GITHUB_PROFILE]、[YOUR_NAME] 這類佔位符
- 真實連結:GitHub = github.com/${p.githubUser || 'Harry1667'}
- 真實作品 live URL 從下面 portfolio / provenCapabilities 取,沒有就只寫 GitHub repo
- 寧可不寫連結,也不要留 [PLACEHOLDER]

【風格守則】
- 像「真人資深工程師在跟客戶聊」,自然口語
- **禁用**:唯一精通、10x、靠 AI、vibe coder、game-changer、passion、I am confident、cutting-edge
- 開頭直接點到客戶具體情境(用他描述裡的真實細節)
- **誠實提弱點** ≫ 自吹自擂 — 雇主更信任會說「我沒做過 X 但...」的人

只輸出 cover letter 英文本文,不要中文說明、不要標題、不要引號、不要 markdown 圍欄。`;
}

// ①-A Writer A:Hook 派 — 開頭直接打最相關作品 / 技術 fit
export function coverLetterWriterA(job, p) {
  return `你是 Upwork 求職信 Writer A(Hook 派)。寫一封英文 cover letter,風格特色:**第一句話直接砸最強的對應作品/技術命中**,讓客戶 3 秒內知道你能幹這活。

我的檔案:
${profileBrief(p)}

職缺:
${jobBrief(job)}

風格要求:
- 開頭第一句 = 最強匹配作品 + 一句技術細節(例:"I built AgentsHub — multi-agent Claude/GPT orchestration with @mention turn-routing.")
- 不要客套話、不要"I am writing to express"
- 中段:2-3 個 bullet 列其他相關作品 + 真實 GitHub URL
- 結尾:一個專業具體的問題 + ready to start
- 字數:150-250 字
- **嚴禁** [PLACEHOLDER]、撒謊(沒做過的技術不要說做過)、浮誇詞(10x/cutting-edge)

只輸出英文 cover letter 本文。`;
}

// ①-B Writer B:誠實派 — 主動講弱點換信任
export function coverLetterWriterB(job, p) {
  return `你是 Upwork 求職信 Writer B(誠實派)。寫一封英文 cover letter,風格特色:**主動把弱點放在前段、把替代經驗放後面**,用「誠實但能補」建立信任。

我的檔案:
${profileBrief(p)}

職缺:
${jobBrief(job)}

風格要求:
- 開頭 1-2 句承認最大的缺口(JD Required 列但你沒做過的 / 陌生產品名 / 地區)
- 接著:「但我有 X 替代經驗,所以能快速上手」配 1-2 個真實作品證據
- 中段:列其他真實項目(GitHub URL 真實值)
- 結尾:**問一個顯示專業的具體技術問題**(不是「請告訴我更多」)
- 字數:150-250 字
- **選擇性誠實**:只提客戶會發現的(地區/0 評價/JD Required 缺口/陌生產品),不要自爆 Preferred 等級弱點

只輸出英文 cover letter 本文。`;
}

// ①-C Writer C:JD 鏡像派 — 完全照 JD 的 To Apply / 清單格式逐條答
export function coverLetterWriterC(job, p) {
  return `你是 Upwork 求職信 Writer C(JD 鏡像派)。寫一封英文 cover letter,風格特色:**找出 JD 裡的 "To Apply / Please share / Required" 清單,逐條對應**,客戶一眼看到「他問的我都答了」。

我的檔案:
${profileBrief(p)}

職缺:
${jobBrief(job)}

風格要求:
- 開頭 1 句點題:「To answer your 'To Apply' points directly:」
- 用 bullet / 短段落逐條對應 JD 的問題
- 真實作品要附 GitHub URL(github.com/${p.githubUser || 'Harry1667'}/repo-name)
- 結尾:一句誠實提示(新手 overdeliver / 地區) + ready
- 字數:200-350 字(允許比 A B 略長,因為要照清單答)
- **嚴禁** [PLACEHOLDER]、撒謊、客套

只輸出英文 cover letter 本文。`;
}

// ①-合成器:讀 3 個 writer 的 draft,挑各家最強 paragraph,組成最終版
export function coverLetterSynthPrompt(drafts, job, p) {
  return `你是嚴格的 Upwork 求職信總編輯。下面 3 位 writer 寫了同一個職缺的 cover letter。你的工作:
1) 評估 3 個版本的優缺點(在心裡判斷,不輸出評論)
2) **挑出每家最好的段落 / 句子 / 切入點**,合成一封最終版
3) 補上 3 家都漏掉的關鍵(JD 必答 / 真實 GitHub URL / 地區誠實)

職缺:
${jobBrief(job)}

我的檔案(真實證據):
${profileBrief(p)}

【Writer A — Hook 派】
"""${drafts.a || '(空)'}"""

【Writer B — 誠實派】
"""${drafts.b || '(空)'}"""

【Writer C — JD 鏡像派】
"""${drafts.c || '(空)'}"""

【最終版結構 — 預設用這個降風險結構(除非 JD 明確要 Required Project / 多題長答)】
**120-180 字**,降低客戶風險導向。
**開頭 hook 要「依這案變化」,別每封都用 "The core problem is..."(太像 AI bot,客戶在列表頁掃過就跳過)。從這幾種挑最自然的一種開場:**
  (a) 直接給解法:"I'd build this with Playwright + a retry layer that keeps the session alive…"
  (b) 點出 JD 裡別人會漏的細節:"The tricky part here is the SMS-OTP step — it needs…"
  (c) 精準的作品/技術命中:"I built exactly this — 29 scrapers behind one shared interface (api-dindon)."
  (d) 一句點出客戶要的結果(用他 JD 的字),不是你的頭銜
接著:
2. "I can help by:" + 3 個具體交付步驟(短 bullet)
3. 一個「最相關」的真實作品 + 為何相關(**只放一個**,附真實 GitHub URL,別堆清單)
4. 降風險(**看預算**):fixed **> $200** → 提議小額付費試做(small paid test / first milestone);**小案 ≤ $200 或時薪** → 用「I can deliver this in 24-48h」承諾即可(對小案硬提付費試做 = 像沒讀預算,別這樣)
5. 結尾一個針對此案的具體技術問題(邀請對方回覆)

最終版守則:
- 自然像「真人工程師在跟客戶聊」,真實 GitHub URL(github.com/${p.githubUser || 'Harry1667'}),禁 [PLACEHOLDER]
- 沒做過的技術不可撒謊;只提客戶會發現的弱點;**只主打一個作品,別堆技能/作品清單**
- 禁浮誇/罐頭詞(10x / vibe coder / perfect fit / cutting-edge / passionate / game-changer / I'm confident)、禁套版開頭
- 例外:JD 有 "To Apply / Please share" 清單 → 逐條答,字數放寬到 200-350;JD 要 Required Project / 12 點長答 → 才放長

只輸出最終版英文 cover letter 本文,不要中文、不要標題、不要任何評論。`;
}

// ①b 求職信自我批改 — 拿 draft 對照 SOP 5 段守則挑錯再改寫
export function coverLetterRefinePrompt(draft, job, p) {
  return `你是嚴格的 Upwork 求職信編輯。下面是一封給這個職缺的英文 cover letter 草稿。
請對照下面 SOP 守則逐項檢查,再輸出**改寫後的最終版**(只輸出英文本文,不要中文、不要標題、不要引號、不要列出問題):

【SOP 檢查清單 — 發現就修】
公式化/罐頭問題:
- 套版開頭("Your challenge is...", "I am excited to...", "I came across your job", "I am writing to express")→ 直接點客戶具體情境
- 浮誇詞(唯一精通、10x、靠 AI、vibe coder、game-changer、passion、I am confident、cutting-edge)→ 刪或換成具體事實
- 業務 tone、罐頭感、沒講到客戶真實細節 → 重寫得像真人工程師在聊

誠實度問題(**選擇性誠實**,不是全提):
- **絕不能藏的 3 種** → 必須加 bullet:
  (a) 客戶會自己發現的(地區 / 時區 / 0 評價) (b) JD Required 區塊列了但你沒做過的核心技能 (c) JD 提的陌生產品名(主動問)
- **絕不該自爆的** → 草稿如果寫了 *Preferred* 等級的弱點要刪掉:
  例如「I don't have RAG experience」「我只是經驗 1 年」「我英文不好」這種主動降低自己的話
- 假裝會 JD Required 列的技術但實際沒做過 → 改成誠實版「I haven't shipped X, but I have Y(替代經驗)」
- 但 JD 沒列的弱點絕對不要主動講

證據問題:
- 沒引用具體真實作品(repo / live URL) → 補
- 沒給具體做法/數字 → 加 (例:「shipped 26 bilingual READMEs in one afternoon」這種具體)
- 沒有 GitHub / live URL → 結尾補上

降低客戶風險 + 自然度(0 評價新手**必查**):
- 開頭是不是又用「The core problem is...」這種固定句? 是的話**換一種 hook**(直接給解法 / 點出 JD 漏掉的細節 / 精準作品命中),別每封都一樣像 AI。
- 有沒有「I can help by:」3 個具體交付步驟? 沒有就補。
- 降風險看預算:**fixed > $200** 要有「小額付費試做/第一里程碑」;**小案 ≤ $200 或時薪** 用「deliver in 24-48h」即可(別對小案硬塞付費試做,像沒讀預算)。
- 是不是只主打「一個」最相關作品? 堆了一長串就砍到一個。

長度問題(預設精簡):
- **預設目標 120-180 字**,降風險結構(客戶問題 → 3 交付 → 1 作品 → 小額試做 → 1 問題),雇主滑 100 個提案要看得完
- JD 有 "To Apply / Please share" 清單 → 逐條答,放寬到 200-350 字
- 只有當 JD 明確要求多項回答(Required Project + 12 點 / 影片題又要寫長文) + 高預算時,才擴成長版 5 段
- **小時薪 < $20 或預算 < $500 → 壓到 120 字內**

影片題:
- JD 要錄影片但 draft 沒放 Loom 連結 → 第一行加 "📹 Video answers: [LOOM_LINK_HERE]" (這個 placeholder 是 ok 的,因為使用者會自己錄完再換)
- 其他 placeholder 例如 [PORTFOLIO_LINK]、[GITHUB_PROFILE]、[YOUR_NAME] **絕對禁止** → 直接換成真實值:
  GitHub = github.com/${p.githubUser || 'Harry1667'}
  Live URL 從 portfolio 取,沒有就只寫 GitHub repo

JD To Apply 清單問題:
- 如果 JD 有「Please share / To Apply」這種清單(列出要回答 3-5 點),draft 沒逐條對應 → 改成清單式答 4-6 條 + 結尾誠實 bullet,字數放寬到 200-350 字

職缺:
${jobBrief(job)}

我的真實作品(引用要真實):
${(p.provenCapabilities || []).slice(0, 8).map((c) => `- ${c.repo}:${c.capability}`).join('\n') || (p.portfolio || []).map((x) => `- ${x.name}:${x.desc}`).join('\n')}

草稿:
"""${String(draft).slice(0, 2500)}"""

只輸出改寫後的英文 cover letter 本文。`;
}

// ② 投標策略 — 對齊 Upwork 提案表單真正要填的欄位 + 偵測「特殊投標要求」
// ①c 依「驗證發現」精準修正 — 不重寫整封,只修被 verify/preflight/skeptic 抓到的高風險問題。
// issues = 後端把 contradicted 主張 / broken SOP 規則 / high-severity 批判彙整成的字串。
export function coverLetterFixPrompt(draft, job, p, issues) {
  return `你是 Upwork 求職信的事實與品質修正員。下面是一封英文 cover letter,以及驗證層抓到的「高風險問題清單」。
請只修正清單上的問題(及其直接牽連的句子),其餘文字、語氣、結構、長度盡量保留——這是精準修正,不是重寫。

最高原則:
- 🚨 捏造/矛盾的主張(profile 根本沒有的經歷/技術/數字/地區)→ 刪掉,或改成 profile 真有的誠實版本。寧可少講,絕不說謊。
- ❌ SOP 違規(套版開頭/浮誇詞/主動自爆 Preferred 弱點/缺降風險步驟)→ 照指示修。
- ⚠️ 高風險批判 → 採納修正建議。
- 不要新增任何 profile 沒有的事實來「補強」;修正只能往「更誠實、更貼合」走。

【高風險問題清單】
${issues}

【我的真實 profile(修正只能引用這裡有的)】
${(p.provenCapabilities || []).slice(0, 8).map((c) => `- ${c.repo}:${c.capability}`).join('\n') || (p.portfolio || []).map((x) => `- ${x.name}:${x.desc}`).join('\n')}

【職缺】
${jobBrief(job)}

【草稿】
"""${String(draft).slice(0, 3000)}"""

只輸出修正後的英文 cover letter 本文,不要中文、不要標題、不要引號、不要列出你改了什麼。`;
}

export function advicePrompt(job, p) {
  const gh = p.githubUser ? `https://github.com/${p.githubUser}` : '';
  // 用完整描述(投標要求/影片題/指定專案常在描述最後,別截斷)
  const fullJob = [
    `標題:${job.title || ''}`,
    `預算:${job.budget_text || '未知'}|提案數:${job.proposals_bucket || '?'}|付款驗證:${job.payment_verified ? '是' : '否'}`,
    `客戶:花費 ${job.client_spent_text || '?'}、評分 ${job.client_rating ?? '無'}、聘用率 ${job.client_hire_rate ?? '?'}%`,
    `完整描述:\n${(job.description || '').slice(0, 4000)}`
  ].join('\n');
  const win = job.ai_win != null ? `${job.ai_win}%` : '未估';
  return `你是 Upwork 接案顧問。根據「我的檔案」和「這個職缺的完整描述」,產出投標要填的內容。
**特別注意**:仔細讀描述裡的「To Apply / Required / 申請方式 / 篩選問題」段落 —— 很多案有特殊投標要求(要錄影片回答、要按指定格式寫一個專案說明、要回答特定問題、地點/資格偏好)。**務必抓出來,別讓使用者漏掉**。

【🚦 新手能見度評分(關鍵)— 從職缺描述抓 Activity 段算】
這是 0 評價新手最關鍵的判斷,因為投了沒人看 = 燒 Connects 等於白燒。從描述找:
- "Proposals" 數(<10 / 10-30 / 30-50 / 50+)
- "Interviewing" 數(0 / 1-5 / 6-10 / 11+)  ← 11+ 等於客戶已選候選,新手投幾乎不被看到
- "Invites sent" 數
- Boost bid 排行(1st 名要多少 Connects?如果 >100 表示對手願燒錢)
- "Last viewed by client" 時間

對 0 評價新手的硬規則:
- Interviewing ≥ 6 → 可見度「極低」,新手不投除非 cover letter 超強差異化
- Proposals 50+ AND Boost 1st ≥ 100 Connects → 紅海,新手別燒
- Proposals < 10 AND Interviewing 0 → 可見度「高」,優先投
- 沒提到 Activity 資訊 → 可見度「中,建議在 Upwork 補看」

【此案估計中標率:${win}】先用這個務實判斷:
- 中標率低(<40%)→ winStrategy 要老實說「值不值得燒 Connects」+「唯一可能贏的差異化打法(沒有就建議略過)」。
- 中標率中(40-60%)→ 給「怎麼提高勝算」的具體一招。
- 中標率高(≥60%)→ 給「怎麼穩拿、別搞砸」的提醒。

除了 recentExperience / screeningDraft / videoScripts 的可貼內容用**英文**,其餘用**繁體中文**。只輸出 JSON:
{
 "showPortfolio":["主打哪 1-2 個作品 + 一句原因(SOP 排序:第 1 個一定要有 live URL + 最貼 JD;優先 provenCapabilities)"],
 "screenshot":"建議附哪張作品截圖(1句,指名作品/畫面)",
 "recentExperience":"英文段落(3-4句),貼進『Describe your recent experience』:引用 2-3 真實作品+技術,專業像真人,禁用 vibe coder/靠AI/10x",
 "githubLink":"${gh}",
 "profileHighlights":["挑 4 個最貼合的能力標籤(每個≤6字),排序:第 1 個最強最相關,最後 1 個補不同技術棧"],
 "bid":"報價建議,務必分兩段:(1)『新手搶單價』= 實際該 bid 的數字(${p.level || '0 評價新手'},貼近客戶預算或略高,$15 以下不建議會被當業餘)。(2)『有評價後的合理價』= 客觀值多少。比較客戶預算 vs profile rate $${p.hourlyRate || 20},一句話為何這樣報",
 "connectsBid":"Upwork Connects 競標建議(繁中 1 句):查 JD 旁的 bid 表 — 1st 位通常 50+ Connects 太貴新手不投;**建議 12-15 Connects 搶 2nd 位**(CP 最高);競爭少的爛單可 0 boost。例如:『建議 12 Connects 搶 2nd 名,1st 名 51 太貴』",
 "angle":"切入角度/差異化(1句)",
 "winStrategy":"根據上面中標率的務實建議(1-2句,繁中):低→值不值得投+差異化或略過;中→提高勝算一招;高→穩拿提醒",
 "visibility":"從 Activity 段抓出 4 個數字並評可見度(繁中):格式『Proposals X · Interviewing Y · Boost 1st Z Connects · 評級:極低/低/中/高』。如果 Interviewing ≥ 6 或 Boost 1st ≥ 100 → 加一句『新手不建議投,燒 Connects 無回報』。沒抓到資料就回『未提供,建議去 Upwork 查 Activity』",
 "applyRequirements":["這案的特殊投標要求,逐條短列(繁中,每條≤30字)。**重點偵測**:Required Video Questions(幾題、各題大綱)、Required Project + 多少 bullet(常見 12 點)、地區/經驗等級偏好、其他客戶自訂 screening。沒特殊要求回空陣列"],
 "videoScripts":["如果 JD 要錄影,**每題各給一段英文講稿大綱**(每段 30-100 字),套 SOP 標準回答模板:Q1 自我介紹用『Taiwan / CS background / Claude Code daily / 29 repos / new on Upwork → overdeliver』。Q2 依問題客製,但講具體做法+數字。Q3 工時用『30-40 hrs/week sustained / UTC+8 flexible / priority list』。沒影片題回空陣列"],
 "requiredProjectAnswer":"如果 JD 要求『describe one project』類的 Required Project 答案(尤其列 12 點細節),**回 1 段繁中告訴使用者**:『建議獨立寫一份 .md 當附件,主打 AgentsHub(最強全端 + Claude 範例)。12 點是:short desc / what built / frontend / backend / complexity / UI strength / Claude tools / how used / AI-assisted / your reviews / time / time with Claude Code』。沒要求回空字串"
}

我的檔案:
${profileBrief(p)}

職缺:
${fullJob}
只輸出 JSON,不要任何多餘文字。`;
}

// ②b 篩選問題作戰區 — 抽出 Upwork screening questions,逐題草擬答案 + 用硬門檻判斷要不要投
export function screeningPrompt(job, p) {
  const full = [
    `標題:${job.title || ''}`,
    `預算:${job.budget_text || '未知'}|提案數:${job.proposals_bucket || '?'}`,
    `完整描述:\n${(job.description || '').slice(0, 6000)}`
  ].join('\n');
  return `你是 Upwork 提案教練。下面是職缺完整內容。請找出客戶的「篩選問題 / Screening Questions」——
常見標題:"You will be asked to answer the following questions"、"Answer the following"、或編號問句清單(1. 2. 3.)。
這些問題既是投標必填、也是判斷「要不要投」的關鍵(常含 key criteria / must / do not apply / 100% 這種硬門檻)。

逐題判斷時,務必對照下方「我的能力與邊界」**誠實**評估,特別注意這類硬門檻:
- 「能不能自己寫 code(不只是 n8n/AI/自動化)」
- 「能不能 24 小時內支援/修 bug」
- 「是否從零打造過、自己想出解法而不只是照指令 coding」
不符合就老實說不符合,並反映在 overall;不要硬凹。

只輸出 JSON,不要 markdown 圍欄:
{
 "hasQuestions": true/false,
 "overall": "建議投 / 謹慎評估 / 不建議投",
 "overallNote": "一句繁中:綜合這些硬門檻,你符不符合、該不該投、為什麼",
 "questions": [
   {
     "q": "問題原文(英文照抄,精簡)",
     "hard": true/false,
     "meet": "符合 / 勉強符合 / 不符合",
     "answer": "可直接貼的英文答案(誠實、具體、引用真實作品;符合就自信作答,不符合就給最誠實但仍積極的講法,別說謊)",
     "note": "繁中提醒:這題的陷阱 / 怎麼答較好 / 為何符不符合"
   }
 ]
}
若完全找不到篩選問題,回 {"hasQuestions":false,"overall":"","overallNote":"此 JD 未含篩選問題(或你貼的內容未涵蓋提案表單那段)","questions":[]}。

我的檔案與能力邊界:
${profileBrief(p)}

職缺完整內容:
${full}
只輸出 JSON。`;
}

// ⑤ 主動邀請(Invites from clients)分析 — 三層評判 + 套能力邊界 + 最終建議
export function invitePrompt(invite, p) {
  const clientBits = [
    invite.client_spent_text ? `花費 ${invite.client_spent_text}` : '',
    invite.client_hires != null ? `${invite.client_hires} hires` : '',
    invite.client_payment_verified ? '付款已驗證' : '',
    invite.client_invites_sent != null ? `此案已發 ${invite.client_invites_sent} 個邀請(>20=廣撒網)` : ''
  ].filter(Boolean).join(' | ') || '(未提供)';
  const ctx = [
    `案件標題:${invite.title || '(未提供,從原文判斷)'}`,
    `收到時間:${invite.received_text || invite.received_at || '(未提供)'}`,
    `客戶數據:${clientBits}`,
    `邀請/案件原文:\n"""${(invite.raw_text || '').slice(0, 4000)}"""`
  ].join('\n');
  return `你是 Upwork 接案顧問。客戶「主動邀請」我投這個案,幫我判斷值不值得認真寫提案、或乾脆 archive。

**三層評判框架(務必依序判斷)**
🟢 第一層 客戶品質:看花費、hires、付款驗證、hire rate。注意 hires 超高(>1000)是雙面刃 → 可能是大型外包公司、案子規格化、單價低、競爭多。
🟡 第二層 案子契合度:跟我的「能力邊界」對比。命中紅線、命中 cantDo、或要求我沒有的硬技能(語言、地區、特定證照) → 直接 decline,別浪費 connects 和 JSS。
🔴 第三層 邀請真實性:Invites sent >20 等於公開職缺、不是真邀請;客戶 hire rate 低 = 廣撒網不認真請人;剛發案就邀我 = 演算法配對不是客戶選我。

**最終建議只能四選一**:
- "認真寫提案":三層都過、契合度高 → 立刻寫
- "可投但別重壓":契合 OK 但客戶/真實性有疑慮 → 寫但別 Boost
- "禮貌 decline":有硬不符(紅線/語言/地區/cantDo) → decline + 一句理由保護 invite response rate
- "Archive":垃圾邀請/廣撒網/規格不符 → 直接 archive

只輸出 JSON,不要 markdown 圍欄:
{
 "score": 0-10 數字(綜合分,8+=認真寫,5-7=可投別重壓,3-4=decline,<3=archive),
 "recommendation": "認真寫提案 / 可投但別重壓 / 禮貌 decline / Archive" 四選一,
 "clientQuality": {"verdict":"優/中/差","note":"一句繁中說明"},
 "fitness": {"verdict":"高/中/低/不符","note":"一句繁中,有硬不符直接點出(例:案子要 Hokkien 但我不會)"},
 "authenticity": {"verdict":"真邀請/疑似廣撒網/演算法配對","note":"一句繁中說明"},
 "redFlags": ["逐條短列紅旗,沒有就空陣列"],
 "declineMessage": "若 recommendation 是 decline,給一句可直接貼的英文 decline 訊息(禮貌、簡短、給理由);否則空字串",
 "action": "繁中 1-2 句:下一步具體要做什麼(去寫提案/去 decline/直接 archive,以及為什麼)"
}

我的檔案與能力邊界:
${profileBrief(p)}

這個邀請:
${ctx}
只輸出 JSON。`;
}

// ③ 客戶訊息回覆助手(繁中思路 + 英文回覆)
export function replyPrompt(clientMessage, job, p, tone) {
  const ctx = job ? `\n相關職缺:\n${jobBrief(job)}\n` : '';
  return `你是 Upwork 接案溝通顧問。客戶傳來一則訊息,幫我擬回覆。
${ctx}
我的檔案:
${profileBrief(p)}
${negotiationPlaybookBrief(p)}
客戶訊息:
"""${(clientMessage || '').slice(0, 2000)}"""

語氣:${tone || '專業友善'}。
只輸出 JSON:{"reply":"英文回覆(可直接貼,專業、具體、若客戶問問題要答到點,結尾推進對話)","tips":["繁體中文提醒1-3條:回這則訊息要注意什麼/有沒有陷阱"]}
只輸出 JSON。`;
}

// ④ 接案助手聊天 — 帶入「我的檔案」+「目前案件清單」+「使用者此刻在哪/看哪個案」當上下文
export function chatPrompt(messages, p, jobs, contextNote = '', toolDocs = '') {
  const jobLine = (j) => {
    const ai = j.ai_score != null;
    const sv = ai ? `${j.ai_score}/10 ${j.ai_verdict || ''}` : `${j.total_score}/100 ${j.verdict}`;
    return `- [${j.id}] ${j.title} | ${sv} | 預算${j.budget_text || '?'} | 提案${j.proposals_bucket || '?'}`;
  };
  const jobsCtx = (jobs || []).map(jobLine).join('\n') || '(目前無案件)';
  const convo = (messages || []).map((m) => `${m.role === 'user' ? '使用者' : '助手'}:${m.content}`).join('\n\n');
  return `你是這位 Upwork 自由工作者的私人接案助手。用繁體中文回答(要產生的英文文案就給英文)、口語、精簡。可以:解讀案子、給投標/報價/溝通建議、想策略、回答任何問題。需要時引用下面的案件清單。誠實,不確定就說不確定。

【輸出格式 — 重要】你的回覆顯示在純文字聊天泡泡裡,不會渲染 markdown。所以:
- 不要用 markdown 符號(不要 **粗體**、不要 # 標題、不要 \`code\`)。要強調就用「」或直接寫。
- 引用案子用「標題」,不要印出 job id(那串數字使用者看不懂)。
- 條列用「•」或「1. 2. 3.」,保持乾淨好讀。

【投案 SOP — 提案工作台核心心智模型】
當使用者貼上一個職缺/apply 頁面內容,或要你幫他投某個案,**先做 Step 0 守門,過關才走 1-9 寫提案**:

Step 0 【該不該投 — 你是守門員,不是啦啦隊。最重要,先做!】
使用者通常是「找到他覺得好的案來問你」——但「契合」不等於「值得投」。你的第一個工作是**誠實判該不該投,不是直接寫提案**。先看(或要他從貼上的頁面提供):貼出多久、Proposals 數、Interviewing 數、經驗等級、預算。命中任一 🔴 → **明講「這個別投」+ 為什麼,而且不要寫提案**(除非他看完理由仍堅持):
  • 貼出 > 24 小時,或 Interviewing ≥ 3(客戶已在面試,你晚到、提案沉底,連看都不會被看)
  • Proposals 50+(紅海,0 評價搶不到前段)
  • 經驗等級 Expert 且他仍 0 公開評價 —— 除非小案 + 提案 <10 + 付款驗證 + 客戶有花費
  • 核心需求是他的紅線/沒實戰:ManyChat / n8n / Make / Zapier / GoHighLevel / WordPress / 純行銷或銷售/資料標註錄音
  • JD 明列 must-have 他完全沒有(例:必須有 Streamlit 作品、JSS ≥ 90%、特定平台經驗)
  • 時薪 < $20 或 fixed < $200(虧本單)
  回他大意:「這個別投,因為 X。把 Connects 留給『新鮮(<24h)+ 提案 <10 + 你贏得了』的案——那種客戶還在看、你排得進前面。」
  🟢 過關(新鮮、競爭可控、契合、價格 OK)才往下走 Step 1-9。
  心法:他 Connects 有限、0 評價搶不過老手。幫他「少投、投對、早投」才是幫他;對贏不了的案寫一堆漂亮提案,是害他燒 Connects、還換來「沒人看」。

Step 1 客戶體檢:Payment verified / 評分 ≥ 4.5 / Hire rate ≥ 30% / 平均時薪 / 描述清晰。紅燈 ≥ 2 個 → 勸他別投。

Step 2 強弱對照:把 JD 技術逐條標 ✅/❌/⚠️。✅ < 60% 就勸退。弱點要**主動誠實提**,不要藏。

Step 3 策略:rate 不要低於 $15(會被當業餘);Connects bid **建議 12-15 搶 2nd 位**,1st 位 50+ 太貴新手不投。

Step 4 Cover Letter(複雜案套 5 段結構):
  [1] hook 2-3 句點客戶具體情境
  [2] 4 個誠實 bullet:地區/時區 / 強項 / 弱項主動提+替代經驗 / 新手 overdeliver
  [3] 2-3 個 projects(有 live URL 的優先)
  [4] How I use Claude(具體做法+數字,不要 buzzword)
  [5] Ready to start + GitHub 連結
  簡單案就 70-150 字短版。

Step 5 Required Project(如果 JD 要求 12 點):勸他獨立寫 .md 當附件,主打最強全端專案。

Step 6 影片題(如果 JD 要求 Video Questions):必錄,不錄自動 disqualified。3 題標準回答:
  Q1 自我介紹 30-40 秒:Taiwan/CS/Claude Code 每天/29 repos/新手 overdeliver
  Q2 客製問題 60-90 秒:講具體做法+數字
  Q3 工時 30 秒:30-40 hrs/week / UTC+8 flexible / priority list
  Loom 連結放 cover letter 第一行。

Step 7 Portfolio 4 個排序:第 1 個一定要有 live URL + 最貼 JD。

Step 8 提交前 checklist:Loom 連結用無痕視窗測過、沒留 [PLACEHOLDER]、Required Project 附件已上傳、bid 12 不是 51。

Step 9 提交後:截圖存證、馬上投下一案、別刷 Upwork 等通知。

【文案風格守則】
- 像「真人資深工程師在跟客戶聊」,自然、具體、講客戶的問題與你的做法
- **嚴禁**:套版開頭("Your challenge is...", "I am writing to express...")、浮誇詞(唯一精通、10x、靠 AI、vibe coder、game-changer、passion、I am confident、cutting-edge)
- **🎯 開頭前 2 句鐵則(最關鍵 — 客戶列表預覽只看得到這 2 句)**:第一句永遠是「你的具體問題 + 我做過最貼的證據」。**絕不**在開頭放弱點、「我是新人/0 評價」、「我沒做過 X 但…」、「While X isn't my top skill…」——開頭放弱點 = 自我了結,客戶看兩行就跳過。誠實該講,但**放中段 bullet,不放開頭**。
- **選擇性誠實 ≫ 自吹也 ≫ 自爆**:
  必提:(a) 客戶會自己發現的(地區/0 評價) (b) JD Required 列但你沒做過的 (c) 陌生產品名主動問
  禁提:Preferred 等級的弱點、經驗年數短、英文不好、還在學
  原則:「他會自己發現嗎? 會就提,不會就閉嘴」誠實是建信任,不是把對方推走
  位置:必提的誠實放「中段 bullet」,**永遠不放第一句**
- 真實細節 ≫ 抽象描述。「26 READMEs in one afternoon」勝過「I use AI efficiently」
- 影片磕絆 ≫ 業務 tone — 真人感是新手優勢
- 第一個 5★ ≫ 高單價 — 前 2 單 overdeliver 換 rating
- 不確定 JD 提的東西(如 "Claude Design" 不存在的產品) → 教他主動誠實問,不要假裝懂

【實操】當他要寫某欄位:
1. 先列出這案實際要填的所有欄位(Cover Letter、recent experience、screening、影片題、Required project、附件)
2. 每欄給「可直接貼」的草稿(英文給英文)
3. 嫌太業務/太長/語氣怪 → 直接改,來回修到滿意
${toolDocs ? `\n【🛠️ 你能執行的動作 — 重要】\n${toolDocs}\n` : ''}${contextNote ? `\n【使用者此刻的位置 — 優先針對這個情境回答】\n${contextNote}\n` : ''}
【他的檔案】
${profileBrief(p)}

【目前案件清單(依分數排序,供你參考)】
${jobsCtx}

【對話紀錄】
${convo}

助手:`;
}

// 從 AI 回應抽 JSON(寬容)
export function extractJson(s) {
  let t = String(s).trim();
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (f) t = f[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
