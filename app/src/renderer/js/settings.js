// Settings screen: paste a "connection code" from the home server's setup
// page (or edit the fields directly) and persist the laptop configuration
// through the main process. The raw bearer token / SMTP password only ever
// exist in the renderer because the USER typed or pasted them here — they are
// never RETURNED to the renderer (getFullConfig reports hasToken, not token).

import { openModal, closeModal } from './modalKit.js';
import { getContrast, setContrast, getTextScale, setTextScale } from './theme.js';

let ctx = null;
let onSaved = null;

let backdrop,
  settingsBtn,
  welcomeEl,
  codeInput,
  applyBtn,
  codeError,
  urlInput,
  tokenInput,
  tokenNote,
  emailModeEl,
  pageSizeEl,
  micSelectEl,
  openRecordingsBtn,
  zoomEl,
  liveSection,
  liveModelEl,
  liveDefaultEl,
  liveDownloadBtn,
  liveDeleteBtn,
  liveNote,
  liveProgress,
  liveProgressFill,
  smtpFields,
  smtpUserEl,
  smtpPasswordEl,
  smtpNote,
  errorEl,
  saveBtn,
  adminBtn,
  adminNote,
  cancelBtn;

// The most recent getFullConfig() result — used to decide whether a blank
// secret field means "keep the saved one" (omit) or "there was none" (clear).
let current = null;

// Decode a connection code: base64url (no padding) of UTF-8 JSON
// {"url": <serverUrl>, "token": <bearerToken>}. Mirrors config.applyConnectionCode
// on the main side so the user can review the URL before saving.
function decodeConnectionCode(code) {
  const raw = String(code || '').trim();
  if (!raw) throw new Error('Paste a connection code first.');

  const malformed = new Error(
    'That connection code could not be read. Copy it again from the home server setup page.'
  );

  let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';

  let json;
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch {
    throw malformed;
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw malformed;
  }

  const url =
    parsed && typeof parsed.url === 'string' ? parsed.url.trim().replace(/\/+$/, '') : '';
  const token = parsed && typeof parsed.token === 'string' ? parsed.token.trim() : '';
  if (!url || !token) {
    throw new Error('That connection code is missing the server URL or token.');
  }
  return { url, token };
}

export function initSettings(context, opts = {}) {
  ctx = context;
  onSaved = opts.onSaved || (() => {});

  backdrop = document.getElementById('settings-modal');
  settingsBtn = document.getElementById('settings-btn');
  welcomeEl = document.getElementById('settings-welcome');
  codeInput = document.getElementById('settings-code-input');
  applyBtn = document.getElementById('settings-apply-code-btn');
  codeError = document.getElementById('settings-code-error');
  urlInput = document.getElementById('settings-url-input');
  tokenInput = document.getElementById('settings-token-input');
  tokenNote = document.getElementById('settings-token-note');
  emailModeEl = document.getElementById('settings-email-mode');
  pageSizeEl = document.getElementById('settings-page-size');
  micSelectEl = document.getElementById('settings-mic-select');
  openRecordingsBtn = document.getElementById('open-recordings-btn');
  zoomEl = document.getElementById('settings-zoom-select');
  initAppearanceControls();
  liveSection = document.getElementById('settings-live-section');
  liveModelEl = document.getElementById('settings-live-model');
  liveDefaultEl = document.getElementById('settings-live-default');
  liveDownloadBtn = document.getElementById('settings-live-download-btn');
  liveDeleteBtn = document.getElementById('settings-live-delete-btn');
  liveNote = document.getElementById('settings-live-note');
  liveProgress = document.getElementById('settings-live-progress');
  liveProgressFill = document.getElementById('settings-live-progress-fill');
  smtpFields = document.getElementById('settings-smtp-fields');
  smtpUserEl = document.getElementById('settings-smtp-user');
  smtpPasswordEl = document.getElementById('settings-smtp-password');
  smtpNote = document.getElementById('settings-smtp-note');
  errorEl = document.getElementById('settings-error');
  saveBtn = document.getElementById('settings-save-btn');
  adminBtn = document.getElementById('settings-admin-btn');
  adminNote = document.getElementById('settings-admin-note');
  cancelBtn = document.getElementById('settings-cancel-btn');

  settingsBtn.addEventListener('click', () => openSettings());
  applyBtn.addEventListener('click', onApplyCode);
  saveBtn.addEventListener('click', onSave);
  if (adminBtn) adminBtn.addEventListener('click', onOpenAdmin);
  cancelBtn.addEventListener('click', closeSettings);
  emailModeEl.addEventListener('change', syncSmtpVisibility);
  if (openRecordingsBtn) {
    openRecordingsBtn.addEventListener('click', async () => {
      if (!ctx.api || typeof ctx.api.recOpenFolder !== 'function') {
        showError(errorEl, 'Opening the recordings folder needs the desktop app.');
        return;
      }
      try {
        await ctx.api.recOpenFolder();
      } catch (err) {
        showError(errorEl, err.message);
      }
    });
  }

  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSettings();
    }
  });
  // Clicking the dimmed area (not the dialog) cancels, like Escape.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeSettings();
  });

  initLiveSection();
}

