const SENDGRID_MAIL_URL = 'https://api.sendgrid.com/v3/mail/send';
const DEFAULT_WEB_BASE_URL = 'https://devices.unicornextermination.info';
const DEFAULT_API_BASE_URL = 'https://api.unicornextermination.info';

function isEmailDeliveryConfigured() {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.EMAIL_FROM);
}

function verificationUrl(token) {
  const apiBaseUrl = process.env.API_PUBLIC_URL || DEFAULT_API_BASE_URL;
  return `${apiBaseUrl}/auth/verify-email?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendVerificationEmail(email, token) {
  if (!isEmailDeliveryConfigured()) {
    throw new Error('Email delivery is not configured');
  }

  const url = verificationUrl(token);
  const safeEmail = escapeHtml(email);
  const subject = 'Confirm your Smart Device account';
  const text = [
    `Hello ${email},`,
    '',
    'Confirm your email address to activate your Smart Device account:',
    url,
    '',
    'This link expires in 24 hours. If you did not create this account, you can ignore this email.'
  ].join('\n');
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#17202a">',
    `<p>Hello ${safeEmail},</p>`,
    '<p>Confirm your email address to activate your Smart Device account.</p>',
    `<p><a href="${url}" style="display:inline-block;padding:12px 18px;background:#17202a;color:#ffffff;text-decoration:none;border-radius:4px">Confirm email address</a></p>`,
    `<p>If the button does not work, copy this link into your browser:<br><a href="${url}">${url}</a></p>`,
    '<p>This link expires in 24 hours. If you did not create this account, you can ignore this email.</p>',
    '</body></html>'
  ].join('');

  const response = await fetch(SENDGRID_MAIL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from: { email: process.env.EMAIL_FROM },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html }
      ]
    })
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`SendGrid rejected email (${response.status}): ${responseBody}`);
  }
}

async function sendContactEmail({ name, email, subject, message }) {
  if (!isEmailDeliveryConfigured()) {
    throw new Error('Email delivery is not configured');
  }

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  const mailSubject = `[Smart Device contact] ${subject.replace(/[\r\n]+/g, ' ')}`;
  const text = [
    'New Smart Device website contact message',
    '',
    `From: ${name} <${email}>`,
    `Subject: ${subject}`,
    '',
    message
  ].join('\n');
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#17202a">',
    '<h2>New Smart Device website contact message</h2>',
    `<p><strong>From:</strong> ${safeName} &lt;${safeEmail}&gt;</p>`,
    `<p><strong>Subject:</strong> ${safeSubject}</p>`,
    `<p><strong>Message:</strong><br>${safeMessage}</p>`,
    '</body></html>'
  ].join('');

  const response = await fetch(SENDGRID_MAIL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: process.env.EMAIL_FROM }] }],
      from: { email: process.env.EMAIL_FROM },
      reply_to: { email, name },
      subject: mailSubject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html }
      ]
    })
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`SendGrid rejected contact email (${response.status}): ${responseBody}`);
  }
}

function verificationSuccessPage() {
  const webBaseUrl = process.env.WEB_BASE_URL || DEFAULT_WEB_BASE_URL;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email confirmed</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:24px;color:#17202a">
  <h1>Email confirmed</h1>
  <p>Your Smart Device account is active. You can now sign in.</p>
  <p><a href="${webBaseUrl}/" style="display:inline-block;padding:12px 18px;background:#17202a;color:#ffffff;text-decoration:none;border-radius:4px">Sign in</a></p>
</body></html>`;
}

function verificationFailurePage() {
  const webBaseUrl = process.env.WEB_BASE_URL || DEFAULT_WEB_BASE_URL;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verification link unavailable</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:24px;color:#17202a">
  <h1>Verification link unavailable</h1>
  <p>This confirmation link is invalid, expired, or has already been used.</p>
  <p><a href="${webBaseUrl}/">Return to Smart Device</a></p>
</body></html>`;
}

module.exports = {
  isEmailDeliveryConfigured,
  sendContactEmail,
  sendVerificationEmail,
  verificationFailurePage,
  verificationSuccessPage
};
