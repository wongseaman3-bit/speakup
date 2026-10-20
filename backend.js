/* DSE_BACKEND — 由 GitHub 自動載入嘅後端程式（唔好喺度放 API Key）*/
(function (CONFIG) {

/***** ② AI 模型優次（按次序嘗試；用完額度或出錯就自動轉下一個）*****
 * rpm / rpd = Google AI Studio 免費額度（每分鐘 / 每日請求數），按你截圖填寫。
 * 每日額度喺美國太平洋時間零晨（香港時間下午 3–4 時）重置。                    */
const MODELS = {
  'gemini-3.8-flash':      { rpm: 5,  rpd: 20,    audio: true,  json: true, think: 'level'  },
  'gemini-3.6-flash':      { rpm: 5,  rpd: 20,    audio: true,  json: true, think: 'level'  },
  'gemini-3-flash-preview':{ rpm: 5,  rpd: 20,    audio: true,  json: true, think: 'level'  },
  'gemini-3.5-flash-lite': { rpm: 15, rpd: 500,   audio: true,  json: true, think: 'level'  },
  'gemini-3.1-flash-lite': { rpm: 15, rpd: 500,   audio: true,  json: true, think: 'level'  },
  'gemma-4-31b-it':        { rpm: 30, rpd: 14400, audio: false, json: false },
  'gemma-4-26b-a4b-it':    { rpm: 30, rpd: 14400, audio: false, json: false }
};
const ROUTES = {
  // 錄音評分：先用質素最好嘅 Flash（每日少量），用完轉 Flash-Lite（每日 500 次 ×2）
  audio: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
          'gemini-3-flash-preview'],   // 3 Flash 常出現 503（Google 伺服器繁忙），放最後做後備
  // 範文 / 討論指引（會快取，每題只生成一次）：Gemma 4 額度最大，留返 Flash 畀錄音評分
  content: ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  // 背景建立範文庫：只用 Gemma（額度最大），唔會用到錄音評分嘅 Flash 額度
  build: ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'],
  // 查生字：快而便宜
  quick: ['gemma-4-26b-a4b-it', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemma-4-31b-it']
};
/***** ③ 真人發音（女聲，英式口音）：先用 Chirp 3 HD，用完每月免費額度自動轉 WaveNet，再轉 Standard *****/
const TTS_TIERS = [
  { id: 'chirp',    name: 'Chirp 3 HD', voice: 'en-GB-Chirp3-HD-Aoede', lang: 'en-GB', free: 1000000 },
  { id: 'wavenet',  name: 'WaveNet',    voice: 'en-GB-Wavenet-A',       lang: 'en-GB', free: 4000000 },
  { id: 'standard', name: 'Standard',   voice: 'en-GB-Standard-A',      lang: 'en-GB', free: 4000000 }
];
const TTS_SAFETY = 0.97;   // 用到免費額度 97% 就轉下一級，避免收費
/***** 設定區完 *****/


/* ============ ① 登入頁（「登入部署」：執行身分＝我；存取＝網域內所有使用者）============ */
function doGet(e) {
  if (e && e.parameter && e.parameter.status) return json_(status_());
  if (e && e.parameter && e.parameter.ping) return json_({ ok: true, app: 'dse-speaking', version: 7, hasKey: getKeys_().length > 0, time: new Date() });
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) return msgPage_('未能識別帳戶', '請用學校 Google 帳戶登入瀏覽器，再重新打開此連結。');
  const stu = findStudent_(email);
  if (!stu && !CONFIG.ALLOW_ALL_IN_DOMAIN) return msgPage_('未在名單內', esc_(email) + ' 不在學生名單內，請聯絡英文老師。');
  const profile = stu || { email: email, name: email.split('@')[0], cls: '' };
  log_(profile, '登入', '', '', '');
  const front = cfg_('FRONTEND_URL'), apiUrl = cfg_('API_URL');
  if (!front || !apiUrl) return msgPage_('系統未完成設定', '老師請喺 Code.gs 填好 FRONTEND_URL 及 API_URL，然後執行一次 setup。');
  const url = front + '#t=' + encodeURIComponent(makeToken_(email)) + '&api=' + encodeURIComponent(apiUrl);
  const html = '<!doctype html><html><head><meta charset="utf-8"><base target="_top"><style>' +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f1e7;font-family:-apple-system,"PingFang HK","Noto Sans TC",sans-serif;color:#1d2a3a}' +
    '.c{background:#fff;padding:36px 30px;border-radius:22px;max-width:420px;text-align:center;box-shadow:0 10px 40px rgba(29,42,58,.12)}' +
    'p{color:#5b6573}.b{display:inline-block;margin-top:12px;background:#d9483b;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:700}' +
    '</style></head><body><div class="c"><div style="font-size:44px">🎙️</div><h2>歡迎，' + esc_(profile.name) + '！</h2>' +
    '<p>' + esc_(profile.cls ? profile.cls + ' 班 · ' : '') + esc_(email) + '</p>' +
    '<a class="b" href="' + esc_(url) + '" target="_top">進入練習 →</a></div>' +
    '<script>setTimeout(function(){try{window.top.location.href=' + JSON.stringify(url) + '}catch(e){}},700)</script></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(CONFIG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ============ ② API（「API 部署」：執行身分＝我；存取＝任何人；靠通行證保護）============ */
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return json_({ ok: false, error: 'BAD_REQUEST' }); }
  const email = verifyToken_(req.token);
  if (!email) return json_({ ok: false, error: 'LOGIN', message: '登入已過期，請重新登入' });
  return json_(api_(email, req.action, req));
}

