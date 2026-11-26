/**
 * 台中區 FAE 測試資產智慧管理 (v4.0) — 跨手機與筆電 PWA 前端核心引擎
 * 支援：雙層權限 (Team PIN + Admin PIN)、FAEM* 依分類自動配號、新進測試品入庫、
 *       RMA 序號編修、4 種標準除帳歸檔、防呆永久刪除、90x45mm 標籤機單張即印。
 */

const LS_KEYS = {
  API_URL: 'fae_cloud_api_url',
  PIN: 'fae_cloud_team_pin',
  FAE_NAME: 'fae_operator_name'
};

const SS_ADMIN_KEY = 'fae_session_admin_pin';

const FALLBACK_CATEGORY_PREFIX = {
  'Remote I/O (ADAM/APAX)':    'FAEMRM',
  '資料擷取卡 (DAQ)':           'FAEMIO',
  'EtherCAT控制與I/O':         'FAEMIO',
  '運動控制與板卡 (Motion)':     'FAEMMO',
  '工業網通 (EKI)':             'FAEMSW',
  '邊緣閘道與RTU (ECU/ADAM)':   'FAEMEG',
  '無線感測與I/O (WISE)':       'FAEMWS',
  'IPC整機與組件':              'FAEMPF',
  '人機介面與視覺 (HMI/Vision)': 'FAEMHM',
  'PAC專案套組':                'TC-PAC-',
  '線材與配件':                 'TC-CBL-',
  '其他測試設備':               'FAEMOT'
};

const ALL_PREFIX_OPTIONS = [
  { pfx: 'FAEMRM', label: 'FAEMRM — Remote I/O (ADAM/APAX)' },
  { pfx: 'FAEMIO', label: 'FAEMIO — DAQ / EtherCAT I/O' },
  { pfx: 'FAEMSW', label: 'FAEMSW — 工業網通 Switch (EKI)' },
  { pfx: 'FAEMMO', label: 'FAEMMO — 運動控制與板卡 (Motion)' },
  { pfx: 'FAEMEG', label: 'FAEMEG — 邊緣閘道與 RTU (ECU)' },
  { pfx: 'FAEMWS', label: 'FAEMWS — 無線感測 (WISE)' },
  { pfx: 'FAEMPF', label: 'FAEMPF — IPC 整機與周邊組件' },
  { pfx: 'FAEMHM', label: 'FAEMHM — 人機介面 (HMI/WOP)' },
  { pfx: 'FAEMVI', label: 'FAEMVI — 機器視覺卡 (Vision)' },
  { pfx: 'FAEMCR', label: 'FAEMCR — Coupler 耦合器' },
  { pfx: 'FAEMAP', label: 'FAEMAP — 無線基地台 AP' },
  { pfx: 'FAEMGW', label: 'FAEMGW — 通訊閘道器 Gateway' },
  { pfx: 'FAEMDS', label: 'FAEMDS — 設備連網伺服器' },
  { pfx: 'FAEMSR', label: 'FAEMSR — 伺服器／工業主機' },
  { pfx: 'FAEMOT', label: 'FAEMOT — 其他測試設備' },
  { pfx: 'TC-PAC-', label: 'TC-PAC- — PAC 專案套組' },
  { pfx: 'TC-CBL-', label: 'TC-CBL- — 線材與配件 (免季盤)' }
];

const STATE = {
  apiUrl: '',
  pin: '',
  adminPin: '',
  faeName: '',
  pinInitializedOnServer: true,
  adminPinInitializedOnServer: false,
  connected: false,
  assets: [],
  retiredAssets: [],
  boxes: [],
  categories: Object.keys(FALLBACK_CATEGORY_PREFIX),
  nextIdByPrefix: {},
  existingIds: [],
  recentLoans: [],
  stats: {},
  hasAiKey: false,
  sheetUrl: '',
  mode: 'LOAN',
  verifiedSet: new Set(),
  scanner: null,
  activeScannerBtnId: null,
  lastScanCode: '',
  lastScanTime: 0,
  audioCtx: null,
  pendingAdminCallback: null,
  currentLabelSpec: null
};

/* ============================================================================
 * 1. 音效、震動與訊息提示
 * ============================================================================ */
function playFeedback(type) {
  try {
    if (!STATE.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) STATE.audioCtx = new AudioContext();
    }
    if (STATE.audioCtx && STATE.audioCtx.state === 'suspended') {
      STATE.audioCtx.resume();
    }
    if (STATE.audioCtx) {
      const ctx = STATE.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;

      if (type === 'ok') {
        osc.frequency.setValueAtTime(1046, now);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (type === 'box') {
        osc.frequency.setValueAtTime(784, now);
        osc.frequency.setValueAtTime(1175, now + 0.08);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(280, now);
        gain.gain.setValueAtTime(0.22, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.start(now);
        osc.stop(now + 0.28);
      }
    }
  } catch (_) {}

  if (navigator.vibrate) {
    navigator.vibrate(type === 'warn' ? [120, 60, 120] : 55);
  }
}

let toastTimer = null;
function showToast(text, isWarn) {
  const el = document.getElementById('scan-toast');
  el.innerText = text;
  el.style.background = isWarn ? 'rgba(185, 28, 28, 0.96)' : 'rgba(12, 35, 64, 0.95)';
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function showMsg(elId, text, isErr) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove('hidden');
  el.style.background = isErr ? '#fee2e2' : '#dcfce7';
  el.style.color = isErr ? '#991b1b' : '#166534';
  el.innerText = text;
}

function hideMsg(elId) {
  const el = document.getElementById(elId);
  if (el) el.classList.add('hidden');
}

/* ============================================================================
 * 2. 免預檢 CORS 雲端 API 通訊層
 * ============================================================================ */
async function callCloudApi(action, extraPayload = {}) {
  if (!STATE.apiUrl) throw new Error('尚未設定 Google Apps Script API 網址');
  const bodyObj = Object.assign({
    action,
    pin: STATE.pin,
    adminPin: STATE.adminPin || ''
  }, extraPayload);

  const resp = await fetch(STATE.apiUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(bodyObj)
  });
  if (!resp.ok) {
    throw new Error(`雲端連線異常 (HTTP ${resp.status})，請確認 Apps Script 部署權限已設為「所有人 (Anyone)」。`);
  }
  const json = await resp.json();
  if (!json.ok) {
    const err = new Error(json.error || '雲端處理失敗');
    err.code = json.code || '';
    throw err;
  }
  return json;
}

/* ============================================================================
 * 3. 啟動初始化、配對碼解析與連線驗證
 * ============================================================================ */
window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (location.hash && location.hash.startsWith('#setup=')) {
    try {
      const raw = decodeURIComponent(escape(atob(location.hash.slice(7))));
      const parsed = JSON.parse(raw);
      if (parsed.u) localStorage.setItem(LS_KEYS.API_URL, parsed.u);
      if (parsed.p) localStorage.setItem(LS_KEYS.PIN, parsed.p);
      history.replaceState(null, '', location.pathname + location.search);
    } catch (_) {}
  }

  const defaultUrl = (window.FAE_CONFIG && window.FAE_CONFIG.DEFAULT_API_URL) ? window.FAE_CONFIG.DEFAULT_API_URL.trim() : '';
  STATE.apiUrl = localStorage.getItem(LS_KEYS.API_URL) || defaultUrl;
  STATE.pin = localStorage.getItem(LS_KEYS.PIN) || '';
  STATE.faeName = localStorage.getItem(LS_KEYS.FAE_NAME) || '';
  STATE.adminPin = sessionStorage.getItem(SS_ADMIN_KEY) || '';

  applySavedFaeName();
  updateAdminBannerUI();

  const params = new URLSearchParams(location.search);
  const urlAssetId = params.get('id');
  const urlBox = params.get('box');
  if (urlAssetId) {
    switchTab('loan');
    document.getElementById('loan-asset-input').value = urlAssetId;
  } else if (urlBox) {
    switchTab('audit');
  }

  if (STATE.apiUrl && STATE.pin) {
    await refreshCloudData(true, urlBox);
  } else {
    openSettingsModal(true);
  }
});

function applySavedFaeName() {
  if (STATE.faeName) {
    document.getElementById('loan-fae').value = STATE.faeName;
    document.getElementById('return-fae').value = STATE.faeName;
    document.getElementById('add-fae').value = STATE.faeName;
  }
}

