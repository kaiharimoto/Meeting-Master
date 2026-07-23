// Settings screen: paste a "connection code" from the home server's setup
// page (or edit the fields directly) and persist the laptop configuration
// through the main process. The raw bearer token / SMTP password only ever
// exist in the renderer because the USER typed or pasted them here — they are
// never RETURNED to the renderer (getFullConfig reports hasToken, not token).

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
  smtpFields,
  smtpUserEl,
  smtpPasswordEl,
  smtpNote,
  errorEl,
  saveBtn,
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
  smtpFields = document.getElementById('settings-smtp-fields');
  smtpUserEl = document.getElementById('settings-smtp-user');
  smtpPasswordEl = document.getElementById('settings-smtp-password');
  smtpNote = document.getElementById('settings-smtp-note');
  errorEl = document.getElementById('settings-error');
  saveBtn = document.getElementById('settings-save-btn');
  cancelBtn = document.getElementById('settings-cancel-btn');

  settingsBtn.addEventListener('click', () => openSettings());
  applyBtn.addEventListener('click', onApplyCode);
  saveBtn.addEventListener('click', onSave);
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
  syncSmtpVisibility();
  await populateMicSelect(cfg);

  backdrop.hidden = false;
  codeInput.focus();
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
  backdrop.hidden = true;
  clearErrors();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  document.body.focus();
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
