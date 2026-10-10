// routes/fulfilment.js
// Powers the Fulfilment screen: a board of orders by stage, moving an order
// to its next stage (with courier / tracking number / a note for the buyer),
// and each order's status timeline. Every status change emails the buyer.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { STAGES, changeOrderStatus, nextOptions, isPickup, orderCode } = require('../db/fulfilment');

const parseId = raw => String(raw).replace(/^BF-0*/i, '');
const clean = (v, max) => (v == null ? undefined : String(v).trim().slice(0, max));

function shape(row) {
  return {
    id: orderCode(row.id), rawId: row.id,
    customerName: row.customer_name || 'Unknown', customerPhone: row.customer_phone || null,
    customerEmail: row.customer_email || null,
    items: row.items, amount: Number(row.amount), paymentStatus: row.payment_status,
    status: row.status, delivery: row.delivery, isPickup: isPickup(row.delivery),
    courier: row.courier, trackingNumber: row.tracking_number,
    createdAt: row.created_at, shippedAt: row.shipped_at, deliveredAt: row.delivered_at,
    nextOptions: nextOptions(row.status),
  };
}

// GET /api/fulfilment/board — everything open, plus the most recent finished orders
router.get('/board', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.business_id = $1
       AND (o.status IN ('New','Processing','Shipped') OR o.created_at > now() - interval '30 days')
     ORDER BY o.created_at ASC`,
    [req.businessId]
  );
  const stages = Object.fromEntries(STAGES.map(s => [s, []]));
  rows.forEach(r => { if (stages[r.status]) stages[r.status].push(shape(r)); });
  // Open stages: oldest first (longest-waiting on top). Finished: newest first, capped.
  stages.Delivered = stages.Delivered.reverse().slice(0, 30);
  stages.Cancelled = stages.Cancelled.reverse().slice(0, 30);
  res.json({ stages, counts: Object.fromEntries(STAGES.map(s => [s, stages[s].length])) });
});

// GET /api/fulfilment/:idOrCode/history — the order's status timeline
router.get('/:idOrCode/history', async (req, res) => {
  const id = parseId(req.params.idOrCode);
  const own = await pool.query('SELECT id FROM orders WHERE id = $1 AND business_id = $2', [id, req.businessId]);
  if (!own.rows[0]) return res.status(404).json({ error: 'Order not found' });
  const { rows } = await pool.query(
    `SELECT from_status, to_status, note, customer_notified, created_at
     FROM order_status_history WHERE order_id = $1 AND business_id = $2 ORDER BY created_at ASC, id ASC`,
    [id, req.businessId]
  );
  res.json(rows.map(h => ({ from: h.from_status, to: h.to_status, note: h.note, customerNotified: h.customer_notified, at: h.created_at })));
});

// POST /api/fulfilment/:idOrCode/status
// body: { status, note?, courier?, trackingNumber?, notify? (default true) }
router.post('/:idOrCode/status', async (req, res) => {
  const { status, notify } = req.body;
  try {
    const result = await changeOrderStatus({
      businessId: req.businessId, orderId: parseId(req.params.idOrCode), status,
      note: clean(req.body.note, 500), courier: clean(req.body.courier, 60), trackingNumber: clean(req.body.trackingNumber, 80),
      notify: notify !== false,
    });
    res.json({
      id: orderCode(result.order.id), status: result.order.status, changed: result.changed,
      courier: result.order.courier, trackingNumber: result.order.tracking_number,
      email: result.email,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// POST /api/fulfilment/bulk-status — move several orders to the same stage at once
// body: { orderIds: ["BF-0001", ...], status, notify? }
router.post('/bulk-status', async (req, res) => {
  const { orderIds, status, notify } = req.body;
  if (!Array.isArray(orderIds) || !orderIds.length) return res.status(400).json({ error: 'orderIds array is required' });
  if (orderIds.length > 100) return res.status(400).json({ error: 'Select 100 orders or fewer at a time' });

  const results = [];
  for (const raw of orderIds) {
    try {
      const r = await changeOrderStatus({ businessId: req.businessId, orderId: parseId(raw), status, notify: notify !== false });
      results.push({ id: orderCode(r.order.id), ok: true, emailed: !!(r.email && r.email.sent), emailReason: r.email && r.email.reason });
    } catch (err) {
      if (!err.status) throw err;
      results.push({ id: String(raw), ok: false, error: err.message });
    }
  }
  res.json({
    moved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length,
    emailed: results.filter(r => r.emailed).length, results,
  });
});

module.exports = router;