// ---- Live transcription section --------------------------------------------

let liveSupport = null; // last liveSupportGet() result

function initLiveSection() {
  if (!liveSection || !ctx.api) return;
  if (liveModelEl) liveModelEl.addEventListener('change', syncLiveButtons);
  if (liveDownloadBtn) {
    liveDownloadBtn.addEventListener('click', async () => {
      if (typeof ctx.api.liveModelDownload !== 'function') return;
      try {
        await ctx.api.liveModelDownload(liveModelEl.value);
        liveDownloadBtn.disabled = true;
        liveNote.textContent = 'Starting download…';
      } catch (err) {
        liveNote.textContent = err.message;
      }
    });
  }
  if (liveDeleteBtn) {
    liveDeleteBtn.addEventListener('click', async () => {
      if (typeof ctx.api.liveModelDelete !== 'function') return;
      if (!confirm('Delete the downloaded live-transcription model?')) return;
      try {
        await ctx.api.liveModelDelete(liveModelEl.value);
        await refreshLiveSection();
      } catch (err) {
        liveNote.textContent = err.message;
      }
    });
  }
  if (typeof ctx.api.onLiveModelEvent === 'function') {
    ctx.api.onLiveModelEvent((payload) => {
      if (!payload || payload.model !== (liveModelEl && liveModelEl.value)) return;
      if (payload.state === 'running') {
        liveProgress.hidden = false;
        const pct = Math.max(0, Math.min(100, Number(payload.progress) || 0));
        liveProgressFill.style.width = `${pct}%`;
        liveProgress.setAttribute('aria-valuenow', String(pct));
        liveNote.textContent = payload.message || '';
      } else {
        liveProgress.hidden = true;
        liveNote.textContent = payload.message || '';
        refreshLiveSection();
      }
    });
  }
}

async function refreshLiveSection(cfg) {
  if (!liveSection) return;
  if (!ctx.api || typeof ctx.api.liveSupportGet !== 'function') {
    liveSection.hidden = true;
    return;
  }
  try {
    liveSupport = await ctx.api.liveSupportGet();
  } catch {
    liveSupport = null;
  }
  if (!liveSupport || !liveSupport.supported) {
    liveSection.hidden = true; // no whisper binary on this machine
    return;
  }
  liveSection.hidden = false;
  const conf = cfg || current || {};
  if (liveModelEl) liveModelEl.value = conf.liveModel === 'base' ? 'base' : 'small';
  if (liveDefaultEl) liveDefaultEl.checked = Boolean(conf.liveTranscriptEnabled);
  syncLiveButtons();
}

