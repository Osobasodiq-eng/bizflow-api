// routes/billing.js — the merchant's billing page: plan, usage, paying, cancelling (login required).
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const billing = require('../db/billing');

const fail = (res, err) => {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  throw err;
};

// GET /api/billing → plans + current plan + usage + payment history
router.get('/', async (req, res) => {
  res.json(await billing.summary(req.businessId));
});

// POST /api/billing/checkout { plan: 'growth'|'pro', interval: 'monthly'|'yearly' } → { url } (Paystack's payment page)
router.post('/checkout', async (req, res) => {
  try {
    const { rows: [u] } = await pool.query('SELECT email FROM users WHERE business_id = $1 ORDER BY id LIMIT 1', [req.businessId]);
    if (!u) return res.status(400).json({ error: 'No login email found for this business' });
    res.json(await billing.startCheckout(req.businessId, u.email, req.body.plan, req.body.interval));
  } catch (err) { fail(res, err); }
});

// POST /api/billing/verify { reference } — called when Paystack sends the merchant back to the dashboard
router.post('/verify', async (req, res) => {
  try {
    const ref = String(req.body.reference || '').trim();
    if (!ref) return res.status(400).json({ error: 'reference is required' });
    const r = await billing.verifyAndActivate(ref, req.businessId);
    res.json({ ok: true, plan: r.plan, summary: await billing.summary(req.businessId) });
  } catch (err) { fail(res, err); }
});

// POST /api/billing/cancel — stop auto-renewal; paid features stay until the period ends
router.post('/cancel', async (req, res) => {
  await billing.cancel(req.businessId);
  res.json(await billing.summary(req.businessId));
});

// POST /api/billing/resume — undo a cancel before the period ends
router.post('/resume', async (req, res) => {
  await billing.resume(req.businessId);
  res.json(await billing.summary(req.businessId));
});

module.exports = router;
