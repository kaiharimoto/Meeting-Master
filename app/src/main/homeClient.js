'use strict';

// HTTP client for the home AI server (see docs: GET /health, POST /jobs,
// GET /jobs/{id}, POST /jobs/{id}/pdf). Uses the global fetch available in
// Electron's main process (Node >= 18).

const fs = require('node:fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');

const BODY_SNIPPET_LIMIT = 300;

function requireServerConfig() {
  const cfg = config.get();
  if (!cfg.serverUrl) {
    throw new Error(
      `HOME_SERVER_URL is not set — create ${cfg.configPath} from config/laptop.env.example.`
    );
  }
  if (!cfg.bearerToken) {
    throw new Error(
      `BEARER_TOKEN is not set — add it to ${cfg.configPath} (must match the home server).`
    );
  }
  return {
    base: cfg.serverUrl,
    headers: { Authorization: `Bearer ${cfg.bearerToken}` },
  };
}

// fetch() rejects with an unhelpful "fetch failed" TypeError on network
// errors; rethrow with the underlying cause and a hint the operator can act on.
async function doFetch(url, options, what) {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      throw new Error(`The home server did not respond in time while ${what}.`);
    }
    const cause = err && err.cause && err.cause.message ? ` (${err.cause.message})` : '';
    throw new Error(
      `Could not reach the home server while ${what}${cause}. ` +
        'Check HOME_SERVER_URL and that the server (and Tailscale) is up.'
    );
  }
}

async function throwHttpError(res, what) {
  let body = '';
  try {
    body = await res.text();
  } catch {
    // body unreadable — the status alone will have to do
  }
  if (body.length > BODY_SNIPPET_LIMIT) body = `${body.slice(0, BODY_SNIPPET_LIMIT)}…`;
  const detail = body ? ` — ${body}` : '';
  throw new Error(`Home server returned ${res.status} while ${what}${detail}`);
}

/**
 * Wrap a file as a Blob for multipart upload WITHOUT reading it into RAM.
 * fs.openAsBlob (Node >= 20, present in Electron 37) returns a file-backed
 * Blob that undici streams from disk. The buffer fallback exists only for
 * exotic runtimes and is loudly warned about — meeting WAVs run ~600MB.
 */
async function fileToBlob(filePath) {
  if (typeof fs.openAsBlob === 'function') {
    return fs.openAsBlob(filePath);
  }
  console.warn(
    '[homeClient] fs.openAsBlob is unavailable — falling back to reading the ' +
      'whole file into memory. Large uploads may exhaust RAM.'
  );
  const buffer = await fsp.readFile(filePath);
  return new Blob([buffer]);
}

/**
 * POST /jobs — multipart: "meeting" = JSON string, "file" = the audio.
 * Returns the new job id. No timeout: a ~600MB WAV over a relay can be slow.
 */
async function uploadMeeting(meeting, wavFilePath) {
  const { base, headers } = requireServerConfig();
  const form = new FormData();
  form.set('meeting', JSON.stringify(meeting));
  form.set('file', await fileToBlob(wavFilePath), path.basename(wavFilePath));

  const res = await doFetch(
    `${base}/jobs`,
    { method: 'POST', headers, body: form },
    'uploading the recording'
  );
  if (!res.ok) await throwHttpError(res, 'uploading the recording'); // expect 202
  const body = await res.json();
  if (!body || typeof body.id !== 'string') {
    throw new Error('Home server accepted the upload but returned no job id.');
  }
  return body.id;
}

/** GET /jobs/{id} — returns the full job record. */
async function getJob(jobId) {
  const { base, headers } = requireServerConfig();
  const res = await doFetch(
    `${base}/jobs/${encodeURIComponent(jobId)}`,
    { headers, signal: AbortSignal.timeout(30000) },
    'checking job status'
  );
  if (!res.ok) await throwHttpError(res, 'checking job status');
  return res.json();
}

/**
 * POST /jobs/{id}/pdf — multipart file field "file" = the rendered PDF.
 * The server stores it, then emails it via SMTP; returns {ok, emailed, error}.
 */
async function postPdf(jobId, pdfPath) {
  const { base, headers } = requireServerConfig();
  const form = new FormData();
  form.set('file', await fileToBlob(pdfPath), path.basename(pdfPath));

  const res = await doFetch(
    `${base}/jobs/${encodeURIComponent(jobId)}/pdf`,
    { method: 'POST', headers, body: form },
    'sending the PDF for emailing'
  );
  if (!res.ok) await throwHttpError(res, 'sending the PDF for emailing');
  return res.json();
}

