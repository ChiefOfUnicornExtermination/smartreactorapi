const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { importSPKI, jwtVerify } = require('jose');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');
const {
  isEmailDeliveryConfigured,
  sendVerificationEmail,
  verificationFailurePage,
  verificationSuccessPage
} = require('../services/email');

const router = express.Router();
const TAUCHO_SSO_ISSUER = process.env.TAUCHO_SSO_ISSUER || 'https://api.taucho.org';
const TAUCHO_SSO_AUDIENCE = process.env.TAUCHO_SSO_AUDIENCE || 'https://api.unicornextermination.info';
const TAUCHO_SSO_MAX_AGE_SECONDS = 300;

function createLoginToken(user) {
  return jwt.sign(
    { user_id: Number(user.id), email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function tauchoPublicKey() {
  if (process.env.TAUCHO_SSO_PUBLIC_KEY_BASE64) {
    return Buffer.from(process.env.TAUCHO_SSO_PUBLIC_KEY_BASE64, 'base64').toString('utf8');
  }
  const value = process.env.TAUCHO_SSO_PUBLIC_KEY;
  return value ? value.replace(/\\n/g, '\n') : '';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function createVerificationToken(conn, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await conn.query('DELETE FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL', [userId]);
  await conn.query(
    'INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR))',
    [tokenHash, userId]
  );
  return token;
}

async function verifyTauchoAssertion(assertion) {
  const publicKey = tauchoPublicKey();
  if (!publicKey) throw new Error('Taucho SSO public key is not configured');

  const key = await importSPKI(publicKey, 'RS256');
  const { payload } = await jwtVerify(assertion, key, {
    algorithms: ['RS256'],
    issuer: TAUCHO_SSO_ISSUER,
    audience: TAUCHO_SSO_AUDIENCE,
    maxTokenAge: `${TAUCHO_SSO_MAX_AGE_SECONDS}s`,
    clockTolerance: 5
  });

  if (
    typeof payload.sub !== 'string' || !payload.sub ||
    typeof payload.email !== 'string' || !payload.email ||
    typeof payload.jti !== 'string' || !payload.jti ||
    typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
    payload.exp <= payload.iat || payload.exp - payload.iat > TAUCHO_SSO_MAX_AGE_SECONDS
  ) {
    throw new Error('Taucho SSO assertion claims are invalid');
  }

  return {
    tauchoUserId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    jti: payload.jti,
    expiresAt: new Date(payload.exp * 1000)
  };
}

// POST /auth/signup
router.post('/signup', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'email address is invalid' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (!isEmailDeliveryConfigured()) {
    return res.status(503).json({ error: 'Account email confirmation is not configured yet' });
  }

  const db = req.app.locals.db;
  let conn;
  try {
    conn = await db.getConnection();
    const existing = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) return res.status(409).json({ error: 'Email already registered' });

    await conn.beginTransaction();
    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await conn.query(
      'INSERT INTO users (email, password_hash, email_verified_at) VALUES (?, ?, NULL)',
      [email, passwordHash]
    );
    const userId = Number(result.insertId);
    const token = await createVerificationToken(conn, userId);
    await conn.commit();

    await sendVerificationEmail(email, token);
    res.status(201).json({
      message: 'Account created. Check your email to confirm your address before signing in.',
      user_id: userId,
      email
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (rollbackErr) { console.error('[AUTH] Signup rollback failed:', rollbackErr.message); }
    }
    console.error('[AUTH] Signup error:', err.message);
    res.status(500).json({ error: 'Could not create account or send confirmation email' });
  } finally {
    if (conn) conn.release();
  }
});

// POST /auth/verify-email/resend
router.post('/verify-email/resend', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'email address is invalid' });
  if (!isEmailDeliveryConfigured()) {
    return res.status(503).json({ error: 'Account email confirmation is not configured yet' });
  }

  let conn;
  try {
    conn = await req.app.locals.db.getConnection();
    const users = await conn.query(
      'SELECT id, email_verified_at FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    if (!users.length || users[0].email_verified_at) {
      return res.json({ message: 'If this account needs confirmation, a new email has been sent.' });
    }

    const recentTokens = await conn.query(
      'SELECT token_hash FROM email_verification_tokens WHERE user_id = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 SECOND) LIMIT 1',
      [users[0].id]
    );
    if (recentTokens.length) {
      return res.status(429).json({ error: 'Please wait one minute before requesting another confirmation email.' });
    }

    await conn.beginTransaction();
    const token = await createVerificationToken(conn, Number(users[0].id));
    await conn.commit();
    await sendVerificationEmail(email, token);
    res.json({ message: 'If this account needs confirmation, a new email has been sent.' });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (rollbackErr) { console.error('[AUTH] Resend rollback failed:', rollbackErr.message); }
    }
    console.error('[AUTH] Verification resend error:', err.message);
    res.status(500).json({ error: 'Could not send confirmation email' });
  } finally {
    if (conn) conn.release();
  }
});