function api_(email, action, p) {
  const stu = findStudent_(email) || { email: email, name: email.split('@')[0], cls: '' };
  try {
    let r;
    switch (action) {
      case 'init': {
        const data = loadUser_(email);
        const returning = Object.keys(data).filter(function (k) { return k !== '_meta'; }).length > 0;
        const lastSeen = data._meta && data._meta.lastSeen || null;
        data._meta = Object.assign({}, data._meta, { lastSeen: Date.now(), logins: ((data._meta && data._meta.logins) || 0) + 1 });
        saveUser_(email, JSON.stringify(data));
        r = { profile: { email: stu.email, name: stu.name, cls: stu.cls }, data: data, returning: returning, lastSeen: lastSeen };
        break;
      }
      case 'save': {
        const s = JSON.stringify(p.data || {});
        if (s.length > 3000000) throw new Error('資料太大');
        saveUser_(email, s); r = { saved: true }; break;
      }
      case 'lib':
        r = getLib_(p.taskId, p.part, p.task);
        if (r._generated) log_(stu, '生成範文（範文庫未有）', p.taskId + ' ' + p.part, r._model || '', '');
        break;
      case 'ttsStatus':
        r = { list: (p.texts || []).slice(0, 40).map(function (t) { const id = ttsId_(t); return { id: id, has: !!ttsFile_(id) }; }) };
        break;
      case 'tts':
        r = getTTS_(p.text, stu);
        break;
      case 'define':
        r = cached_('w2_' + safe_(String(p.word).toLowerCase()), function () { return ai_('quick', [{ text: promptDefine_(p.word, p.context) }], 0.2); });
        break;
      case 'translate': {
        const t = ttsNorm_(p.text);
        if (!t) throw new Error('冇文字');
        if (t.length > 4000) throw new Error('文字太長');
        r = cached_('tr_' + ttsId_(t), function () { return ai_('quick', [{ text: promptTranslate_(t) }], 0.2); });
        break;
      }
      case 'assess':
        if (!p.audio) throw new Error('沒有錄音');
        r = ai_('audio', [
          { inlineData: { mimeType: p.mime || 'audio/wav', data: p.audio } },
          { text: promptAssessRead_(p) }
        ], 0.2);
        log_(stu, '跟讀評分' + (p.kind === 'gd' ? '（小組討論）' : p.kind === 'uni' ? '（萬用句子）' : '（個人回應）'),
          (p.paper || '') + ' ' + (p.taskTitle || '') + (p.version ? ' [' + p.version + ']' : ''), r._model,
          r.overall + ' 分 / 相似度 ' + (r.similarity == null ? '-' : r.similarity + '%') + ' · ' + r._sec + ' 秒' + (r._tried.length ? ' · 先試過：' + r._tried.join('；') : ''));
        break;
      default: throw new Error('後端版本過舊，未支援「' + action + '」：請老師更新 GitHub 上的 backend.js');
    }
    return { ok: true, result: r };
  } catch (err) {
    const m = String(err && err.message || err);
    log_(stu, '錯誤', action, '', m.slice(0, 450));
    return { ok: false, message: m };
  }
}

/* ---- 設定儲存喺「指令碼屬性」：執行 setup 後即時生效，唔使重新部署 ---- */
function cleanKeys_(arr) {
  return (arr || []).map(function (k) { return String(k || '').trim(); })
    .filter(function (k) { return k.length > 20 && !/在這裡|貼上|你的/.test(k); });
}
function getKeys_() {
  const saved = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEYS');
  const fromProps = saved ? cleanKeys_(saved.split(/[\s,]+/)) : [];
  return fromProps.length ? fromProps : cleanKeys_(CONFIG.API_KEYS);
}
function cfg_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  const c = String(CONFIG[name] || '');
  return v || (/你的|在這裡|貼上/.test(c) ? '' : c);
}

/* ---- 通行證（HMAC 簽署，學生改唔到）---- */
function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s;
}
function sign_(str) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(str, secret_())).replace(/=+$/, ''); }
function makeToken_(email) {
  const body = Utilities.base64EncodeWebSafe(email + '|' + (Date.now() + CONFIG.TOKEN_DAYS * 864e5), Utilities.Charset.UTF_8).replace(/=+$/, '');
  return body + '.' + sign_(body);
}
function verifyToken_(token) {
  if (!token || String(token).indexOf('.') < 0) return null;
  const parts = String(token).split('.');
  if (sign_(parts[0]) !== parts[1]) return null;
  let b = parts[0]; while (b.length % 4) b += '=';
  const raw = Utilities.newBlob(Utilities.base64DecodeWebSafe(b)).getDataAsString().split('|');
  if (Number(raw[1]) < Date.now()) return null;
  if (!CONFIG.ALLOW_ALL_IN_DOMAIN && !findStudent_(raw[0])) return null;
  return raw[0];
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }


/* ============ AI：按優次自動切換模型 ============ */
const AI_BUDGET_MS = 95000, QUICK_BUDGET_MS = 40000;   // 一次請求最多用 95 秒試模型（前端最多等 120 秒）
const CODE_ZH = { 429: '額度已滿', 404: '模型不可用', 403: '無權限', 400: '請求被拒', NET: '連線逾時', EMPTY: '冇回應', JSON: '回覆格式錯誤', SKIP: '已達用量上限', COOL: '冷卻中' };
function codeZh_(c) { return CODE_ZH[c] || (Number(c) >= 500 ? 'Google 伺服器繁忙' : String(c)); }

