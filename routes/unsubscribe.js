// routes/unsubscribe.js
// PUBLIC: the "Unsubscribe" link in every marketing email.
// GET shows a confirmation button (so email scanners that pre-open links can't
// unsubscribe people by accident); POST does it — mail apps' one-click
// unsubscribe also POSTs here.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { verifyUnsubToken } = require('./../db/campaigns');
const { esc } = require('../db/email');

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F9FAFB;margin:0;padding:48px 16px;">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.06);text-align:center;color:#111827;">${body}</div></body></html>`;

async function lookup(token) {
  const id = verifyUnsubToken(token);
  if (!id) return null;
  const { rows } = await pool.query(
    'SELECT c.id, c.marketing_opt_out, b.name AS store FROM customers c JOIN businesses b ON b.id = c.business_id WHERE c.id = $1', [id]
  );
  return rows[0] || null;
}

router.get('/:token', async (req, res) => {
  const c = await lookup(req.params.token);
  if (!c) return res.status(404).send(page('Link not valid', '<h2>This link isn\'t valid</h2><p style="color:#6B7280">It may be incomplete. Reply to the email and ask to be removed.</p>'));
  if (c.marketing_opt_out) return res.send(page('Unsubscribed', `<h2>You're already unsubscribed</h2><p style="color:#6B7280">${esc(c.store)} won't send you marketing emails.</p>`));
  res.send(page('Unsubscribe', `<h2>Unsubscribe?</h2><p style="color:#6B7280">Stop receiving marketing emails from <strong>${esc(c.store)}</strong>. You'll still get updates about your orders.</p>
    <form method="POST"><button style="background:#4F46E5;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-weight:600;font-size:14px;cursor:pointer;">Yes, unsubscribe me</button></form>`));
});

router.post('/:token', async (req, res) => {
  const c = await lookup(req.params.token);
  if (!c) return res.status(404).send(page('Link not valid', '<h2>This link isn\'t valid</h2>'));
  await pool.query('UPDATE customers SET marketing_opt_out = true WHERE id = $1', [c.id]);
  res.send(page('Unsubscribed', `<h2>You're unsubscribed</h2><p style="color:#6B7280">${esc(c.store)} won't send you marketing emails anymore. You'll still receive updates about your orders.</p>`));
});

module.exports = router;
