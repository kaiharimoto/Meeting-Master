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

  return {
    serverUrl: val('HOME_SERVER_URL').replace(/\/+$/, ''),
    bearerToken: val('BEARER_TOKEN'),
    emailMode,
    pageSize,
    smtpUser: val('SMTP_USER'),
    smtpAppPassword: val('SMTP_APP_PASSWORD'),
    configPath: loadedPath || candidates[0],
  };
}

module.exports = { get, parseEnvFile, KEYS };