function ai_(route, parts, temperature) {
  const keys = getKeys_();
  if (!keys.length) throw new Error('後端未有 Gemini API Key：請老師喺 Apps Script 編輯器貼好 Key 後執行一次 setup');
  const t0 = Date.now(), tried = [], cache0 = CacheService.getScriptCache();
  // 最近太慢（>45 秒）嘅模型暫時排到最後
  const list = ROUTES[route].slice().sort(function (a, b) { return (cache0.get('slow_' + a) ? 1 : 0) - (cache0.get('slow_' + b) ? 1 : 0); });
  for (let i = 0; i < list.length; i++) {
    const model = list[i], m = MODELS[model];
    for (let k = 0; k < keys.length; k++) {
      const left = (route === 'quick' ? QUICK_BUDGET_MS : AI_BUDGET_MS) - (Date.now() - t0);
      if (left < 20000) { tried.push('（時間不足，停止再試）'); return fail_(route, tried, t0); }
      const r = reserve_(model, k, m);
      if (r !== true) { tried.push(short_(model) + '：' + codeZh_(r)); continue; }
      const t1 = Date.now();
      const res = callGemini_(keys[k], model, m, parts, temperature);
      const sec = ((Date.now() - t1) / 1000).toFixed(1);
      if (Number(sec) > (route === 'quick' ? 15 : 45)) cache0.put('slow_' + model, '1', 600); else if (res.ok) cache0.remove('slow_' + model);
      if (res.ok) {
        try {
          const out = parseJson_(res.text);
          out._model = model; out._sec = ((Date.now() - t0) / 1000).toFixed(1); out._tried = tried;
          return out;
        } catch (e) { tried.push(short_(model) + '：' + codeZh_('JSON') + '（' + sec + '秒）'); break; }
      }
      tried.push(short_(model) + '：' + codeZh_(res.code) + '（' + sec + '秒）');
      handleFailure_(model, k, res);
      if (res.code === 404 || res.code === 400 || res.code === 403) break;
    }
  }
  return fail_(route, tried, t0);
}
function short_(m) { return m.replace('gemini-', '').replace('-preview', '').replace('gemma-4-', 'gemma4-'); }
function fail_(route, tried, t0) {
  const allLimited = tried.length && tried.every(function (x) { return /上限|冷卻|額度/.test(x); });
  const msg = allLimited
    ? 'AI 今日／今分鐘嘅免費額度已用完，請 1 分鐘後再試（每日額度香港時間下午 3–4 時重置）。'
    : 'AI 暫時未能完成分析（已用 ' + ((Date.now() - t0) / 1000).toFixed(0) + ' 秒），請再試一次。';
  const e = new Error(msg + '［已嘗試：' + tried.join('；') + '］');
  e.tried = tried; throw e;
}

function callGemini_(key, model, m, parts, temperature, noThink) {
  const cfg = { temperature: temperature };
  if (m.json) cfg.responseMimeType = 'application/json';
  if (!noThink && m.think === 'level') cfg.thinkingConfig = { thinkingLevel: 'low' };
  if (!noThink && m.think === 'budget') cfg.thinkingConfig = { thinkingBudget: 0 };
  const payload = { contents: [{ role: 'user', parts: parts }], generationConfig: cfg };
  let res;
  try {
    res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': key }, payload: JSON.stringify(payload)
    });
  } catch (e) { return { ok: false, code: 'NET', body: String(e) }; }
  const code = res.getResponseCode(), body = res.getContentText();
  if (code === 400 && !noThink && cfg.thinkingConfig && /think/i.test(body)) return callGemini_(key, model, m, parts, temperature, true);
  if (code !== 200) return { ok: false, code: code, body: body };
  const j = JSON.parse(body);
  const c = j.candidates && j.candidates[0];
  const text = ((c && c.content && c.content.parts) || []).filter(function (x) { return x.text && !x.thought; })
    .map(function (x) { return x.text; }).join('');
  if (!text) return { ok: false, code: 'EMPTY', body: body.slice(0, 200) };
  return { ok: true, text: text };
}

function parseJson_(t) {
  t = String(t).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw e;
  }
}

/* ---- 額度管理：每分鐘（CacheService）+ 每日（ScriptProperties，太平洋時間）---- */
function dayKey_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyyMMdd'); }
function reserve_(model, k, m) {
  const cache = CacheService.getScriptCache();
  if (cache.get('off_' + model + '_' + k)) return 'COOL';
  const lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return 'COOL'; }
  try {
    const mk = 'rpm_' + model + '_' + k + '_' + Math.floor(Date.now() / 60000);
    const used = Number(cache.get(mk) || 0);
    if (used >= m.rpm) return 'SKIP';
    const props = PropertiesService.getScriptProperties();
    const dk = 'rpd_' + model + '_' + k, day = dayKey_();
    const rec = (props.getProperty(dk) || '').split('|');
    const usedDay = rec[0] === day ? Number(rec[1]) : 0;
    if (usedDay >= m.rpd) return 'SKIP';
    cache.put(mk, String(used + 1), 120);
    props.setProperty(dk, day + '|' + (usedDay + 1));
    return true;
  } finally { lock.releaseLock(); }
}
function handleFailure_(model, k, res) {
  const cache = CacheService.getScriptCache(), b = String(res.body || '');
  if (res.code === 429) {
    if (/per ?day|PerDay|daily/i.test(b)) PropertiesService.getScriptProperties().setProperty('rpd_' + model + '_' + k, dayKey_() + '|999999');
    else cache.put('off_' + model + '_' + k, '1', 65);
  } else if (res.code === 404 || res.code === 403 || (res.code === 400 && /not found|not supported|unsupported|audio/i.test(b))) {
    cache.put('off_' + model + '_' + k, '1', 21600);          // 6 小時內唔再試
  } else if (res.code >= 500 || res.code === 'NET' || res.code === 'EMPTY') {
    cache.put('off_' + model + '_' + k, '1', 120);   // Google 伺服器繁忙：2 分鐘內唔再試呢個模型
  }
}

