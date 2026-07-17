'use strict';

// Registers an ipcMain.handle for every channel in shared/schema.js CHANNELS,
// plus the main->renderer JOB_PROGRESS event.

const { ipcMain, dialog, shell } = require('electron');
const { CHANNELS } = require('../shared/schema');
const config = require('./config');
const homeClient = require('./homeClient');
const pdf = require('./pdf');
const emailer = require('./emailer');

/**
 * @param {() => import('electron').BrowserWindow|null} getMainWindow
 *        Getter (not a direct reference) so recreated windows keep working.
 */
function registerIpcHandlers(getMainWindow) {
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
    return safeFull(config.get());
  });
}

module.exports = { registerIpcHandlers };
