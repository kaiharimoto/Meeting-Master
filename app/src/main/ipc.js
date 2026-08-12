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
const recorder = require('./recorder');
const whisperLocator = require('./whisperLocator');
const modelManager = require('./modelManager');
const liveTranscriber = require('./liveTranscriber');
const liveFlagger = require('./liveFlagger');
const miniManager = require('./miniManager');

/**
 * @param {() => import('electron').BrowserWindow|null} getMainWindow
 *        Getter (not a direct reference) so recreated windows keep working.
 * @param {{setOverlayTheme?: (theme: string) => void}} [hooks]
 *        Main-process callbacks that don't belong to any service module.
 */
// Font extension -> the MIME type a data: URI needs. Anything unrecognized
// gets the generic type; browsers sniff the actual format anyway.
const FONT_MIME = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
};

function fontMimeType(filePath) {
  return FONT_MIME[require('path').extname(filePath).toLowerCase()] || 'application/octet-stream';
}

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

  // Like handle(), but only for OUR file:// pages (chooser, boot page,
  // operator renderer). The server-mode window navigates to the loopback
  // dashboard with the same preload attached — remote content must never be
  // able to switch modes or bounce the sidecar.
  function handleLocal(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        let url = '';
        try {
          url = (event.senderFrame && event.senderFrame.url) || '';
        } catch {
          url = '';
        }
        if (!url.startsWith('file:')) {
          throw new Error('This action is not available from the dashboard page.');
        }
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

  handle(CHANNELS.JOB_SUMMARIZE_RETRY, async (jobId) => {
    if (!jobId) throw new Error('No job to re-summarize.');
    return homeClient.retrySummary(jobId);
  });

  handle(CHANNELS.JOB_EMAIL_PREVIEW, async (jobId) => {
    if (!jobId) throw new Error('No job to build the email for.');
    return homeClient.getEmailPreview(jobId);
  });

  handle(CHANNELS.JOB_NAMES_GET, async (jobId) => {
    if (!jobId) throw new Error('No job to scan for names.');
    return homeClient.getJobNames(jobId);
  });

  handle(CHANNELS.JOB_NAMES_APPLY, async (jobId, mapping) => {
    if (!jobId) throw new Error('No job to apply names to.');
    return homeClient.applyJobNames(jobId, mapping || {});
  });

  handle(CHANNELS.JOB_DRAFT_ANSWERS, (jobId, questions, attendees) => {
    if (!jobId) throw new Error('Upload the meeting first — answers are drafted from its transcript.');
    return homeClient.draftAnswers(jobId, {
      questions: Array.isArray(questions) ? questions : [],
      attendees: Array.isArray(attendees) ? attendees : [],
    });
  });

  handle(CHANNELS.JOB_PROMPT, async (jobId) => {
    if (!jobId) throw new Error('No job to fetch a prompt for.');
    return { text: await homeClient.getJobPrompt(jobId) };
  });

  // ---- PDF -------------------------------------------------------------------

  handle(CHANNELS.PDF_RENDER, (meeting, summary) => {
    const cfg = config.get();
    return pdf.renderMeetingPdf({ meeting, summary, pageSize: cfg.pageSize });
  });

  handle(CHANNELS.PDF_PREVIEW, (meeting, summary) => {
    const cfg = config.get();
    return pdf.openPdfPreview({
      meeting,
      summary,
      pageSize: cfg.pageSize,
      parent: getMainWindow(),
    });
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

  // Write plain text to a path the user just picked via FILE_PICK_SAVE (the
  // renderer has no filesystem access). Used for transcript export.
  handle(CHANNELS.FILE_SAVE_TEXT, async (filePath, text) => {
    if (!filePath) throw new Error('No file path to save to.');
    require('fs').writeFileSync(filePath, String(text ?? ''), 'utf8');
    return { ok: true, path: filePath };
  });

  // ---- In-app recording (v0.8.0) --------------------------------------------
  // handleLocal: the dashboard page shares this preload and must never be able
  // to start capture or probe the recordings folder.

  handleLocal(CHANNELS.REC_START, (meta) => recorder.start(meta || {}));

  handleLocal(CHANNELS.REC_APPEND, (recId, seq, chunk, elapsedMs) =>
    recorder.append(recId, seq, chunk, elapsedMs)
  );

  handleLocal(CHANNELS.REC_STOP, (recId, info) => {
    const out = recorder.stop(recId, info || {});
    // "Stop recording and close" (window close guard): main.js waits for the
    // session to finalize before letting the window actually close.
    if (typeof hooks.onRecordingStopped === 'function') hooks.onRecordingStopped();
    return out;
  });

  handleLocal(CHANNELS.REC_DISCARD, (recId) => {
    const out = recorder.discard(recId);
    if (typeof hooks.onRecordingStopped === 'function') hooks.onRecordingStopped();
    return out;
  });

  handleLocal(CHANNELS.REC_ORPHANS, () => ({ orphans: recorder.listOrphans() }));

  handleLocal(CHANNELS.REC_ORPHAN_RESOLVE, (recId, action) =>
    recorder.resolveOrphan(recId, action)
  );

  handleLocal(CHANNELS.REC_STAT, (filePath) => recorder.stat(filePath));

  handleLocal(CHANNELS.REC_OPEN_FOLDER, async () => {
    const dir = paths.recordingsDir();
    const failure = await shell.openPath(dir); // '' on success
    if (failure) throw new Error(`Could not open the recordings folder: ${failure}`);
    return { ok: true, path: dir };
  });

  // ---- Live mid-meeting transcription (v0.9.0) ------------------------------
  // handleLocal throughout: local processes + the recording bus are involved.

  function pushTo(channel) {
    return (payload) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    };
  }
  liveTranscriber.setEmitter(pushTo(CHANNELS.LIVE_EVENT));
  liveFlagger.setEmitter(pushTo(CHANNELS.LIVE_EVENT));
  modelManager.setEmitter(pushTo(CHANNELS.LIVE_MODEL_EVENT));

  handleLocal(CHANNELS.LIVE_SUPPORT_GET, () => whisperLocator.support());
  handleLocal(CHANNELS.LIVE_MODEL_DOWNLOAD, (name) => modelManager.download(name));
  handleLocal(CHANNELS.LIVE_MODEL_DELETE, (name) => modelManager.remove(name));

  handleLocal(CHANNELS.LIVE_START, (opts) => {
    const input = opts || {};
    const model = config.get().liveModel || 'small';
    const out = liveTranscriber.start({
      attendees: Array.isArray(input.attendees) ? input.attendees : [],
      model,
    });
    liveFlagger.start(); // silent-skip loop; dies with the transcriber session
    return out;
  });

  handleLocal(CHANNELS.LIVE_PCM, (chunk, rms) => liveTranscriber.feed(chunk, rms));

  handleLocal(CHANNELS.LIVE_STOP, () => {
    liveFlagger.stop();
    return liveTranscriber.stop();
  });

  // ---- Usability batch (v0.10.0) --------------------------------------------

  // Pre-flight readiness probe for the Record panel's status chips.
  handleLocal(CHANNELS.PREFLIGHT_GET, async () => {
    let freeBytes = null;
    try {
      const s = require('fs').statfsSync(paths.recordingsDir());
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      // Unknown free space — the chip is simply omitted.
    }
    const server = { ok: false, error: null };
    try {
      await homeClient.health();
      server.ok = true;
    } catch (err) {
      server.error = err.message;
    }
    const live = whisperLocator.support();
    const model = config.get().liveModel || 'small';
    return {
      freeBytes,
      server,
      live: {
        supported: live.supported,
        modelReady: Boolean(live.models[model] && live.models[model].downloaded),
      },
    };
  });

  // Mini mode: the strip window is a remote control for the recording that
  // lives in the MAIN window's renderer (see miniManager.js).
  handleLocal(CHANNELS.MINI_OPEN, () => miniManager.open(getMainWindow));

  handleLocal(CHANNELS.MINI_CMD, (cmd) => {
    const c = String(cmd || '');
    if (c === 'expand' || c === 'q') {
      miniManager.close(); // restores + focuses the main window
    }
    if (c !== 'expand') {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.MINI_CMD, { cmd: c });
    }
    return { ok: true };
  });

  handleLocal(CHANNELS.MINI_STATUS, (payload) => {
    miniManager.forwardStatus(payload, getMainWindow);
    return { ok: true };
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

  // The brand font for the RENDERER (the PDF gets its own copy via
  // insertCSS in pdf.js). Sent as data: URIs rather than file:// paths
  // because the renderer's CSP is origin-scoped and the fonts live outside
  // the app directory in <userData>/fonts — a path that also differs between
  // dev and packaged builds, which is the same problem pdf.js works around.
  //
  // Only the weights the UI actually uses: Medium for reading, Roman as the
  // stand-in when no licensed Medium file was ever dropped in. Missing fonts
  // are not an error — callers fall back to the system stack.
  handleLocal(CHANNELS.FONTS_FACES, async () => {
    const wanted = [
      { base: 'NeueHaasGrotesk-Medium', weight: 500 },
      { base: 'NeueHaasGrotesk-Roman', weight: 400 },
    ];
    const faces = [];
    for (const { base, weight } of wanted) {
      const file = paths.findFont(base);
      if (!file) continue;
      try {
        const bytes = await require('fs/promises').readFile(file);
        faces.push({
          weight,
          family: 'Neue Haas Grotesk',
          dataUrl: `data:${fontMimeType(file)};base64,${bytes.toString('base64')}`,
        });
      } catch {
        // Unreadable font file — behave as if it were absent.
      }
    }
    return { faces };
  });

  // ---- App mode + sidecar (v0.3.0) ------------------------------------------

  handleLocal(CHANNELS.MODE_GET, () => ({ mode: config.resolveMode() }));

  handleLocal(CHANNELS.MODE_SET, async (mode) => {
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

  handleLocal(CHANNELS.SIDECAR_STATE_GET, () => serverManager.getState());

  handleLocal(CHANNELS.SIDECAR_RETRY, async () => {
    await serverManager.retry();
    return serverManager.getState();
  });

  handleLocal(CHANNELS.SIDECAR_OPEN_LOG, async () => {
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
      micDeviceId: cfg.micDeviceId,
      micDeviceLabel: cfg.micDeviceLabel,
      liveTranscriptEnabled: cfg.liveTranscriptEnabled,
      liveModel: cfg.liveModel,
      uiZoom: cfg.uiZoom,
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
      micDeviceId: cfg.micDeviceId,
      micDeviceLabel: cfg.micDeviceLabel,
      liveTranscriptEnabled: cfg.liveTranscriptEnabled,
      liveModel: cfg.liveModel,
      uiZoom: cfg.uiZoom,
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
      micDeviceId: input.micDeviceId,
      micDeviceLabel: input.micDeviceLabel,
      liveTranscriptEnabled: input.liveTranscriptEnabled,
      liveModel: input.liveModel,
      uiZoom: input.uiZoom,
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
    // A changed UI-size setting should take effect without a restart.
    require('./zoom').apply(getMainWindow());
    return safeFull(config.get());
  });
}

module.exports = { registerIpcHandlers };
