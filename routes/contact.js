const express = require('express');
const { isEmailDeliveryConfigured, sendContactEmail } = require('../services/email');

const router = express.Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;
const submissionTimesByIp = new Map();

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRateLimited(ipAddress) {
  const now = Date.now();
  const recentSubmissions = (submissionTimesByIp.get(ipAddress) || [])
    .filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (recentSubmissions.length >= MAX_SUBMISSIONS_PER_WINDOW) {
    submissionTimesByIp.set(ipAddress, recentSubmissions);
    return true;
  }

  recentSubmissions.push(now);
  submissionTimesByIp.set(ipAddress, recentSubmissions);
  return false;
}

router.post('/', async (req, res) => {
  const name = cleanText(req.body.name);
  const email = cleanText(req.body.email).toLowerCase();
  const subject = cleanText(req.body.subject);
  const message = cleanText(req.body.message);

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'name, email, subject, and message are required' });
  }
  if (name.length > 100 || email.length > 254 || subject.length > 200 || message.length > 5000) {
    return res.status(400).json({ error: 'name, email, subject, or message exceeds the allowed length' });
  }
  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'email address is invalid' });
  }
  if (!isEmailDeliveryConfigured()) {
    return res.status(503).json({ error: 'Contact email is not configured yet' });
  }
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many messages. Please try again later.' });
  }

  try {
    await sendContactEmail({ name, email, subject, message });
    res.status(202).json({ message: 'Message sent. We will get back to you soon.' });
  } catch (err) {
    console.error('[CONTACT] Email delivery failed:', err.message);
    res.status(502).json({ error: 'Could not send your message. Please try again later.' });
  }
});

module.exports = router;
