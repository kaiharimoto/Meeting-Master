'use strict';

// Loads laptop.env — a plain KEY=VALUE file, parsed here without any dotenv
// dependency. Keys are documented in config/laptop.env.example.
//
// Precedence (highest wins):
//   1. real environment variables (HOME_SERVER_URL, BEARER_TOKEN, ...)
//   2. the first laptop.env found in:
//        a) app.getPath('userData')   (normal install location)
//        b) the app directory          (dev convenience: next to package.json)

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const KEYS = [
  'APP_MODE',
  'HOME_SERVER_URL',
  'BEARER_TOKEN',
  'EMAIL_MODE',
  'PAGE_SIZE',
  'SMTP_USER',
  'SMTP_APP_PASSWORD',
];

// Parse simple KEY=VALUE lines. Blank lines and #-comments are ignored.
// Values keep everything after the first '=' (so tokens may contain '=').
function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // not a KEY=VALUE line
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    values[key] = value;
  }
  return values;
}

function candidatePaths() {
  return [
    path.join(app.getPath('userData'), 'laptop.env'),
    // In development: a laptop.env next to app/package.json.
    path.join(app.getAppPath(), 'laptop.env'),
  ];
}

// The canonical location the Settings screen writes to. get() also reads a
// dev laptop.env next to package.json, but the app only ever WRITES here.
function writePath() {
  return path.join(app.getPath('userData'), 'laptop.env');
}

// Maps the renderer-facing field names to laptop.env keys. Fields that are
// `undefined` in a save() call are left untouched (their existing value is
// preserved); an explicit empty string clears the key.
const FIELD_TO_KEY = Object.freeze({
  mode: 'APP_MODE',
  serverUrl: 'HOME_SERVER_URL',
  token: 'BEARER_TOKEN',
  emailMode: 'EMAIL_MODE',
  pageSize: 'PAGE_SIZE',
  smtpUser: 'SMTP_USER',
  smtpPassword: 'SMTP_APP_PASSWORD',
});

/**
 * Returns the effective configuration. Re-reads the file on every call so a
 * config edit + window reload picks up new values without restarting.
 *
 * configPath is always set: the file that was loaded, or (when none exists
 * yet) the userData location where it SHOULD be created — the UI shows this
 * path to the operator.
 */
function get() {
  const candidates = candidatePaths();
  let fileValues = {};
  let loadedPath = null;

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        fileValues = parseEnvFile(fs.readFileSync(p, 'utf8'));
        loadedPath = p;
        break; // only the FIRST file found is used
      }
    } catch {
      // Unreadable file: treat as absent and keep looking.
    }
  }

  // Real environment variables override file values (empty string = unset).
  const val = (key) => {
    const env = process.env[key];
    if (env !== undefined && env !== '') return env;
    const fromFile = fileValues[key];
    return fromFile !== undefined && fromFile !== '' ? fromFile : '';
  };

  const emailMode = val('EMAIL_MODE').toLowerCase() === 'laptop' ? 'laptop' : 'home';
  const pageSize = val('PAGE_SIZE').toLowerCase() === 'a4' ? 'A4' : 'Letter';
  const rawMode = val('APP_MODE').toLowerCase();
  const mode = rawMode === 'server' || rawMode === 'operator' ? rawMode : '';

  return {
    mode,
    serverUrl: val('HOME_SERVER_URL').replace(/\/+$/, ''),
    bearerToken: val('BEARER_TOKEN'),
    emailMode,
    pageSize,
    smtpUser: val('SMTP_USER'),
    smtpAppPassword: val('SMTP_APP_PASSWORD'),
    configPath: loadedPath || candidates[0],
  };
}

/**
 * The effective app mode: 'server' | 'operator' | null (= not chosen yet,
 * show the first-run chooser). Installs that predate modes (v0.2.x laptops
 * have a server URL + token but no APP_MODE) are inferred as operator so an
 * auto-update never lands an existing user on the chooser.
 */
function resolveMode(cfg) {
  const c = cfg || get();
  if (c.mode) return c.mode;
  if (c.serverUrl && c.bearerToken) return 'operator';
  return null;
}

/**
 * Persist configuration to laptop.env in userData as KEY=VALUE lines.
 *
 * `values` uses the renderer-facing field names (see FIELD_TO_KEY): serverUrl,
 * token, emailMode, pageSize, smtpUser, smtpPassword. A field left `undefined`
 * keeps its previous value; a field set to '' clears it. Unknown keys already
 * present in the file are preserved.
 *
 * get() re-reads the file on every call, so there is no in-memory cache to
 * invalidate — the very next get() reflects what was just written.
 */
function save(values) {
  const input = values || {};
  const target = writePath();

  // Start from whatever is already on disk so unknown keys survive.
  let existing = {};
  try {
    if (fs.existsSync(target)) existing = parseEnvFile(fs.readFileSync(target, 'utf8'));
  } catch {
    existing = {};
  }

  const merged = { ...existing };
  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    if (input[field] === undefined) continue;
    let value = String(input[field]).trim();
    if (field === 'serverUrl') value = value.replace(/\/+$/, '');
    merged[key] = value;
  }

  // Documented keys first (stable order), then any preserved unknown keys.
  const extraKeys = Object.keys(merged).filter((k) => !KEYS.includes(k));
  const lines = [...KEYS, ...extraKeys]
    .filter((k) => merged[k] !== undefined)
    .map((k) => `${k}=${merged[k]}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');

  return { configPath: target };
}

/**
 * Decode a connection code produced by the home server's setup page.
 *
 * Contract: base64url (no padding) of the UTF-8 JSON
 *   {"url": <serverUrl>, "token": <bearerToken>}
 *
 * Returns {serverUrl, token}; throws a friendly Error on malformed input.
 */
function applyConnectionCode(code) {
  const raw = String(code || '').trim();
  if (!raw) throw new Error('Paste a connection code first.');

  const malformed = new Error(
    'That connection code could not be read. Copy it again from the home server setup page.'
  );

  // base64url -> base64, restore padding.
  let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';

  let json;
  try {
    json = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    throw malformed;
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw malformed;
  }

  const serverUrl =
    parsed && typeof parsed.url === 'string' ? parsed.url.trim().replace(/\/+$/, '') : '';
  const token = parsed && typeof parsed.token === 'string' ? parsed.token.trim() : '';
  if (!serverUrl || !token) {
    throw new Error('That connection code is missing the server URL or token.');
  }
  return { serverUrl, token };
}

module.exports = { get, save, applyConnectionCode, parseEnvFile, resolveMode, KEYS };
