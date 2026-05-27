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

// 把檔案濃縮成 prompt 用的文字
function profileBrief(p) {
  const port = (p.portfolio || []).map((x) => `- ${x.name}(${x.type}):${x.desc}`).join('\n');
  // Profile Agent 從 GitHub 歸納的「真實 repo 證據」— 求職信優先引用這些(有實作可佐證)
  const proven = (p.provenCapabilities || [])
    .map((c) => `- ${c.repo}:${c.capability}${c.url ? `(${c.url})` : ''} [${(c.techs || []).join('/')}]`)
    .join('\n');
  // 能力邊界(可交付項目 + 能做/不做)— 讓 AI 判斷案子在不在能力圈、別承諾做不到的事
  const capSkills = (p.capability?.skills || [])
    .map((s) => {
      const bits = [`${s.name}(深度${s.level}/5)`];
      if (s.canDo) bits.push(`能做:${s.canDo}`);
      if (s.cantDo) bits.push(`不做:${s.cantDo}`);
      return `- ${bits.join(';')}`;
    })
    .join('\n');
  const redlines = (p.capability?.redlines || []).join('、');
  const capBrief = capSkills
    ? `我的可交付能力與邊界:\n${capSkills}${redlines ? `\n絕不接(紅線):${redlines}` : ''}${p.capability?.scaleCeiling ? `\n規模上限:${p.capability.scaleCeiling}` : ''}`
    : '';
  return [
    `姓名:${p.name || ''}`,
    `定位:${p.title || ''}|等級:${p.level || ''}|時薪:$${p.hourlyRate || '?'}`,
    `自介:${p.bio || ''}`,
    `技能:${(p.skills || []).join(', ')}`,
    capBrief,
    `作品集:\n${port}`,
    proven ? `已證明能力(GitHub 真實 repo,優先當證據):\n${proven}` : '',
    `求職信規則:${(p.coverLetterStyle?.rules || []).join(';')}`
  ].filter(Boolean).join('\n');
}

function jobBrief(job) {
  return [
    `標題:${job.title || ''}`,
    `預算:${job.budget_text || '未知'}|提案數:${job.proposals_bucket || '?'}|付款驗證:${job.payment_verified ? '是' : '否'}`,
    `客戶:花費 ${job.client_spent_text || '?'}、評分 ${job.client_rating ?? '無'}、聘用率 ${job.client_hire_rate ?? '?'}%`,
    `描述:${(job.description || '').slice(0, 2000)}`
  ].join('\n');
}

// ① 求職信(英文 cover letter)
export function coverLetterPrompt(job, p) {
  return `你是 Upwork 接案顧問。根據「我的檔案」與「這個職缺」,寫一封**英文 cover letter**。

我的檔案:
${profileBrief(p)}

職缺:
${jobBrief(job)}

要求:嚴格遵守上面的求職信規則,並特別注意:
- 像「真人資深工程師在跟客戶聊」,自然口語,不要套版、不要公式化開頭(別用 "Your challenge is..." 這種開場)。
- 禁用浮誇/空話:唯一精通、10x、靠AI、vibe coder、game-changer、passion。
- 開頭直接點到這個客戶的具體情境(用他描述裡的真實細節),不要泛泛。
- 用 1 個最相關的真實作品當證據(具體技術),給具體做法,結尾問一個好回答的問題。70-110 字。
只輸出 cover letter 英文本文,不要任何中文說明、不要標題、不要引號。`;
}

