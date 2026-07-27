// Manual-email fallback (email-modal). When SMTP is down (or the operator
// just prefers their own mail client), this shows the EXACT Subject /
// recipient list / body the server would have sent — composed server-side
// from the same template — with copy buttons. The PDF is attached by hand.

import { showError, setStatus } from './status.js';
import { copyText } from './clipboard.js';
import { openModal, closeModal } from './modalKit.js';

let ctx = null;
let backdrop, toEl, subjectEl, bodyEl, noteEl;

export function initEmailPreview(context) {
  ctx = context;
  backdrop = document.getElementById('email-modal');
  toEl = document.getElementById('em-recipients');
  subjectEl = document.getElementById('em-subject');
  bodyEl = document.getElementById('em-body');
  noteEl = document.getElementById('em-note');

  const copy = (getText, label) => async () => {
    if (await copyText(getText())) {
      noteEl.textContent = `${label} copied.`;
    } else {
      noteEl.textContent = `Could not copy — select the ${label.toLowerCase()} text and copy manually.`;
    }
  };
  document.getElementById('em-copy-recipients').addEventListener('click', copy(() => toEl.value, 'Recipients'));
  document.getElementById('em-copy-subject').addEventListener('click', copy(() => subjectEl.value, 'Subject'));
  document.getElementById('em-copy-body').addEventListener('click', copy(() => bodyEl.value, 'Body'));
  document.getElementById('em-close').addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
}

function close() {
  closeModal(backdrop);
}

export async function openEmailPreview() {
  const jobId = ctx.state.job && ctx.state.job.id;
  if (!jobId || !ctx.api || typeof ctx.api.getEmailPreview !== 'function') {
    showError('The email text comes from the home server — upload the meeting first.');
    return;
  }
  setStatus('Fetching the email text…', { busy: true });
  try {
    const preview = await ctx.api.getEmailPreview(jobId);
    toEl.value = (preview.recipients || []).join(', ');
    subjectEl.value = preview.subject || '';
    bodyEl.value = preview.body || '';
    noteEl.textContent = ctx.state.pdfPath
      ? `Attach the PDF: ${ctx.state.pdfPath}`
      : 'Generate the PDF first, then attach it to the email.';
    openModal(backdrop, document.getElementById('em-close'));
    setStatus('Email text ready to copy.');
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}
