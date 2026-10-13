// routes/inbox.js — the merchant's side of the inbox (login required).
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { CHANNELS, sendReply } = require('../db/inbox');
const { inboxAddress, inboundEnabled, emailConfigured } = require('../db/email');
const { requireFeature, hasFeature } = require('../db/billing');

// The inbox is a Growth+ feature. Messages keep arriving (nothing is lost) but reading/replying needs the plan; /summary stays open for the badge + upgrade card.
router.use((req, res, next) => (req.method === 'GET' && req.path === '/summary') ? next() : requireFeature('inbox')(req, res, next));

const fail = (res, err) => {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error('Inbox error:', err); res.status(500).json({ error: 'Something went wrong on our side' });
};

function shapeConv(c, stats) {
  const s = stats || { orders: 0, spend: 0 };
  const tags = [];
  if (!c.customer_id || s.orders === 0) tags.push('New customer');
  if (s.spend >= 100000 || s.orders >= 5) tags.push('VIP');
  else if (s.orders > 0) tags.push('Ordered');
  if (c.last_direction === 'out') tags.push('Awaiting reply');
  return {
    id: c.id, channel: c.channel, channelLabel: (CHANNELS[c.channel] || {}).label || c.channel,
    name: c.contact_name || c.contact_detail || (c.channel === 'chat' ? 'Website visitor' : c.contact_handle), handle: c.channel === 'chat' ? (c.contact_detail || '') : c.contact_handle, subject: c.subject,
    status: c.status, unread: c.unread_count, preview: c.last_message_preview || '', lastDirection: c.last_direction,
    lastAt: c.last_message_at, customerId: c.customer_id, tags,
  };
}

async function statsFor(businessId, customerIds) {
  if (!customerIds.length) return {};
  const { rows } = await pool.query(
    `SELECT customer_id, COUNT(*) AS orders, COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0) AS spend
     FROM orders WHERE business_id = $1 AND customer_id = ANY($2::int[]) AND status != 'Cancelled' GROUP BY customer_id`, [businessId, customerIds]);
  return Object.fromEntries(rows.map(r => [r.customer_id, { orders: Number(r.orders), spend: Number(r.spend) }]));
}

router.get('/summary', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT channel, COUNT(*) FILTER (WHERE status = 'open') AS open, COALESCE(SUM(unread_count) FILTER (WHERE status = 'open'), 0) AS unread
     FROM inbox_conversations WHERE business_id = $1 GROUP BY channel`, [req.businessId]);
  const byChannel = Object.fromEntries(rows.map(r => [r.channel, { open: Number(r.open), unread: Number(r.unread) }]));
  res.json({
    open: rows.reduce((n, r) => n + Number(r.open), 0),
    unreadConversations: (await pool.query(`SELECT COUNT(*) AS n FROM inbox_conversations WHERE business_id = $1 AND status = 'open' AND unread_count > 0`, [req.businessId])).rows[0].n * 1,
    byChannel,
    email: { configured: emailConfigured(), address: inboxAddress(req.businessId), receiving: inboundEnabled() },
    channels: Object.entries(CHANNELS).map(([key, c]) => ({ key, label: c.label, ready: c.canReply })),
    locked: !(await hasFeature(req.businessId, 'inbox')),
  });
});

// ?status=open|closed|all  &channel=email  &unread=1  &q=text
router.get('/conversations', async (req, res) => {
  const status = ['open', 'closed', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const where = ['business_id = $1'], vals = [req.businessId];
  if (status !== 'all') { vals.push(status); where.push(`status = $${vals.length}`); }
  if (CHANNELS[req.query.channel]) { vals.push(req.query.channel); where.push(`channel = $${vals.length}`); }
  if (req.query.unread === '1') where.push('unread_count > 0');
  if (req.query.q) { vals.push('%' + String(req.query.q).slice(0, 80).replace(/[%_\\]/g, m => '\\' + m) + '%'); where.push(`(contact_name ILIKE $${vals.length} OR contact_handle ILIKE $${vals.length} OR last_message_preview ILIKE $${vals.length})`); }
  const { rows } = await pool.query(`SELECT * FROM inbox_conversations WHERE ${where.join(' AND ')} ORDER BY last_message_at DESC LIMIT 100`, vals);
  const stats = await statsFor(req.businessId, [...new Set(rows.map(r => r.customer_id).filter(Boolean))]);
  res.json(rows.map(c => shapeConv(c, stats[c.customer_id])));
});

// Opening a conversation marks it read.
router.get('/conversations/:id', async (req, res) => {
  const { rows: [c] } = await pool.query('SELECT * FROM inbox_conversations WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  const [msgs, stats] = await Promise.all([
    pool.query('SELECT id, direction, body, status, error, created_at FROM inbox_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 200', [c.id]),
    statsFor(req.businessId, c.customer_id ? [c.customer_id] : []),
  ]);
  if (c.unread_count > 0) await pool.query('UPDATE inbox_conversations SET unread_count = 0 WHERE id = $1', [c.id]);
  const conv = shapeConv({ ...c, unread_count: 0 }, stats[c.customer_id]);
  res.json({ ...conv, canReply: !!(CHANNELS[c.channel] || {}).canReply, messages: msgs.rows.reverse().map(m => ({ id: m.id, direction: m.direction, body: m.body, status: m.status, error: m.error, at: m.created_at })) });
});

router.post('/conversations/:id/reply', async (req, res) => {
  try {
    const m = await sendReply(req.businessId, Number(req.params.id) || 0, req.body.body);
    res.status(m.status === 'failed' ? 502 : 201).json(m.status === 'failed' ? { error: `Couldn't send: ${m.error}`, message: m } : { id: m.id, direction: 'out', body: m.body, status: m.status, at: m.created_at });
  } catch (err) { fail(res, err); }
});

router.patch('/conversations/:id', async (req, res) => {
  const status = req.body.status;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { rowCount } = await pool.query('UPDATE inbox_conversations SET status = $1 WHERE id = $2 AND business_id = $3', [status, req.params.id, req.businessId]);
  if (!rowCount) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ok: true });
});

module.exports = router;
