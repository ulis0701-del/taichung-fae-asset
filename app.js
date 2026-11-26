/**
 * 台中區 FAE 測試資產智慧管理 — 跨手機與筆電 PWA 前端核心引擎
 * 安全規範：所有真實清冊、借還紀錄與 AI 金鑰皆存放於 Google 雲端，本程式透過免預檢 POST 與雲端互動。
 */

const LS_KEYS = {
  API_URL: 'fae_cloud_api_url',
  PIN: 'fae_cloud_team_pin',
  FAE_NAME: 'fae_operator_name'
};

const STATE = {
  apiUrl: '',
  pin: '',
  faeName: '',
  pinInitializedOnServer: true,
  connected: false,
  assets: [],
  boxes: [],
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
  audioCtx: null
};

/* ============================================================================
 * 1. 音效與震動回饋（專為 90x45mm 標籤免看螢幕連續快掃設計）
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
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
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
  const bodyObj = Object.assign({ action, pin: STATE.pin }, extraPayload);
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

  // 解析 #setup= 配對連結（由另一台筆電產生的配對 QR Code）
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

  applySavedFaeName();

  // 解析網址列 ?id=FAEMxxx（若直接用手機原生相機掃標籤）
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
  }
}

async function openSettingsModal(isInitial) {
  hideMsg('auth-msg');
  document.getElementById('cfg-api-url').value = STATE.apiUrl || '';
  document.getElementById('cfg-pin').value = STATE.pin || '';
  document.getElementById('cfg-fae-name').value = STATE.faeName || '';
  document.getElementById('cfg-gemini-key').value = '';
  document.getElementById('btn-close-auth').classList.toggle('hidden', Boolean(isInitial && !STATE.connected));
  document.getElementById('auth-modal').classList.remove('hidden');

  if (STATE.apiUrl) {
    try {
      const st = await callCloudApi('status');
      STATE.pinInitializedOnServer = Boolean(st.pinInitialized);
      updatePinPromptLabel();
    } catch (_) {}
  }
}

function updatePinPromptLabel() {
  const lbl = document.getElementById('cfg-pin-label');
  if (!STATE.pinInitializedOnServer) {
    lbl.innerText = '2. 🎉 首次啟用：請設定您的「團隊專屬通行碼」（4～12 碼英數）';
    lbl.style.color = '#0f766e';
  } else {
    lbl.innerText = '2. 團隊專屬通行碼（PIN）';
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
  const geminiKey = document.getElementById('cfg-gemini-key').value.trim();

  if (!urlInput || !urlInput.startsWith('https://script.google.com/')) {
    return showMsg('auth-msg', '請貼上正確的 Google Apps Script 網頁應用程式網址（以 https://script.google.com/ 開頭，/exec 結尾）！', true);
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
      const setupRes = await callCloudApi('setupPin', { newPin: pinInput });
      initData = setupRes.data;
    } else {
      const res = await callCloudApi('init');
      initData = res.data;
    }

    if (geminiKey) {
      await callCloudApi('saveSettings', { geminiApiKey: geminiKey });
      initData.hasAiKey = true;
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
 * 4. 資料綁定與四大畫面渲染
 * ============================================================================ */
function hydrateAppData(data, preferredBox) {
  STATE.connected = true;
  STATE.assets = data.assets || [];
  STATE.boxes = data.boxes || [];
  STATE.recentLoans = data.recentLoans || [];
  STATE.stats = data.stats || {};
  STATE.hasAiKey = Boolean(data.hasAiKey);
  STATE.sheetUrl = data.sheetUrl || '#';

  const st = STATE.stats;
  document.getElementById('sub-status').innerText =
    `🟢 已連線雲端主檔｜應盤硬體 ${st.totalHardware || 0} 件（在庫 ${st.inStock || 0} 件）｜AI：${STATE.hasAiKey ? '已啟用' : '待設定金鑰'}`;

  document.getElementById('stat-total').innerText = st.totalHardware ?? 0;
  document.getElementById('stat-instock').innerText = st.inStock ?? 0;
  document.getElementById('stat-internal').innerText = st.internalTesting ?? 0;
  document.getElementById('stat-cust').innerText = st.customerLoan ?? 0;
  document.getElementById('stat-overdue').innerText = st.overdue90Count ?? 0;

  // Datalist
  document.getElementById('asset-datalist').innerHTML = STATE.assets.map(a =>
    `<option value="${a.assetId}">${a.pn} | S/N:${a.sn || '無'} | ${a.box} (${a.status})</option>`
  ).join('');

  // Box selectors
  const curAuditBox = preferredBox || document.getElementById('audit-box').value || 'Box-05';
  const curFilterBox = document.getElementById('filter-box').value;

  const boxOpts = STATE.boxes.map(b => `<option value="${b}">${b}</option>`).join('');
  document.getElementById('return-box').innerHTML = boxOpts;
  document.getElementById('audit-box').innerHTML = boxOpts;
  document.getElementById('filter-box').innerHTML = `<option value="">📦 全部儲位箱號</option>` + boxOpts;

  if (STATE.boxes.includes(curAuditBox)) document.getElementById('audit-box').value = curAuditBox;
  if (curFilterBox) document.getElementById('filter-box').value = curFilterBox;

  // AI badge & Sheet link
  const aiBadge = document.getElementById('ai-badge');
  aiBadge.innerText = STATE.hasAiKey ? 'Gemini AI 已就緒' : '未設定 API Key';
  aiBadge.className = 'badge ' + (STATE.hasAiKey ? 'b-ok' : 'b-loan');
  document.getElementById('sheet-direct-link').href = STATE.sheetUrl;

  previewSelectedAsset();
  renderAssetCatalog();
  renderBoxChecklist();
  renderRecentLoans();
}