/** GET /health — unauthenticated reachability probe (5s timeout). */
async function health() {
  const cfg = config.get();
  if (!cfg.serverUrl) throw new Error('HOME_SERVER_URL is not set.');
  const res = await doFetch(
    `${cfg.serverUrl}/health`,
    { signal: AbortSignal.timeout(5000) },
    'checking server health'
  );
  if (!res.ok) await throwHttpError(res, 'checking server health');
  return res.json();
}

/** GET /jobs — trimmed list of recent jobs (newest first). */
async function listJobs(limit = 50) {
  const { base, headers } = requireServerConfig();
  const res = await doFetch(
    `${base}/jobs?limit=${encodeURIComponent(limit)}`,
    { headers, signal: AbortSignal.timeout(15000) },
    'listing jobs'
  );
  if (!res.ok) await throwHttpError(res, 'listing jobs');
  return res.json();
}

/** GET /jobs/{id}/prompt — the external-AI prompt harness for a job's
 *  transcript (plain text, composed by the server as the single source of
 *  truth so the format never drifts from what the local model gets). */
async function getJobPrompt(jobId) {
  const { base, headers } = requireServerConfig();
  const res = await doFetch(
    `${base}/jobs/${encodeURIComponent(jobId)}/prompt`,
    { headers, signal: AbortSignal.timeout(30000) },
    'fetching the AI prompt'
  );
  if (!res.ok) await throwHttpError(res, 'fetching the AI prompt');
  return res.text();
}

/** POST /jobs/{id}/summarize — re-run ONLY the AI stages (summary + Q&A)
 *  on the job's stored transcript. */
async function retrySummary(jobId) {
  const { base, headers } = requireServerConfig();
  const res = await doFetch(
    `${base}/jobs/${encodeURIComponent(jobId)}/summarize`,
    { method: 'POST', headers, signal: AbortSignal.timeout(15000) },
    'retrying the AI summary'
  );
  if (!res.ok) await throwHttpError(res, 'retrying the AI summary');
  return res.json();
}

/** GET /jobs/{id}/email — the exact Subject/recipients/body the server
 *  would send, for manual copy-paste emailing when SMTP is down. */
async function getEmailPreview(jobId) {
  const { base, headers } = requireServerConfig();
  const res = await doFetch(
    `${base}/jobs/${encodeURIComponent(jobId)}/email`,
    { headers, signal: AbortSignal.timeout(15000) },
    'fetching the email text'
  );
  if (!res.ok) await throwHttpError(res, 'fetching the email text');
  return res.json();
}

/** GET /jobs/{id}/names — candidate person names in the transcript. */
async function getJobNames(jobId) {
  const { base, headers } = requireServerConfig();
  const res = await doFetch(
    `${base}/jobs/${encodeURIComponent(jobId)}/names`,
    { headers, signal: AbortSignal.timeout(15000) },
    'scanning the transcript for names'
  );
  if (!res.ok) await throwHttpError(res, 'scanning the transcript for names');
  return res.json();
}

/** POST /jobs/{id}/names — rewrite the STORED transcript with a
 *  {wrong: corrected} name mapping so the AI reads the fixed names. */
async function applyJobNames(jobId, mapping) {
  const { base, headers } = requireServerConfig();
  const res = await doFetch(
    `${base}/jobs/${encodeURIComponent(jobId)}/names`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping }),
      signal: AbortSignal.timeout(20000),
    },
    'applying the name corrections'
  );
  if (!res.ok) await throwHttpError(res, 'applying the name corrections');
  return res.json();
}

/** GET /logs/tail — the last N server log lines. */
async function getLogTail(lines = 200) {
  const { base, headers } = requireServerConfig();
  const res = await doFetch(
    `${base}/logs/tail?lines=${encodeURIComponent(lines)}`,
    { headers, signal: AbortSignal.timeout(15000) },
    'fetching the server log'
  );
  if (!res.ok) await throwHttpError(res, 'fetching the server log');
  return res.json();
}

module.exports = { uploadMeeting, getJob, postPdf, health, listJobs, getLogTail, getJobPrompt, retrySummary, getEmailPreview, getJobNames, applyJobNames };