/** 老師工具：喺編輯器執行，查看今日各模型用量 */
function checkQuota() {
  const props = PropertiesService.getScriptProperties(), day = dayKey_();
  Object.keys(MODELS).forEach(function (model) {
    getKeys_().forEach(function (_, k) {
      const rec = (props.getProperty('rpd_' + model + '_' + k) || '').split('|');
      Logger.log(model + ' (Key ' + (k + 1) + ')：今日已用 ' + (rec[0] === day ? rec[1] : 0) + ' / ' + MODELS[model].rpd);
    });
  });
}
function status_() {
  const props = PropertiesService.getScriptProperties(), cache = CacheService.getScriptCache(), day = dayKey_(), out = {};
  Object.keys(MODELS).forEach(function (model) {
    getKeys_().forEach(function (_, k) {
      const rec = (props.getProperty('rpd_' + model + '_' + k) || '').split('|');
      const used = rec[0] === day ? Number(rec[1]) : 0;
      out[model + (k ? ' #' + (k + 1) : '')] = (used >= 999999 ? 'Google 回報今日額度已滿' : '今日 ' + used + ' / ' + MODELS[model].rpd) +
        (cache.get('off_' + model + '_' + k) ? '（冷卻中）' : '');
    });
  });
  const tts = {}; TTS_TIERS.forEach(function (t) { tts[t.name] = '本月 ' + ttsUsed_(t.id) + ' / ' + t.free + ' 字元'; });
  return { ok: true, app: 'dse-speaking', version: 7, hasKey: getKeys_().length > 0, keys: getKeys_().length, models: out, tts: tts, time: new Date() };
}
/** 老師工具：檢查系統實際用緊邊條 Key（只顯示頭尾幾個字）*/
function checkKeys() {
  const mask = function (k) { return k.slice(0, 6) + '……' + k.slice(-4) + '（共 ' + k.length + ' 字）'; };
  const saved = (PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEYS') || '').split(/[\s,]+/).filter(String);
  Logger.log('第 12 行填咗：' + (cleanKeys_(CONFIG.API_KEYS).map(mask).join('、') || '（冇有效 Key）'));
  Logger.log('系統已儲存（實際使用）：' + (saved.map(mask).join('、') || '（冇）'));
  Logger.log(saved.join() === cleanKeys_(CONFIG.API_KEYS).join() ? '✅ 兩者一致' : '⚠️ 兩者唔一致：請執行 setup，令系統改用第 12 行嘅 Key');
}
/** 老師工具：測試 API Key 及每個模型是否可用 */
function testModels() {
  Object.keys(MODELS).forEach(function (model) {
    const t = Date.now();
    const r = callGemini_(getKeys_()[0], model, MODELS[model], [{ text: 'Reply with JSON {"ok":true}' }], 0);
    Logger.log((r.ok ? '✅ ' : '❌ ') + model + '（' + ((Date.now() - t) / 1000).toFixed(1) + ' 秒）' + (r.ok ? '' : '  → ' + r.code + ' ' + String(r.body).slice(0, 120)));
  });
}
/** 老師工具：清除 AI 快取（想重新生成範文時執行） */
function clearCache() {
  const it = getSub_(root_(), 'cache').getFiles(); let n = 0;
  while (it.hasNext()) { it.next().setTrashed(true); n++; }
  Logger.log('已清除 ' + n + ' 個快取檔');
}


/* ============ Prompts ============ */
function taskText_(t) {
  t = t || {};
  return 'TITLE: ' + (t.title || '') + '\nINTRO: ' + (t.intro || '') + '\nTEXT:\n' + (t.text || '') +
    '\nTASK: ' + (t.task || '') + '\nDISCUSSION POINTS:\n- ' + (t.points || []).join('\n- ');
}
function promptDefine_(word, context) {
  return 'You are an English dictionary for Hong Kong secondary students. Explain the English word "' + word + '"' +
    (context ? ' as it is used in this sentence: "' + context + '"' : '') + '.\n' +
    'Use the base form for "word" (e.g. "studies" -> "study") but keep the meaning that fits the sentence.\n' +
    'pos must be ONE of: n. / v. / adj. / adv. / prep. / conj. / pron. / det. / int. / phr.\n' +
    'Return ONLY valid JSON: {"word":"","pos":"","pos_zh":"名詞 / 動詞 / 形容詞 / 副詞 / 介詞 / 連詞 / 代詞 / 限定詞 / 感嘆詞 / 短語",' +
    '"ipa":"/British IPA/","zh":"繁體中文意思（香港用語，簡短）","example":"one short natural example sentence"}';
}
function promptTranslate_(text) {
  return 'Translate the following English text into natural, fluent Traditional Chinese (Hong Kong written Chinese, 書面語) ' +
    'for Hong Kong secondary students. Keep names as they are, keep paragraph breaks.\n---\n' + text + '\n---\n' +
    'Return ONLY valid JSON: {"zh":""}';
}
function promptAssessRead_(req) {
  return 'You are a strict but encouraging English pronunciation coach for Hong Kong HKDSE students (Cantonese L1).\n' +
    'The audio is a student READING ALOUD this script:\n"""' + req.script + '"""\n\n' +
    'Compare carefully. Check individual sounds (/θ/, /ð/, /v/, /z/, final consonants, clusters, long vs short vowels), ' +
    'articulation clarity, words missed/skipped/added, word stress, sentence stress, intonation (natural vs flat), pace and pausing.\n' +
    'Also transcribe what the student actually said and estimate similarity (0-100%) between the reading and the script ' +
    '(words read correctly in the right order ÷ script words).\n' +
    'If the audio is silent, too noisy or not this script, set overall and similarity below 20 and say so.\n' +
    'Feedback in Traditional Chinese (HK). Quote words EXACTLY as in the script.\nReturn ONLY valid JSON:\n' +
    '{"overall":0-100,"similarity":0-100,"transcript":"","dse_level":"發音及表達估計 3 / 4 / 5 / 5* / 5**","scores":{"pronunciation":0-10,"articulation":0-10,"completeness":0-10,"intonation":0-10,"fluency":0-10},' +
    '"summary_zh":"","strengths_zh":[""],"missed":[{"text":"script words skipped","note_zh":""}],' +
    '"wrong":[{"word":"script word read as a different word","heard_as":"","tip_zh":""}],' +
    '"unclear":[{"word":"","heard_as":"","ipa":"","tip_zh":"口形/舌位提示"}],"intonation":[{"phrase":"","issue_zh":"","tip_zh":""}],' +
    '"pace_zh":"","next_steps_zh":["3項"]}\nUp to 8 unclear words, 5 intonation points.';
}

/* ============ 真人發音（Cloud TTS → Drive「tts」資料夾，生成一次之後重用）============ */
function ttsNorm_(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
function ttsId_(t) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ttsNorm_(t), Utilities.Charset.UTF_8);
  return d.slice(0, 12).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function ttsFolder_() { return getSub_(root_(), 'tts'); }
function ttsFile_(id) { const it = ttsFolder_().getFilesByName('tts_' + id + '.mp3'); return it.hasNext() ? it.next() : null; }
function monthKey_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyyMM'); }
function ttsUsed_(tier) { return Number(PropertiesService.getScriptProperties().getProperty('tts_' + monthKey_() + '_' + tier) || 0); }
function ttsAdd_(tier, n) {
  const p = PropertiesService.getScriptProperties(), k = 'tts_' + monthKey_() + '_' + tier;
  p.setProperty(k, String(Number(p.getProperty(k) || 0) + n));
}
function ttsKey_() { const k = String(PropertiesService.getScriptProperties().getProperty('TTS_API_KEY') || CONFIG.TTS_API_KEY || '').trim(); return k.length > 20 ? k : getKeys_()[0]; }

function getTTS_(text, stu) {
  text = ttsNorm_(text);
  if (!text) throw new Error('冇文字');
  if (text.length > 3000) throw new Error('文字太長');
  const id = ttsId_(text);
  let f = ttsFile_(id);
  if (f) return { id: id, cached: true, audio: Utilities.base64Encode(f.getBlob().getBytes()), voice: f.getDescription() || '' };
  // 避免多人同時生成同一段
  const cache = CacheService.getScriptCache(), gk = 'ttsgen_' + id;
  if (cache.get(gk)) {
    for (let i = 0; i < 8; i++) { Utilities.sleep(3000); f = ttsFile_(id); if (f) return { id: id, cached: true, audio: Utilities.base64Encode(f.getBlob().getBytes()), voice: f.getDescription() || '' }; }
    throw new Error('另一位同學正在生成呢段發音，請稍後再試');
  }
  cache.put(gk, '1', 60);
  try {
    const t0 = Date.now(), errs = [];
    for (let i = 0; i < TTS_TIERS.length; i++) {
      const tier = TTS_TIERS[i];
      if (ttsUsed_(tier.id) + text.length > tier.free * TTS_SAFETY) { errs.push(tier.name + '：本月免費額度已用完'); continue; }
      if (cache.get('ttsoff_' + tier.id)) { errs.push(tier.name + '：暫停中'); continue; }
      const res = ttsCall_(text, tier);
      const code = res.getResponseCode();
      if (code !== 200) {
        const body = res.getContentText();
        let msg = ''; try { msg = (JSON.parse(body || '{}').error || {}).message || ''; } catch (e) { msg = body.slice(0, 120); }
        errs.push(tier.name + '：' + code + ' ' + msg);
        cache.put('ttsoff_' + tier.id, '1', code === 400 ? 21600 : 300);
        continue;
      }
      ttsAdd_(tier.id, text.length);
      const b64 = JSON.parse(res.getContentText()).audioContent;
      const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'audio/mpeg', 'tts_' + id + '.mp3');
      ttsFolder_().createFile(blob).setDescription(tier.name);
      log_(stu, '生成真人發音', tier.name + ' · ' + text.length + ' 字元 · ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒', '', text.slice(0, 60));
      return { id: id, cached: false, audio: b64, voice: tier.name };
    }
    log_(stu, '錯誤', '真人發音', '', errs.join('；').slice(0, 450));
    throw new Error('暫時未能生成真人發音［已嘗試：' + errs.join('；') + '］');
  } finally { cache.remove(gk); }
}
/* 認證：優先用 OAuth（Chirp 3 HD 必須），失敗再試 API Key */
function ttsCall_(text, tier) {
  const body = JSON.stringify({ input: { text: text }, voice: { languageCode: tier.lang, name: tier.voice }, audioConfig: { audioEncoding: 'MP3' } });
  const url = 'https://texttospeech.googleapis.com/v1/text:synthesize';
  let token = '';
  try { token = ScriptApp.getOAuthToken(); } catch (e) {}
  let res = null;
  if (token) {
    res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token }, payload: body });
    if (res.getResponseCode() === 200) return res;
  }
  const key = ttsKey_();
  if (key) {
    const r2 = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': key }, payload: body });
    if (r2.getResponseCode() === 200 || !res) return r2;
    // 兩種都失敗：回報較有用的 OAuth 錯誤
    return /API keys are not supported/.test(r2.getContentText()) ? res : r2;
  }
  return res;
}
/** 老師工具：查看本月真人發音用量 */
function ttsUsage() {
  TTS_TIERS.forEach(function (t) { Logger.log(t.name + '：本月已用 ' + ttsUsed_(t.id).toLocaleString() + ' / ' + t.free.toLocaleString() + ' 免費字元'); });
  Logger.log('已儲存發音檔：' + (function () { let n = 0; const it = ttsFolder_().getFiles(); while (it.hasNext()) { it.next(); n++; } return n; })() + ' 個');
}
/** 老師工具：測試真人發音 */
function testTTS() {
  const r = getTTS_('Hello everyone. This is a test of the natural voice for our speaking practice.', { email: 'teacher', name: '老師', cls: '' });
  Logger.log('✅ 成功（' + r.voice + '，' + (r.cached ? '已存在' : '新生成') + '）');
}