function switchTab(tabName) {
  stopActiveScanner();
  const tabs = ['dashboard', 'loan', 'audit', 'ai'];
  tabs.forEach((k, idx) => {
    document.getElementById('tab-' + k).classList.toggle('hidden', k !== tabName);
    document.querySelectorAll('.nav-btn')[idx].classList.toggle('active', k === tabName);
  });
}

/* ============================================================================
 * 5. TAB 1: 總覽快搜與一鍵借出／歸還
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
    const actionBtn = isOut
      ? `<button class="btn btn-teal btn-sm" onclick="quickJumpLoanReturn('${a.assetId}', 'RETURN')">📥 歸還</button>`
      : `<button class="btn btn-outline btn-sm" onclick="quickJumpLoanReturn('${a.assetId}', 'LOAN')">📤 借出</button>`;

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
      <td style="text-align:right;">${actionBtn}</td>
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

/* ============================================================================
 * 6. TAB 2: 掃碼借還表單與送出
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
 * 7. TAB 3: 分箱雙軌快盤（相機連掃 QR + 條碼槍 + AI 整箱拍照）
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
        <input type="checkbox" style="width:18px; height:18px; flex-shrink:0;" ${isChecked ? 'checked' : ''} onchange="toggleVerify('${a.assetId}', this.checked)">
        <span>
          <strong>${escapeHtml(a.assetId)}</strong>｜${escapeHtml(a.pn)}
          <div style="font-size:11px; color:#64748b;">S/N: ${escapeHtml(a.sn || '無')}${isOut ? ' ｜ 帳面：' + escapeHtml(a.status) + ' (' + escapeHtml(a.holder) + ')' : ''}</div>
        </span>
      </span>
      <span class="badge ${isChecked ? 'b-ok' : (isOut ? 'b-cust' : 'b-loan')}">${isChecked ? '✔ 已核對' : (isOut ? a.status : '待掃')}</span>
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
  processAuditCode(code, true);
}

function onAuditQrScan(decoded) {
  const now = Date.now();
  if (decoded === STATE.lastScanCode && now - STATE.lastScanTime < 1800) return;
  STATE.lastScanCode = decoded;
  STATE.lastScanTime = now;
  processAuditCode(decoded, false);
}

function processAuditCode(decoded, fromWedge) {
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

  // 支援網址型 QR (?id=FAEMxxx) 或直線分隔型 (FAEMxxx|PN|SN|Box)
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
    return showMsg('audit-ai-msg', `❌ 雲端主檔查無此編號或序號：${token}`, true);
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
 * 8. 相機 QR 掃描器控制 (html5-qrcode)
 * ============================================================================ */
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
    if (btn) {
      btn.innerText = STATE.activeScannerBtnId === 'btn-cam-loan'
        ? '📷 開啟手機／筆電相機掃描設備 QR 貼紙'
        : '📷 軌道A：連掃盒外QR';
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
      { fps: 14, qrbox: { width: 240, height: 180 } },
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
 * 9. TAB 4: AI 一句話記帳與近期異動紀錄
 * ============================================================================ */
async function runNlpParse() {
  const txt = document.getElementById('nlp-input').value.trim();
  if (!txt) return showMsg('nlp-msg', '請先輸入一句借出或歸還描述！', true);

  const btn = document.getElementById('btn-nlp');
  btn.disabled = true;
  showMsg('nlp-msg', '🤖 Gemini AI 正在比對 190 件台中區資產清單並解析語意...', false);

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
    const isRet = r.type === '歸還入庫' || r.status === '已歸還';
    return `<div style="padding:9px 4px; border-bottom:1px solid #e2e8f0; font-size:13px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span><span class="badge ${isRet ? 'b-ok' : 'b-loan'}">${escapeHtml(r.type || r.status)}</span> <strong>${escapeHtml(r.assetId)}</strong>｜${escapeHtml(r.pn)}</span>
        <span style="font-size:11px; color:#64748b;">${escapeHtml(r.date)}</span>
      </div>
      <div style="font-size:12px; color:#475569; margin-top:3px;">
        對象：${escapeHtml(r.borrower || '-')} ｜ 經手：${escapeHtml(r.fae || '-')} ${r.note ? '｜ ' + escapeHtml(r.note) : ''}
      </div>
    </div>`;
  }).join('');
}

/* ============================================================================
 * 10. 手機／多台筆電一鍵配對 QR Code
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
  if (typeof qrcode !== 'undefined') {
    const qr = qrcode(0, 'M');
    qr.addData(fullLink);
    qr.make();
    box.innerHTML = qr.createSvgTag(4, 8);
  } else {
    box.innerHTML = '<p style="font-size:12px;color:#64748b;">請複製下方配對連結開啟</p>';
  }
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