async function openSettingsModal(isInitial) {
  hideMsg('auth-msg');
  document.getElementById('cfg-api-url').value = STATE.apiUrl || '';
  document.getElementById('cfg-pin').value = STATE.pin || '';
  document.getElementById('cfg-fae-name').value = STATE.faeName || '';
  document.getElementById('cfg-cur-admin-pin').value = STATE.adminPin || '';
  document.getElementById('cfg-gemini-key').value = '';
  document.getElementById('cfg-new-admin-pin').value = '';
  document.getElementById('btn-close-auth').classList.toggle('hidden', Boolean(isInitial && !STATE.connected));
  document.getElementById('auth-modal').classList.remove('hidden');

  if (STATE.apiUrl) {
    try {
      const st = await callCloudApi('status');
      STATE.pinInitializedOnServer = Boolean(st.pinInitialized);
      STATE.adminPinInitializedOnServer = Boolean(st.adminPinInitialized);
      updatePinPromptLabel();
    } catch (_) {}
  }
}

function updatePinPromptLabel() {
  const lbl = document.getElementById('cfg-pin-label');
  if (!STATE.pinInitializedOnServer) {
    lbl.innerText = '2. 🎉 首次啟用：請設定您的「團隊專屬通行碼 Team PIN」（4～12 碼）';
    lbl.style.color = '#0f766e';
  } else {
    lbl.innerText = '2. 團隊專屬通行碼（Team PIN）';
    lbl.style.color = '#334155';
  }
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
}

