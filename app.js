(function () {
'use strict';

const CFG = window.APP_CONFIG;
const REFUND_COS = CFG.REFUND_COMPANIES || ['J&J Tax Free（J-TaxRefund）', 'PIE VAT', 'Smart Detax（JP Refund）', 'Global Blue', '其他／不確定'];
const C = window.Calc;
const TH = CFG.THRESHOLD_JPY;
const VERSION = '1.8.0';

/* ========== 小工具 ========== */
const $ = (s, el) => (el || document).querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => '¥' + Math.round(n || 0).toLocaleString('en-US');
const twd = n => 'NT$' + Math.round(n || 0).toLocaleString('en-US');
const sumBy = (list, k) => list.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const configMissing = () => /^PASTE_/.test(CFG.API_URL) || /^PASTE_/.test(CFG.GOOGLE_CLIENT_ID);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}
function b64ToBlob(b64, mime) {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime || 'image/jpeg' });
}

async function compress(file, max, q) {
  max = max || 1600; q = q || 0.82;
  let src, w, h, url;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width; h = src.height;
  } catch (e) {
    src = await new Promise((res, rej) => {
      url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej; im.src = url;
    });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const sc = Math.min(1, max / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  if (url) URL.revokeObjectURL(url);
  return new Promise(res => cv.toBlob(b => res(b), 'image/jpeg', q));
}

/* ========== IndexedDB（離線儲存） ========== */
let _db;
function db() {
  return _db || (_db = new Promise((res, rej) => {
    const q = indexedDB.open('jptax', 1);
    q.onupgradeneeded = () => {
      const d = q.result;
      d.createObjectStore('kv');
      d.createObjectStore('receipts', { keyPath: 'id' });
      d.createObjectStore('photos', { keyPath: 'id' });
    };
    q.onsuccess = () => {
      const d = q.result;
      d.onclose = () => { _db = null; };
      d.onversionchange = () => { d.close(); _db = null; };
      res(d);
    };
    q.onerror = () => { _db = null; rej(q.error); };
    q.onblocked = () => { _db = null; };
  }));
}
function tx1(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result !== undefined ? r.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
/* 手機瀏覽器切到背景後可能把資料庫連線關掉：失敗時重連再試一次 */
function tx(store, mode, fn) {
  return tx1(store, mode, fn).catch(e => {
    if (e && (e.name === 'InvalidStateError' || /closing|closed/i.test(String(e.message)))) {
      _db = null;
      return tx1(store, mode, fn);
    }
    throw e;
  });
}
const kvGet = k => tx('kv', 'readonly', s => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
const allReceipts = () => tx('receipts', 'readonly', s => s.getAll()).then(x => x || []);
const putReceipt = r => tx('receipts', 'readwrite', s => s.put(r));
const delReceipt = id => tx('receipts', 'readwrite', s => s.delete(id));
const putPhoto = (id, blob) => tx('photos', 'readwrite', s => s.put({ id, blob }));
const getPhotoRec = id => tx('photos', 'readonly', s => s.get(id));
const delPhoto = id => tx('photos', 'readwrite', s => s.delete(id));
async function clearAll() {
  for (const n of ['kv', 'receipts', 'photos']) await tx(n, 'readwrite', s => s.clear());
}

/* ========== 狀態 ========== */
const S = {
  user: null, users: [], stores: [], receipts: [],
  rate: null, rateTs: 0, rateManual: false,
  token: null, view: 'home', scope: 'me',
  syncing: false, needLogin: false, budgetDirty: false,
  onlyEligible: false, lastSync: 0, refundFilter: ''
};
const thumbCache = new Map();

const visible = () => S.receipts.filter(r => r.sync !== 'delete');
function scoped() {
  const v = visible();
  return (S.scope === 'all' && S.user.role === 'admin') ? v : v.filter(r => r.owner === S.user.email);
}
const pendingCount = () => S.receipts.filter(r => r.sync && r.sync !== 'synced').length;
const rate = () => S.rate || CFG.FALLBACK_RATE;
const saveStores = () => kvSet('stores', S.stores);

/* ========== 登入（Google） ========== */
let gsiReady = false;
let gsiWaiters = [];

function jwtExp(t) {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; }
  catch (e) { return 0; }
}
function loadGsi() {
  return new Promise(res => {
    if (window.google && google.accounts && google.accounts.id) return res(true);
    if (!navigator.onLine) return res(false);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(true); s.onerror = () => res(false);
    document.head.appendChild(s);
  });
}
async function initGsi() {
  if (gsiReady) return true;
  if (configMissing()) return false;
  if (!(await loadGsi())) return false;
  google.accounts.id.initialize({
    client_id: CFG.GOOGLE_CLIENT_ID, callback: onCredential,
    auto_select: true, cancel_on_tap_outside: false
  });
  gsiReady = true;
  return true;
}
async function onCredential(resp) {
  S.token = resp.credential;
  kvSet('token', S.token);
  S.needLogin = false;
  const w = gsiWaiters; gsiWaiters = [];
  w.forEach(f => f(true));
  if (!S.user) await firstLogin();
  else { closeModal(); render(); sync(); }
}
function silentLogin() {
  return initGsi().then(ok => {
    if (!ok) return false;
    return new Promise(res => {
      const done = v => { clearTimeout(timer); res(v); };
      const timer = setTimeout(() => { gsiWaiters = gsiWaiters.filter(f => f !== done); res(false); }, 7000);
      gsiWaiters.push(done);
      try { google.accounts.id.prompt(); } catch (e) { done(false); }
    });
  });
}
function authErr(msg) { const e = new Error(msg); e.code = 'AUTH'; return e; }
async function ensureToken() {
  if (S.token && jwtExp(S.token) > Date.now() + 60000) return;
  if (!navigator.onLine) throw authErr('離線中');
  if (!(await silentLogin())) {
    S.needLogin = true; render();
    throw authErr('需要重新登入');
  }
}

async function showLogin(msg) {
  $('#app').hidden = true; $('#login').hidden = false;
  const m = $('#loginMsg');
  m.textContent = msg || '';
  if (configMissing()) { m.textContent = '尚未設定：請先填好 config.js 的 API_URL 與 GOOGLE_CLIENT_ID。'; return; }
  if (!navigator.onLine) { m.textContent = '第一次登入需要網路，請連上網路後重新開啟。'; return; }
  if (!(await initGsi())) { m.textContent = '無法載入 Google 登入，請檢查網路。'; return; }
  $('#gbtn').innerHTML = '';
  google.accounts.id.renderButton($('#gbtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh-TW', width: 280 });
}
async function firstLogin() {
  $('#loginMsg').textContent = '登入中…';
  try {
    await pullInit();
    await kvSet('token', S.token);
    showApp();
  } catch (e) {
    S.token = null; kvSet('token', null);
    $('#loginMsg').textContent = e.code === 'FORBIDDEN'
      ? e.message + '（請請管理者把這個 Gmail 加進 Users 工作表）'
      : e.message;
    if (e.code === 'FORBIDDEN' && window.google) google.accounts.id.disableAutoSelect();
  }
}
function showRelogin() {
  openModal('<div class="sheet"><div class="sheet-head"><h2>重新登入</h2><button class="x" data-act="close-modal">×</button></div>' +
    '<p class="muted small" style="margin-bottom:14px">登入已過期，請重新登入（待上傳的收據不會消失）</p><div id="gbtn2"></div></div>');
  initGsi().then(ok => {
    if (ok) google.accounts.id.renderButton($('#gbtn2'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh-TW', width: 280 });
  });
}

/* ========== 後端呼叫 ========== */
function netErr(msg) { const e = new Error(msg || '網路不穩，稍後再試'); e.code = 'NET'; return e; }
async function api(action, payload, timeoutMs) {
  await ensureToken();
  let res;
  const ctl = timeoutMs ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    res = await fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: S.token, payload: payload || {} }),
      signal: ctl ? ctl.signal : undefined
    });
  } catch (e) {
    if (e && e.name === 'AbortError') { const te = new Error('辨識太久沒回應，請稍後再試，或先手動輸入金額'); te.code = 'TIMEOUT'; throw te; }
    throw netErr();
  } finally { if (timer) clearTimeout(timer); }
  let d;
  try { d = await res.json(); } catch (e) { throw netErr('伺服器回應異常'); }
  if (!d.ok) {
    const e = new Error(d.message || '發生錯誤'); e.code = d.code;
    if (d.code === 'AUTH') { S.token = null; kvSet('token', null); }
    throw e;
  }
  return d.data;
}

/* ========== 同步 ========== */
async function pullInit() {
  const d = await api('init');
  const keepBudget = S.budgetDirty && S.user ? S.user.budgetTWD : null;
  S.user = d.user;
  if (keepBudget !== null) S.user.budgetTWD = keepBudget;
  S.users = d.users || [];
  // 店家：伺服器清單 + 尚未上傳的本地新店家
  const pendStores = S.stores.filter(s => s.pending && !d.stores.some(x => x.name.toLowerCase() === s.name.toLowerCase()));
  S.stores = d.stores.concat(pendStores);
  // 收據：伺服器為準，但保留尚未上傳的本地變更
  const local = await allReceipts();
  const pend = new Map(local.filter(r => r.sync && r.sync !== 'synced').map(r => [r.id, r]));
  const next = [];
  d.receipts.forEach(r => { if (!pend.has(r.id)) { r.sync = 'synced'; next.push(r); } });
  pend.forEach(r => next.push(r));
  await tx('receipts', 'readwrite', s => { s.clear(); next.forEach(r => s.put(r)); });
  S.receipts = next;
  await Promise.all([kvSet('user', S.user), kvSet('users', S.users), saveStores()]);
}

const pickFields = r => ({
  id: r.id, date: r.date, store: r.store, amountIncl: r.amountIncl, tax: r.tax, amountExcl: r.amountExcl,
  rate: r.rate, note: r.note, packed: r.packed, needsReview: r.needsReview, createdAt: r.createdAt, refundCo: r.refundCo || '', consumed: !!r.consumed, proxy: !!r.proxy, proxyFor: r.proxyFor || '', category: r.category || ''
});