/* ============ 範文庫（Google Sheet「範文庫」分頁，可由老師直接修改）============
 * 欄：題目ID | 類型(GD/VOCAB/IR) | 序號 | 標題或問題 | 英文（GD 段落 / Level 4）| 5** | 中文說明 | 更新時間 */
const LIB_SHEET = '範文庫';
const LIB_HEAD = ['題目ID', '類型', '序號', '標題 / 問題', '英文（GD 段落 / Level 4）', '5**', '中文說明', '更新時間'];
function libSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(LIB_SHEET);
  if (!sh) { sh = ss.insertSheet(LIB_SHEET); }
  if (sh.getLastRow() === 0) { sh.appendRow(LIB_HEAD); sh.setFrozenRows(1); sh.setColumnWidths(5, 2, 420); }
  return sh;
}
function libRows_(taskId, fresh) {
  const cache = CacheService.getScriptCache(), ck = 'lib_' + safe_(taskId);
  if (!fresh) { const c = cache.get(ck); if (c) return JSON.parse(c); }
  const sh = libSheet_();
  const cells = sh.getRange('A:A').createTextFinder(taskId).matchEntireCell(true).findAll();
  const rows = cells.map(function (c) { return sh.getRange(c.getRow(), 1, 1, 7).getValues()[0]; })
    .filter(function (r) { return String(r[0]) === String(taskId); });
  try { cache.put(ck, JSON.stringify(rows), 600); } catch (e) {}
  return rows;
}
function irHalf_(qIndex) { return Number(qIndex) < 4 ? 'ir1' : 'ir2'; }
function partFromRows_(rows, part, task) {
  if (part === 'gd') {
    const gd = rows.filter(function (r) { return r[1] === 'GD'; }).sort(function (a, b) { return a[2] - b[2]; })
      .map(function (r) { return { title: String(r[3]), text: String(r[4]), zh: String(r[6]) }; });
    const v = rows.filter(function (r) { return r[1] === 'VOCAB'; })[0];
    let vocab = []; try { vocab = v ? JSON.parse(v[4]) : []; } catch (e) {}
    return gd.length ? { gd: gd.slice(0, 6), vocab: vocab } : null;
  }
  const lo = part === 'ir1' ? 1 : 5, hi = part === 'ir1' ? 4 : 99, seen = {}, ir = [];
  const norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  rows.forEach(function (r) {
    const n = Number(r[2]);
    if (r[1] !== 'IR' || !(n >= lo && n <= hi) || seen[n]) return;
    // 有題目資料時，問題文字要對得上，避免錯配
    if (task && task.ir && task.ir[n - 1] != null && norm(task.ir[n - 1]) !== norm(r[3])) return;
    seen[n] = 1;
    ir.push({ q: n - 1, question: String(r[3]), level4: String(r[4]), level7: String(r[5]), notes: String(r[6]) });
  });
  return ir.length ? { ir: ir } : null;
}
function getLib_(taskId, part, task) {
  if (['gd', 'ir1', 'ir2'].indexOf(part) < 0) part = irHalf_(part);
  let got = partFromRows_(libRows_(taskId), part, task);
  if (got) return got;
  // 未有：避免多個同學同時生成同一題
  const cache = CacheService.getScriptCache(), gk = 'gen_' + safe_(taskId) + '_' + part;
  if (cache.get(gk)) {
    for (let i = 0; i < 10; i++) { Utilities.sleep(6000); got = partFromRows_(libRows_(taskId, true), part, task); if (got) return got; }
    throw new Error('範文正由另一位同學生成中，請稍後再開。');
  }
  cache.put(gk, '1', 150);
  try {
    if (!task) throw new Error('範文庫未有此題');
    const made = generatePart_(task, part, 'content');
    got = partFromRows_(made.rows, part, task) || partFromRows_(libRows_(taskId, true), part, task);
    if (!got) throw new Error('AI 回覆格式唔完整，未能生成範文，請撳「再試」');
    got._generated = true; got._model = made.model;
    return got;
  } finally { cache.remove(gk); }
}
function generatePart_(task, part, route) {
  const sh = libSheet_(), now = new Date(), rows = [];
  let out;
  if (part === 'gd') {
    out = ai_(route, [{ text: promptLibGD_(task) }], 0.6);
    (out.passages || []).slice(0, 6).forEach(function (x, i) { if (x && x.text) rows.push([task.id, 'GD', i + 1, x.title || '', x.text, '', x.zh || '', now]); });
    if (rows.length) rows.push([task.id, 'VOCAB', 1, '主題生字', JSON.stringify(out.vocab || []), '', '', now]);
  } else {
    const lo = part === 'ir1' ? 0 : 4, hi = part === 'ir1' ? 4 : 99;
    const qs = (task.ir || []).map(function (q, i) { return { i: i, q: q }; }).slice(lo, hi);
    if (!qs.length) return { rows: [], model: '' };
    out = ai_(route, [{ text: promptLibIR_(task, qs) }], 0.6);
    const ans = out.answers || out.questions || [];
    const used = {};
    ans.forEach(function (a, k) {
      if (!a || !(a.level4 || a.level7)) return;
      // 題號：AI 有時由 1 重新數起，所以只接受本批題目範圍內的題號，否則按次序對應
      let qi = a.n != null ? Number(a.n) - 1 : -1;
      if (!qs.some(function (x) { return x.i === qi; }) || used[qi]) qi = qs[k] ? qs[k].i : -1;
      if (qi < 0 || used[qi]) return;
      used[qi] = 1;
      rows.push([task.id, 'IR', qi + 1, task.ir[qi], a.level4 || '', a.level7 || '', a.notes_zh || '', now]);
    });
  }
  if (!rows.length) throw new Error('AI 未能生成範文，請再試');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (!partFromRows_(libRows_(task.id, true), part, task)) {
      const rg = sh.getRange(sh.getLastRow() + 1, 1, rows.length, 8);
      rg.offset(0, 0, rows.length, 4).setNumberFormat('@');   // 題目ID 等保持文字，避免被當成日期
      rg.setValues(rows);
    }
  } finally { lock.releaseLock(); }
  CacheService.getScriptCache().remove('lib_' + safe_(task.id));
  return { rows: rows, model: out._model };
}
/** 老師工具：清除範文庫入面題號對錯咗嘅個人回應（之後會自動重新生成） */
function fixLibrary() {
  const T = {}; loadPapers_().forEach(function (p) { p.tasks.forEach(function (t) { T[t.id] = t; }); });
  const sh = libSheet_(), v = sh.getDataRange().getValues();
  const norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  let n = 0;
  for (let r = v.length - 1; r >= 1; r--) {
    const t = T[String(v[r][0])];
    if (v[r][1] === 'IR' && t && norm(t.ir[Number(v[r][2]) - 1]) !== norm(v[r][3])) { sh.deleteRow(r + 1); n++; }
  }
  CacheService.getScriptCache().removeAll(Object.keys(T).map(function (id) { return 'lib_' + safe_(id); }));
  Logger.log('已刪除 ' + n + ' 行錯配嘅範文');
}
function promptLibGD_(task) {
  return 'You are an experienced HKDSE English Language Paper 4 teacher in Hong Kong. For this Group Interaction task, write model ' +
    'contributions that students will READ ALOUD for shadowing practice.\n\n' + taskText_(task) + '\n\n' +
    'Write exactly 5 passages: 1) an opening that starts the discussion and sets the agenda; 2)-4) one strong contribution for EACH of the first three ' +
    'discussion points (respond to a groupmate, give a clear idea, a reason and a concrete Hong Kong example, then invite someone, using a name ' +
    'such as Mandy, Kelvin or Joyce); 5) a closing summary. Each passage 55-85 words (readable aloud in under 60 seconds), natural spoken English at ' +
    'Level 5**-quality but easy to say, no headings inside the text.\n' +
    'Also give 10 useful topic vocabulary items.\n' +
    'Return ONLY valid JSON, no markdown: {"passages":[{"title":"short English label e.g. Opening / Point 1: ...","zh":"一句中文：用途及亮點","text":""}],' +
    '"vocab":[{"word":"","pos":"","zh":"","example":""}]}';
}
function promptLibIR_(task, qs) {
  return 'You are an experienced HKDSE English Language Paper 4 teacher. Context (Group Interaction task):\n' + taskText_(task) + '\n\n' +
    'Write ONE-minute model answers for these Individual Response questions:\n' +
    qs.map(function (x) { return (x.i + 1) + '. ' + x.q; }).join('\n') + '\n\n' +
    'For each question: level4 = 90-110 words, clear stance, 2 reasons, simple accurate language and basic linking words; ' +
    'level7 = 130-150 words (5**): confident direct answer, developed reasons with a vivid Hong Kong example, brief acknowledgement of another view, ' +
    'precise natural vocabulary, varied structures, crisp conclusion. Spoken style, no headings, no bullet points. ' +
    'notes_zh = 一句中文指出 5** 版本最值得學的用字或結構.\n' +
    'Return ONLY valid JSON, no markdown: {"answers":[{"n":question_number,"level4":"","level7":"","notes_zh":""}]}';
}

