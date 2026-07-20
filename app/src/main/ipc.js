'use strict';

// Registers an ipcMain.handle for every channel in shared/schema.js CHANNELS,
// plus the main->renderer JOB_PROGRESS event.

const { app, ipcMain, dialog, shell } = require('electron');
const { CHANNELS } = require('../shared/schema');
const config = require('./config');
const homeClient = require('./homeClient');
const pdf = require('./pdf');
const emailer = require('./emailer');
const sseClient = require('./sseClient');
const updater = require('./updater');
const paths = require('./paths');
const serverManager = require('./serverManager');

/**
 * @param {() => import('electron').BrowserWindow|null} getMainWindow
 *        Getter (not a direct reference) so recreated windows keep working.
 * @param {{setOverlayTheme?: (theme: string) => void}} [hooks]
 *        Main-process callbacks that don't belong to any service module.
 */
function registerIpcHandlers(getMainWindow, hooks = {}) {
  function sendProgress(payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(CHANNELS.JOB_PROGRESS, payload);
    }
  }

  // A rejected ipcRenderer.invoke reaches the renderer wrapped in
  // "Error invoking remote method '...' : Error: ..." noise (plus a main-side
  // stack). Instead, every handler resolves with a bare {error: message}
  // (exactly one key) on failure; the preload wrapper re-throws it as a clean
  // Error the renderer can show on the status line.
  function handle(channel, fn) {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      }
    });
  }

  // ---- Jobs ----------------------------------------------------------------

  handle(CHANNELS.JOB_UPLOAD, async (meeting, wavFilePath) => {
    const cfg = config.get();
    if (!cfg.serverUrl || !cfg.bearerToken) {
      throw new Error(
        'The home server is not configured yet. Create ' +
          `${cfg.configPath} with HOME_SERVER_URL and BEARER_TOKEN ` +
          '(copy config/laptop.env.example).'
      );
    }
    if (!wavFilePath) throw new Error('No audio file was selected.');

    sendProgress({
      jobId: null,
      state: 'uploading',
      message: 'Uploading the recording to the home server… (large files take a while)',
    });
    try {
      const jobId = await homeClient.uploadMeeting(meeting, wavFilePath);
      sendProgress({
        jobId,
        state: 'queued',
        message: 'Upload complete — the home server queued the job.',
      });
      return { jobId };
    } catch (err) {
      sendProgress({ jobId: null, state: 'failed', message: err.message });
      throw err;
    }
  });

  handle(CHANNELS.JOB_STATUS, (jobId) => homeClient.getJob(jobId));

  // ---- PDF -------------------------------------------------------------------

  handle(CHANNELS.PDF_RENDER, (meeting, transcript, summary) => {
    const cfg = config.get();
    return pdf.renderMeetingPdf({ meeting, transcript, summary, pageSize: cfg.pageSize });
  });

  handle(CHANNELS.PDF_OPEN, async (pdfPath) => {
    if (!pdfPath) throw new Error('No PDF has been generated yet.');
    const failure = await shell.openPath(pdfPath); // '' on success
    if (failure) throw new Error(`Could not open the PDF: ${failure}`);
    return { ok: true };
  });

  handle(CHANNELS.PDF_SEND_HOME, (jobId, pdfPath) => {
    // Returns the server's {ok, emailed, error} verbatim so the renderer can
    // distinguish "stored but email failed" from full success.
    return homeClient.postPdf(jobId, pdfPath);
  });

  handle(CHANNELS.PDF_SEND_LAPTOP, async (meeting, pdfPath) => {
    const cfg = config.get();
    if (!cfg.smtpUser || !cfg.smtpAppPassword) {
      throw new Error(
        'Laptop email mode needs SMTP_USER and SMTP_APP_PASSWORD in ' +
          `${cfg.configPath} — use a Gmail App Password, never the account password.`
      );
    }
    if (!pdfPath) throw new Error('Generate the PDF before sending the email.');
    await emailer.sendMeetingPdf({
      meeting,
      pdfPath,
      smtpUser: cfg.smtpUser,
      smtpAppPassword: cfg.smtpAppPassword,
    });
    return { ok: true, error: null };
  });

  // ---- File dialogs ----------------------------------------------------------

  handle(CHANNELS.FILE_PICK_WAV, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Pick the meeting recording',
      properties: ['openFile'],
      // The server transcodes with ffmpeg anyway, so accept common formats.
      filters: [
        { name: 'Audio recordings', extensions: ['wav', 'flac', 'mp3', 'm4a', 'ogg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return { filePath: !canceled && filePaths.length > 0 ? filePaths[0] : null };
  });

  handle(CHANNELS.FILE_PICK_SAVE, async (defaultName) => {
    const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Save as',
      defaultPath: defaultName || undefined,
    });
    return { filePath: !canceled && filePath ? filePath : null };
  });

  // ---- App shell ---------------------------------------------------------------

  handle(CHANNELS.APP_INFO, () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  handle(CHANNELS.WINDOW_SET_OVERLAY, (theme) => {
    if (typeof hooks.setOverlayTheme === 'function') {
      hooks.setOverlayTheme(theme === 'dark' ? 'dark' : 'light');
    }
    return { ok: true };
  });

  // ---- Live monitoring -------------------------------------------------------

  handle(CHANNELS.SERVER_STATUS_GET, () => sseClient.getStatus());
  handle(CHANNELS.JOBS_LIST, (limit) => homeClient.listJobs(limit));
  handle(CHANNELS.LOGS_TAIL, (lines) => homeClient.getLogTail(lines));

  // ---- Auto-update + fonts ---------------------------------------------------

  handle(CHANNELS.UPDATE_STATE_GET, () => updater.getState());
  handle(CHANNELS.UPDATE_CHECK, async () => {
    await updater.checkNow();
    return updater.getState();
  });
  handle(CHANNELS.UPDATE_INSTALL, () => updater.installNow());

  handle(CHANNELS.FONTS_OPEN, async () => {
    const dir = paths.userFontsDir();
    const failure = await shell.openPath(dir); // '' on success
    if (failure) throw new Error(`Could not open the fonts folder: ${failure}`);
    return { ok: true, path: dir };
  });

  // ---- App mode + sidecar (v0.3.0) ------------------------------------------

  handle(CHANNELS.MODE_GET, () => ({ mode: config.resolveMode() }));

  handle(CHANNELS.MODE_SET, async (mode) => {
    const next = String(mode) === 'server' ? 'server' : 'operator';
    config.save({ mode: next });
    // A mode is a different app: stop whatever this one was doing, then
    // relaunch cleanly into the new one.
    serverManager.kill();
    sseClient.stop();
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 400); // let the renderer paint its "restarting…" feedback first
    return { ok: true, mode: next };
  });

  handle(CHANNELS.SIDECAR_STATE_GET, () => serverManager.getState());

  handle(CHANNELS.SIDECAR_RETRY, async () => {
    await serverManager.retry();
    return serverManager.getState();
  });

  handle(CHANNELS.SIDECAR_OPEN_LOG, async () => {
    const logPath = serverManager.serverLogPath();
    const failure = await shell.openPath(logPath); // '' on success
    if (failure) {
      // No log yet (server never started): fall back to the config folder.
      const dirFailure = await shell.openPath(serverManager.configHome());
      if (dirFailure) throw new Error(`Could not open the server log: ${failure}`);
    }
    return { ok: true, path: logPath };
  });

  // ---- Config ------------------------------------------------------------------

  handle(CHANNELS.CONFIG_GET, () => {
    const cfg = config.get();
    // Safe subset only: the bearer token and SMTP password must never reach
    // the renderer process.
    return {
      serverUrl: cfg.serverUrl,
      emailMode: cfg.emailMode,
      pageSize: cfg.pageSize,
      hasToken: Boolean(cfg.bearerToken),
      configPath: cfg.configPath,
    };
  });

  // Pre-fill subset for the Settings form. Reports whether the secrets are set
  // (hasToken / hasSmtpPassword) but never returns the secrets themselves.
  function safeFull(cfg) {
    return {
      serverUrl: cfg.serverUrl,
      emailMode: cfg.emailMode,
      pageSize: cfg.pageSize,
      smtpUser: cfg.smtpUser,
      hasToken: Boolean(cfg.bearerToken),
      hasSmtpPassword: Boolean(cfg.smtpAppPassword),
      configPath: cfg.configPath,
    };
  }

  handle(CHANNELS.CONFIG_GET_FULL, () => safeFull(config.get()));

  handle(CHANNELS.CONFIG_SAVE, (values) => {
    const input = values || {};

    const toSave = {
      serverUrl: input.serverUrl,
      token: input.token,
      emailMode: input.emailMode,
      pageSize: input.pageSize,
      smtpUser: input.smtpUser,
      smtpPassword: input.smtpPassword,
    };

    // A pasted connection code wins over any typed URL/token fields.
    if (input.connectionCode !== undefined && String(input.connectionCode).trim() !== '') {
      const decoded = config.applyConnectionCode(input.connectionCode);
      toSave.serverUrl = decoded.serverUrl;
      toSave.token = decoded.token;
    }

    // Normalize the enum-ish fields so the written file stays clean.
    if (toSave.emailMode !== undefined) {
      toSave.emailMode = String(toSave.emailMode).toLowerCase() === 'laptop' ? 'laptop' : 'home';
    }
    if (toSave.pageSize !== undefined) {
      toSave.pageSize = String(toSave.pageSize).toLowerCase() === 'a4' ? 'A4' : 'Letter';
    }

    config.save(toSave);
    // New URL/token: reconnect the live event stream and re-point the updater.
    sseClient.restart();
    updater.onConfigChanged();
    return safeFull(config.get());
  });
}

module.exports = { registerIpcHandlers };
