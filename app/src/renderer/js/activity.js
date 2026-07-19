// Activity screen: live pipeline stepper for the current job, the home
// server's recent-jobs list, and a streaming log viewer. Fed by SSE events
// relayed from the main process, with the Meeting screen's polling (mm:job
// DOM events) as the fallback signal. All api calls are guarded — the screen
// renders sensibly with a stubbed or older window.api.

const STEPS = [
  { key: 'queued', label: 'Queued' },
  { key: 'normalizing', label: 'Normalize' },
  { key: 'transcribing', label: 'Transcribe' },
  { key: 'summarizing', label: 'Summarize' },
  { key: 'ready', label: 'Ready' },
];
const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.key, i]));
const DONE_STATES = new Set(['ready', 'pdf_received', 'emailed']);
const LOG_CAP = 1000;

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

let ctx = null;
let els = null;
// The freshest view of the current job: seeded from ctx.state.job, overlaid
// with any SSE `job` event carrying the same id.
let liveJob = null;
let jobsCache = [];
let logLines = [];
let loadedOnce = false;

export function initActivity(context) {
  ctx = context;
  els = {
    pipeline: document.getElementById('pipeline-host'),
    jobs: document.getElementById('jobs-list-host'),
    log: document.getElementById('log-view'),
    follow: document.getElementById('log-follow-check'),
    refresh: document.getElementById('log-refresh-btn'),
  };
  if (!els.pipeline) return;

  els.refresh.addEventListener('click', () => loadLog());

  document.addEventListener('mm:screen', (e) => {
    if (e.detail && e.detail.screen === 'activity') onEnter();
  });
  document.addEventListener('mm:job', () => {
    liveJob = null; // state.job changed via polling — drop the SSE overlay
    renderPipeline();
  });

  const api = ctx.api;
  if (api && typeof api.onServerEvent === 'function') {
    api.onServerEvent(onServerEvent);
  }

  renderPipeline();
  renderJobs();
  renderLog();
}

function onEnter() {
  renderPipeline();
  if (!loadedOnce) {
    loadedOnce = true;
    loadJobs();
    loadLog();
  } else {
    loadJobs(); // cheap refresh on every visit; SSE keeps it live in between
  }
}

function onServerEvent(payload) {
  if (!payload) return;
  if (payload.type === 'sse' && payload.event === 'hello' && payload.data) {
    if (Array.isArray(payload.data.jobs)) {
      jobsCache = payload.data.jobs;
      renderJobs();
    }
    return;
  }
  if (payload.type === 'sse' && payload.event === 'job' && payload.data) {
    patchJob(payload.data);
    return;
  }
  if (payload.type === 'sse' && payload.event === 'log' && payload.data) {
    appendLog([payload.data.line].filter(Boolean));
  }
}

// ---- Pipeline stepper -------------------------------------------------------

function currentJob() {
  const base = (ctx.state.job && ctx.state.job.id) ? { ...ctx.state.job } : null;
  if (!base) return null;
  if (liveJob && liveJob.id === base.id) {
    return { ...base, ...liveJob };
  }
  return base;
}

function renderPipeline() {
  const host = els.pipeline;
  host.replaceChildren();
  const job = currentJob();

  if (!job || !job.state) {
    const empty = document.createElement('div');
    empty.className = 'pipeline-empty';
    empty.textContent =
      'No job yet — pick the meeting audio on the Meeting screen to start the AI.';
    host.append(empty);
    return;
  }

  const isDone = DONE_STATES.has(job.state);
  const failed = job.state === 'failed';
  const activeIdx = isDone
    ? STEPS.length - 1
    : STEP_INDEX[job.state] !== undefined
      ? STEP_INDEX[job.state]
      : 0;

  const rail = document.createElement('div');
  rail.className = 'pipeline';

  STEPS.forEach((step, i) => {
    const el = document.createElement('div');
    el.className = 'pipe-step';
    const done = isDone || i < activeIdx;
    const current = !isDone && !failed && i === activeIdx;
    if (done) el.classList.add('done');
    if (current) el.classList.add('current');
    if (failed && i === activeIdx) el.classList.add('failed');

    const dot = document.createElement('span');
    dot.className = 'pipe-dot';
    if (done) dot.innerHTML = CHECK_SVG; // static trusted markup
    else dot.textContent = failed && i === activeIdx ? '!' : '';
    el.append(dot);

    const label = document.createElement('span');
    label.className = 'pipe-label';
    label.textContent = step.label;
    el.append(label);

    const sub = document.createElement('span');
    sub.className = 'pipe-sub';
    if (step.key === 'transcribing' && current && typeof job.progress === 'number' && job.progress > 0) {
      sub.textContent = `${job.progress}%`;
    } else {
      sub.textContent = ' ';
    }
    el.append(sub);

    rail.append(el);
  });
  host.append(rail);

  if (failed) {
    const err = document.createElement('div');
    err.className = 'pipeline-error';
    err.textContent = `Job failed${job.error ? `: ${job.error}` : ''} — see the server log below.`;
    host.append(err);
  }
}