async function saveAndConnect() {
  const urlInput = document.getElementById('cfg-api-url').value.trim();
  const pinInput = document.getElementById('cfg-pin').value.trim();
  const faeInput = document.getElementById('cfg-fae-name').value.trim();
  const curAdmin = document.getElementById('cfg-cur-admin-pin').value.trim();
  const geminiKey = document.getElementById('cfg-gemini-key').value.trim();
  const newAdmin = document.getElementById('cfg-new-admin-pin').value.trim();

  if (!urlInput || !urlInput.startsWith('https://script.google.com/')) {
    return showMsg('auth-msg', '請貼上正確的 Google Apps Script 網址（以 https://script.google.com/ 開頭，/exec 結尾）！', true);
  }
  if (pinInput.length < 4) {
    return showMsg('auth-msg', '團隊通行碼長度請至少輸入 4 碼！', true);
  }

  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.innerText = '雲端驗證連線中...';
  hideMsg('auth-msg');

  try {
    STATE.apiUrl = urlInput;
    STATE.pin = pinInput;
    STATE.faeName = faeInput;

    const statusRes = await callCloudApi('status');
    let initData = null;

    if (!statusRes.pinInitialized) {
      const setupRes = await callCloudApi('setupPin', { newPin: pinInput, newAdminPin: newAdmin });
      initData = setupRes.data;
    } else {
      const res = await callCloudApi('init');
      initData = res.data;
    }

    if (geminiKey || newAdmin) {
      await callCloudApi('saveSettings', {
        adminPin: curAdmin || STATE.adminPin,
        geminiApiKey: geminiKey || undefined,
        newAdminPin: newAdmin || undefined
      });
      if (newAdmin) {
        STATE.adminPin = newAdmin;
        sessionStorage.setItem(SS_ADMIN_KEY, newAdmin);
      }
      const fresh = await callCloudApi('init');
      initData = fresh.data;
    }

    localStorage.setItem(LS_KEYS.API_URL, STATE.apiUrl);
    localStorage.setItem(LS_KEYS.PIN, STATE.pin);
    if (STATE.faeName) localStorage.setItem(LS_KEYS.FAE_NAME, STATE.faeName);
    applySavedFaeName();

    hydrateAppData(initData);
    closeAuthModal();
    showToast('✅ 已成功連線台中區 FAE 雲端主檔！', false);
  } catch (err) {
    showMsg('auth-msg', err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerText = '連線並驗證雲端主檔';
  }
}

async function refreshCloudData(openModalOnFail, preferredBox) {
  document.getElementById('sub-status').innerText = '正在與 Google 雲端主檔同步最新資料...';
  try {
    const res = await callCloudApi('init');
    hydrateAppData(res.data, preferredBox);
    if (!openModalOnFail) showToast('🔄 已同步最新雲端狀態', false);
  } catch (err) {
    document.getElementById('sub-status').innerText = '⚠️ 連線驗證未通過或尚未設定';
    if (openModalOnFail || err.code === 'AUTH_FAILED' || err.code === 'PIN_NOT_INITIALIZED') {
      if (err.code === 'PIN_NOT_INITIALIZED') STATE.pinInitializedOnServer = false;
      openSettingsModal(true);
      showMsg('auth-msg', err.message, true);
    } else {
      showToast('⚠️ ' + err.message, true);
    }
  }
}

/* ============================================================================
 * 4. 管理員密碼 (Admin PIN) 解鎖與首次設定控制
 * ============================================================================ */
function updateAdminBannerUI() {
  const bar = document.getElementById('admin-status-bar');
  const txt = document.getElementById('admin-status-text');
  const btnUnlock = document.getElementById('btn-admin-unlock');
  const btnLock = document.getElementById('btn-admin-lock');

  if (STATE.adminPin) {
    bar.className = 'admin-bar admin-unlocked';
    txt.innerText = '🔓 管理員權限已解鎖：可執行「主檔編修／RMA 改序號／正式除帳退庫／永久刪除／復原回庫」（關閉分頁自動上鎖）。';
    btnUnlock.classList.add('hidden');
    btnLock.classList.remove('hidden');
  } else {
    bar.className = 'admin-bar admin-locked';
    txt.innerText = STATE.adminPinInitializedOnServer
      ? '🔒 一般同仁模式：可直接「➕ 新增測試品入庫」；若需「編修主檔／除帳退庫／永久刪除」請點右側解鎖管理員權限。'
      : '🛡️ 尚未設定管理員密碼（Admin PIN）：請點擊右側按鈕設定您的專屬管理員密碼以啟用編修與除帳保護！';
    btnUnlock.innerText = STATE.adminPinInitializedOnServer ? '🛡️ 管理員解鎖 (Admin PIN)' : '🛡️ 首次設定管理員密碼';
    btnUnlock.classList.remove('hidden');
    btnLock.classList.add('hidden');
  }
}

function lockAdminSession() {
  STATE.adminPin = '';
  sessionStorage.removeItem(SS_ADMIN_KEY);
  updateAdminBannerUI();
  showToast('🔒 已鎖定管理員權限', false);
}

function openAdminPinModal(onSuccessCallback) {
  STATE.pendingAdminCallback = onSuccessCallback || null;
  hideMsg('admin-modal-msg');
  document.getElementById('admin-pin-input').value = '';

  const isSetup = !STATE.adminPinInitializedOnServer;
  document.getElementById('admin-modal-title').innerText = isSetup
    ? '🛡️ 首次設定「管理員專屬密碼 (Admin PIN)」'
    : '🛡️ 請輸入管理員密碼 (Admin PIN)';
  document.getElementById('admin-modal-desc').innerText = isSetup
    ? '請設定一組與團隊通行碼不同的 4～12 碼管理員密碼，未來僅管理員可執行「除帳退庫、永久刪除與修改主檔」。'
    : '此操作屬於管理員權限，請輸入管理員密碼驗證解鎖（本分頁期間有效）：';
  document.getElementById('admin-pin-input-label').innerText = isSetup ? '設定管理員密碼（至少 4 碼）' : '管理員密碼（Admin PIN）';
  document.getElementById('btn-confirm-admin').innerText = isSetup ? '儲存並解鎖管理權限' : '驗證並解鎖';

  document.getElementById('admin-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('admin-pin-input').focus(), 80);
}

function closeAdminPinModal() {
  document.getElementById('admin-modal').classList.add('hidden');
  STATE.pendingAdminCallback = null;
}

async function confirmAdminPinModal() {
  const val = document.getElementById('admin-pin-input').value.trim();
  if (val.length < 4) {
    return showMsg('admin-modal-msg', '管理員密碼請至少輸入 4 碼！', true);
  }
  const btn = document.getElementById('btn-confirm-admin');
  btn.disabled = true;
  hideMsg('admin-modal-msg');

  try {
    if (!STATE.adminPinInitializedOnServer) {
      await callCloudApi('setupAdminPin', { newAdminPin: val });
      STATE.adminPinInitializedOnServer = true;
    } else {
      STATE.adminPin = val;
      await callCloudApi('verifyAdminPin');
    }
    STATE.adminPin = val;
    sessionStorage.setItem(SS_ADMIN_KEY, val);
    updateAdminBannerUI();
    const cb = STATE.pendingAdminCallback;
    closeAdminPinModal();
    playFeedback('ok');
    showToast('🔓 管理員權限已解鎖！', false);
    if (typeof cb === 'function') cb();
  } catch (err) {
    STATE.adminPin = '';
    sessionStorage.removeItem(SS_ADMIN_KEY);
    if (err.code === 'ADMIN_PIN_NOT_INITIALIZED') {
      STATE.adminPinInitializedOnServer = false;
      openAdminPinModal(STATE.pendingAdminCallback);
    }
    showMsg('admin-modal-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function ensureAdminUnlocked(actionFn) {
  if (STATE.adminPin) {
    actionFn();
  } else {
    openAdminPinModal(actionFn);
  }
}

/* ============================================================================
 * 5. 資料綁定與畫面渲染
 * ============================================================================ */
function hydrateAppData(data, preferredBox) {
  STATE.connected = true;
  STATE.assets = data.assets || [];
  STATE.retiredAssets = data.retiredAssets || [];
  STATE.boxes = data.boxes || [];
  if (data.categories && data.categories.length) STATE.categories = data.categories;
  STATE.nextIdByPrefix = data.nextIdByPrefix || {};
  STATE.existingIds = data.existingIds || [];
  STATE.recentLoans = data.recentLoans || [];
  STATE.stats = data.stats || {};
  STATE.hasAiKey = Boolean(data.hasAiKey);
  if (data.adminPinInitialized !== undefined) {
    STATE.adminPinInitializedOnServer = Boolean(data.adminPinInitialized);
  }
  STATE.sheetUrl = data.sheetUrl || '#';

  updateAdminBannerUI();

  const st = STATE.stats;
  document.getElementById('sub-status').innerText =
    `🟢 已連線雲端主檔｜應盤硬體 ${st.totalHardware || 0} 件（在庫 ${st.inStock || 0} 件）｜AI：${STATE.hasAiKey ? '已啟用' : '待設定金鑰'}`;

  document.getElementById('stat-total').innerText = st.totalHardware ?? 0;
  document.getElementById('stat-instock').innerText = st.inStock ?? 0;
  document.getElementById('stat-internal').innerText = st.internalTesting ?? 0;
  document.getElementById('stat-cust').innerText = st.customerLoan ?? 0;
  document.getElementById('stat-overdue').innerText = st.overdue90Count ?? 0;
  document.getElementById('retired-count-chip').innerText = STATE.retiredAssets.length;

  document.getElementById('asset-datalist').innerHTML = STATE.assets.map(a =>
    `<option value="${a.assetId}">${a.pn} | S/N:${a.sn || '無'} | ${a.box} (${a.status})</option>`
  ).join('');

  const curAuditBox = preferredBox || document.getElementById('audit-box').value || 'Box-05';
  const curFilterBox = document.getElementById('filter-box').value;
  const curAddBox = document.getElementById('add-box').value || 'Box-02';

  const boxOpts = STATE.boxes.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  document.getElementById('return-box').innerHTML = boxOpts;
  document.getElementById('audit-box').innerHTML = boxOpts;
  document.getElementById('edit-box').innerHTML = boxOpts;
  document.getElementById('filter-box').innerHTML = `<option value="">📦 全部儲位箱號</option>` + boxOpts;
  document.getElementById('add-box').innerHTML = boxOpts + `<option value="__NEW_BOX__">➕ 新增擴充儲位箱號（如 Box-16）...</option>`;

  if (STATE.boxes.includes(curAuditBox)) document.getElementById('audit-box').value = curAuditBox;
  if (curFilterBox) document.getElementById('filter-box').value = curFilterBox;
  if (STATE.boxes.includes(curAddBox)) document.getElementById('add-box').value = curAddBox;

  // Populate Category & Prefix selectors
  const catOpts = STATE.categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const prevAddCat = document.getElementById('add-category').value;
  document.getElementById('add-category').innerHTML = catOpts;
  document.getElementById('edit-category').innerHTML = catOpts;
  if (prevAddCat && STATE.categories.includes(prevAddCat)) {
    document.getElementById('add-category').value = prevAddCat;
  }

  document.getElementById('add-prefix').innerHTML = ALL_PREFIX_OPTIONS.map(o => {
    const nextCode = STATE.nextIdByPrefix[o.pfx] || (o.pfx + '001');
    return `<option value="${o.pfx}">${o.label}（下一號：${nextCode}）</option>`;
  }).join('');
  onAddCategoryChange();

  const aiBadge = document.getElementById('ai-badge');
  aiBadge.innerText = STATE.hasAiKey ? 'Gemini AI 已就緒' : '未設定 API Key';
  aiBadge.className = 'badge ' + (STATE.hasAiKey ? 'b-ok' : 'b-loan');
  document.getElementById('sheet-direct-link').href = STATE.sheetUrl;

  previewSelectedAsset();
  renderAssetCatalog();
  renderBoxChecklist();
  renderRetiredCatalog();
  renderRecentLoans();
}

function switchTab(tabName) {
  stopActiveScanner();
  const tabs = ['dashboard', 'loan', 'audit', 'manage', 'ai'];
  tabs.forEach((k, idx) => {
    document.getElementById('tab-' + k).classList.toggle('hidden', k !== tabName);
    document.querySelectorAll('.nav-btn')[idx].classList.toggle('active', k === tabName);
  });
}

function switchManageSubtab(subName) {
  stopActiveScanner();
  ['add', 'edit', 'retire', 'archive'].forEach(k => {
    document.getElementById('msub-' + k).classList.toggle('hidden', k !== subName);
    document.getElementById('subbtn-' + k).classList.toggle('active', k === subName);
  });
}

/* ============================================================================
 * 6. TAB 1: 總覽快搜、一鍵借還、單張補印標籤與快速跳轉編修
 * ============================================================================ */
function setStatusQuickFilter(statusVal) {
  document.getElementById('filter-status').value = statusVal;
  const map = { '': 'kpi-all', '在庫': 'kpi-instock', '同仁測試中': 'kpi-internal', '客戶借測中': 'kpi-cust', 'OVERDUE90': 'kpi-overdue' };
  document.querySelectorAll('.kpi-card').forEach(c => c.classList.remove('active-filter'));
  if (map[statusVal]) document.getElementById(map[statusVal]).classList.add('active-filter');
  renderAssetCatalog();
}

function resetCatalogFilters() {
  document.getElementById('search-kw').value = '';
  document.getElementById('filter-box').value = '';
  setStatusQuickFilter('');
}

function statusBadgeHtml(a) {
  if (a.status === '在庫') return `<span class="badge b-ok">在庫</span>`;
  if (a.status === '同仁測試中') return `<span class="badge b-loan">同仁測試${a.loanDays >= 90 ? ' (' + a.loanDays + '天!)' : ''}</span>`;
  if (a.status === '客戶借測中') return `<span class="badge b-cust">客戶借測${a.loanDays >= 90 ? ' (' + a.loanDays + '天!)' : ''}</span>`;
  if (a.status === '盤虧待查') return `<span class="badge b-err">盤虧待查</span>`;
  return `<span class="badge b-gray">${escapeHtml(a.status)}</span>`;
}

function renderAssetCatalog() {
  const kw = document.getElementById('search-kw').value.trim().toUpperCase();
  const boxF = document.getElementById('filter-box').value;
  const stF = document.getElementById('filter-status').value;

  const filtered = STATE.assets.filter(a => {
    if (stF === '') {
      if (a.status === '線材(免季盤)') return false;
    } else if (stF === 'OVERDUE90') {
      if (a.loanDays < 90) return false;
    } else if (stF !== 'ALL_WITH_CABLE' && a.status !== stF) {
      return false;
    }
    if (boxF && a.box !== boxF) return false;
    if (kw) {
      const hay = `${a.assetId} ${a.origNo} ${a.pn} ${a.sn} ${a.desc} ${a.holder} ${a.box}`.toUpperCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  document.getElementById('filter-count').innerText = `顯示 ${filtered.length} 筆`;

  const tbody = document.getElementById('catalog-tbody');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#64748b; padding:24px;">沒有符合篩選條件的設備</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(a => {
    const isOut = (a.status === '同仁測試中' || a.status === '客戶借測中');
    const loanBtn = isOut
      ? `<button class="btn btn-teal btn-sm" onclick="quickJumpLoanReturn('${escapeAttr(a.assetId)}', 'RETURN')">📥 歸還</button>`
      : `<button class="btn btn-outline btn-sm" onclick="quickJumpLoanReturn('${escapeAttr(a.assetId)}', 'LOAN')">📤 借出</button>`;

    return `<tr>
      <td><strong>${escapeHtml(a.assetId)}</strong></td>
      <td>
        <div style="font-weight:700; color:#0c2340;">${escapeHtml(a.pn)}</div>
        <div style="font-size:11px; color:#64748b;">${escapeHtml(a.desc || a.category || '')}</div>
      </td>
      <td style="font-family:Consolas,monospace; font-size:12px;">${escapeHtml(a.sn || '-')}</td>
      <td><span class="badge b-gray">${escapeHtml(a.box)}</span></td>
      <td>
        ${statusBadgeHtml(a)}
        ${a.holder ? `<div style="font-size:12px; color:#334155; margin-top:2px;">👤 ${escapeHtml(a.holder)}</div>` : ''}
      </td>
      <td style="text-align:right;">
        <div class="action-group">
          ${loanBtn}
          <button class="btn btn-ghost btn-sm" onclick="openAssetLabelById('${escapeAttr(a.assetId)}')" title="列印單張 90x45mm QR 標籤">🖨️</button>
          <button class="btn btn-ghost btn-sm" onclick="quickJumpManageAsset('${escapeAttr(a.assetId)}')" title="編修資料或除帳退庫">✏️</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function quickJumpLoanReturn(assetId, mode) {
  switchTab('loan');
  setLoanMode(mode);
  document.getElementById('loan-asset-input').value = assetId;
  previewSelectedAsset();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function quickJumpManageAsset(assetId) {
  switchTab('manage');
  switchManageSubtab('edit');
  document.getElementById('edit-pick-input').value = assetId;
  document.getElementById('retire-pick-input').value = assetId;
  loadAssetForEdit();
  loadAssetForRetire();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================================
 * 7. TAB 4: 庫存維護 — 新增入庫、編修/RMA、除帳退庫、永久刪除與復原
 * ============================================================================ */
function onAddCategoryChange() {
  const cat = document.getElementById('add-category').value;
  const defaultPfx = FALLBACK_CATEGORY_PREFIX[cat] || 'FAEMOT';
  const pfxSel = document.getElementById('add-prefix');
  if (pfxSel) pfxSel.value = defaultPfx;
  updateSuggestedAssetId();
}

function updateSuggestedAssetId() {
  const pfx = document.getElementById('add-prefix').value || 'FAEMRM';
  const nextId = STATE.nextIdByPrefix[pfx] || (pfx + '001');
  document.getElementById('add-asset-id').value = nextId;
  checkAssetIdCollision();
}

function checkAssetIdCollision() {
  const val = document.getElementById('add-asset-id').value.trim().toUpperCase();
  const hint = document.getElementById('add-id-hint');
  if (!val) {
    hint.style.color = '#0f766e';
    hint.innerText = '留空將由雲端自動配發不重複流水號';
    return;
  }
  if (STATE.existingIds.includes(val)) {
    hint.style.color = '#dc2626';
    hint.innerText = `⚠️ 編號「${val}」已存在於主檔中（含歷史紀錄），請改用其他號碼！`;
  } else {
    hint.style.color = '#0f766e';
    hint.innerText = `✔ 可使用編號：${val}`;
  }
}

function toggleCustomNewBox() {
  const isCustom = document.getElementById('add-box').value === '__NEW_BOX__';
  document.getElementById('add-custom-box').classList.toggle('hidden', !isCustom);
}

function onNewSnBarcodeScan(decoded) {
  const txt = String(decoded || '').trim();
  if (!txt) return;
  document.getElementById('add-sn').value = txt;
  playFeedback('ok');
  showToast(`✔ 已掃入序號：${txt}`, false);
  stopActiveScanner();
}

async function uploadNewBoxSticker(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  showMsg('add-msg', '📸 Gemini AI 正在辨識原廠外盒側標上的 P/N、S/N 與產品規格，請稍候...', false);

  try {
    const base64 = await compressImageToBase64(file, 1500);
    const res = await callCloudApi('parseBoxLabelPhoto', {
      base64Data: base64,
      mimeType: 'image/jpeg'
    });
    const sp = res.spec || {};
    if (sp.suggestedCategory && STATE.categories.includes(sp.suggestedCategory)) {
      document.getElementById('add-category').value = sp.suggestedCategory;
      onAddCategoryChange();
    }
    if (sp.origAssetId && !STATE.existingIds.includes(sp.origAssetId.toUpperCase())) {
      document.getElementById('add-asset-id').value = sp.origAssetId.toUpperCase();
      checkAssetIdCollision();
    }
    if (sp.pn) document.getElementById('add-pn').value = sp.pn;
    if (sp.sn) document.getElementById('add-sn').value = sp.sn;
    if (sp.desc) document.getElementById('add-desc').value = sp.desc;
    playFeedback('ok');
    showMsg('add-msg', '✨ AI 已自動擷取外盒標籤資訊！確認儲位箱號無誤後即可按下方確認建檔入庫。', false);
  } catch (err) {
    playFeedback('warn');
    showMsg('add-msg', err.message, true);
  }
}

async function submitCreateAsset() {
  const pn = document.getElementById('add-pn').value.trim();
  if (!pn) return showMsg('add-msg', '請填寫產品料號 (P/N)！', true);

  let box = document.getElementById('add-box').value;
  if (box === '__NEW_BOX__') {
    box = document.getElementById('add-custom-box').value.trim();
    if (!box) return showMsg('add-msg', '請輸入新擴充的儲位箱號（例如：Box-16）！', true);
  }

  const fae = document.getElementById('add-fae').value.trim();
  if (fae) {
    STATE.faeName = fae;
    localStorage.setItem(LS_KEYS.FAE_NAME, fae);
    applySavedFaeName();
  }

  const assetId = document.getElementById('add-asset-id').value.trim().toUpperCase();
  if (assetId && STATE.existingIds.includes(assetId)) {
    return showMsg('add-msg', `編號「${assetId}」已經存在，請重新選擇分類自動配號！`, true);
  }

  const payload = {
    assetId: assetId || 'AUTO',
    prefix: document.getElementById('add-prefix').value,
    category: document.getElementById('add-category').value,
    box: box,
    pn: pn,
    sn: document.getElementById('add-sn').value.trim(),
    desc: document.getElementById('add-desc').value.trim(),
    fae: fae,
    memo: document.getElementById('add-memo').value.trim(),
    sourceNote: document.getElementById('add-memo').value.trim()
  };

  const btn = document.getElementById('btn-submit-add');
  btn.disabled = true;
  showMsg('add-msg', '⏳ 正在寫入《01_資產主檔》與《02_借還異動紀錄》...', false);

  try {
    const res = await callCloudApi('createAsset', { payload });
    playFeedback('box');
    hydrateAppData(res.data);

    const keepModel = document.getElementById('chk-keep-model').checked;
    document.getElementById('add-sn').value = '';
    if (!keepModel) {
      document.getElementById('add-pn').value = '';
      document.getElementById('add-desc').value = '';
      document.getElementById('add-memo').value = '';
    }
    updateSuggestedAssetId();
    showMsg('add-msg', res.message, false);

    if (res.createdAsset) {
      openAssetLabelModal(res.createdAsset);
    }
  } catch (err) {
    playFeedback('warn');
    showMsg('add-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* --- 子頁 4-2: 編修與 RMA 換序號 --- */
function loadAssetForEdit() {
  hideMsg('edit-msg');
  const found = findAssetByToken(document.getElementById('edit-pick-input').value);
  const body = document.getElementById('edit-form-body');
  if (!found) {
    body.classList.add('hidden');
    return;
  }
  body.classList.remove('hidden');
  document.getElementById('edit-current-summary').innerHTML =
    `正在編修：<strong>${escapeHtml(found.assetId)}</strong> ｜ 目前狀態：${statusBadgeHtml(found)} ${found.holder ? '（' + escapeHtml(found.holder) + '）' : ''}`;
  document.getElementById('edit-pn').value = found.pn || '';
  document.getElementById('edit-sn').value = found.sn || '';
  if (STATE.categories.includes(found.category)) document.getElementById('edit-category').value = found.category;
  if (STATE.boxes.includes(found.box)) document.getElementById('edit-box').value = found.box;
  document.getElementById('edit-desc').value = found.desc || '';
  document.getElementById('edit-memo').value = found.memo || '';
  document.getElementById('edit-reason').value = '';
}

function submitEditAsset() {
  const found = findAssetByToken(document.getElementById('edit-pick-input').value);
  if (!found) return showMsg('edit-msg', '請先搜尋並選取欲修改的設備！', true);

  ensureAdminUnlocked(async () => {
    const btn = document.getElementById('btn-submit-edit');
    btn.disabled = true;
    showMsg('edit-msg', '⏳ 正在更新雲端主檔並寫入異動稽核紀錄...', false);
    try {
      const res = await callCloudApi('updateAsset', {
        payload: {
          assetId: found.assetId,
          pn: document.getElementById('edit-pn').value.trim(),
          sn: document.getElementById('edit-sn').value.trim(),
          category: document.getElementById('edit-category').value,
          box: document.getElementById('edit-box').value,
          desc: document.getElementById('edit-desc').value.trim(),
          memo: document.getElementById('edit-memo').value.trim(),
          changeReason: document.getElementById('edit-reason').value.trim(),
          fae: STATE.faeName || '管理員'
        }
      });
      playFeedback('ok');
      hydrateAppData(res.data);
      loadAssetForEdit();
      showMsg('edit-msg', res.message, false);
    } catch (err) {
      if (err.code === 'ADMIN_AUTH_FAILED' || err.code === 'ADMIN_PIN_NOT_INITIALIZED') {
        lockAdminSession();
      }
      playFeedback('warn');
      showMsg('edit-msg', err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

function printCurrentEditedAsset() {
  const found = findAssetByToken(document.getElementById('edit-pick-input').value);
  if (found) openAssetLabelModal(found);
}

/* --- 子頁 4-3: 正式除帳退庫與永久刪除 --- */
function loadAssetForRetire() {
  hideMsg('retire-msg');
  const found = findAssetByToken(document.getElementById('retire-pick-input').value);
  const body = document.getElementById('retire-form-body');
  if (!found) {
    body.classList.add('hidden');
    return;
  }
  body.classList.remove('hidden');
  const isOut = (found.status === '客戶借測中' || found.status === '同仁測試中');
  document.getElementById('retire-asset-summary').innerHTML =
    `<div>目標設備：<strong>${escapeHtml(found.assetId)}</strong> ｜ <strong>${escapeHtml(found.pn)}</strong> (S/N: ${escapeHtml(found.sn || '無')}) ｜ 儲位：${escapeHtml(found.box)}</div>
     <div style="margin-top:4px;">目前狀態：${statusBadgeHtml(found)} ${found.holder ? '👤 ' + escapeHtml(found.holder) : ''}</div>
     ${isOut ? '<div style="color:#b91c1c; font-weight:700; margin-top:4px;">⚠️ 提醒：此設備目前外借中！除「客戶轉購除帳」外，請先辦理歸還再退庫；且系統已鎖定禁止永久刪除。</div>' : ''}`;
  document.getElementById('delete-confirm-id').value = '';
}

function submitRetireAsset() {
  const found = findAssetByToken(document.getElementById('retire-pick-input').value);
  if (!found) return showMsg('retire-msg', '請先選取欲除帳的設備！', true);
  const retireStatus = document.getElementById('retire-status').value;
  const targetNote = document.getElementById('retire-note').value.trim();
  if (!targetNote) {
    return showMsg('retire-msg', '請填寫「去向說明／接收窗口或單號備註」（例如退回哪位 PM 或移撥哪一區），以利日後查核！', true);
  }

  ensureAdminUnlocked(async () => {
    if (!confirm(`確定要將【${found.assetId}｜${found.pn}】執行正式除帳歸檔為「${retireStatus}」嗎？\n（歷史紀錄將完整保留，並自動自日常應盤母數排除）`)) {
      return;
    }
    const btn = document.getElementById('btn-submit-retire');
    btn.disabled = true;
    showMsg('retire-msg', '⏳ 正在執行除帳歸檔並寫入稽核軌跡...', false);
    try {
      const res = await callCloudApi('retireAsset', {
        payload: {
          assetId: found.assetId,
          retireStatus,
          targetNote,
          fae: STATE.faeName || '管理員'
        }
      });
      playFeedback('ok');
      hydrateAppData(res.data);
      document.getElementById('retire-pick-input').value = '';
      document.getElementById('retire-note').value = '';
      document.getElementById('retire-form-body').classList.add('hidden');
      showMsg('retire-msg', res.message, false);
    } catch (err) {
      if (err.code === 'ADMIN_AUTH_FAILED' || err.code === 'ADMIN_PIN_NOT_INITIALIZED') lockAdminSession();
      playFeedback('warn');
      showMsg('retire-msg', err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

function submitHardDeleteAsset() {
  const found = findAssetByToken(document.getElementById('retire-pick-input').value);
  if (!found) return showMsg('retire-msg', '請先選取設備！', true);
  const confirmId = document.getElementById('delete-confirm-id').value.trim().toUpperCase();
  if (confirmId !== found.assetId.toUpperCase()) {
    return showMsg('retire-msg', `請在確認欄完整輸入「${found.assetId}」以確認永久刪除！`, true);
  }

  ensureAdminUnlocked(async () => {
    if (!confirm(`⚠️ 警告：確定要從《01_資產主檔》永久刪除【${found.assetId}｜${found.pn}】這一整列嗎？\n（若非剛建檔打錯字，強烈建議改用上方「正式除帳歸檔」！）`)) {
      return;
    }
    const btn = document.getElementById('btn-submit-delete');
    btn.disabled = true;
    showMsg('retire-msg', '⏳ 正在從雲端主檔移除該列...', false);
    try {
      const res = await callCloudApi('deleteAsset', {
        payload: {
          assetId: found.assetId,
          confirmAssetId: confirmId,
          reason: document.getElementById('delete-reason').value.trim() || '管理員永久刪除',
          fae: STATE.faeName || '管理員'
        }
      });
      playFeedback('ok');
      hydrateAppData(res.data);
      document.getElementById('retire-pick-input').value = '';
      document.getElementById('retire-form-body').classList.add('hidden');
      showMsg('retire-msg', res.message, false);
    } catch (err) {
      if (err.code === 'ADMIN_AUTH_FAILED' || err.code === 'ADMIN_PIN_NOT_INITIALIZED') lockAdminSession();
      playFeedback('warn');
      showMsg('retire-msg', err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

/* --- 子頁 4-4: 歷史已除帳專區與一鍵復原回庫 --- */
function renderRetiredCatalog() {
  const tbody = document.getElementById('retired-tbody');
  if (!STATE.retiredAssets || STATE.retiredAssets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#64748b; padding:20px;">目前尚無已除帳／歸檔設備</td></tr>`;
    return;
  }
  tbody.innerHTML = STATE.retiredAssets.map(a => `<tr>
    <td><strong>${escapeHtml(a.assetId)}</strong></td>
    <td>
      <div style="font-weight:700;">${escapeHtml(a.pn)}</div>
      <div style="font-size:11px; color:#64748b;">S/N: ${escapeHtml(a.sn || '-')}</div>
    </td>
    <td><span class="badge b-gray">${escapeHtml(a.status)}</span></td>
    <td style="font-size:12px; color:#475569;">
      <div>${escapeHtml(a.loanDate || '')} ${escapeHtml(a.holder || '')}</div>
      ${a.memo ? `<div style="font-size:11px; color:#64748b;">${escapeHtml(a.memo)}</div>` : ''}
    </td>
    <td style="text-align:right;">
      <button class="btn btn-outline btn-sm" onclick="promptRestoreAsset('${escapeAttr(a.assetId)}', '${escapeAttr(a.box)}')">♻️ 復原回庫</button>
    </td>
  </tr>`).join('');
}

function promptRestoreAsset(assetId, origBox) {
  ensureAdminUnlocked(async () => {
    const defaultBox = (origBox && STATE.boxes.includes(origBox)) ? origBox : 'Box-02';
    const targetBox = prompt(`請輸入【${assetId}】復原回庫後要放入的儲位箱號：`, defaultBox);
    if (!targetBox) return;
    try {
      const res = await callCloudApi('restoreAsset', {
        payload: {
          assetId,
          returnBox: targetBox.trim(),
          fae: STATE.faeName || '管理員'
        }
      });
      playFeedback('ok');
      hydrateAppData(res.data);
      showToast(res.message, false);
    } catch (err) {
      if (err.code === 'ADMIN_AUTH_FAILED' || err.code === 'ADMIN_PIN_NOT_INITIALIZED') lockAdminSession();
      showToast('⚠️ ' + err.message, true);
    }
  });
}

/* ============================================================================
 * 8. 內建精準 90mm × 45mm 標籤預覽與單張即印引擎
 * ============================================================================ */
function makeQrSvg(text, cellSize = 4, margin = 2) {
  if (typeof qrcode === 'undefined') return '';
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag(cellSize, margin);
}

function openAssetLabelById(assetId) {
  const found = STATE.assets.find(a => a.assetId === assetId);
  if (found) openAssetLabelModal(found);
}

function openAssetLabelModal(asset) {
  const qrPayload = `${asset.assetId}|${asset.pn}|${asset.sn || 'NA'}|${asset.box}`;
  STATE.currentLabelSpec = {
    type: 'ASSET',
    qrPayload,
    assetId: asset.assetId,
    pn: asset.pn,
    sn: asset.sn || '無S/N',
    desc: asset.desc || asset.category || '',
    box: asset.box
  };

  const svg = makeQrSvg(qrPayload, 3, 2);
  document.getElementById('label-preview-container').innerHTML = `
    <div class="label-preview-frame">
      <div style="display:flex; justify-content:center; align-items:center;">${svg}</div>
      <div class="label-preview-meta">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1.5px solid #000; padding-bottom:3px;">
          <span style="font-size:10px; font-weight:800;">台中區 FAE 測試資產</span>
          <span style="background:#000; color:#fff; font-size:11px; font-weight:900; padding:1px 6px; border-radius:3px;">${escapeHtml(asset.box)}</span>
        </div>
        <div style="font-size:19px; font-weight:900; letter-spacing:0.4px; margin-top:2px;">${escapeHtml(asset.assetId)}</div>
        <div style="font-size:13px; font-weight:800; word-break:break-all;">${escapeHtml(asset.pn)}</div>
        <div style="font-family:Consolas,monospace; font-size:11px; font-weight:700;">S/N: ${escapeHtml(asset.sn || '無')}</div>
        <div style="font-size:9px; color:#333; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(asset.desc || asset.category || '')}</div>
      </div>
    </div>
  `;
  document.getElementById('label-modal').classList.remove('hidden');
}

function openBoxCardPrintCurrent() {
  const box = document.getElementById('audit-box').value || 'Box-02';
  const qrPayload = `BOX:${box}`;
  STATE.currentLabelSpec = {
    type: 'BOX',
    qrPayload,
    box
  };
  const svg = makeQrSvg(qrPayload, 4, 2);
  document.getElementById('label-preview-container').innerHTML = `
    <div class="label-preview-frame">
      <div style="display:flex; justify-content:center; align-items:center;">${svg}</div>
      <div class="label-preview-meta" style="justify-content:center; gap:6px;">
        <div style="font-size:11px; font-weight:800; border-bottom:2px solid #000; padding-bottom:4px;">ATW 台中區 FAE 儲位箱卡</div>
        <div style="font-size:26px; font-weight:900;">${escapeHtml(box)}</div>
        <div style="font-size:10px; font-weight:700;">快盤請先掃此 QR 自動切換箱號</div>
      </div>
    </div>
  `;
  document.getElementById('label-modal').classList.remove('hidden');
}

function closeLabelModal() {
  document.getElementById('label-modal').classList.add('hidden');
}

function executePrint90x45() {
  const sp = STATE.currentLabelSpec;
  if (!sp) return;
  const svgTag = makeQrSvg(sp.qrPayload, 4, 1)
    .replace('<svg ', '<svg style="width:36mm; height:36mm; display:block;" ');

  const innerHtml = sp.type === 'BOX'
    ? `<div class="lbl">
         <div class="qr">${svgTag}</div>
         <div class="info" style="justify-content:center; gap:2mm;">
           <div class="top"><span>台中區 FAE 儲位箱卡</span></div>
           <div style="font-size:21pt; font-weight:900; line-height:1.1;">${escapeHtml(sp.box)}</div>
           <div style="font-size:8pt; font-weight:700;">季盤請先掃此碼切換目標箱號</div>
         </div>
       </div>`
    : `<div class="lbl">
         <div class="qr">${svgTag}</div>
         <div class="info">
           <div class="top">
             <span>台中區 FAE 資產</span>
             <span class="box-chip">${escapeHtml(sp.box)}</span>
           </div>
           <div class="aid">${escapeHtml(sp.assetId)}</div>
           <div class="pn">${escapeHtml(sp.pn)}</div>
           <div class="sn">S/N: ${escapeHtml(sp.sn)}</div>
           <div class="desc">${escapeHtml(sp.desc)}</div>
         </div>
       </div>`;

  const printDoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Print 90x45mm</title>
  <style>
    @page { size: 90mm 45mm; margin: 0; }
    * { box-sizing: border-box; font-family: "Microsoft JhengHei", Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { width: 90mm; height: 45mm; margin: 0; padding: 0; background: #fff; color: #000; overflow: hidden; }
    .lbl { width: 90mm; height: 45mm; padding: 3.5mm 4mm; display: grid; grid-template-columns: 37mm 1fr; gap: 3mm; align-items: center; }
    .qr { display: flex; justify-content: center; align-items: center; }
    .info { display: flex; flex-direction: column; justify-content: space-between; height: 37mm; overflow: hidden; }
    .top { display: flex; justify-content: space-between; align-items: center; border-bottom: 0.45mm solid #000; padding-bottom: 0.8mm; font-size: 7.5pt; font-weight: 800; }
    .box-chip { background: #000; color: #fff; padding: 0.3mm 1.8mm; border-radius: 0.8mm; font-size: 8.5pt; font-weight: 900; }
    .aid { font-size: 14.5pt; font-weight: 900; line-height: 1.1; letter-spacing: 0.2px; }
    .pn { font-size: 10pt; font-weight: 800; line-height: 1.15; word-break: break-all; }
    .sn { font-family: Consolas, monospace; font-size: 8.5pt; font-weight: 700; }
    .desc { font-size: 7pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style></head><body>${innerHtml}</body></html>`;

  let iframe = document.getElementById('hidden-print-frame');
  if (iframe) iframe.remove();
  iframe = document.createElement('iframe');
  iframe.id = 'hidden-print-frame';
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(printDoc);
  doc.close();
  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  }, 220);
}

/* ============================================================================
 * 9. TAB 2: 掃碼借還表單與送出
 * ============================================================================ */
function setLoanMode(m) {
  STATE.mode = m;
  document.getElementById('btn-mode-loan').className = 'mode-btn ' + (m === 'LOAN' ? 'active-loan' : '');
  document.getElementById('btn-mode-ret').className  = 'mode-btn ' + (m === 'RETURN' ? 'active-ret' : '');
  document.getElementById('loan-fields').classList.toggle('hidden', m !== 'LOAN');
  document.getElementById('return-fields').classList.toggle('hidden', m !== 'RETURN');
}

function findAssetByToken(rawToken) {
  const val = String(rawToken || '').split('|')[0].trim().toUpperCase();
  if (!val) return null;
  return STATE.assets.find(a =>
    a.assetId.toUpperCase() === val ||
    (a.sn && a.sn.toUpperCase() === val) ||
    a.pn.toUpperCase() === val
  );
}

function previewSelectedAsset() {
  const found = findAssetByToken(document.getElementById('loan-asset-input').value);
  const el = document.getElementById('asset-preview');
  if (found) {
    el.innerText = `✔ 匹配設備：${found.assetId}｜${found.pn} (S/N:${found.sn || '無'})｜原儲位：${found.box}｜目前：${found.status} ${found.holder || ''}`;
    if (STATE.boxes.includes(found.box)) {
      document.getElementById('return-box').value = found.box;
    }
  } else {
    el.innerText = '';
  }
}

async function submitLoanForm() {
  const rawInput = document.getElementById('loan-asset-input').value.trim();
  if (!rawInput) return showMsg('loan-msg', '請先掃描或輸入設備編號！', true);

  const fae = (STATE.mode === 'LOAN' ? document.getElementById('loan-fae').value : document.getElementById('return-fae').value).trim();
  if (fae) {
    STATE.faeName = fae;
    localStorage.setItem(LS_KEYS.FAE_NAME, fae);
    applySavedFaeName();
  }

  const found = findAssetByToken(rawInput);
  const payload = {
    mode: STATE.mode,
    assetId: found ? found.assetId : rawInput,
    loanType: document.getElementById('loan-type').value,
    fae: fae,
    borrower: document.getElementById('loan-borrower').value.trim(),
    dueDate: document.getElementById('loan-due').value,
    returnBox: document.getElementById('return-box').value,
    note: document.getElementById('loan-note').value.trim()
  };

  if (STATE.mode === 'LOAN' && !payload.borrower && !payload.fae) {
    return showMsg('loan-msg', '請填寫經手 FAE 或借用對象名稱！', true);
  }

  const btn = document.getElementById('btn-submit-loan');
  btn.disabled = true;
  showMsg('loan-msg', '⏳ 正在同步寫入 Google 雲端主檔與異動紀錄...', false);

  try {
    const res = await callCloudApi('loanReturn', { payload });
    playFeedback('ok');
    hydrateAppData(res.data);
    document.getElementById('loan-asset-input').value = '';
    document.getElementById('loan-note').value = '';
    document.getElementById('asset-preview').innerText = '';
    showMsg('loan-msg', res.message, false);
  } catch (err) {
    playFeedback('warn');
    showMsg('loan-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================================
 * 10. TAB 3: 分箱雙軌快盤
 * ============================================================================ */
function renderBoxChecklist() {
  const box = document.getElementById('audit-box').value;
  const list = STATE.assets.filter(a => a.box === box && a.status !== '線材(免季盤)');
  const inStockList = list.filter(a => a.status === '在庫');
  const verifiedCount = inStockList.filter(a => STATE.verifiedSet.has(a.assetId)).length;
  const pct = inStockList.length > 0 ? Math.round((verifiedCount / inStockList.length) * 100) : 100;

  document.getElementById('box-progress-title').innerText = `${box} 應盤清單（在庫 ${inStockList.length} 件）`;
  document.getElementById('box-progress-badge').innerText = `已核對 ${verifiedCount} / ${inStockList.length} (${pct}%)`;
  document.getElementById('box-progress-badge').className = 'badge ' + (verifiedCount === inStockList.length ? 'b-ok' : 'b-loan');
  document.getElementById('box-progress-fill').style.width = pct + '%';

  const container = document.getElementById('box-checklist');
  if (list.length === 0) {
    container.innerHTML = `<p style="padding:16px; font-size:13px; color:#64748b; margin:0;">此儲位目前無應盤硬體項目。</p>`;
    return;
  }

  container.innerHTML = list.map(a => {
    const isChecked = STATE.verifiedSet.has(a.assetId);
    const isOut = (a.status !== '在庫');
    return `<label class="check-row ${isChecked ? 'verified' : ''}">
      <span style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" style="width:18px; height:18px; flex-shrink:0;" ${isChecked ? 'checked' : ''} onchange="toggleVerify('${escapeAttr(a.assetId)}', this.checked)">
        <span>
          <strong>${escapeHtml(a.assetId)}</strong>｜${escapeHtml(a.pn)}
          <div style="font-size:11px; color:#64748b;">S/N: ${escapeHtml(a.sn || '無')}${isOut ? ' ｜ 帳面：' + escapeHtml(a.status) + ' (' + escapeHtml(a.holder) + ')' : ''}</div>
        </span>
      </span>
      <span class="badge ${isChecked ? 'b-ok' : (isOut ? 'b-cust' : 'b-loan')}">${isChecked ? '✔ 已核對' : (isOut ? escapeHtml(a.status) : '待掃')}</span>
    </label>`;
  }).join('');
}

function toggleVerify(id, checked) {
  if (checked) STATE.verifiedSet.add(id);
  else STATE.verifiedSet.delete(id);
  renderBoxChecklist();
}

function selectAllCurrentBox(checkAll) {
  const box = document.getElementById('audit-box').value;
  STATE.assets.filter(a => a.box === box && a.status === '在庫').forEach(a => {
    if (checkAll) STATE.verifiedSet.add(a.assetId);
    else STATE.verifiedSet.delete(a.assetId);
  });
  renderBoxChecklist();
}

function handleWedgeInput(inputEl) {
  const code = inputEl.value.trim();
  inputEl.value = '';
  if (!code) return;
  processAuditCode(code);
}

function onAuditQrScan(decoded) {
  const now = Date.now();
  if (decoded === STATE.lastScanCode && now - STATE.lastScanTime < 1800) return;
  STATE.lastScanCode = decoded;
  STATE.lastScanTime = now;
  processAuditCode(decoded);
}

function processAuditCode(decoded) {
  const clean = String(decoded || '').trim();
  if (clean.toUpperCase().startsWith('BOX:')) {
    const target = clean.slice(4).trim();
    if (STATE.boxes.includes(target)) {
      document.getElementById('audit-box').value = target;
      renderBoxChecklist();
      playFeedback('box');
      showToast(`📦 已切換盤點箱號：${target}`, false);
      showMsg('audit-ai-msg', `📦 已自動切換至儲位：${target}，請直接連續掃描盒上標籤！`, false);
    }
    return;
  }

  let token = clean;
  if (clean.includes('id=')) {
    try { token = new URL(clean).searchParams.get('id') || clean; } catch (_) {}
  }
  token = token.split('|')[0].trim().toUpperCase();

  const curBox = document.getElementById('audit-box').value;
  const found = STATE.assets.find(a =>
    a.assetId.toUpperCase() === token ||
    (a.sn && a.sn.toUpperCase() === token)
  );

  if (!found) {
    playFeedback('warn');
    showToast(`❌ 查無編號：${token}`, true);
    return showMsg('audit-ai-msg', `❌ 現役資產查無此編號或序號：${token}`, true);
  }

  const already = STATE.verifiedSet.has(found.assetId);
  STATE.verifiedSet.add(found.assetId);
  renderBoxChecklist();

  if (found.box !== curBox) {
    playFeedback('warn');
    showToast(`⚠️ 放錯箱！${found.assetId} 應在 ${found.box}`, true);
    showMsg('audit-ai-msg', `⚠️ 放錯箱號警示：${found.assetId} (${found.pn}) 帳面儲位應在【${found.box}】！`, true);
  } else {
    playFeedback('ok');
    showToast(`${already ? '✔ 已核對過' : '✅ 核對成功'}：${found.assetId} (${found.pn})`, false);
    showMsg('audit-ai-msg', `✅ 核對成功：${found.assetId} ｜ ${found.pn} (${found.sn || '無S/N'})`, false);
  }
}

async function uploadBoxPhoto(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  const curBox = document.getElementById('audit-box').value;
  showMsg('audit-ai-msg', `📸 Gemini AI 正在辨識 ${curBox} 照片中的所有標籤與序號，請稍候約 3～5 秒...`, false);

  try {
    const base64 = await compressImageToBase64(file, 1600);
    const res = await callCloudApi('photoOcr', {
      base64Data: base64,
      mimeType: 'image/jpeg',
      targetBox: curBox
    });
    const r = res.result;
    (r.inBoxMatched || []).forEach(a => STATE.verifiedSet.add(a.assetId));
    renderBoxChecklist();

    let msg = `✅ AI 拍照辨識完成！本箱相符 ${r.inBoxMatched.length} 件、尚餘未見 ${r.missingInBox.length} 件。`;
    if (r.wrongBoxFound && r.wrongBoxFound.length > 0) {
      msg += `\n⚠️ 發現放錯箱設備：${r.wrongBoxFound.map(x => `${x.assetId}(應在${x.box})`).join('、')}`;
      playFeedback('warn');
    } else {
      playFeedback('ok');
    }
    showMsg('audit-ai-msg', msg, Boolean(r.wrongBoxFound && r.wrongBoxFound.length > 0));
  } catch (err) {
    playFeedback('warn');
    showMsg('audit-ai-msg', err.message, true);
  }
}

function compressImageToBase64(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('讀取照片失敗'));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error('解析照片失敗'));
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.84).split(',')[1]);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function commitMobileAudit() {
  const curBox = document.getElementById('audit-box').value;
  const ids = Array.from(STATE.verifiedSet);
  if (ids.length === 0) {
    return showMsg('audit-ai-msg', '請先掃碼、拍照或勾選至少一件已核對設備！', true);
  }

  const btn = document.getElementById('btn-commit-audit');
  btn.disabled = true;
  showMsg('audit-ai-msg', `⏳ 正在將 ${curBox} 共 ${ids.length} 件實盤結果寫入雲端試算表...`, false);

  try {
    const updateWrong = document.getElementById('chk-update-wrong-box').checked;
    const res = await callCloudApi('auditBatch', {
      targetBox: curBox,
      verifiedAssetIds: ids,
      updateWrongBoxLocation: updateWrong,
      auditor: STATE.faeName ? `${STATE.faeName}(雲端PWA)` : '雲端快盤PWA'
    });
    STATE.verifiedSet.clear();
    playFeedback('box');
    hydrateAppData(res.data, curBox);
    showMsg('audit-ai-msg', res.message, false);
    showToast(`🎉 ${curBox} 已完成過帳 (${res.count} 件)！`, false);
  } catch (err) {
    playFeedback('warn');
    showMsg('audit-ai-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================================
 * 11. 相機條碼／QR 掃描器控制
 * ============================================================================ */
const SCAN_BTN_DEFAULT_TEXT = {
  'btn-cam-loan': '📷 開啟手機／筆電相機掃描設備 QR 貼紙',
  'btn-cam-audit': '📷 軌道A：連掃盒外QR',
  'btn-cam-newsn': '📷 掃外盒 S/N 條碼'
};

async function stopActiveScanner() {
  if (STATE.scanner) {
    try {
      await STATE.scanner.stop();
      STATE.scanner.clear();
    } catch (_) {}
    STATE.scanner = null;
  }
  document.querySelectorAll('.qr-viewport').forEach(el => el.classList.remove('active-cam'));
  if (STATE.activeScannerBtnId) {
    const btn = document.getElementById(STATE.activeScannerBtnId);
    if (btn && SCAN_BTN_DEFAULT_TEXT[STATE.activeScannerBtnId]) {
      btn.innerText = SCAN_BTN_DEFAULT_TEXT[STATE.activeScannerBtnId];
    }
    STATE.activeScannerBtnId = null;
  }
}

async function toggleScanner(divId, onScanCallback, btnId) {
  if (STATE.scanner) {
    const sameBtn = (STATE.activeScannerBtnId === btnId);
    await stopActiveScanner();
    if (sameBtn) return;
  }

  const vp = document.getElementById(divId);
  vp.classList.add('active-cam');
  STATE.activeScannerBtnId = btnId;
  const btn = document.getElementById(btnId);
  if (btn) btn.innerText = '⏹️ 關閉相機鏡頭';

  try {
    STATE.scanner = new Html5Qrcode(divId);
    await STATE.scanner.start(
      { facingMode: 'environment' },
      { fps: 14, qrbox: { width: 250, height: 170 } },
      onScanCallback,
      () => {}
    );
  } catch (err) {
    await stopActiveScanner();
    alert('無法開啟相機鏡頭，請確認瀏覽器已允許相機權限：' + err);
  }
}

function onLoanScan(decoded) {
  if (String(decoded).toUpperCase().startsWith('BOX:')) return;
  let token = String(decoded).trim();
  if (token.includes('id=')) {
    try { token = new URL(token).searchParams.get('id') || token; } catch (_) {}
  }
  document.getElementById('loan-asset-input').value = token.split('|')[0].trim();
  playFeedback('ok');
  previewSelectedAsset();
  stopActiveScanner();
}

/* ============================================================================
 * 12. TAB 5: AI 一句話記帳與近期異動紀錄
 * ============================================================================ */
async function runNlpParse() {
  const txt = document.getElementById('nlp-input').value.trim();
  if (!txt) return showMsg('nlp-msg', '請先輸入一句借出或歸還描述！', true);

  const btn = document.getElementById('btn-nlp');
  btn.disabled = true;
  showMsg('nlp-msg', '🤖 Gemini AI 正在比對台中區現役資產清單並解析語意...', false);

  try {
    const res = await callCloudApi('nlpParse', { userText: txt });
    const p = res.parsed || {};
    hideMsg('nlp-msg');
    switchTab('loan');
    setLoanMode(p.mode === 'RETURN' ? 'RETURN' : 'LOAN');
    document.getElementById('loan-asset-input').value = p.assetId || '';
    if (p.loanType) document.getElementById('loan-type').value = p.loanType;
    if (p.fae) {
      document.getElementById('loan-fae').value = p.fae;
      document.getElementById('return-fae').value = p.fae;
    }
    document.getElementById('loan-borrower').value = p.borrower || '';
    document.getElementById('loan-due').value = p.dueDate || '';
    if (p.returnBox && STATE.boxes.includes(p.returnBox)) {
      document.getElementById('return-box').value = p.returnBox;
    }
    document.getElementById('loan-note').value = p.note || txt;
    previewSelectedAsset();
    playFeedback('ok');
    showMsg('loan-msg', '✨ AI 已自動帶入所有欄位！確認無誤後請按下方「確認送出」。', false);
  } catch (err) {
    showMsg('nlp-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function renderRecentLoans() {
  const el = document.getElementById('recent-loans-list');
  if (!STATE.recentLoans || STATE.recentLoans.length === 0) {
    el.innerHTML = `<p style="font-size:13px; color:#64748b;">尚無近期異動紀錄。</p>`;
    return;
  }
  el.innerHTML = STATE.recentLoans.map(r => {
    let badgeCls = 'b-loan';
    if (r.status === '已歸還' || r.status === '已入庫') badgeCls = 'b-ok';
    else if (r.status === '已異動修正') badgeCls = 'b-cust';
    else if (r.status === '已除帳歸檔') badgeCls = 'b-gray';
    else if (r.status === '已永久刪除') badgeCls = 'b-err';

    return `<div style="padding:9px 4px; border-bottom:1px solid #e2e8f0; font-size:13px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span><span class="badge ${badgeCls}">${escapeHtml(r.type || r.status)}</span> <strong>${escapeHtml(r.assetId)}</strong>｜${escapeHtml(r.pn)}</span>
        <span style="font-size:11px; color:#64748b;">${escapeHtml(r.date)}</span>
      </div>
      <div style="font-size:12px; color:#475569; margin-top:3px;">
        對象/位置：${escapeHtml(r.borrower || '-')} ｜ 經手：${escapeHtml(r.fae || '-')} ${r.note ? '｜ ' + escapeHtml(r.note) : ''}
      </div>
    </div>`;
  }).join('');
}

/* ============================================================================
 * 13. 手機／多台筆電一鍵配對 QR Code
 * ============================================================================ */
function openPairModal() {
  if (!STATE.apiUrl) {
    openSettingsModal();
    return;
  }
  document.getElementById('chk-pair-with-pin').checked = false;
  document.getElementById('pair-modal').classList.remove('hidden');
  renderPairQr();
}

function closePairModal() {
  document.getElementById('pair-modal').classList.add('hidden');
}

function renderPairQr() {
  const includePin = document.getElementById('chk-pair-with-pin').checked;
  const payload = { u: STATE.apiUrl };
  if (includePin && STATE.pin) payload.p = STATE.pin;

  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const baseUrl = location.origin + location.pathname;
  const fullLink = `${baseUrl}#setup=${encoded}`;

  document.getElementById('pair-url-text').value = fullLink;
  const box = document.getElementById('pair-qr-box');
  box.innerHTML = makeQrSvg(fullLink, 4, 6) || '<p style="font-size:12px;color:#64748b;">請複製下方配對連結開啟</p>';
}

function copyPairLink() {
  const input = document.getElementById('pair-url-text');
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('📋 已複製配對連結！', false);
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}
