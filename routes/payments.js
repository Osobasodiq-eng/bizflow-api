// routes/payments.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/summary', async (req, res) => {
  const businessId = req.businessId;
  const { rows: payments } = await pool.query('SELECT * FROM payments WHERE business_id = $1', [businessId]);
  const { rows: orders } = await pool.query('SELECT amount FROM orders WHERE business_id = $1', [businessId]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const confirmed = payments.filter(p => p.status === 'Confirmed');
  const collectedToday = confirmed.filter(p => p.paid_at && new Date(p.paid_at) >= today).reduce((s, p) => s + Number(p.amount), 0);
  const pending = payments.filter(p => p.status === 'Awaiting');
  const avgOrderValue = orders.length ? Math.round(orders.reduce((s, o) => s + Number(o.amount), 0) / orders.length) : 0;

  res.json({
    collectedToday,
    transfersConfirmedToday: confirmed.filter(p => p.paid_at && new Date(p.paid_at) >= today).length,
    pendingAmount: pending.reduce((s, p) => s + Number(p.amount), 0),
    pendingCount: pending.length,
    monthTotal: confirmed.reduce((s, p) => s + Number(p.amount), 0),
    avgOrderValue,
  });
});

router.get('/collections', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT method, paid_at FROM payments WHERE business_id = $1 AND status = 'Confirmed' AND paid_at IS NOT NULL`,
    [req.businessId]
  );
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDay = days.map(day => ({ day, Transfer: 0, POS: 0, Cash: 0 }));
  rows.forEach(p => {
    const idx = (new Date(p.paid_at).getDay() + 6) % 7;
    if (byDay[idx][p.method] !== undefined) byDay[idx][p.method] += Number(p.amount);
  });
  res.json(byDay);
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS customer_name FROM payments p
     LEFT JOIN customers c ON c.id = p.customer_id
     WHERE p.business_id = $1 ORDER BY p.id DESC`,
    [req.businessId]
  );
  res.json(rows.map(p => ({
    id: `PAY-${p.id}`, orderId: `BF-${String(p.order_id).padStart(4, '0')}`,
    customerName: p.customer_name || 'Unknown', amount: Number(p.amount),
    method: p.method, ref: p.ref, status: p.status, date: p.paid_at,
  })));
});

router.post('/:orderIdOrCode/mark-paid', async (req, res) => {
  const orderId = req.params.orderIdOrCode.replace(/^BF-0*/, '');
  const { method, ref } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 AND business_id = $2', [orderId, req.businessId]);
    const order = orderResult.rows[0];
    if (!order) throw { status: 404, message: 'Order not found' };

    const payResult = await client.query(
      `INSERT INTO payments (business_id, order_id, customer_id, amount, method, ref, status, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Confirmed', now()) RETURNING *`,
      [req.businessId, order.id, order.customer_id, order.amount, method || 'Transfer', ref || null]
    );
    await client.query(`UPDATE orders SET payment_status = 'Paid' WHERE id = $1`, [order.id]);
    await client.query('COMMIT');

    const cust = await pool.query('SELECT name FROM customers WHERE id = $1', [order.customer_id]);
    const p = payResult.rows[0];
    res.status(201).json({
      id: `PAY-${p.id}`, orderId: `BF-${String(p.order_id).padStart(4, '0')}`,
      customerName: cust.rows[0]?.name || 'Unknown', amount: Number(p.amount),
      method: p.method, ref: p.ref, status: p.status, date: p.paid_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message || 'Could not mark as paid' });
  } finally {
    client.release();
  }
});

module.exports = router;
