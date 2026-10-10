// routes/auth.js
// Signup creates a new business + its first user in one step.
// Login checks the password and hands back a JWT — a signed token the
// frontend stores and sends with every future request, proving who it is.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const router = express.Router();
const { sendPasswordResetEmail } = require('../db/email');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-in-production';
if (!process.env.JWT_SECRET) {
  // Anyone who can read this source could forge a login token for ANY business
  // if the default secret is used. Set JWT_SECRET (a long random string) in
  // the host's environment variables.
  console.warn('\n!!! WARNING: JWT_SECRET is not set — using the insecure built-in default. Set JWT_SECRET before real users sign up. !!!\n');
}

// POST /api/auth/signup — creates a business AND its first user together
router.post('/signup', async (req, res) => {
  const { businessName, password } = req.body;
  const email = (req.body.email || '').trim();
  if (!businessName || !email || !password) {
    return res.status(400).json({ error: 'businessName, email, and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const bizResult = await client.query(
      'INSERT INTO businesses (name) VALUES ($1) RETURNING id, name',
      [businessName]
    );
    const business = bizResult.rows[0];

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      'INSERT INTO users (business_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email',
      [business.id, email.toLowerCase(), passwordHash]
    );
    const user = userResult.rows[0];

    await client.query('COMMIT');

    const token = jwt.sign({ userId: user.id, businessId: business.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, business: { id: business.id, name: business.name }, email: user.email });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Could not create account' });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { password } = req.body;
  const email = (req.body.email || '').trim();
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.password_hash, b.id AS business_id, b.name AS business_name
       FROM users u JOIN businesses b ON b.id = u.business_id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ userId: user.id, businessId: user.business_id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, business: { id: user.business_id, name: user.business_name }, email: user.email });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Could not log in' });
  }
});

// POST /api/auth/forgot-password
// Generates a one-time reset token (1 hour, single use) and EMAILS a reset
// link to the account's address. The raw token is never returned in the API
// response — otherwise anyone could reset anybody's password just by
// knowing their email. The one exception is local development: set
// ALLOW_DEV_RESET_TOKEN=true to get the token in the response (and the
// server console) when you have no mail service configured.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const message = 'If that email has an account, we\'ve sent reset instructions to it.';

  const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  const user = userResult.rows[0];

  // Always respond the same way whether or not the email exists — this
  // stops someone from using this endpoint to discover which emails are
  // registered on the system.
  if (!user) return res.json({ message });

  const rawToken = crypto.randomBytes(32).toString('hex'); // the real, unhashed token
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex'); // what we store
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

  // Invalidate any earlier, still-unused tokens for this user
  await pool.query('UPDATE password_resets SET used = true WHERE user_id = $1 AND used = false', [user.id]);
  await pool.query(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, tokenHash, expiresAt]
  );

  const dashboardUrl = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
  const resetLink = dashboardUrl ? `${dashboardUrl}/?reset=${rawToken}` : null;
  sendPasswordResetEmail({ to: email.trim().toLowerCase(), resetLink, token: rawToken }).catch(() => {});

  if (process.env.ALLOW_DEV_RESET_TOKEN === 'true') {
    console.log(`[DEV ONLY] Password reset token for ${email}: ${rawToken}`);
    return res.json({ message, devToken: rawToken });
  }
  res.json({ message });
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const token = req.body.token;
  const newPassword = req.body.newPassword || req.body.password; // admin.html sends `password`
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(
    `SELECT * FROM password_resets WHERE token_hash = $1 AND used = false AND expires_at > now()`,
    [tokenHash]
  );
  const resetRow = result.rows[0];
  if (!resetRow) return res.status(400).json({ error: 'This reset link is invalid or has expired' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetRow.user_id]);
  await pool.query('UPDATE password_resets SET used = true WHERE id = $1', [resetRow.id]);

  res.json({ message: 'Password updated — you can now log in with your new password.' });
});

// Middleware other route files use to require a valid login and know WHICH
// business is making the request. Reads "Authorization: Bearer <token>".
function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.businessId = payload.businessId; // every downstream route uses this to scope queries
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin check — deliberately simple: no separate admin login system, no
// database column to manage. Whoever's email is listed in the ADMIN_EMAILS
// environment variable (comma-separated) on Render is treated as the
// platform owner. Must run AFTER requireAuth (needs req.userEmail set).
function requireAdmin(req, res, next) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!req.userEmail || !adminEmails.includes(req.userEmail.toLowerCase())) {
    return res.status(403).json({ error: 'Admin access only' });
  }
  next();
}

module.exports = { router, requireAuth, requireAdmin };