async function pushPending() {
  for (const st of S.stores.filter(s => s.pending)) {
    const o = await api('addStore', { name: st.name, category: st.category });
    st.id = o.id; delete st.pending;
  }
  await saveStores();
  if (S.budgetDirty) {
    await api('setBudget', { budgetTWD: S.user.budgetTWD });
    S.budgetDirty = false; await kvSet('budgetDirty', false);
  }
  const pend = S.receipts.filter(r => r.sync && r.sync !== 'synced');
  for (const r of pend) {
    if (r.sync === 'delete') {
      await api('deleteReceipt', { id: r.id });
      await delReceipt(r.id); await delPhoto(r.id);
      S.receipts = S.receipts.filter(x => x.id !== r.id);
      continue;
    }
    const payload = { receipt: pickFields(r) };
    if (!r.photoFileId) {
      const ph = await getPhotoRec(r.id);
      if (ph && ph.blob) payload.photoBase64 = await blobToB64(ph.blob);
    }
    const o = await api('saveReceipt', payload);
    r.photoFileId = o.photoFileId || r.photoFileId;
    r.sync = 'synced';
    await putReceipt(r);
  }
}

async function sync(manual) {
  if (S.syncing || !S.user) return;
  if (!navigator.onLine) { if (manual) toast('離線中，連線後自動上傳'); return; }
  if (configMissing()) return;
  S.syncing = true; renderChrome();
  try {
    await pushPending();
    await pullInit();
    S.lastSync = Date.now();
    if (manual) toast('已同步');
  } catch (e) {
    if (e.code === 'AUTH') { S.needLogin = true; if (manual) toast('請先重新登入'); }
    else if (e.code === 'FORBIDDEN') { toast(e.message); }
    else if (manual || e.code !== 'NET') toast('同步失敗：' + e.message);
  } finally {
    S.syncing = false; render();
  }
}

/* ========== 匯率 ========== */
async function loadRate(force) {
  const c = await kvGet('rate');
  if (c) { S.rate = c.v; S.rateTs = c.ts; S.rateManual = !!c.manual; }
  if (S.rateManual && !force) return;
  if (!navigator.onLine) return;
  if (!force && c && Date.now() - c.ts < 6 * 3600e3) return;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/JPY');
    const j = await r.json();
    const v = j && j.rates && j.rates.TWD;
    if (v) {
      S.rate = v; S.rateTs = Date.now(); S.rateManual = false;
      await kvSet('rate', { v, ts: S.rateTs, manual: false });
      render();
      if (force) toast('匯率已更新');
    }
  } catch (e) { if (force) toast('匯率更新失敗'); }
}
function rateNote() {
  if (!S.rate) return '預設值（尚未取得即時匯率）';
  if (S.rateManual) return '手動設定';
  return '更新於 ' + new Date(S.rateTs).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ========== 畫面 ========== */
function renderChrome() {
  if (!S.user) return;
  const pend = pendingCount();
  const chip = $('#syncChip');
  let t, cls = 'chip';
  if (!navigator.onLine) { t = '離線' + (pend ? ' · 待上傳 ' + pend : ''); cls += ' off'; }
  else if (S.syncing) t = '同步中…';
  else if (pend) { t = '待上傳 ' + pend; cls += ' pending'; }
  else t = '已同步';
  chip.textContent = t; chip.className = cls;

  const sb = $('#scopeBox');
  sb.hidden = S.user.role !== 'admin';
  sb.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === S.scope));

  const bn = $('#banner');
  if (S.needLogin) { bn.hidden = false; bn.innerHTML = '登入已過期。<button data-act="relogin">點此重新登入</button>（待上傳的收據不會消失）'; }
  else if (configMissing()) { bn.hidden = false; bn.textContent = '尚未設定 config.js（API_URL / GOOGLE_CLIENT_ID）'; }
  else bn.hidden = true;

  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
  $('#fab').hidden = !(S.view === 'home' || S.view === 'receipts');
}

function render() {
  if (!S.user) return;
  renderChrome();
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest('#view') && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) return;
  $('#view').innerHTML = ({ home: viewHome, receipts: viewReceipts, tax: viewTax, coupons: viewCoupons, settings: viewSettings })[S.view]();
  hydrateThumbs();
}

async function hydrateThumbs() {
  const els = document.querySelectorAll('[data-thumb]');
  for (const el of els) {
    const id = el.dataset.thumb;
    let url = thumbCache.get(id);
    if (!url) {
      const p = await getPhotoRec(id);
      if (p && p.blob) { url = URL.createObjectURL(p.blob); thumbCache.set(id, url); }
    }
    if (url) { el.style.backgroundImage = 'url("' + url + '")'; el.textContent = ''; }
  }
}

/* ----- 首頁 ----- */
function viewHome() {
  const list = scoped(), rt = rate();
  const G = C.groupReceipts(list, TH);
  const incl = sumBy(list, 'amountIncl');
  const inclProxy = sumBy(list.filter(r => r.proxy), 'amountIncl');
  const refund = G.reduce((a, g) => a + g.refund, 0);
  const fee = feeOfGroups(G), net = Math.max(0, refund - fee), rsp = refundSplit(G), netOwn = Math.max(0, rsp.own - feeOfGroups(G.map(g => Object.assign({}, g, { receipts: g.receipts.filter(r => !r.proxy) }))));
  const today = C.localDate();
  let h = '<div class="section"><div class="kpi">' +
    '<div class="card"><div class="lab">總花費（含稅）</div><div class="big">' + yen(incl) + '</div><div class="sub">≈ ' + twd(C.toTWD(incl, rt)) + '</div>' + '</div>' +
    '<div class="card refund"><div class="lab">預估退稅</div><div class="big">' + yen(refund) + '</div><div class="sub">≈ ' + twd(C.toTWD(refund, rt)) + '</div>' + (refund > 0 ? '<div class="sub">實拿約 ' + yen(net) + '（估）</div>' : '') + (rsp.proxy > 0 ? '<div class="sub">不含代購 ' + yen(rsp.own) + '</div><div class="sub">代購 ' + yen(rsp.proxy) + '</div>' : '') + '</div>' +
    '</div></div>';

  if (S.scope === 'me') {
    const budget = S.user.budgetTWD || 0;
    const spent = C.toTWD(incl - inclProxy, rt);
    const bs = C.budgetStatus(spent, budget);
    h += '<div class="section"><h2>預算</h2><div class="card">';
    if (bs.level === 'none') {
      h += '<p class="muted">還沒設定預算。</p><p style="margin-top:8px"><button class="btn line" data-act="tab" data-v="settings">去設定預算</button></p>';
    } else {
      const pct = Math.min(100, Math.round(bs.ratio * 100));
      const msg = bs.level === 'over' ? '已超過預算 ' + twd(spent - budget)
        : bs.level === 'warn' ? '已用 ' + pct + '%，快到上限了' : '';
      const left0 = Math.max(0, budget - spent);
      const left1 = Math.max(0, budget - Math.max(0, spent - C.toTWD(netOwn, rt)));
      const row = (k, v) => '<div class="row" style="margin-top:6px;gap:12px"><span class="small muted">' + k + '</span><span class="num"><b>' + v + '</b></span></div>';
      h += '<div class="num"><b>' + twd(spent) + '</b> <span class="muted">/ ' + twd(budget) + '</span></div>' +
        '<div class="meter ' + (bs.level === 'ok' ? '' : bs.level) + '"><i style="width:' + pct + '%"></i></div>' +
        (msg ? '<div class="small" style="' + (bs.level === 'over' ? 'color:var(--red);font-weight:700' : 'color:var(--muted)') + '">' + msg + '</div>' : '') +
        row('剩餘', twd(left0)) +
        row('退稅後（估）', twd(left1));
    }
    h += '</div></div>';
  }

  if (inclProxy > 0) {
    const nProxy = list.filter(r => r.proxy && r.amountIncl > 0).length;
    const prow = (k, v) => '<div class="row" style="margin-top:6px;gap:12px"><span class="small muted">' + k + '</span><span class="num"><b>' + v + '</b></span></div>';
    h += '<div class="section"><h2>代購</h2><div class="card">' +
      prow('總額（' + nProxy + ' 張）', yen(inclProxy) + ' <span class="small muted">≈ ' + twd(C.toTWD(inclProxy, rt)) + '</span>') +
      prow('退稅（估）', yen(rsp.proxy)) + '</div></div>';
  }

  const alerts = [];
  G.filter(g => g.date === today && !g.eligible && g.excl > 0).forEach(g => {
    alerts.push('<div class="alert warn"><b>' + esc(g.store) + '</b> 今天未稅 ' + yen(g.excl) + '，再買 <b>' + yen(g.shortfall) + '</b>（未稅）就能退稅</div>');
  });
  const nDraft = list.filter(isDraft).length;
  const noAmt = list.filter(r => !isDraft(r) && r.needsReview && !r.amountIncl).length;
  const toCheck = list.filter(r => !isDraft(r) && r.needsReview && r.amountIncl > 0).length;
  if (nDraft) alerts.push('<div class="alert bad">有 <b>' + nDraft + '</b> 張照片還沒 AI 辨識</div>');
  if (noAmt) alerts.push('<div class="alert bad">有 <b>' + noAmt + '</b> 張收據還沒補金額</div>');
  if (toCheck) alerts.push('<div class="alert bad">有 <b>' + toCheck + '</b> 張待核對</div>');
  const unpacked = G.filter(g => g.eligible && !g.packedAll).length;
  if (unpacked) alerts.push('<div class="alert">有 <b>' + unpacked + '</b> 組已達標，尚未打包</div>');
  G.filter(g => g.eligible).forEach(g => {
    const d = C.daysLeft(g.date, today, CFG.DEADLINE_DAYS);
    if (d <= 14) alerts.push('<div class="alert ' + (d <= 7 ? 'bad' : 'warn') + '"><b>' + esc(g.store) + '</b>（' + esc(g.date) + '）' + (d < 0 ? '已超過出境期限' : '要在 ' + d + ' 天內出境') + '</div>');
  });
  h += '<div class="section"><h2>提醒</h2>' + (alerts.length ? alerts.join('') : '<p class="muted">沒有待辦</p>') + '</div>';
  h += pieCard(list, rt);
  h += '<p class="small muted">1 日圓 ＝ ' + rt.toFixed(4) + ' 台幣 · ' + esc(rateNote()) + '</p>';
  return h;
}