/* ---- 背景建立整個範文庫（老師喺編輯器執行 startBuildLibrary 一次即可）---- */
function startBuildLibrary() {
  stopBuildLibrary();
  ScriptApp.newTrigger('buildLibraryStep').timeBased().everyMinutes(5).create();
  Logger.log('✅ 已開始：每 5 分鐘自動生成一批範文，完成後會自動停止。可執行 libraryProgress 查看進度。');
  buildLibraryStep();
}
function stopBuildLibrary() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'buildLibraryStep') ScriptApp.deleteTrigger(t); });
}
function libDoneSet_() {
  const v = libSheet_().getDataRange().getValues().slice(1), done = {};
  v.forEach(function (r) {
    const id = String(r[0]); if (!id) return;
    if (r[1] === 'GD') done[id + '|gd'] = 1;
    if (r[1] === 'IR') done[id + '|' + (r[2] <= 4 ? 'ir1' : 'ir2')] = 1;
  });
  return done;
}
function libTodo_() {
  const done = libDoneSet_(), todo = [];
  loadPapers_().forEach(function (p) {
    p.tasks.forEach(function (t) {
      ['gd', 'ir1', 'ir2'].forEach(function (part) {
        if (part === 'ir2' && (t.ir || []).length <= 4) return;
        if (!done[t.id + '|' + part]) todo.push({ task: t, part: part });
      });
    });
  });
  return todo;
}
function buildLibraryStep() {
  const cache = CacheService.getScriptCache();
  if (cache.get('building')) return;           // 上一批仲做緊
  cache.put('building', '1', 330);
  const t0 = Date.now();
  let made = 0, fails = 0;
  try {
    const todo = libTodo_();
    if (!todo.length) { stopBuildLibrary(); Logger.log('🎉 範文庫已全部完成'); return; }
    for (let i = 0; i < todo.length && Date.now() - t0 < 4.3 * 60000; i++) {
      try { generatePart_(todo[i].task, todo[i].part, 'build'); made++; }
      catch (e) { fails++; Logger.log(todo[i].task.id + ' ' + todo[i].part + '：' + e.message); if (/額度|上限/.test(String(e.message)) || fails >= 3) break; }
    }
  } finally { cache.remove('building'); }
  Logger.log('今批完成 ' + made + ' 份，失敗 ' + fails);
}
function libraryProgress() {
  let total = 0;
  loadPapers_().forEach(function (p) { p.tasks.forEach(function (t) { total += (t.ir || []).length > 4 ? 3 : 2; }); });
  const left = libTodo_().length;
  Logger.log('範文庫進度：' + (total - left) + ' / ' + total + '（' + Math.round((total - left) / total * 100) + '%）');
}
function loadPapers_() {
  const it = root_().getFilesByName('papers.json');
  if (!it.hasNext()) throw new Error('Drive 資料夾內找不到 papers.json（建立範文庫需要），請先上載。');
  return JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
}