function syncLiveButtons() {
  if (!liveSupport || !liveSupport.models || !liveModelEl) return;
  const model = liveSupport.models[liveModelEl.value];
  const downloaded = Boolean(model && model.downloaded);
  if (liveDownloadBtn) {
    liveDownloadBtn.hidden = downloaded;
    liveDownloadBtn.disabled = false;
  }
  if (liveDeleteBtn) liveDeleteBtn.hidden = !downloaded;
  if (liveNote) liveNote.textContent = downloaded ? 'Model ready.' : 'Not downloaded yet.';
  if (liveProgress) liveProgress.hidden = true;
}

/** Open the Settings modal, prefilling from the main process. */
export async function openSettings({ welcome = false } = {}) {
  clearErrors();
  welcomeEl.hidden = !welcome;
  codeInput.value = '';

  current = null;
  if (ctx && ctx.api && typeof ctx.api.getFullConfig === 'function') {
    try {
      current = await ctx.api.getFullConfig();
    } catch (err) {
      showError(errorEl, `Could not read the configuration: ${err.message}`);
    }
  }

  const cfg = current || {};
  urlInput.value = cfg.serverUrl || '';
  tokenInput.value = '';
  tokenNote.hidden = !cfg.hasToken;
  emailModeEl.value = cfg.emailMode === 'laptop' ? 'laptop' : 'home';
  pageSizeEl.value = cfg.pageSize === 'A4' ? 'A4' : 'Letter';
  smtpUserEl.value = cfg.smtpUser || '';
  smtpPasswordEl.value = '';
  smtpNote.hidden = !cfg.hasSmtpPassword;
  // The remote dashboard needs a URL AND a token to authenticate; without
  // both, the button would open a window that can only 401.
  syncAdminAvailability(Boolean(cfg.serverUrl) && Boolean(cfg.hasToken));
  syncSmtpVisibility();
  await populateMicSelect(cfg);
  await refreshLiveSection(cfg);
  // Appearance preferences are renderer-only (localStorage, applied pre-paint
  // by themeBoot.js), so they are read straight from theme.js rather than from
  // the main process's config like everything else in this dialog.
  const contrastEl = document.getElementById('settings-contrast-check');
  if (contrastEl) contrastEl.checked = getContrast() === 'high';
  const textSizeEl = document.getElementById('settings-textsize-select');
  if (textSizeEl) textSizeEl.value = String(getTextScale());

  if (zoomEl) {
    const saved = cfg.uiZoom || '';
    // A Ctrl+= nudge can land between the preset steps — surface it honestly.
    if (saved && ![...zoomEl.options].some((o) => o.value === saved)) {
      const custom = document.createElement('option');
      custom.value = saved;
      custom.textContent = `${Math.round(Number(saved) * 100)}% (custom)`;
      zoomEl.append(custom);
    }
    zoomEl.value = saved;
  }

  openModal(backdrop, codeInput);
}

// Fill the default-microphone picker. A saved device that is currently
// unplugged still shows (disabled) so the preference isn't silently lost.
async function populateMicSelect(cfg) {
  if (!micSelectEl) return;
  const savedId = cfg.micDeviceId || '';
  const savedLabel = cfg.micDeviceLabel || '';

  micSelectEl.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'System default microphone';
  micSelectEl.append(def);

  let mics = [];
  if (
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === 'function'
  ) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
    } catch {
      mics = [];
    }
  }
  for (const mic of mics) {
    const opt = document.createElement('option');
    opt.value = mic.deviceId;
    opt.textContent = mic.label || 'Microphone';
    micSelectEl.append(opt);
  }

  if (savedId && [...micSelectEl.options].some((o) => o.value === savedId)) {
    micSelectEl.value = savedId;
  } else if (savedId) {
    const missing = document.createElement('option');
    missing.value = savedId;
    missing.textContent = `${savedLabel || 'Saved microphone'} (not connected)`;
    missing.disabled = true;
    micSelectEl.append(missing);
    micSelectEl.value = ''; // record with the default until it returns
  }
}