/* ----- 花費分類圓餅圖（依店家分類，不含代購） ----- */
const RCATS = ['飲食', '藥妝', '電器', '服飾雜貨', '百貨', '綜合量販', '其他'];
const PIE_COLORS = ['#1F3A5F', '#B5452F', '#3E6B8C', '#C9962B', '#5E8C61', '#8A5A8C', '#7A8794'];
function spendByCategory(list) {
  const cat = {};
  S.stores.forEach(st => { cat[st.name] = st.category || '其他'; });
  const m = {};
  list.filter(r => !r.proxy && r.amountIncl > 0 && !isDraft(r)).forEach(r => { const c = r.category || cat[r.store] || '其他'; m[c] = (m[c] || 0) + r.amountIncl; });
  return Object.keys(m).map(k => ({ k, v: m[k] })).sort((a, b) => b.v - a.v);
}
function pieCard(list, rt) {
  const rows = spendByCategory(list), tot = rows.reduce((a, x) => a + x.v, 0);
  if (!tot) return '';
  const R = 15.915, CIR = 100; let off = 25, segs = '', leg = '';
  rows.forEach((x, i) => {
    const p = x.v / tot * 100, col = PIE_COLORS[i % PIE_COLORS.length];
    segs += '<circle cx="21" cy="21" r="' + R + '" fill="none" stroke="' + col + '" stroke-width="7" stroke-dasharray="' + p.toFixed(3) + ' ' + (CIR - p).toFixed(3) + '" stroke-dashoffset="' + off.toFixed(3) + '"></circle>';
    off -= p;
    leg += '<div class="pie-row"><span class="dot" style="background:' + col + '"></span><span class="pie-k">' + esc(x.k) + '</span><span class="pie-v num">' + yen(x.v) + '</span><span class="pie-p num">' + Math.round(p) + '%</span></div>';
  });
  return '<div class="section"><h2>花費分類</h2><div class="card"><div class="pie-wrap"><svg viewBox="0 0 42 42" class="pie">' + segs + '</svg></div>' + leg +
    '<div class="pie-row pie-tot"><span class="pie-k">合計（不含代購）</span><span class="pie-v num">' + yen(tot) + '</span><span class="pie-p small muted">≈ ' + twd(C.toTWD(tot, rt)) + '</span></div></div></div>';
}

/* ----- 退稅公司篩選與統計 ----- */
const DRAFT = '（待辨識）';
const NO_CO = '未選';
const isDraft = r => r.store === DRAFT;
const coOf = r => r.refundCo || NO_CO;
const matchCo = r => !S.refundFilter || coOf(r) === S.refundFilter;
function coOrder(a, b) {
  const rank = k => k === NO_CO ? 999 : (REFUND_COS.indexOf(k) < 0 ? 500 : REFUND_COS.indexOf(k));
  return rank(a) - rank(b) || String(a).localeCompare(String(b));
}
function refundFilterBar(list) {
  const cnt = new Map();
  list.forEach(r => cnt.set(coOf(r), (cnt.get(coOf(r)) || 0) + 1));
  const cur = S.refundFilter || '';
  const keys = Array.from(cnt.keys());
  if (cur && !cnt.has(cur)) keys.push(cur);
  keys.sort(coOrder);
  let h = '<div class="field" style="margin-bottom:10px"><select id="refundFilter" class="select"><option value="">全部退稅公司（' + list.length + ' 張）</option>';
  keys.forEach(k => { h += '<option value="' + esc(k) + '"' + (k === cur ? ' selected' : '') + '>' + esc(k) + '（' + (cnt.get(k) || 0) + ' 張）</option>'; });
  return h + '</select></div>';
}
/* 依退稅公司彙總。gm = 完整分組（門檻要用全部收據判斷，不能先篩再分組） */
function summarizeByCo(list, gm) {
  const m = new Map();
  list.filter(r => r.amountIncl > 0).forEach(r => {
    const k = coOf(r);
    const o = m.get(k) || { co: k, n: 0, incl: 0, refund: 0, fee: 0 };
    const g = gm.get(C.groupKey(r));
    o.n++; o.incl += r.amountIncl; if (g && g.eligible && !r.consumed) { o.refund += r.tax || 0; o.fee += feeOf(r); }
    m.set(k, o);
  });
  return Array.from(m.values()).sort((a, b) => coOrder(a.co, b.co));
}
function coSummaryLine(o, rt) {
  return o.n + ' 張 · 含稅 ' + yen(o.incl) + ' · 預估退稅 ' + yen(o.refund) + '（≈ ' + twd(C.toTWD(o.refund, rt)) + '）' + (o.refund > 0 ? ' · 實拿約 ' + yen(Math.max(0, o.refund - o.fee)) : '');
}