/* ============ Sheet：學生名單 + 系統日誌 ============ */
function findStudent_(email) {
  const cache = CacheService.getScriptCache();
  let list = cache.get('students');
  if (!list) {
    const out = [];
    SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheets().forEach(function (sh) {
      if (sh.getName() === CONFIG.LOG_SHEET) return;
      const v = sh.getDataRange().getValues(); if (v.length < 2) return;
      const h = v[0].map(function (x) { return String(x).toLowerCase(); });
      const col = function (re) { for (let i = 0; i < h.length; i++) if (re.test(h[i])) return i; return -1; };
      const ce = col(/e-?mail|電郵|郵件|郵箱/), cn = col(/name|姓名|名稱/), cc = col(/^class$|class\b|班別|班級|^班$/), cno = col(/no\.?$|number|學號|班號/);
      if (ce < 0) return;
      v.slice(1).forEach(function (r) {
        const e = String(r[ce] || '').trim().toLowerCase();
        if (e.indexOf('@') > 0) out.push({ email: e, name: cn >= 0 ? String(r[cn] || '') : '', cls: cc >= 0 ? String(r[cc] || '') : '', no: cno >= 0 ? String(r[cno] || '') : '' });
      });
    });
    list = JSON.stringify(out);
    try { cache.put('students', list, 600); } catch (e) {}
  }
  email = String(email).toLowerCase();
  const s = JSON.parse(list).filter(function (x) { return x.email === email; })[0];
  if (s && !s.name) s.name = email.split('@')[0];
  return s || null;
}
function log_(stu, action, detail, model, result) {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    let sh = ss.getSheetByName(CONFIG.LOG_SHEET);
    if (!sh) { sh = ss.insertSheet(CONFIG.LOG_SHEET); }
    if (sh.getLastRow() === 0) { sh.appendRow(['時間', '電郵', '姓名', '班別', '動作', '詳情', 'AI 模型', '結果']); sh.setFrozenRows(1); }
    sh.appendRow([new Date(), stu.email, stu.name, stu.cls, action, detail || '', model || '', result || '']);
  } catch (e) { console.warn(e); }
}


