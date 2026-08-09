// routes/payments.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/summary', async (req, res) => {
  const businessId = req.businessId;
  const { rows: payments } = await pool.query('SELECT * FROM payments WHERE business_id = $1', [businessId]);
  const { rows: orders } = await pool.query(`SELECT id, amount, payment_status FROM orders WHERE business_id = $1 AND payment_status != 'Cancelled'`, [businessId]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const confirmed = payments.filter(p => p.status === 'Confirmed');
  const collectedToday = confirmed.filter(p => p.paid_at && new Date(p.paid_at) >= today).reduce((s, p) => s + Number(p.amount), 0);
  const avgOrderValue = orders.length ? Math.round(orders.reduce((s, o) => s + Number(o.amount), 0) / orders.length) : 0;

  // Pending = real outstanding balance, not full order value — an order
  // that's "Partial" only counts what's actually still owed, not its
  // whole amount (that would double-count the part already paid).
  const paidByOrder = {};
  confirmed.forEach(p => { paidByOrder[p.order_id] = (paidByOrder[p.order_id] || 0) + Number(p.amount); });
  const unpaidOrders = orders.filter(o => o.payment_status === 'Awaiting' || o.payment_status === 'Partial');
  const pendingAmount = unpaidOrders.reduce((s, o) => s + (Number(o.amount) - (paidByOrder[o.id] || 0)), 0);

  res.json({
    collectedToday,
    transfersConfirmedToday: confirmed.filter(p => p.paid_at && new Date(p.paid_at) >= today).length,
    pendingAmount,
    pendingCount: unpaidOrders.length,
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
  const { method, ref, amount } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 AND business_id = $2 FOR UPDATE', [orderId, req.businessId]);
    const order = orderResult.rows[0];
    if (!order) throw { status: 404, message: 'Order not found' };

    // How much has already been paid on this order, before this new payment
    const priorResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = $1 AND status = 'Confirmed'`,
      [order.id]
    );
    const alreadyPaid = Number(priorResult.rows[0].total);
    const remainingBalance = Number(order.amount) - alreadyPaid;

    // If no amount is given, default to paying off whatever's left — this
    // keeps the old "just mark it paid" behavior working exactly as before
    // for anyone not using partial payments.
    const paymentAmount = (amount != null && amount !== '') ? Number(amount) : remainingBalance;
    if (paymentAmount <= 0) throw { status: 400, message: 'Payment amount must be greater than zero' };

    const payResult = await client.query(
      `INSERT INTO payments (business_id, order_id, customer_id, amount, method, ref, status, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Confirmed', now()) RETURNING *`,
      [req.businessId, order.id, order.customer_id, paymentAmount, method || 'Transfer', ref || null]
    );

    const newTotalPaid = alreadyPaid + paymentAmount;
    // Small tolerance for floating point rounding when comparing to the order total
    const newStatus = newTotalPaid >= Number(order.amount) - 0.01 ? 'Paid' : (newTotalPaid > 0 ? 'Partial' : 'Awaiting');
    await client.query(`UPDATE orders SET payment_status = $1 WHERE id = $2`, [newStatus, order.id]);
    await client.query('COMMIT');

    const cust = await pool.query('SELECT name FROM customers WHERE id = $1', [order.customer_id]);
    const p = payResult.rows[0];
    res.status(201).json({
      id: `PAY-${p.id}`, orderId: `BF-${String(p.order_id).padStart(4, '0')}`,
      customerName: cust.rows[0]?.name || 'Unknown', amount: Number(p.amount),
      method: p.method, ref: p.ref, status: p.status, date: p.paid_at,
      orderPaymentStatus: newStatus,
      amountPaid: newTotalPaid,
      balanceRemaining: Math.max(0, Number(order.amount) - newTotalPaid),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message || 'Could not mark as paid' });
  } finally {
    client.release();
  }
});

// POST /import — bulk-create payment records from a parsed CSV. Unlike
// products/customers/orders, payments can't be created standalone — each
// row MUST reference an existing order (by its BF-#### code), since a
// payment is always a record of money received against a specific order.
router.post('/import', async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array is required' });

  let created = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.orderId) throw new Error('orderId is required (e.g. BF-0042)');
      const orderNum = String(r.orderId).replace(/^BF-0*/i, '');

      const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1 AND business_id = $2', [orderNum, req.businessId]);
      const order = orderResult.rows[0];
      if (!order) throw new Error(`Order ${r.orderId} not found`);

      const amount = r.amount != null && r.amount !== '' ? Number(r.amount) : Number(order.amount);
      const status = r.status || 'Confirmed';
      const paidAt = r.date ? new Date(r.date) : new Date();

      await pool.query(
        `INSERT INTO payments (business_id, order_id, customer_id, amount, method, ref, status, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [req.businessId, order.id, order.customer_id, amount, r.method || 'Transfer', r.ref || null, status, paidAt]
      );
      if (status === 'Confirmed') {
        await pool.query(`UPDATE orders SET payment_status = 'Paid' WHERE id = $1`, [order.id]);
      }
      created++;
    } catch (err) {
      errors.push({ row: i + 1, orderId: r.orderId || '(no order id)', error: err.message });
    }
  }

  res.json({ created, errors });
});

module.exports = router;
