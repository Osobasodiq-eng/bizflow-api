// routes/payments.js
// Powers the "Payments" panel: KPI row, daily collections chart, payment log table,
// and the "Mark as paid" button.

const express = require('express');
const router = express.Router();
const db = require('../data/store');

function withCustomer(payment) {
  const customer = db.customers.find(c => c.id === payment.customerId);
  return { ...payment, customerName: customer ? customer.name : 'Unknown' };
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/payments/summary -> the 4 KPI cards on the Payments panel
router.get('/summary', (req, res) => {
  const today = startOfToday();
  const confirmed = db.payments.filter(p => p.status === 'Confirmed');
  const collectedToday = confirmed
    .filter(p => new Date(p.date) >= today)
    .reduce((sum, p) => sum + p.amount, 0);
  const pending = db.payments.filter(p => p.status === 'Awaiting');
  const pendingAmount = pending.reduce((sum, p) => sum + p.amount, 0);
  const monthTotal = confirmed.reduce((sum, p) => sum + p.amount, 0);
  const avgOrderValue = db.orders.length
    ? Math.round(db.orders.reduce((sum, o) => sum + o.amount, 0) / db.orders.length)
    : 0;

  res.json({
    collectedToday,
    transfersConfirmedToday: confirmed.filter(p => new Date(p.date) >= today).length,
    pendingAmount,
    pendingCount: pending.length,
    monthTotal,
    avgOrderValue,
  });
});

// GET /api/payments/collections -> stacked bar chart: daily totals by method, last 7 days
router.get('/collections', (req, res) => {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDay = days.map(day => ({ day, Transfer: 0, POS: 0, Cash: 0 }));

  db.payments.filter(p => p.status === 'Confirmed' && p.date).forEach(p => {
    const dayIndex = (new Date(p.date).getDay() + 6) % 7; // convert Sun=0 -> Mon=0 indexing
    byDay[dayIndex][p.method] += p.amount;
  });

  res.json(byDay);
});

// GET /api/payments -> the payment log table
router.get('/', (req, res) => {
  res.json(db.payments.map(withCustomer));
});

// POST /api/payments/:orderId/mark-paid -> "Mark as paid" button
router.post('/:orderId/mark-paid', (req, res) => {
  const order = db.orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { method, ref } = req.body;
  const payment = {
    id: db.nextPaymentId(),
    orderId: order.id,
    customerId: order.customerId,
    amount: order.amount,
    method: method || 'Transfer',
    ref: ref || null,
    status: 'Confirmed',
    date: new Date().toISOString(),
  };
  db.payments.push(payment);
  order.paymentStatus = 'Paid';

  res.status(201).json(withCustomer(payment));
});

module.exports = router;