function syncAdminAvailability(ready) {
  if (!adminBtn) return;
  adminBtn.disabled = !ready;
  if (adminNote) {
    adminNote.textContent = ready
      ? "Opens the home server's own dashboard over Tailscale — models, live " +
        'suggestions, email, everything the setup page shows — so a setting can ' +
        'be changed from here instead of only from the home PC.'
      : 'Connect to a home server first (paste a connection code above).';
  }
}

async function onOpenAdmin() {
  clearErrors();
  if (!ctx || !ctx.api || typeof ctx.api.openServerAdmin !== 'function') {
    showError(errorEl, 'The server dashboard is only available in the desktop app.');
    return;
  }
  try {
    await ctx.api.openServerAdmin();
  } catch (err) {
    showError(errorEl, err.message);
  }
}

function syncSmtpVisibility() {
  smtpFields.hidden = emailModeEl.value !== 'laptop';
}

function onApplyCode() {
  clearError(codeError);
  try {
    const { url, token } = decodeConnectionCode(codeInput.value);
    urlInput.value = url;
    tokenInput.value = token;
    // The field now carries a token, so the "already saved" hint is moot.
    tokenNote.hidden = true;
  } catch (err) {
    showError(codeError, err.message);
  }
}

async function onSave() {
  clearErrors();
  if (!ctx || !ctx.api || typeof ctx.api.saveConfig !== 'function') {
    showError(errorEl, 'Saving is only available in the desktop app.');
    return;
  }

  const payload = {
    serverUrl: urlInput.value.trim(),
    emailMode: emailModeEl.value,
    pageSize: pageSizeEl.value,
    smtpUser: smtpUserEl.value.trim(),
  };

  if (micSelectEl) {
    const chosen = micSelectEl.selectedOptions[0];
    if (chosen && !chosen.disabled) {
      payload.micDeviceId = micSelectEl.value;
      payload.micDeviceLabel = micSelectEl.value ? chosen.textContent : '';
    }
    // A disabled "(not connected)" selection keeps the saved preference.
  }

  if (liveSection && !liveSection.hidden && liveModelEl && liveDefaultEl) {
    payload.liveModel = liveModelEl.value === 'base' ? 'base' : 'small';
    payload.liveTranscriptEnabled = liveDefaultEl.checked ? '1' : '';
  }

  if (zoomEl) payload.uiZoom = zoomEl.value;

  // A blank secret means "keep what's saved" (omit) only when one exists;
  // otherwise send '' so the field stays explicitly empty.
  const token = tokenInput.value.trim();
  if (token) payload.token = token;
  else if (!current || !current.hasToken) payload.token = '';

  const smtpPassword = smtpPasswordEl.value.trim();
  if (smtpPassword) payload.smtpPassword = smtpPassword;
  else if (!current || !current.hasSmtpPassword) payload.smtpPassword = '';

  saveBtn.disabled = true;
  try {
    await ctx.api.saveConfig(payload);
    closeSettings();
    onSaved();
  } catch (err) {
    showError(errorEl, err.message);
  } finally {
    saveBtn.disabled = false;
  }
}

function closeSettings() {
  closeModal(backdrop);
  clearErrors();
}

function showError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function clearError(el) {
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}

function clearErrors() {
  clearError(codeError);
  clearError(errorEl);
}

// High contrast and text size apply the moment they change — waiting for Save
// would mean choosing a legibility setting you can't read yet. Neither is part
// of the Save payload; both live in localStorage.
function initAppearanceControls() {
  const contrastEl = document.getElementById('settings-contrast-check');
  if (contrastEl) {
    contrastEl.addEventListener('change', () =>
      setContrast(contrastEl.checked ? 'high' : 'normal')
    );
  }
  const textSizeEl = document.getElementById('settings-textsize-select');
  if (textSizeEl) {
    textSizeEl.addEventListener('change', () => setTextScale(textSizeEl.value));
  }
}
