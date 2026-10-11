// routes/chat.js — the storefront "Message us" widget (public; scoped by store id in the URL).
// A visitor's first message returns a secret token; the widget keeps it and polls for replies with it.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db/pool');
const { recordInbound } = require('../db/inbox');

// Per-IP limit on SENDING (polling is cheap and not limited here).
const hits = new Map();
function sendAllowed(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 10 * 60e3);
  if (list.length >= 15) return false;
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 10 * 60e3)) hits.delete(k);
  return true;
}

const bizId = raw => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };

// body: { message, name?, contact? (email or phone), token? }
router.post('/:businessId', async (req, res) => {
  const businessId = bizId(req.params.businessId);
  if (!businessId) return res.status(400).json({ error: 'Invalid store' });
  if (!sendAllowed(req.ip)) return res.status(429).json({ error: 'You\'re sending messages too quickly. Please wait a few minutes.' });
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'Type a message first' });

  const { rows: [biz] } = await pool.query('SELECT id FROM businesses WHERE id = $1', [businessId]);
  if (!biz) return res.status(404).json({ error: 'Store not found' });

  // returning visitor: add to their existing conversation
  if (req.body.token && /^[a-f0-9]{32}$/.test(String(req.body.token))) {
    const { rows: [conv] } = await pool.query('SELECT id, contact_handle FROM inbox_conversations WHERE chat_token = $1 AND business_id = $2', [req.body.token, businessId]);
    if (conv) {
      await recordInbound({ businessId, channel: 'chat', handle: conv.contact_handle, body: message, chatToken: req.body.token });
      return res.status(201).json({ token: req.body.token });
    }
  }
  const name = String(req.body.name || '').trim().slice(0, 60) || null;
  const contact = String(req.body.contact || '').trim().slice(0, 80);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact), isPhone = /^\+?[\d\s-]{7,16}$/.test(contact);
  // Every visitor gets their own private thread keyed by the secret token. The email/phone they type is only a
  // label (and used to link a customer) — it must never open someone else's thread, since anyone can type any address.
  const token = crypto.randomBytes(16).toString('hex');
  await recordInbound({ businessId, channel: 'chat', handle: `guest-${token}`, name, detail: isEmail || isPhone ? contact : null, body: message, chatToken: token });
  res.status(201).json({ token });
});

// The visitor's view of the thread.
router.get('/:businessId/:token', async (req, res) => {
  const businessId = bizId(req.params.businessId);
  if (!businessId || !/^[a-f0-9]{32}$/.test(req.params.token)) return res.status(400).json({ error: 'Invalid request' });
  const { rows: [conv] } = await pool.query('SELECT id FROM inbox_conversations WHERE chat_token = $1 AND business_id = $2', [req.params.token, businessId]);
  if (!conv) return res.json({ messages: [] });
  const { rows } = await pool.query(`SELECT direction, body, created_at FROM inbox_messages WHERE conversation_id = $1 AND status = 'sent' ORDER BY id DESC LIMIT 100`, [conv.id]);
  res.json({ messages: rows.reverse().map(r => ({ from: r.direction === 'in' ? 'you' : 'store', text: r.body, at: r.created_at })) });
});

module.exports = router;