// GET /auth/verify-email?token=...
router.get('/verify-email', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.status(400).type('html').send(verificationFailurePage());

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let conn;
  try {
    conn = await req.app.locals.db.getConnection();
    await conn.beginTransaction();
    const tokens = await conn.query(
      'SELECT token_hash, user_id FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() LIMIT 1',
      [tokenHash]
    );
    if (!tokens.length) {
      await conn.rollback();
      return res.status(400).type('html').send(verificationFailurePage());
    }

    await conn.query('UPDATE users SET email_verified_at = UTC_TIMESTAMP() WHERE id = ?', [tokens[0].user_id]);
    await conn.query('UPDATE email_verification_tokens SET used_at = UTC_TIMESTAMP() WHERE token_hash = ?', [tokenHash]);
    await conn.query('DELETE FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL', [tokens[0].user_id]);
    await conn.commit();
    res.type('html').send(verificationSuccessPage());
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (rollbackErr) { console.error('[AUTH] Verification rollback failed:', rollbackErr.message); }
    }
    console.error('[AUTH] Verification error:', err.message);
    res.status(500).type('html').send(verificationFailurePage());
  } finally {
    if (conn) conn.release();
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
    const users = await conn.query(
      'SELECT id, email, password_hash, password_login_enabled, email_verified_at FROM users WHERE email = ?',
      [email]
    );
    conn.release();
    if (users.length === 0) return res.status(401).json({ error: 'Invalid email or password' });
    const user = users[0];
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.email_verified_at) {
      return res.status(403).json({ error: 'Confirm your email address before signing in. Check your inbox or request a new confirmation email.' });
    }
    if (!user.password_login_enabled) {
      return res.status(403).json({ error: 'Password login is not enabled for this account. Sign in through Taucho or set a password first.' });
    }
    const token = createLoginToken(user);
    res.json({ message: 'Login successful', token, user_id: Number(user.id), email: user.email });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/user/register
// Explicitly register a new user from Taucho SSO assertion
// Only for users who DON'T exist yet
router.post('/user/register', async (req, res) => {
  if (typeof req.body.assertion !== 'string' || !req.body.assertion) {
    return res.status(400).json({ error: 'assertion is required' });
  }

  let assertion;
  try {
    assertion = await verifyTauchoAssertion(req.body.assertion);
  } catch (err) {
    if (err.message === 'Taucho SSO public key is not configured') {
      console.error('[TAUCHO SSO] Public key is not configured');
      return res.status(503).json({ error: 'Taucho SSO is not configured' });
    }
    console.warn('[TAUCHO SSO] Rejected assertion:', err.code || err.message);
    return res.status(401).json({ error: 'Invalid or expired Taucho SSO assertion' });
  }

  let conn;
  try {
    conn = await req.app.locals.db.getConnection();
    await conn.beginTransaction();

    // Record the assertion as consumed
    await conn.query(
      'INSERT INTO taucho_sso_assertions (jti, expires_at) VALUES (?, ?)',
      [assertion.jti, assertion.expiresAt]
    );

    // Check if user already exists
    let users = await conn.query(
      'SELECT id FROM users WHERE email = ? OR taucho_user_id = ?',
      [assertion.email, assertion.tauchoUserId]
    );

    if (users.length > 0) {
      await conn.rollback();
      return res.status(409).json({ error: 'User with this email or Taucho ID already exists. Use /auth/taucho/exchange to link instead.' });
    }

    // Create new user account
    const unavailablePassword = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
    const result = await conn.query(
      'INSERT INTO users (email, password_hash, password_login_enabled, taucho_user_id, taucho_linked_at, email_verified_at) VALUES (?, ?, 0, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
      [assertion.email, unavailablePassword, assertion.tauchoUserId]
    );

    const user = {
      id: Number(result.insertId),
      email: assertion.email
    };

    await conn.commit();
    const token = createLoginToken(user);
    res.status(201).json({
      message: 'Account registered successfully',
      token,
      user_id: user.id,
      email: user.email
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (rollbackErr) { console.error('[TAUCHO SSO] Register rollback failed:', rollbackErr.message); }
    }
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Taucho SSO assertion was already used' });
    }
    console.error('[TAUCHO SSO] Register failed:', err.message);
    res.status(500).json({ error: 'Could not register account' });
  } finally {
    if (conn) conn.release();
  }
});