/* ============ Drive：進度、快取、題庫 ============ */
function root_() { return DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID); }
function getSub_(parent, name) { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : parent.createFolder(name); }
function userFile_(email) {
  const folder = getSub_(root_(), 'users'), it = folder.getFilesByName(email + '.json');
  return { folder: folder, file: it.hasNext() ? it.next() : null };
}
function loadUser_(email) {
  const f = userFile_(email).file;
  try { return f ? JSON.parse(f.getBlob().getDataAsString('UTF-8') || '{}') : {}; } catch (e) { return {}; }
}
function saveUser_(email, str) {
  const lock = LockService.getUserLock(); lock.waitLock(10000);
  try { const u = userFile_(email); if (u.file) u.file.setContent(str); else u.folder.createFile(email + '.json', str, 'application/json'); }
  finally { lock.releaseLock(); }
}
function cached_(name, makeFn) {
  const folder = getSub_(root_(), 'cache'), it = folder.getFilesByName(name + '.json');
  if (it.hasNext()) { const o = JSON.parse(it.next().getBlob().getDataAsString('UTF-8')); delete o._model; return o; }
  const data = makeFn();
  folder.createFile(name + '.json', JSON.stringify(data), 'application/json');
  return data;
}

/** 第一次使用：喺編輯器揀 setup → 執行（會要求授權） */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const keys = cleanKeys_(CONFIG.API_KEYS);
  if (keys.length) props.setProperty('GEMINI_API_KEYS', keys.join(','));
  const tk = String(CONFIG.TTS_API_KEY || '').trim();
  if (tk.length > 20) props.setProperty('TTS_API_KEY', tk);
  ['FRONTEND_URL', 'API_URL'].forEach(function (n) {
    const c = String(CONFIG[n] || '');
    if (c && !/你的|在這裡|貼上/.test(c)) props.setProperty(n, c);
  });
  Logger.log('🔑 已儲存 API Key：' + getKeys_().length + ' 條（之後改 Key 只要再執行 setup，唔使重新部署）');
  Logger.log('🌐 FRONTEND_URL = ' + (cfg_('FRONTEND_URL') || '（未填）') + '   API_URL = ' + (cfg_('API_URL') || '（未填）'));
  SpreadsheetApp.openById(CONFIG.SHEET_ID);
  getSub_(root_(), 'users'); getSub_(root_(), 'cache');
  secret_();
  log_({ email: Session.getEffectiveUser().getEmail(), name: '老師', cls: '' }, '系統設定', 'setup 完成', '', '');
  Logger.log('✅ 設定完成。接住可以執行 testModels 測試 API Key。');
}

function safe_(s) { return String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80); }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function msgPage_(title, body) {
  return HtmlService.createHtmlOutput('<div style="font-family:sans-serif;max-width:420px;margin:15vh auto;text-align:center;padding:24px">' +
    '<div style="font-size:44px">🎙️</div><h2>' + title + '</h2><p style="color:#5b6573">' + body + '</p></div>')
    .setTitle(CONFIG.APP_TITLE).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

return { doGet: doGet, doPost: doPost, setup: setup, testModels: testModels, checkQuota: checkQuota, checkKeys: checkKeys, testTTS: testTTS, ttsUsage: ttsUsage, clearCache: clearCache, startBuildLibrary: startBuildLibrary, stopBuildLibrary: stopBuildLibrary, buildLibraryStep: buildLibraryStep, libraryProgress: libraryProgress, fixLibrary: fixLibrary, status_: status_, VERSION: 7 };
})