// ② 投標策略 — 對齊 Upwork 提案表單真正要填的欄位 + 偵測「特殊投標要求」
export function advicePrompt(job, p) {
  const gh = p.githubUser ? `https://github.com/${p.githubUser}` : '';
  // 用完整描述(投標要求/影片題/指定專案常在描述最後,別截斷)
  const fullJob = [
    `標題:${job.title || ''}`,
    `預算:${job.budget_text || '未知'}|提案數:${job.proposals_bucket || '?'}|付款驗證:${job.payment_verified ? '是' : '否'}`,
    `客戶:花費 ${job.client_spent_text || '?'}、評分 ${job.client_rating ?? '無'}、聘用率 ${job.client_hire_rate ?? '?'}%`,
    `完整描述:\n${(job.description || '').slice(0, 4000)}`
  ].join('\n');
  return `你是 Upwork 接案顧問。根據「我的檔案」和「這個職缺的完整描述」,產出投標要填的內容。
**特別注意**:仔細讀描述裡的「To Apply / Required / 申請方式 / 篩選問題」段落 —— 很多案有特殊投標要求(要錄影片回答、要按指定格式寫一個專案說明、要回答特定問題、地點/資格偏好)。**務必抓出來,別讓使用者漏掉**。

除了 recentExperience / screeningDraft / videoScripts 的可貼內容用**英文**,其餘用**繁體中文**。只輸出 JSON:
{
 "showPortfolio":["主打哪 1-2 個作品 + 一句原因(優先用『已證明能力』真實 repo)"],
 "screenshot":"建議附哪張作品截圖(1句,指名作品/畫面)",
 "recentExperience":"英文段落(3-4句),貼進『Describe your recent experience』:引用 2-3 真實作品+技術,專業像真人,禁用 vibe coder/靠AI/10x",
 "githubLink":"${gh}",
 "profileHighlights":["挑 4 個最貼合的能力標籤(每個≤6字)"],
 "bid":"報價建議,務必分兩段給:(1)『新手搶單價』= 實際該 bid 的數字(關鍵:使用者是 ${p.level || 'Upwork 新手, 0 評價'},就算這活值更多,0 評價新手報太高幾乎贏不了 → 報價要務實、貼近客戶預算或略高,目標是先拿下第一個 5 星;不要建議贏不了的高價)。(2)『有評價後的合理價』= 這活客觀值多少(供日後參考)。比較客戶預算 vs 我的 profile rate $${p.hourlyRate || 20},一句話講清楚為何這樣報",
 "angle":"切入角度/差異化(1句)",
 "applyRequirements":["這案的特殊投標要求,逐條短列(繁中,每條≤30字)。例:需錄3段影片回答(自我介紹/如何用Claude/工時)、需按指定格式寫一個專案說明、客戶偏好地點印尼(僅優先非硬性,台灣時區仍可投)。沒有特殊要求就回空陣列。只列出『要求是什麼』,不要寫長篇草稿"]
}

我的檔案:
${profileBrief(p)}

職缺:
${fullJob}
只輸出 JSON,不要任何多餘文字。`;
}

// ③ 客戶訊息回覆助手(繁中思路 + 英文回覆)
export function replyPrompt(clientMessage, job, p, tone) {
  const ctx = job ? `\n相關職缺:\n${jobBrief(job)}\n` : '';
  return `你是 Upwork 接案溝通顧問。客戶傳來一則訊息,幫我擬回覆。
${ctx}
我的檔案:
${profileBrief(p)}

客戶訊息:
"""${(clientMessage || '').slice(0, 2000)}"""

語氣:${tone || '專業友善'}。
只輸出 JSON:{"reply":"英文回覆(可直接貼,專業、具體、若客戶問問題要答到點,結尾推進對話)","tips":["繁體中文提醒1-3條:回這則訊息要注意什麼/有沒有陷阱"]}
只輸出 JSON。`;
}

// ④ 接案助手聊天 — 帶入「我的檔案」+「目前案件清單」+「使用者此刻在哪/看哪個案」當上下文
export function chatPrompt(messages, p, jobs, contextNote = '') {
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

【你是提案工作台 — 很重要】
當使用者貼上一個職缺/apply 頁面內容,或要你幫他投某個案:
1. 先列出「這個 apply 實際會要他填的每一個欄位/問題」(只列這案真的有的:Cover Letter、Describe your recent experience、客戶自訂的篩選問答、影片題、Required project、附件… 別列這案沒有的)。
2. 為每一欄寫一份「可直接貼」的草稿(英文文案給英文),用下面的「求職信風格規則」,引用他的真實作品/已證明能力當證據。
3. 文案要像「真人資深工程師在跟客戶講話」:自然、具體、講客戶的問題與你的做法。**嚴禁**:公式化開頭(別都 "Your challenge is...")、浮誇詞(唯一精通、10x、靠 AI、vibe coder)、空泛吹捧。
4. 他嫌「太業務感/太長/語氣怪」就直接改,來回修到他滿意。
${contextNote ? `\n【使用者此刻的位置 — 優先針對這個情境回答】\n${contextNote}\n` : ''}
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