// ---- Recent jobs ------------------------------------------------------------

async function loadJobs() {
  const api = ctx.api;
  if (!api || typeof api.listJobs !== 'function') return renderJobs();
  // Skeletons while loading (only when we have nothing to show yet).
  if (jobsCache.length === 0) {
    els.jobs.replaceChildren(...[1, 2, 3].map(() => {
      const sk = document.createElement('div');
      sk.className = 'skeleton';
      sk.style.height = '38px';
      sk.style.marginBottom = '8px';
      return sk;
    }));
  }
  try {
    const payload = await api.listJobs(50);
    jobsCache = (payload && payload.jobs) || [];
  } catch {
    jobsCache = jobsCache || [];
  }
  renderJobs();
}

function patchJob(trimmed) {
  if (!trimmed || !trimmed.id) return;
  const idx = jobsCache.findIndex((j) => j.id === trimmed.id);
  if (idx >= 0) jobsCache[idx] = { ...jobsCache[idx], ...trimmed };
  else jobsCache.unshift(trimmed);
  renderJobs();

  // The same event may concern the meeting currently in flight.
  if (ctx.state.job && ctx.state.job.id === trimmed.id) {
    liveJob = trimmed;
    renderPipeline();
  }
}

function friendlyWhen(iso) {
  if (!iso) return '';
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const min = Math.round((Date.now() - then) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    if (min < 60 * 24) return `${Math.round(min / 60)}h ago`;
    return `${Math.round(min / 1440)}d ago`;
  } catch {
    return iso;
  }
}

function renderJobs() {
  const host = els.jobs;
  host.replaceChildren();
  if (jobsCache.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'jobs-empty';
    empty.textContent = ctx.api && typeof ctx.api.listJobs === 'function'
      ? 'No jobs on the home server yet — start one from the Meeting screen.'
      : 'Connect to the home server to see its job history here.';
    host.append(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'jobs-list';
  jobsCache.slice(0, 25).forEach((job) => {
    const row = document.createElement('div');
    row.className = 'job-row';

    const title = document.createElement('span');
    title.className = 'job-title';
    title.textContent = job.title || '(untitled meeting)';
    title.title = `${job.id}`;
    row.append(title);

    const chip = document.createElement('span');
    chip.className = 'state-chip';
    chip.dataset.state = job.state || '';
    chip.textContent =
      job.state === 'transcribing' && typeof job.progress === 'number' && job.progress > 0
        ? `transcribing ${job.progress}%`
        : (job.state || 'unknown').replace('_', ' ');
    row.append(chip);

    const when = document.createElement('span');
    when.className = 'job-when';
    when.textContent = friendlyWhen(job.updatedAt);
    row.append(when);

    list.append(row);
  });
  host.append(list);
}

// ---- Log viewer -------------------------------------------------------------

async function loadLog() {
  const api = ctx.api;
  if (!api || typeof api.getLogTail !== 'function') return renderLog();
  try {
    const payload = await api.getLogTail(200);
    logLines = (payload && payload.lines) || [];
  } catch (err) {
    logLines = [`(could not fetch the server log: ${err && err.message ? err.message : err})`];
  }
  renderLog();
}

function appendLog(lines) {
  if (!lines.length) return;
  logLines.push(...lines);
  if (logLines.length > LOG_CAP) logLines = logLines.slice(-LOG_CAP);
  renderLog();
}

function renderLog() {
  const view = els.log;
  if (!view) return;
  view.replaceChildren(
    ...logLines.map((line) => {
      const el = document.createElement('span');
      el.className = 'log-line';
      el.textContent = line;
      return el;
    })
  );
  if (logLines.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'log-line';
    empty.textContent = '(no log lines yet)';
    view.append(empty);
  }
  if (els.follow && els.follow.checked) {
    view.scrollTop = view.scrollHeight;
  }
}
