// routes/notifications.js — the bell in the dashboard (login required, scoped to the business).
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const shape = n => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.read_at, at: n.created_at });

// GET /api/notifications  → { unread, items: [latest 30] }
router.get('/', async (req, res) => {
  // Housekeeping: read notifications older than 60 days (and anything older than 180) are dropped.
  pool.query(`DELETE FROM notifications WHERE business_id = $1 AND ((read_at IS NOT NULL AND created_at < now() - interval '60 days') OR created_at < now() - interval '180 days')`, [req.businessId]).catch(() => {});
  const [{ rows }, { rows: [c] }] = await Promise.all([
    pool.query(`SELECT * FROM notifications WHERE business_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`, [req.businessId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE business_id = $1 AND read_at IS NULL`, [req.businessId]),
  ]);
  res.json({ unread: c.n, items: rows.map(shape) });
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at = now() WHERE business_id = $1 AND read_at IS NULL`, [req.businessId]);
  res.json({ ok: true });
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND business_id = $2 AND read_at IS NULL`, [req.params.id, req.businessId]);
  res.json({ ok: true });
});

module.exports = router;
