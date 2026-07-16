// Binds the "Meeting details" inputs to ctx.state (input events) and renders
// restored values back into the form.

let els = null;

// Attendees accept one-per-line or comma separated; recipients commas only.
function parseAttendees(text) {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRecipients(text) {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function initDetailsForm(ctx) {
  els = {
    title: document.getElementById('meeting-title-input'),
    date: document.getElementById('meeting-date-input'),
    time: document.getElementById('meeting-time-input'),
    attendees: document.getElementById('meeting-attendees-input'),
    recipients: document.getElementById('meeting-recipients-input'),
  };

  els.title.addEventListener('input', () => {
    ctx.state.details.title = els.title.value;
    ctx.persist();
  });
  els.date.addEventListener('input', () => {
    ctx.state.details.date = els.date.value;
    ctx.persist();
  });
  els.time.addEventListener('input', () => {
    ctx.state.details.time = els.time.value;
    ctx.persist();
  });
  els.attendees.addEventListener('input', () => {
    ctx.state.details.attendees = parseAttendees(els.attendees.value);
    ctx.persist();
  });
  els.recipients.addEventListener('input', () => {
    ctx.state.recipients = parseRecipients(els.recipients.value);
    ctx.persist();
  });
}

// Called on boot (restored state), New meeting, and after loading the mock.
// Never called on user input, so it can't fight the caret position.
export function renderDetailsForm(ctx) {
  const d = ctx.state.details || {};
  els.title.value = d.title || '';
  els.date.value = d.date || '';
  els.time.value = d.time || '';
  els.attendees.value = Array.isArray(d.attendees) ? d.attendees.join('\n') : '';
  els.recipients.value = Array.isArray(ctx.state.recipients) ? ctx.state.recipients.join(', ') : '';
}