// POST /auth/taucho/exchange
// Links an existing Unicorn account to Taucho SSO
// Only for users who ALREADY exist
router.post('/taucho/exchange', async (req, res) => {
  if (typeof req.body.assertion !== 'string' || !req.body.assertion) {
    return res.status(400).json({ error: 'assertion is required' });
  }

  let assertion;
  try {
    assertion = await verifyTauchoAssertion(req.body.assertion);
  } catch (err) {
    if (err.message === 'Taucho SSO public key is not configured') {
      console.error('[TAUCHO SSO] Public key is not configured');
      return res.status(503).json({ error: 'Taucho SSO is not configured' });
    }
    console.warn('[TAUCHO SSO] Rejected assertion:', err.code || err.message);
    return res.status(401).json({ error: 'Invalid or expired Taucho SSO assertion' });
  }

  let conn;
  try {
    conn = await req.app.locals.db.getConnection();
    await conn.beginTransaction();

    // Record the assertion as consumed
    await conn.query(
      'INSERT INTO taucho_sso_assertions (jti, expires_at) VALUES (?, ?)',
      [assertion.jti, assertion.expiresAt]
    );

    // Check if already linked to this Taucho account
    let users = await conn.query(
      'SELECT id, email, taucho_user_id FROM users WHERE taucho_user_id = ?',
      [assertion.tauchoUserId]
    );
    let user = users[0];

    if (user) {
      // Already linked - just update email if changed
      if (user.email !== assertion.email) {
        await conn.query('UPDATE users SET email = ? WHERE id = ?', [assertion.email, user.id]);
        user.email = assertion.email;
      }
    } else {
      // Try to find user by email to link
      users = await conn.query(
        'SELECT id, email, taucho_user_id FROM users WHERE email = ?',
        [assertion.email]
      );
      user = users[0];

      if (!user) {
        await conn.rollback();
        return res.status(404).json({ error: 'User account not found. Register first using /auth/user/register.' });
      }

      if (user.taucho_user_id && user.taucho_user_id !== assertion.tauchoUserId) {
        await conn.rollback();
        return res.status(409).json({ error: 'This account is already linked to a different Taucho account' });
      }

      // Link the account
      await conn.query(
        'UPDATE users SET taucho_user_id = ?, taucho_linked_at = UTC_TIMESTAMP() WHERE id = ?',
        [assertion.tauchoUserId, user.id]
      );
    }

    await conn.commit();
    const token = createLoginToken(user);
    res.json({
      message: 'Taucho account linked successfully',
      token,
      user_id: Number(user.id),
      email: user.email
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (rollbackErr) { console.error('[TAUCHO SSO] Exchange rollback failed:', rollbackErr.message); }
    }
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Taucho SSO assertion was already used' });
    }
    console.error('[TAUCHO SSO] Exchange failed:', err.message);
    res.status(500).json({ error: 'Could not link Taucho account' });
  } finally {
    if (conn) conn.release();
  }
});

// POST /auth/password
// A Taucho-created user can set a local password after signing in via Taucho.
router.post('/password', authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  let conn;
  try {
    const passwordHash = bcrypt.hashSync(password, 12);
    conn = await req.app.locals.db.getConnection();
    await conn.query(
      'UPDATE users SET password_hash = ?, password_login_enabled = 1 WHERE id = ?',
      [passwordHash, req.user.user_id]
    );
    res.json({ message: 'Password set successfully' });
  } catch (err) {
    console.error('[AUTH] Password setup error:', err.message);
    res.status(500).json({ error: 'Failed to set password' });
  } finally {
    if (conn) conn.release();
  }
});

// POST /auth/verify  — confirm token still valid
router.post('/verify', authMiddleware, (req, res) => {
  res.json({ message: 'Token is valid', user_id: req.user.user_id, email: req.user.email });
});

// GET /auth/user/check
// Check if a user exists by email (no authentication required)
// Used by Taucho SSO to determine if user needs registration or linking
router.get('/user/check', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Missing email parameter' });
  }

  const emailTrimmed = String(email).trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(emailTrimmed)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  let conn;
  try {
    conn = await req.app.locals.db.getConnection();
    const users = await conn.query(
      'SELECT id FROM users WHERE email = ?',
      [emailTrimmed]
    );

    if (users.length > 0) {
      res.json({
        exists: true,
        email: emailTrimmed,
        user_id: Number(users[0].id)
      });
    } else {
      res.json({
        exists: false,
        email: emailTrimmed
      });
    }
  } catch (err) {
    console.error('[AUTH] User check error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