/* ----- 收據 ----- */
function viewReceipts() {
  const all = scoped().slice().sort((a, b) => String(b.date).localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  if (!all.length) return '<div class="empty">還沒有收據。<br>按右下角「＋ 新增收據」開始記錄。</div>' +
    '<button class="btn line" data-act="multi">一次選多張照片</button>';
  const gm = new Map(C.groupReceipts(all, TH).map(g => [g.key, g]));
  const list = all.filter(matchCo);
  const rt = rate();
  const nd = all.filter(isDraft).length;
  let h = '<button class="btn line" style="margin-bottom:10px" data-act="multi">一次選多張照片</button>';
  if (nd) h += '<div class="note" style="margin-bottom:10px"><b>' + nd + '</b> 張待辨識。點開單張，或按下面一次辨識全部。</div>' +
    '<button id="batchBtn" class="btn" style="margin-bottom:10px" data-act="batch-ocr">' + (S.batchBusy ? '辨識中…' : '一鍵辨識全部待辨識（' + nd + ' 張）') + '</button>';
  h += refundFilterBar(all);
  if (S.refundFilter) {
    const o = summarizeByCo(list, gm)[0];
    h += '<div class="note" style="margin-bottom:10px">' + (o ? coSummaryLine(o, rt) : '這個分類還沒有金額資料') + '</div>';
  }
  if (!list.length) return h + '<div class="empty">沒有符合的收據。</div>';
  let last = '';
  list.forEach(r => {
    if (r.date !== last) { h += '<div class="day">' + esc(r.date) + '</div>'; last = r.date; }
    const g = gm.get(C.groupKey(r));
    let b = '';
    if (r.sync && r.sync !== 'synced') b += '<span class="badge warn">待上傳</span>';
    if (isDraft(r)) b += '<span class="badge bad">待辨識</span>';
    else if (r.needsReview && !r.amountIncl) b += '<span class="badge bad">待補金額</span>';
    else if (r.needsReview) b += '<span class="badge bad">待核對</span>';
    else if (g) b += g.eligible ? '<span class="badge ok">可退稅</span>' : '<span class="badge warn">未達門檻</span>';
    if (r.refundCo) b += '<span class="badge">' + esc(r.refundCo.replace(/（.*）/, '')) + '</span>';
    if (r.consumed) b += '<span class="badge warn">馬上吃掉／使用</span>';
    if (r.proxy) b += '<span class="badge">代購' + (r.proxyFor ? '：' + esc(r.proxyFor) : '') + '</span>';
    if (r.packed) b += '<span class="badge ok">已打包</span>';
    if (S.scope === 'all') b += '<span class="badge">' + esc(r.ownerName) + '</span>';
    h += '<button class="item" data-act="edit" data-id="' + esc(r.id) + '">' +
      '<div class="thumb" data-thumb="' + esc(r.id) + '">' + (r.photoFileId ? '照片' : '—') + '</div>' +
      '<div class="meta"><div class="store">' + esc(r.store) + '</div>' +
      '<div class="amt">' + yen(r.amountIncl) + '<small>' + twd(C.toTWD(r.amountIncl, rt)) + '</small></div>' +
      '<div class="badges">' + b + '</div></div></button>';
  });
  return h;
}

/* ----- 退稅清單（機場用） ----- */
function viewTax() {
  const list = scoped().filter(r => r.amountIncl > 0);
  const G = C.groupReceipts(list, TH);
  const el = G.filter(g => g.eligible);
  const refund = el.reduce((a, g) => a + g.refund, 0);
  const fee = feeOfGroups(G), net = Math.max(0, refund - fee), rsp = refundSplit(G);
  const packed = el.filter(g => g.packedAll).length;
  const rt = rate(), today = C.localDate();
  let h = '<div class="section"><div class="card"><div class="lab small muted">預估退稅合計</div>' +
    '<div class="num" style="font-size:24px;font-weight:700;color:var(--red)">' + yen(refund) + '</div>' +
    '<div class="num small muted">≈ ' + twd(C.toTWD(refund, rt)) + ' · 已打包 ' + packed + ' / ' + el.length + ' 組</div>' +
    (refund > 0 ? '<div class="num small" style="margin-top:6px">實拿約 <b>' + yen(net) + '</b> <span class="muted">（≈ ' + twd(C.toTWD(net, rt)) + '，手續費約 ' + yen(fee) + '，網友行情估算）</span></div>' : '') + (rsp.proxy > 0 ? '<div class="num small" style="margin-top:4px">不含代購 <b>' + yen(rsp.own) + '</b> <span class="muted">／ 代購部分 ' + yen(rsp.proxy) + '</span></div>' : '') + '</div></div>';
  h += '<div class="note" style="margin-bottom:14px">新制三步：① 先付含稅價 ② 出境前到機場海關確認 ③ 購買日起 ' + CFG.DEADLINE_DAYS + ' 天內出境。<br><b>金額以實際結算為準。</b></div>';
  h += '<div class="btn-row" style="margin-bottom:12px"><button class="btn ' + (S.onlyEligible ? '' : 'line') + '" data-act="filter-eligible">' + (S.onlyEligible ? '顯示全部' : '只看可退稅') + '</button></div>';
  const gm = new Map(G.map(g => [g.key, g]));
  const sums = summarizeByCo(list, gm);
  if (sums.length) {
    h += '<div class="card" style="margin-bottom:12px"><div class="lab small muted" style="margin-bottom:6px">各退稅公司（預估退稅）</div>' +
      sums.map(o => '<div class="row" style="margin-bottom:4px"><span>' + esc(o.co) + ' <span class="small muted">' + o.n + ' 張</span></span><span class="num"><b>' + yen(o.refund) + '</b> <span class="small muted">≈ ' + twd(C.toTWD(o.refund, rt)) + (o.refund > 0 ? '；實拿約 ' + yen(Math.max(0, o.refund - o.fee)) : '') + '</span></span></div>').join('') + '</div>';
  }
  h += refundFilterBar(list);
  const hasCo = g => !S.refundFilter || g.receipts.some(matchCo);
  const show = (S.onlyEligible ? el : G).filter(hasCo);
  if (!show.length) return h + '<div class="empty">沒有資料。</div>';
  show.forEach(g => {
    const own = g.owner === S.user.email;
    let status;
    if (g.eligible) {
      const d = C.daysLeft(g.date, today, CFG.DEADLINE_DAYS);
      status = '<span class="badge ok">已達 ' + yen(TH) + ' 門檻</span> <span class="small ' + (d <= 7 ? '' : 'muted') + '" style="' + (d <= 7 ? 'color:var(--red);font-weight:700' : '') + '">出境期限 ' + C.deadlineDate(g.date, CFG.DEADLINE_DAYS) + '（' + (d < 0 ? '已過期' : '剩 ' + d + ' 天') + '）</span>';
    } else {
      status = '<span class="badge warn">未達門檻</span> <span class="small muted">還差 ' + yen(g.shortfall) + '（未稅）</span>';
    }
    h += '<div class="group ' + (g.eligible ? '' : 'no') + '">' +
      '<div class="row"><span class="name">' + esc(g.store) + '</span><span class="refund">' + (g.eligible ? '退 ' + yen(g.refund) : '') + '</span></div>' +
      '<div class="row"><span class="date">' + esc(g.date) + (S.scope === 'all' ? ' · ' + esc(g.ownerName) : '') + ' · ' + g.receipts.length + ' 張</span><span class="small num">未稅 ' + yen(g.excl) + '</span></div>' +
      '<div style="margin-top:6px">' + status + '</div>' +
      '<div class="thumbs">' + g.receipts.map(r => '<button class="thumb" data-act="edit" data-id="' + esc(r.id) + '" data-thumb="' + esc(r.id) + '">' + (r.photoFileId ? '照片' : '—') + '</button>').join('') + '</div>' +
      (g.eligible ? '<label class="check"><input type="checkbox" data-act="pack" data-key="' + esc(g.key) + '" ' + (g.packedAll ? 'checked' : '') + (own ? '' : ' disabled') + '> 已放進隨身行李（可通過海關確認）</label>' : '') +
      '</div>';
  });
  return h;
}

/* ----- 設定 ----- */
function viewSettings() {
  const pend = pendingCount();
  const admin = S.user.role === 'admin';
  return '' +
    '<div class="section"><h2>匯率</h2><div class="card">' +
    '<p class="num"><b>1 日圓 ＝ ' + rate().toFixed(4) + ' 台幣</b></p><p class="small muted" style="margin-bottom:10px">' + esc(rateNote()) + '</p>' +
    '<div class="field"><label>手動設定匯率（例如刷卡實際匯率）</label><input id="rateInput" class="input" type="number" inputmode="decimal" step="0.0001" placeholder="' + rate().toFixed(4) + '"></div>' +
    '<div class="btn-row"><button class="btn line" data-act="rate-manual">套用手動匯率</button><button class="btn line" data-act="rate-auto">自動更新</button></div></div></div>' +

    '<div class="section"><h2>我的預算（台幣）</h2><div class="card">' +
    '<div class="field"><input id="budgetInput" class="input" type="number" inputmode="numeric" value="' + (S.user.budgetTWD || '') + '" placeholder="例如 30000"></div>' +
    '<button class="btn" data-act="save-budget">儲存預算</button></div></div>' +

    '<div class="section"><h2>匯出 Excel</h2><div class="card">' +
    '<button class="btn" data-act="export-me">匯出我的收據</button>' +
    (admin ? '<button class="btn line" data-act="export-all">匯出全部人員</button>' : '') +
    '<p class="small muted" style="margin-top:10px">包含明細、店家日彙總、人員彙總三張工作表，匯率以目前設定為準。</p></div></div>' +

    '<div class="section"><h2>店家清單</h2><div class="card">' +
    '<p class="small muted" style="margin-bottom:8px">目前 ' + S.stores.length + ' 間。預設是常見店家，實際能否退稅以店內「Tax-free」標示為準。</p>' +
    '<div class="field"><input id="newStore" class="input" placeholder="新增店家名稱"></div>' +
    '<button class="btn line" data-act="add-store">新增店家</button></div></div>' +

    '<div class="section"><h2>同步與備份</h2><div class="card">' +
    '<p class="small muted" style="margin-bottom:10px">' + (pend ? '還有 <b>' + pend + '</b> 筆待上傳，連上網路會自動補傳。' : '所有收據都已上傳。') + (S.lastSync ? ' 上次同步 ' + new Date(S.lastSync).toLocaleTimeString('zh-TW', { hour12: false }) : '') + '</p>' +
    '<button class="btn" data-act="sync">立即同步</button>' +
    '<button class="btn line" data-act="backup">匯出待上傳備份（JSON）</button>' +
    '<button class="btn line" data-act="import">匯入備份</button></div></div>' +

    '<div class="section"><h2>帳號</h2><div class="card">' +
    '<p>' + esc(S.user.name) + (admin ? '（管理者）' : '') + '</p><p class="small muted" style="margin-bottom:10px">' + esc(S.user.email) + '</p>' +
    '<button class="btn ghost" data-act="logout">登出並清除這支手機的資料</button></div></div>' +
    '<p class="small muted" style="text-align:center">版本 ' + VERSION + '</p>';
}

/* ========== 收據表單（彈出視窗） ========== */
let F = null;

function openModal(html) { const m = $('#modal'); m.innerHTML = '<div class="back" data-act="close-modal"></div>' + html; m.hidden = false; }
function closeModal() {
  $('#modal').hidden = true; $('#modal').innerHTML = '';
  if (F && F.photoUrl) URL.revokeObjectURL(F.photoUrl);
  F = null;
}

async function openReceipt(id) {
  const ex = id ? S.receipts.find(r => r.id === id) : null;
  F = { id: ex ? ex.id : uid(), isNew: !ex, readonly: !!(ex && ex.owner !== S.user.email), base: ex ? Object.assign({}, ex) : null, photoBlob: null, photoUrl: null, photoNew: false };
  if (ex) {
    const p = await getPhotoRec(ex.id);
    if (p && p.blob) { F.photoBlob = p.blob; F.photoUrl = URL.createObjectURL(p.blob); }
  }
  renderForm();
  if (ex && !F.photoBlob && ex.photoFileId && navigator.onLine) fetchRemotePhoto(ex.id);
  if (ex && !F.readonly && isDraft(ex) && F.photoBlob && navigator.onLine && !configMissing()) runOcr();
}

async function fetchRemotePhoto(id) {
  try {
    const o = await api('getPhoto', { id });
    const blob = b64ToBlob(o.base64, o.mime);
    await putPhoto(id, blob);
    if (F && F.id === id && !F.photoBlob) { F.photoBlob = blob; F.photoUrl = URL.createObjectURL(blob); setPhotoBox(); }
  } catch (e) { /* 照片抓不到就算了 */ }
}

function refundOptions(sel) {
  let h = '<option value="">選擇（看收據 QR Code）</option>';
  REFUND_COS.forEach(c => { h += '<option value="' + esc(c) + '"' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>'; });
  if (sel && REFUND_COS.indexOf(sel) < 0) h += '<option value="' + esc(sel) + '" selected>' + esc(sel) + '</option>';
  return h;
}

/* 同一間店上次選過的退稅公司，下次選到這間店就自動帶入 */
/* 各店常用的退稅公司與手續費（網友整理，僅供預設與估算，以現場為準）
   fee: {p: 佔未稅價%, base:'incl' 則佔含稅價} 或 {fix: 每張固定日圓} */
const CO_J = 'J&J Tax Free（J-TaxRefund）', CO_GB = 'Global Blue', CO_JP = 'Smart Detax（JP Refund）', CO_PIE = 'PIE VAT';
const STORE_RULES = [
  [/bic ?camera|ビック|山田|yamada|唐吉|donki|ドンキ|札幌|sapporo|sundrug|サンドラッグ|鶴羽|tsuruha|多慶屋|kojima|sofmap/i, CO_J, { p: 0 }],
  [/松本清|マツモト|cocokara|ココカラ/i, CO_J, { p: 0.33 }],
  [/東武|^gu$|ジーユー|uniqlo|ユニクロ|優衣庫/i, CO_J, { p: 1 }],
  [/edion|愛電王|エディオン/i, CO_GB, { fix: 210 }],
  [/sugi|スギ薬局|杉藥局/i, CO_GB, { p: 1.6 }],
  [/大丸|daimaru|松坂屋|阪急|hankyu|阪神|hanshin/i, CO_GB, { p: 2.3 }],
  [/國民|kokumin|コクミン/i, CO_JP, { p: 1.25 }],
  [/阿卡將|akachan|アカチャン/i, CO_JP, { p: 1.1, base: 'incl' }],
  [/3 ?coins|スリーコインズ/i, CO_JP, { fix: 320 }],
  [/三井|mitsui|lalaport/i, CO_PIE, { p: 1.5 }]
];
const CO_FEE = {}; CO_FEE[CO_J] = { p: 1 }; CO_FEE[CO_GB] = { p: 2.3 }; CO_FEE[CO_JP] = { p: 1.5 }; CO_FEE[CO_PIE] = { p: 1.5 };
const FEE_GUESS = { p: 1.5 };
function storeRule(store) {
  const n = String(store || '').trim();
  for (let i = 0; i < STORE_RULES.length; i++) if (STORE_RULES[i][0].test(n)) return STORE_RULES[i];
  return null;
}
function defaultCoFor(store) {
  const r = storeRule(store);
  return r && REFUND_COS.indexOf(r[1]) >= 0 ? r[1] : '';
}
/* 單張收據的預估手續費（日圓）：店家規則優先；沒規則就用退稅公司的一般行情 */
function feeOf(r) {
  const tax = Number(r.tax) || 0;
  if (!(tax > 0) || r.consumed) return 0;
  const sr = storeRule(r.store);
  let f = sr && (!r.refundCo || r.refundCo === sr[1]) ? sr[2] : (CO_FEE[r.refundCo] || FEE_GUESS);
  const v = f.fix != null ? f.fix : Math.round((f.base === 'incl' ? (Number(r.amountIncl) || 0) : (Number(r.amountExcl) || Number(r.amountIncl) - tax)) * f.p / 100);
  return Math.min(tax, Math.max(0, v));
}
/* 退稅拆成「全部」與「其中代購」 */
function refundSplit(G) {
  let all = 0, proxy = 0;
  G.filter(g => g.eligible).forEach(g => g.receipts.forEach(r => { if (!r.consumed) { all += r.tax || 0; if (r.proxy) proxy += r.tax || 0; } }));
  return { all, proxy, own: all - proxy };
}
const feeOfGroups = G => G.filter(g => g.eligible).reduce((a, g) => a + g.receipts.reduce((b, r) => b + feeOf(r), 0), 0);
function lastRefundFor(store) {
  if (!store) return '';
  const l = S.receipts.filter(r => r.store === store && r.refundCo).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return l.length ? l[0].refundCo : defaultCoFor(store);
}
function autoRefund() {
  const sel = $('#fRefund');
  if (!sel || F.readonly || (F.refundTouched && sel.value)) return;
  const st = $('#fStore').value;
  const v = st && st !== '__other' ? lastRefundFor(st) : '';
  if (v) sel.value = v;
}

function storeOptions(sel) {
  const cats = {};
  S.stores.forEach(s => { const c = s.category || '其他'; (cats[c] = cats[c] || []).push(s); });
  let h = '<option value="">選擇店家…</option>';
  Object.keys(cats).forEach(c => {
    h += '<optgroup label="' + esc(c) + '">' + cats[c].map(s => '<option value="' + esc(s.name) + '"' + (s.name === sel ? ' selected' : '') + '>' + esc(s.name) + (s.nameJa ? '　' + esc(s.nameJa) : '') + '</option>').join('') + '</optgroup>';
  });
  return h + '<option value="__other"' + (sel === '__other' ? ' selected' : '') + '>＋ 其他店家（自行輸入）</option>';
}

function renderForm() {
  const b = Object.assign({}, F.base || {});
  if (b.store === DRAFT) b.store = '';
  const inList = S.stores.some(s => s.name === b.store);
  const selVal = b.store ? (inList ? b.store : '__other') : '';
  const incl = b.amountIncl || '';
  let rateSel = '10';
  if (b.id) {
    const sp = C.splitTax(b.amountIncl, b.rate);
    rateSel = (b.rate === 8 || b.rate === 10) && sp.tax === b.tax ? String(b.rate) : (b.amountIncl ? 'x' : '10');
  }
  const ro = F.readonly ? ' disabled' : '';
  openModal(
    '<div class="sheet"><div class="sheet-head"><h2>' + (F.isNew ? '新增收據' : (F.readonly ? esc(b.ownerName) + ' 的收據' : '編輯收據')) + '</h2><button class="x" data-act="close-modal">×</button></div>' +
    '<div id="photoBox" class="photo-box"></div>' +
    '<div id="ocrWrap" style="margin-bottom:12px"></div>' +
    '<div class="field"><label>店家</label><select id="fStore" class="select"' + ro + '>' + storeOptions(selVal) + '</select>' +
    '<input id="fStoreOther" class="input" style="margin-top:6px" placeholder="輸入店名" value="' + esc(inList ? '' : (b.store || '')) + '"' + (selVal === '__other' ? '' : ' hidden') + ro + '></div>' +
    '<div class="field"><label>退稅公司</label><select id="fRefund" class="select"' + ro + '>' + refundOptions(b.refundCo || '') + '</select></div>' +
    '<div class="two"><div class="field"><label>購買日</label><input id="fDate" class="input" type="date" value="' + esc(b.date || C.localDate()) + '"' + ro + '></div>' +
    '<div class="field"><label>含稅金額（日圓）</label><input id="fIncl" class="input num" type="number" inputmode="numeric" value="' + esc(incl) + '" placeholder="收據上的合計"' + ro + '></div></div>' +
    '<div class="two"><div class="field"><label>稅率</label><select id="fRate" class="select"' + ro + '><option value="10"' + (rateSel === '10' ? ' selected' : '') + '>10%（一般商品）</option><option value="8"' + (rateSel === '8' ? ' selected' : '') + '>8%（食品、飲料）</option><option value="x"' + (rateSel === 'x' ? ' selected' : '') + '>混合／自填稅額</option></select></div>' +
    '<div class="field" id="fTaxWrap"><label>消費稅額（日圓）</label><input id="fTax" class="input num" type="number" inputmode="numeric" value="' + esc(b.tax || '') + '" placeholder="收據上的内消費税"' + ro + '></div></div>' +
    '<div id="calcBox" class="calcbox"></div>' +
    '<div class="field"><label>類別（圓餅圖用）</label><select id="fCat" class="select"' + ro + '><option value="">自動（依店家分類）</option>' + RCATS.map(c => '<option value="' + c + '"' + (b.category === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
    '<div class="field"><label>備註</label><input id="fNote" class="input" value="' + esc(b.note || '') + '" placeholder="例如：化妝水、零食"' + ro + '></div>' +
    '<label class="check" style="margin:0 0 6px"><input id="fPacked" type="checkbox"' + (b.packed ? ' checked' : '') + ro + '> 已放進隨身行李</label>' +
    '<label class="check" style="margin:0 0 2px"><input id="fConsumed" type="checkbox"' + (b.consumed ? ' checked' : '') + ro + '> 馬上吃掉／使用</label>' +
    '<p class="small muted" style="margin:0 0 14px 28px">食物、飲料、貼布、藥品、化妝品等在日本拆封或用掉的才勾；衣服穿著不用勾。要馬上用的，結帳請分開收據。</p>' +
    '<label class="check" style="margin:0 0 6px"><input id="fProxy" type="checkbox"' + (b.proxy ? ' checked' : '') + ro + '> 代購（幫別人買）</label>' +
    '<div class="field" id="fProxyWrap" style="' + (b.proxy ? '' : 'display:none') + '"><input id="fProxyFor" class="input" value="' + esc(b.proxyFor || '') + '" placeholder="幫誰買？例如：媽媽、同事小美"' + ro + '><p class="small muted" style="margin:4px 0 0">不計入預算，退稅照算</p></div>' +
    (F.readonly ? '<p class="muted small">這是別人的收據，只能查看。</p>' :
      '<button class="btn" data-act="save">儲存</button>' + (F.isNew ? '' : '<button class="btn ghost" style="color:var(--red)" data-act="delete">刪除這張收據</button>')) +
    '</div>');
  setPhotoBox();
  updateCalc();
}

function setPhotoBox() {
  const box = $('#photoBox');
  if (!box) return;
  if (F.photoUrl) {
    box.className = 'photo-box has';
    box.innerHTML = '<img src="' + F.photoUrl + '" alt="收據照片">';
  } else if (F.readonly) {
    box.className = 'photo-box'; box.innerHTML = '<span class="muted small">照片載入中或沒有照片</span>';
  } else {
    box.className = 'photo-box';
    box.innerHTML = '<button class="btn" style="width:auto" data-act="cam">拍照</button><button class="btn line" style="width:auto;margin:0" data-act="pick">從相簿選</button>' + (F.isNew ? '<button class="btn line" style="width:auto;margin:0" data-act="multi">一次選多張</button>' : '');
  }
  const ow = $('#ocrWrap');
  if (ow) {
    ow.innerHTML = (!F.readonly && F.photoBlob)
      ? '<div class="btn-row"><button id="ocrBtn" class="btn line" data-act="ocr">AI 辨識這張收據</button><button class="btn ghost" data-act="cam">重拍</button></div>'
      : '';
  }
}

function readForm() {
  const sel = $('#fStore').value;
  const store = sel === '__other' ? $('#fStoreOther').value.trim() : sel;
  const incl = Math.max(0, Math.round(Number($('#fIncl').value) || 0));
  const rs = $('#fRate').value;
  let rate, tax;
  if (rs === 'x') {
    tax = Math.max(0, Math.min(incl, Math.round(Number($('#fTax').value) || 0)));
    rate = incl - tax > 0 ? Math.round(tax / (incl - tax) * 100) : 10;
  } else { rate = Number(rs); tax = C.splitTax(incl, rate).tax; }
  return { store, date: $('#fDate').value, incl, rate, rs, tax, excl: incl - tax, note: $('#fNote').value.trim(), packed: $('#fPacked').checked, consumed: $('#fConsumed') ? $('#fConsumed').checked : false, refundCo: $('#fRefund') ? $('#fRefund').value : '', proxy: $('#fProxy') ? $('#fProxy').checked : false, proxyFor: $('#fProxyFor') ? $('#fProxyFor').value.trim() : '', category: $('#fCat') ? $('#fCat').value : '' };
}

function updateCalc() {
  if (!F || !$('#calcBox')) return;
  const f = readForm(), rt = rate();
  $('#fTaxWrap').style.visibility = f.rs === 'x' ? 'visible' : 'hidden';
  if (f.rs !== 'x') $('#fTax').value = f.incl ? f.tax : '';
  $('#fStoreOther').hidden = $('#fStore').value !== '__other';
  let h;
  if (!f.incl) h = '<span class="muted">輸入金額後顯示試算</span>';
  else {
    h = '<div class="l"><span>含稅</span><span class="num">' + yen(f.incl) + '（≈ ' + twd(C.toTWD(f.incl, rt)) + '）</span></div>' +
      '<div class="l"><span>消費稅</span><span class="num">' + yen(f.tax) + '</span></div>' +
      '<div class="l"><span>未稅</span><span class="num">' + yen(f.excl) + '</span></div>';
    if (f.store && f.date) {
      const owner = F.base ? F.base.owner : S.user.email;
      const others = visible().filter(r => r.id !== F.id && r.owner === owner && r.store === f.store && r.date === f.date && !r.consumed);
      const exclSum = sumBy(others, 'amountExcl') + (f.consumed ? 0 : f.excl);
      const taxSum = sumBy(others, 'tax') + (f.consumed ? 0 : f.tax);
      if (f.consumed) h += '<div class="l"><span class="no">馬上吃掉／使用</span><span class="num no">這張不計入退稅</span></div>';
      h += '<div class="l"><span>同店同日未稅累計</span><span class="num">' + yen(exclSum) + '</span></div>';
      h += exclSum >= TH
        ? '<div class="l"><span class="ok">已達門檻</span><span class="num ok">預估退 ' + yen(taxSum) + '</span></div>'
        : '<div class="l"><span class="no">未達門檻</span><span class="num no">再買 ' + yen(TH - exclSum) + '（未稅）</span></div>';
    }
  }
  $('#calcBox').innerHTML = h;
}

async function handlePhoto(file) {
  if (!file || !F) return;
  try {
    const blob = await compress(file);
    if (F.photoUrl) URL.revokeObjectURL(F.photoUrl);
    F.photoBlob = blob; F.photoUrl = URL.createObjectURL(blob); F.photoNew = true;
    setPhotoBox();
    if (navigator.onLine && F.isNew && !configMissing()) runOcr();
    else if (!navigator.onLine) toast('離線中，已先存照片，連線後再辨識');
  } catch (e) { toast('照片處理失敗，請再試一次'); }
}

async function runOcr() {
  if (!F || !F.photoBlob) return;
  if (!navigator.onLine) { toast('離線中，連線後再辨識'); return; }
  const btn = $('#ocrBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>辨識中…'; }
  try {
    const t0 = Date.now();
    const small = await compress(F.photoBlob, 1024, 0.7).catch(() => null);
    const o = await api('ocr', { photoBase64: await blobToB64(small || F.photoBlob) }, 60000);
    applyOcr(o);
    toast('已預填（' + String(o.model || '').replace('claude-', 'Claude ') + '，' + Math.round((Date.now() - t0) / 1000) + ' 秒），請核對金額與店家');
  } catch (e) {
    toast(e.code === 'AUTH' ? '請先重新登入' : e.message);
  } finally {
    const b2 = $('#ocrBtn');
    if (b2) { b2.disabled = false; b2.textContent = 'AI 辨識這張收據'; }
  }
}

function applyOcr(o) {
  if (!F || !$('#fStore')) return;
  const m = C.matchStore(o.store, S.stores);
  if (m) { $('#fStore').value = m.name; }
  else if (o.store) { $('#fStore').value = '__other'; $('#fStoreOther').value = String(o.store).slice(0, 40); }
  autoRefund();
  if (o.date && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) $('#fDate').value = o.date;
  if (o.totalIncl > 0) {
    $('#fIncl').value = o.totalIncl;
    const r = (o.rate === 8 || o.rate === 10) ? o.rate : 10;
    if (o.tax != null && o.tax >= 0 && o.tax !== C.splitTax(o.totalIncl, r).tax) {
      $('#fRate').value = 'x'; $('#fTax').value = o.tax;
    } else $('#fRate').value = String(r);
  }
  updateCalc();
}

async function saveForm() {
  if (!F || F.readonly) return;
  const f = readForm();
  if (!f.store) { toast('請選擇店家'); return; }
  if (!f.date) { toast('請選擇購買日'); return; }
  const base = F.base;
  const rec = {
    id: F.id, owner: S.user.email, ownerName: S.user.name,
    date: f.date, store: f.store, amountIncl: f.incl, tax: f.tax, amountExcl: f.excl, rate: f.rate,
    note: f.note, packed: f.packed, consumed: f.consumed, proxy: f.proxy, proxyFor: f.proxy ? f.proxyFor : '', category: f.category, refundCo: f.refundCo, needsReview: f.incl === 0,
    photoFileId: base ? base.photoFileId || '' : '',
    createdAt: base ? base.createdAt : Date.now(),
    sync: (!base || base.sync === 'add') ? 'add' : 'update'
  };
  if (F.photoNew && F.photoBlob) {
    await putPhoto(rec.id, F.photoBlob);
    const old = thumbCache.get(rec.id); if (old) { URL.revokeObjectURL(old); thumbCache.delete(rec.id); }
  }
  if (!S.stores.some(s => s.name.toLowerCase() === f.store.toLowerCase())) {
    S.stores.push({ id: 'L' + Date.now(), name: f.store, nameJa: '', aliases: '', category: '其他', pending: true });
    await saveStores();
  }
  await putReceipt(rec);
  const i = S.receipts.findIndex(r => r.id === rec.id);
  if (i >= 0) S.receipts[i] = rec; else S.receipts.push(rec);
  closeModal(); render();
  toast(rec.needsReview ? '已存檔，記得補上金額' : (navigator.onLine ? '已儲存' : '已存在手機，連網後自動上傳'));
  sync();
}

async function deleteForm() {
  if (!F || F.readonly || F.isNew) return;
  if (!confirm('確定刪除這張收據？')) return;
  const r = S.receipts.find(x => x.id === F.id);
  if (!r) return;
  if (r.sync === 'add') {
    await delReceipt(r.id); await delPhoto(r.id);
    S.receipts = S.receipts.filter(x => x.id !== r.id);
  } else {
    r.sync = 'delete'; await putReceipt(r);
  }
  closeModal(); render(); sync();
}

/* ========== 一次選多張照片：每張先建成「待辨識」草稿 ========== */
async function handleMulti(files) {
  files = Array.from(files || []);
  if (!files.length || !S.user) return;
  if (F) closeModal();
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    toast('處理照片 ' + (i + 1) + ' / ' + files.length + '…');
    try {
      const blob = await compress(files[i]);
      const rec = {
        id: uid(), owner: S.user.email, ownerName: S.user.name,
        date: C.localDate(), store: DRAFT, amountIncl: 0, tax: 0, amountExcl: 0, rate: 10,
        note: '', packed: false, refundCo: '', needsReview: true, photoFileId: '',
        createdAt: Date.now() + i, sync: 'add'
      };
      await putPhoto(rec.id, blob);
      await putReceipt(rec);
      S.receipts.push(rec); ok++;
    } catch (e) { /* 這張處理失敗就跳過 */ }
  }
  S.view = 'receipts'; S.refundFilter = '';
  render(true); window.scrollTo(0, 0);
  toast(ok ? '已建立 ' + ok + ' 張草稿，點開每張會自動 AI 辨識' + (ok < files.length ? '（' + (files.length - ok) + ' 張失敗）' : '') : '照片處理失敗，請再試一次');
  sync();
}

/* ========== 一鍵依序辨識所有草稿（一次一張，不會同時呼叫） ========== */
async function batchOcr() {
  if (S.batchBusy) return;
  if (!navigator.onLine) { toast('離線中，連線後再辨識'); return; }
  if (configMissing()) return;
  const drafts = scoped().filter(r => isDraft(r) && r.owner === S.user.email);
  if (!drafts.length) { toast('沒有待辨識的照片'); return; }
  S.batchBusy = true;
  let ok = 0, fail = 0, stop = '';
  for (let i = 0; i < drafts.length; i++) {
    const btn = $('#batchBtn'); if (btn) { btn.disabled = true; btn.textContent = '辨識中 ' + (i + 1) + ' / ' + drafts.length + '…'; }
    const r = drafts[i];
    try {
      const p = await getPhotoRec(r.id);
      if (!p || !p.blob) { fail++; continue; }
      const small = await compress(p.blob, 1024, 0.7).catch(() => null);
      const o = await api('ocr', { photoBase64: await blobToB64(small || p.blob) }, 60000);
      const m = C.matchStore(o.store, S.stores);
      const store = m ? m.name : (o.store ? String(o.store).slice(0, 40) : '');
      if (!store) { fail++; continue; }
      const incl = o.totalIncl > 0 ? Math.round(o.totalIncl) : 0;
      let rate = (o.rate === 8 || o.rate === 10) ? o.rate : 10, tax = C.splitTax(incl, rate).tax;
      if (incl && o.tax != null && o.tax >= 0 && o.tax !== tax) {
        tax = Math.min(incl, Math.round(o.tax));
        rate = incl - tax > 0 ? Math.round(tax / (incl - tax) * 100) : 10;
      }
      if (!S.stores.some(x => x.name.toLowerCase() === store.toLowerCase())) {
        S.stores.push({ id: 'L' + Date.now() + i, name: store, nameJa: '', aliases: '', category: '其他', pending: true });
        await saveStores();
      }
      Object.assign(r, {
        store, date: (o.date && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) ? o.date : r.date,
        amountIncl: incl, tax, amountExcl: incl - tax, rate, needsReview: true,
        refundCo: r.refundCo || lastRefundFor(store), sync: r.sync === 'add' ? 'add' : 'update'
      });
      await putReceipt(r);
      ok++;
    } catch (e) {
      fail++;
      if (e.code === 'AUTH') { stop = '請先重新登入'; break; }
      if (e.code === 'OCR_LIMIT') { stop = 'AI 辨識額度用完了，剩下的請手動輸入'; break; }
    }
    render(true);
  }
  S.batchBusy = false;
  render(true);
  toast(stop || ('完成：辨識 ' + ok + ' 張' + (fail ? '，' + fail + ' 張失敗（仍是待辨識）' : '') + '。請逐張點開核對金額'));
  sync();
}

/* ========== 匯出 Excel ========== */
function exportExcel(all) {
  if (typeof XLSX === 'undefined') { toast('Excel 元件尚未載入，請連網後再試一次'); return; }
  const rt = rate();
  const list = (all && S.user.role === 'admin' ? visible() : visible().filter(r => r.owner === S.user.email))
    .slice().sort((a, b) => String(a.date).localeCompare(b.date) || String(a.store).localeCompare(b.store));
  if (!list.length) { toast('沒有可匯出的收據'); return; }
  const G = C.groupReceipts(list, TH);
  const gm = new Map(G.map(g => [g.key, g]));
  const today = C.localDate();

  const rows = [['購買日', '購買者', '店家', '含稅金額(JPY)', '消費稅(JPY)', '未稅金額(JPY)', '稅率(%)', '含稅金額(TWD)', '同店同日是否達門檻', '預估退稅(JPY)', '預估退稅(TWD)', '出境期限', '剩餘天數', '已打包', '備註', '收據照片連結', '退稅公司', '馬上吃掉／使用', '代購', '幫誰買']];
  list.forEach(r => {
    const g = gm.get(C.groupKey(r));
    const ok = g && g.eligible && !r.consumed;
    rows.push([r.date, r.ownerName, r.store, r.amountIncl, r.tax, r.amountExcl, r.rate, C.toTWD(r.amountIncl, rt),
      ok ? '是' : '否', ok ? r.tax : 0, ok ? C.toTWD(r.tax, rt) : 0,
      C.deadlineDate(r.date, CFG.DEADLINE_DAYS), C.daysLeft(r.date, today, CFG.DEADLINE_DAYS),
      r.packed ? '是' : '否', r.note || '', r.photoFileId ? 'https://drive.google.com/file/d/' + r.photoFileId + '/view' : '', r.refundCo || '', r.consumed ? '是' : '否', r.proxy ? '是' : '否', r.proxy ? (r.proxyFor || '') : '']);
  });
  const n = rows.length;
  rows.push(['合計', '', '', { f: 'SUM(D2:D' + n + ')' }, { f: 'SUM(E2:E' + n + ')' }, { f: 'SUM(F2:F' + n + ')' }, '', { f: 'SUM(H2:H' + n + ')' }, '', { f: 'SUM(J2:J' + n + ')' }, { f: 'SUM(K2:K' + n + ')' }]);
  const ws1 = XLSX.utils.aoa_to_sheet(rows);
  ws1['!cols'] = [12, 10, 22, 14, 12, 14, 8, 14, 16, 14, 14, 12, 10, 8, 20, 40, 22, 16].map(w => ({ wch: w }));

  const rows2 = [['購買日', '購買者', '店家', '收據張數', '含稅合計(JPY)', '未稅合計(JPY)', '是否達 ' + TH.toLocaleString('en-US') + ' 門檻', '還差(JPY,未稅)', '預估退稅(JPY)', '預估退稅(TWD)', '已打包', '退稅公司']];
  G.slice().sort((a, b) => String(a.date).localeCompare(b.date) || String(a.store).localeCompare(b.store)).forEach(g => {
    rows2.push([g.date, g.ownerName, g.store, g.receipts.length, g.incl, g.excl, g.eligible ? '是' : '否', g.shortfall, g.refund, C.toTWD(g.refund, rt), g.eligible ? (g.packedAll ? '是' : '否') : '', Array.from(new Set(g.receipts.map(x => x.refundCo).filter(Boolean))).join('、')]);
  });
  const ws2 = XLSX.utils.aoa_to_sheet(rows2);
  ws2['!cols'] = [12, 10, 22, 10, 14, 14, 16, 14, 14, 14, 8, 22].map(w => ({ wch: w }));

  const byOwner = new Map();
  list.forEach(r => { (byOwner.get(r.owner) || byOwner.set(r.owner, []).get(r.owner)).push(r); });
  const rows3 = [['購買者', '收據張數', '含稅總額(JPY)', '含稅總額(TWD)', '預估退稅(JPY)', '預估退稅(TWD)', '預算(TWD)']];
  byOwner.forEach((rs, email) => {
    const gg = C.groupReceipts(rs, TH);
    const refund = gg.reduce((a, g) => a + g.refund, 0);
    const incl = sumBy(rs, 'amountIncl');
    rows3.push([rs[0].ownerName, rs.length, incl, C.toTWD(incl, rt), refund, C.toTWD(refund, rt), email === S.user.email ? (S.user.budgetTWD || '') : '']);
  });
  const ws3 = XLSX.utils.aoa_to_sheet(rows3);
  ws3['!cols'] = [12, 10, 16, 16, 16, 16, 12].map(w => ({ wch: w }));

  const gmAll = new Map(G.map(g => [g.key, g]));
  const rows5 = [['退稅公司', '購買者', '收據張數', '含稅合計(JPY)', '含稅合計(TWD)', '預估退稅(JPY)', '預估退稅(TWD)']];
  const coKeys = Array.from(new Set(list.filter(r => r.amountIncl > 0).map(coOf))).sort(coOrder);
  coKeys.forEach(co => {
    const owners = Array.from(new Set(list.filter(r => r.amountIncl > 0 && coOf(r) === co).map(r => r.owner)));
    owners.forEach(ow => {
      const o = summarizeByCo(list.filter(r => r.owner === ow && coOf(r) === co), gmAll)[0];
      if (o) rows5.push([co, (list.find(r => r.owner === ow) || {}).ownerName || ow, o.n, o.incl, C.toTWD(o.incl, rt), o.refund, C.toTWD(o.refund, rt)]);
    });
  });
  const n5 = rows5.length;
  rows5.push(['合計', '', { f: 'SUM(C2:C' + n5 + ')' }, { f: 'SUM(D2:D' + n5 + ')' }, { f: 'SUM(E2:E' + n5 + ')' }, { f: 'SUM(F2:F' + n5 + ')' }, { f: 'SUM(G2:G' + n5 + ')' }]);
  const ws5 = XLSX.utils.aoa_to_sheet(rows5);
  ws5['!cols'] = [26, 12, 10, 16, 16, 16, 16].map(w => ({ wch: w }));

  const rows4 = [['說明'], ['匯出時間', new Date().toLocaleString('zh-TW', { hour12: false })], ['換算匯率', '1 日圓 = ' + rt.toFixed(4) + ' 台幣（' + rateNote() + '）'],
    ['退稅門檻', '同一人、同一店、同一天，未稅合計達 ' + TH.toLocaleString('en-US') + ' 日圓'],
    ['出境期限', '購買日起 ' + CFG.DEADLINE_DAYS + ' 天'], ['注意', '預估值，實際金額以海關確認與退稅業者結算為準']];
  const ws4 = XLSX.utils.aoa_to_sheet(rows4);
  ws4['!cols'] = [{ wch: 12 }, { wch: 70 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, '明細');
  XLSX.utils.book_append_sheet(wb, ws2, '店家日彙總');
  XLSX.utils.book_append_sheet(wb, ws3, '人員彙總');
  XLSX.utils.book_append_sheet(wb, ws5, '依退稅公司');
  XLSX.utils.book_append_sheet(wb, ws4, '說明');
  XLSX.writeFile(wb, '日本購物收據_' + C.localDate().replace(/-/g, '') + (all ? '_全部' : '') + '.xlsx');
  toast('已匯出 Excel');
}

/* ========== 備份 ========== */
async function exportBackup() {
  const pend = S.receipts.filter(r => r.sync && r.sync !== 'synced' && r.sync !== 'delete');
  if (!pend.length) { toast('沒有待上傳的收據'); return; }
  const out = [];
  for (const r of pend) {
    const p = await getPhotoRec(r.id);
    out.push({ receipt: r, photo: p && p.blob ? await blobToB64(p.blob) : null });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ v: 1, items: out })], { type: 'application/json' }));
  a.download = '待上傳備份_' + C.localDate() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function importBackup(file) {
  try {
    const j = JSON.parse(await file.text());
    let n = 0;
    for (const it of (j.items || [])) {
      const r = it.receipt;
      if (!r || !r.id || S.receipts.some(x => x.id === r.id)) continue;
      r.owner = S.user.email; r.ownerName = S.user.name; r.sync = 'add';
      if (it.photo) await putPhoto(r.id, b64ToBlob(it.photo));
      await putReceipt(r); S.receipts.push(r); n++;
    }
    toast('已匯入 ' + n + ' 筆'); render(); sync();
  } catch (e) { toast('備份檔格式不正確'); }
}

/* ----- 優惠券 ----- */
// 圖片放在 coupons/ 資料夾；新增優惠券：加一筆資料 + 放圖片（xxx.jpg、xxx-t.jpg）
const COUPONS = [
  { id: 'alpen', name: 'Alpen／SPORTS DEPO／GOLF5', off: '5% OFF（全店）', exp: '2026-12-31', info: '運動用品。免稅需滿 ¥5,500（含稅）。不可與其他折扣併用。', must: '' },
  { id: 'cosmos', name: 'COSMOS 科摩思', off: '免稅＋5／7／9%', exp: '2026-12-31', info: '滿 ¥1萬／3萬／5萬（不含稅）。僅圖上 5 間指定店可用，每天限用一次。', must: '' },
  { id: 'snowpeak', name: 'Snow Peak', off: '退稅＋最大 7%', exp: '2027-03-31', info: '滿 ¥1萬送禮品；滿 3萬 5%；滿 5萬 7%。依金額掃對應那一條。需護照。', must: '依消費金額，掃對應的那一條條碼' },
  { id: 'keio', name: '京王百貨 新宿店', off: '5% OFF', exp: '2027-03-31', info: '滿 ¥3,000（不含稅）。限訪日旅客。結帳時出示，優待番號 76－110。', must: '' },
  { id: 'matsumoto', name: '松本清', off: '3／5／7%', exp: '2027-03-31', info: '滿 ¥1–3萬 3%、3–5萬 5%、5萬以上 7%。停留日本期間有效，可能不預告終止。', must: '' },
  { id: 'cocokara', name: 'Cocokara Fine', off: '3／5／7%', exp: '2027-03-31', info: '滿 ¥1–3萬 3%、3–5萬 5%、5萬以上 7%。一天上限 ¥50萬。', must: '' },
  { id: 'sapporo', name: '札幌藥妝', off: '免稅＋5%／7%', exp: null, info: '5%：一般金額；7%：滿 ¥38,888（不含稅）。券上未標示期限。', must: '' },
  { id: 'drug11', name: 'Drug Eleven', off: '3／5／7%', exp: '2027-02-28', info: '滿 ¥1–3萬 3%、3–5萬 5%、5萬以上 7%。石垣島四家門市、國際通店、福岡縣免稅店。', must: '' },
  { id: 'sugi', name: '杉藥局 Sugi', off: '14／16／18%', exp: '2027-02-28', info: '含免稅 10%。滿 ¥1–3萬 14%、3–5萬 16%、5萬以上 18%。免稅結帳時才能用。', must: '' },
  { id: 'yamada', name: '山田電機 YAMADA', off: '免稅 10%＋7% OFF', exp: '2027-03-31', info: '每次結帳限一張。折扣後須滿 ¥5,000（未稅）才能免稅。', must: '' },
  { id: 'biccamera', name: 'BicCamera／Kojima', off: '5%日用品／7%家電／3%清酒', exp: '2027-04-30', info: '折扣後滿 ¥5,000。免稅結帳時才能用。', must: '①、② 兩條條碼都要掃' },
  { id: 'daimaru', name: '大丸／松坂屋百貨', off: '退稅＋5% OFF＋美食券', exp: '2027-08-31', info: '滿 ¥3,000。需護照。食品、餐廳、咖啡廳除外。', must: '' },
  { id: 'tsuruha', name: '鶴羽藥妝 Tsuruha', off: '免稅 10%＋3／5／7%', exp: '2027-12-31', info: '滿 ¥1–3萬 3%、3–5萬 5%、5萬以上 7%。結帳前出示，結帳後不能補折。', must: '' },
  { id: 'sundrug', name: 'Sundrug 尚都樂客', off: '3／5／7%', exp: null, info: '滿 ¥1萬 3%、3萬 5%、5萬 7%。券上未標示期限。', must: '' },
  { id: 'kokumin', name: '國民藥妝 Kokumin', off: '5%／8%', exp: '2027-12-31', info: '滿 ¥1–3萬 5%、3萬以上 8%。Welcia 不適用。', must: '' },
  { id: 'edion', name: 'EDION 愛電王', off: '7%家電 或 5%食品藥妝', exp: '2027-12-31', info: '二選一。', must: '①、② 兩條條碼都要掃' }
];
function couponState(c) {
  if (!c.exp) return { cls: '', txt: '未標示期限', days: 99999, gone: false };
  const end = new Date(c.exp + 'T23:59:59'), d = Math.ceil((end - Date.now()) / 864e5);
  const t = c.exp.replace(/-/g, '/');
  if (d < 0) return { cls: 'gone', txt: '已過期 ' + t, days: d, gone: true };
  if (d <= 30) return { cls: 'soon', txt: '剩 ' + d + ' 天 · ' + t, days: d, gone: false };
  return { cls: '', txt: '到 ' + t, days: d, gone: false };
}
function viewCoupons() {
  const used = S.cu || {};
  const list = COUPONS.map(c => ({ c, st: couponState(c) })).sort((a, b) => (a.st.gone - b.st.gone) || (!!used[a.c.id] - !!used[b.c.id]) || (a.st.days - b.st.days));
  let h = '<section class="section"><h2>優惠券 <span class="small muted">' + COUPONS.length + ' 張</span></h2>' +
    '<div class="field" style="margin-bottom:10px"><select id="cpFilter" class="select"><option value="">全部店家（' + COUPONS.length + ' 張）</option>' +
    list.map(({ c }) => '<option value="' + c.id + '"' + (S.cpFilter === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select></div>' +
    '<p class="small muted" style="margin-bottom:10px">點圖放大，結帳時給店員掃條碼。先把螢幕調亮。到期近的排前面。</p>';
  list.filter(({ c }) => !S.cpFilter || c.id === S.cpFilter).forEach(({ c, st }) => {
    const u = !!used[c.id];
    h += '<div class="card cp' + (st.gone ? ' gone' : '') + (u ? ' used' : '') + '" data-act="coupon" data-id="' + c.id + '">' +
      '<div class="cp-img" style="background-image:url(coupons/' + c.id + '-t.jpg)"></div>' +
      '<div class="cp-body"><div class="cp-name">' + esc(c.name) + '</div><div class="cp-off">' + esc(c.off) + '</div>' +
      '<div class="cp-exp ' + st.cls + '">' + st.txt + '</div>' + (u ? '<div class="small muted">✓ 已用過</div>' : '') + '</div></div>';
  });
  return h + '</section>';
}
function openCoupon(id) {
  const c = COUPONS.find(x => x.id === id); if (!c) return;
  const st = couponState(c), u = !!(S.cu || {})[id];
  openModal('<div class="sheet"><div class="sheet-head"><h2>' + esc(c.name) + '</h2><button class="x" data-act="close-modal">×</button></div>' +
    '<p><b>' + esc(c.off) + '</b> · <span class="cp-exp ' + st.cls + '">' + st.txt + '</span></p>' +
    '<p class="small" style="margin:6px 0">' + esc(c.info) + '</p>' +
    (c.must ? '<p class="small" style="color:var(--red);font-weight:700">⚠ ' + esc(c.must) + '</p>' : '') +
    '<img class="cp-full" src="coupons/' + c.id + '.jpg" alt="' + esc(c.name) + '優惠券">' +
    '<p style="margin-top:12px"><button class="btn line" data-act="coupon-used" data-id="' + id + '">' + (u ? '取消「已用過」' : '標記「已用過」') + '</button></p></div>');
}

/* ========== 事件 ========== */
const handlers = {
  tab(el) { S.view = el.dataset.v; render(); window.scrollTo(0, 0); },
  coupon(el) { openCoupon(el.dataset.id); },
  async 'coupon-used'(el) { S.cu = S.cu || {}; const id = el.dataset.id; if (S.cu[id]) delete S.cu[id]; else S.cu[id] = 1; await kvSet('couponUsed', S.cu); closeModal(); render(); },
  scope(el) { S.scope = el.dataset.v; kvSet('scope', S.scope); render(true); },
  sync() { sync(true); },
  new() { openReceipt(null); },
  edit(el) { openReceipt(el.dataset.id); },
  'close-modal'() { closeModal(); },
  cam() { $('#fileCam').click(); },
  pick() { $('#filePick').click(); },
  multi() { $('#fileMulti').click(); },
  'batch-ocr'() { batchOcr(); },
  ocr() { runOcr(); },
  save() { saveForm(); },
  delete() { deleteForm(); },
  relogin() { showRelogin(); },
  'filter-eligible'() { S.onlyEligible = !S.onlyEligible; render(); },
  async pack(el) {
    const key = el.dataset.key, mine = scoped().filter(r => C.groupKey(r) === key && r.owner === S.user.email);
    const val = el.checked;
    for (const r of mine) { r.packed = val; if (r.sync === 'synced') r.sync = 'update'; await putReceipt(r); }
    render(true); sync();
  },
  async 'rate-manual'() {
    const v = Number($('#rateInput').value);
    if (!(v > 0)) { toast('請輸入匯率數字'); return; }
    S.rate = v; S.rateTs = Date.now(); S.rateManual = true;
    await kvSet('rate', { v, ts: S.rateTs, manual: true });
    toast('已套用手動匯率'); render(true);
  },
  async 'rate-auto'() { S.rateManual = false; await kvSet('rate', { v: S.rate || CFG.FALLBACK_RATE, ts: 0, manual: false }); await loadRate(true); render(true); },
  async 'save-budget'() {
    S.user.budgetTWD = Math.max(0, Math.round(Number($('#budgetInput').value) || 0));
    S.budgetDirty = true; await kvSet('budgetDirty', true); await kvSet('user', S.user);
    toast('預算已儲存'); render(true); sync();
  },
  async 'add-store'() {
    const name = $('#newStore').value.trim();
    if (!name) { toast('請輸入店家名稱'); return; }
    if (S.stores.some(s => s.name.toLowerCase() === name.toLowerCase())) { toast('這間店已經在清單裡'); return; }
    S.stores.push({ id: 'L' + Date.now(), name, nameJa: '', aliases: '', category: '其他', pending: true });
    await saveStores(); toast('已新增'); render(true); sync();
  },
  'export-me'() { exportExcel(false); },
  'export-all'() { exportExcel(true); },
  backup() { exportBackup(); },
  import() { $('#fileBackup').click(); },
  async logout() {
    const p = pendingCount();
    if (p && !confirm('還有 ' + p + ' 筆收據沒上傳，登出會一併清除！\n建議先連網同步或匯出備份。\n確定要登出？')) return;
    if (!p && !confirm('確定登出並清除這支手機上的資料？（已上傳的資料不會消失）')) return;
    await clearAll();
    try { google.accounts.id.disableAutoSelect(); } catch (e) { /* 沒載入就略過 */ }
    location.reload();
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const h = handlers[el.dataset.act];
  if (h) h(el, e);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.matches && el.matches('input[data-act="pack"]')) handlers.pack(el);
  else if (el.id === 'cpFilter') { S.cpFilter = el.value; el.blur(); render(); }
  else if (el.id === 'refundFilter') { S.refundFilter = el.value; el.blur(); render(); }
  else if (el.closest && el.closest('#modal')) {
    if (el.id === 'fRefund' && F) F.refundTouched = true;
    if (el.id === 'fStore' && F) autoRefund();
    if (el.id === 'fProxy') { const w = $('#fProxyWrap'); if (w) w.style.display = el.checked ? '' : 'none'; }
    updateCalc();
  }
});
document.addEventListener('input', e => { if (e.target.closest && e.target.closest('#modal')) updateCalc(); });
['fileCam', 'filePick'].forEach(id => $('#' + id).addEventListener('change', e => { handlePhoto(e.target.files[0]); e.target.value = ''; }));
$('#fileMulti').addEventListener('change', e => { handleMulti(e.target.files); e.target.value = ''; });
$('#fileBackup').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

window.addEventListener('online', () => { render(); initGsi(); if (S.user) { loadRate(); sync(); } });
window.addEventListener('offline', () => render());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.user && navigator.onLine && Date.now() - S.lastSync > 30000) sync();
});

/* ========== 啟動 ========== */
function showApp() {
  $('#login').hidden = true; $('#app').hidden = false;
  if (S.user.role !== 'admin') S.scope = 'me';
  render(true);
  loadRate();
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    const [user, stores, users, token, bd, scope] = await Promise.all([kvGet('user'), kvGet('stores'), kvGet('users'), kvGet('token'), kvGet('budgetDirty'), kvGet('scope')]);
    S.receipts = await allReceipts();
    S.token = token || null; S.budgetDirty = !!bd; S.stores = stores || []; S.users = users || [];
    if (scope) S.scope = scope;
    S.cu = (await kvGet('couponUsed')) || {};
    if (user) {
      S.user = user;
      showApp();
      if (navigator.onLine) sync();
    } else {
      showLogin();
    }
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin', '<p style="padding:20px;color:#B5452F">這個瀏覽器無法使用本機儲存（可能是無痕模式），請改用一般模式開啟。</p>');
  }
}
boot();
})();
