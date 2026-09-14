const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { importSPKI, jwtVerify } = require('jose');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

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
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
    const existing = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) { conn.release(); return res.status(409).json({ error: 'Email already registered' }); }
    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await conn.query('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash]);
    conn.release();
    res.status(201).json({ message: 'Account created successfully', user_id: Number(result.insertId), email });
  } catch (err) {
    console.error('[AUTH] Signup error:', err.message);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
    const users = await conn.query(
      'SELECT id, email, password_hash, password_login_enabled FROM users WHERE email = ?',
      [email]
    );
    conn.release();
    if (users.length === 0) return res.status(401).json({ error: 'Invalid email or password' });
    const user = users[0];
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
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

// POST /auth/taucho/exchange
// Exchanges a short-lived Taucho-signed assertion for the normal device API JWT.
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
    await conn.query(
      'INSERT INTO taucho_sso_assertions (jti, expires_at) VALUES (?, ?)',
      [assertion.jti, assertion.expiresAt]
    );

    let users = await conn.query(
      'SELECT id, email, taucho_user_id FROM users WHERE taucho_user_id = ?',
      [assertion.tauchoUserId]
    );
    let user = users[0];
    let created = false;

    if (user) {
      if (user.email !== assertion.email) {
        await conn.query('UPDATE users SET email = ? WHERE id = ?', [assertion.email, user.id]);
        user.email = assertion.email;
      }
    } else {
      users = await conn.query(
        'SELECT id, email, taucho_user_id FROM users WHERE email = ?',
        [assertion.email]
      );
      user = users[0];
      if (user && user.taucho_user_id && user.taucho_user_id !== assertion.tauchoUserId) {
        throw new Error('email belongs to a different Taucho account');
      }
      if (user) {
        await conn.query(
          'UPDATE users SET taucho_user_id = ?, taucho_linked_at = UTC_TIMESTAMP() WHERE id = ?',
          [assertion.tauchoUserId, user.id]
        );
      } else {
        const unavailablePassword = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
        const result = await conn.query(
          'INSERT INTO users (email, password_hash, password_login_enabled, taucho_user_id, taucho_linked_at) VALUES (?, ?, 0, ?, UTC_TIMESTAMP())',
          [assertion.email, unavailablePassword, assertion.tauchoUserId]
        );
        user = { id: Number(result.insertId), email: assertion.email };
        created = true;
      }
    }

    await conn.commit();
    const token = createLoginToken(user);
    res.json({
      message: 'Taucho login successful',
      token,
      user_id: Number(user.id),
      email: user.email,
      created
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (rollbackErr) { console.error('[TAUCHO SSO] Rollback failed:', rollbackErr.message); }
    }
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Taucho SSO assertion was already used' });
    }
    console.error('[TAUCHO SSO] Exchange failed:', err.message);
    res.status(500).json({ error: 'Taucho login could not be completed' });
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

module.exports = router;
