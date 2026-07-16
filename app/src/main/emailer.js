'use strict';

// Laptop-side email (EMAIL_MODE=laptop): sends the PDF directly via Gmail.
// Gmail requires an App Password (https://myaccount.google.com/apppasswords)
// over smtp.gmail.com:465 with implicit SSL — the account password will NOT
// work and plain STARTTLS on 587 is deliberately not used here.

const path = require('path');
const nodemailer = require('nodemailer');

/**
 * Email the rendered PDF to meeting.recipients.
 * The body mirrors config/email_template.example.txt with values substituted.
 */
async function sendMeetingPdf({ meeting, pdfPath, smtpUser, smtpAppPassword }) {
  const recipients = Array.isArray(meeting && meeting.recipients)
    ? meeting.recipients.map((r) => String(r).trim()).filter(Boolean)
    : [];
  if (recipients.length === 0) {
    // The preset recipients list is server-side only; laptop mode cannot use it.
    throw new Error(
      'Laptop email mode needs recipients entered in the app — the preset list lives on the home server'
    );
  }

  const details = (meeting && meeting.details) || {};
  const title = details.title || 'Untitled meeting';
  const date = details.date || '';
  const time = details.time || '';
  const attendees = Array.isArray(details.attendees) ? details.attendees.join(', ') : '';

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // implicit SSL on 465
    auth: { user: smtpUser, pass: smtpAppPassword },
  });

  // Mirrors config/email_template.example.txt.
  const text = [
    'Hello,',
    '',
    `Attached are the meeting notes for "${title}" held on ${date} at ${time}.`,
    '',
    `Attendees: ${attendees}`,
    '',
    'The PDF includes the meeting details, the key questions and answers captured',
    'during the meeting, and a general summary of the discussion.',
    '',
    '— Sent automatically by Meeting Master',
  ].join('\n');

  await transporter.sendMail({
    from: smtpUser,
    to: recipients.join(', '),
    subject: `Meeting Notes — ${title} (${date})`,
    text,
    attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
  });
}

module.exports = { sendMeetingPdf };
