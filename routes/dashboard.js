// routes/dashboard.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/summary', async (req, res) => {
  const businessId = req.businessId;
  const { rows: orders } = await pool.query('SELECT * FROM orders WHERE business_id = $1', [businessId]);
  const { rows: products } = await pool.query('SELECT quantity, threshold FROM products WHERE business_id = $1', [businessId]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

  const ordersToday = orders.filter(o => new Date(o.created_at) >= today);
  const revenueToday = ordersToday.filter(o => o.payment_status === 'Paid').reduce((s, o) => s + Number(o.amount), 0);
  const ordersYesterday = orders.filter(o => new Date(o.created_at) >= yesterday && new Date(o.created_at) < today);
  const revenueYesterday = ordersYesterday.filter(o => o.payment_status === 'Paid').reduce((s, o) => s + Number(o.amount), 0);

  const unpaid = orders.filter(o => o.payment_status === 'Awaiting');
  const lowStock = products.filter(p => p.quantity <= p.threshold).length;

  res.json({
    revenueToday,
    revenueChangePct: revenueYesterday > 0 ? Math.round(((revenueToday - revenueYesterday) / revenueYesterday) * 100) : null,
    ordersToday: ordersToday.length,
    unpaidAmount: unpaid.reduce((s, o) => s + Number(o.amount), 0),
    unpaidCount: unpaid.length,
    lowStockCount: lowStock,
  });
});

router.get('/revenue-trend', async (req, res) => {
  const { rows } = await pool.query(`SELECT amount, created_at FROM orders WHERE business_id = $1 AND payment_status = 'Paid'`, [req.businessId]);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const totals = days.map(day => ({ day, revenue: 0 }));
  rows.forEach(o => { totals[(new Date(o.created_at).getDay() + 6) % 7].revenue += Number(o.amount); });
  res.json(totals);
});

router.get('/payment-methods', async (req, res) => {
  const { rows } = await pool.query(`SELECT method, amount FROM payments WHERE business_id = $1 AND status = 'Confirmed'`, [req.businessId]);
  const total = rows.reduce((s, p) => s + Number(p.amount), 0) || 1;
  const byMethod = { Transfer: 0, POS: 0, Cash: 0 };
  rows.forEach(p => { if (byMethod[p.method] !== undefined) byMethod[p.method] += Number(p.amount); });
  res.json({ total, breakdown: Object.entries(byMethod).map(([method, amount]) => ({ method, amount, pct: Math.round((amount / total) * 100) })) });
});

router.get('/orders-by-status', async (req, res) => {
  const { rows } = await pool.query('SELECT status, COUNT(*) FROM orders WHERE business_id = $1 GROUP BY status', [req.businessId]);
  const statuses = ['New', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
  const counts = Object.fromEntries(rows.map(r => [r.status, Number(r.count)]));
  res.json(statuses.map(status => ({ status, count: counts[status] || 0 })));
});

router.get('/top-products', async (req, res) => {
  const { rows } = await pool.query(`SELECT items FROM orders WHERE business_id = $1 AND status != 'Cancelled'`, [req.businessId]);
  const unitsSold = {};
  rows.forEach(o => { o.items.forEach(item => { unitsSold[item.name] = (unitsSold[item.name] || 0) + item.qty; }); });
  const ranked = Object.entries(unitsSold).map(([name, units]) => ({ name, units })).sort((a, b) => b.units - a.units).slice(0, 5);
  res.json(ranked);
});

// Activity feed is computed live from recent orders + payments — no separate
// table needed, same principle as everything else being derived, not stored.
router.get('/activity', async (req, res) => {
  const businessId = req.businessId;
  const { rows: recentOrders } = await pool.query(
    `SELECT o.id, o.status, o.created_at, c.name AS customer_name FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id WHERE o.business_id = $1 ORDER BY o.created_at DESC LIMIT 5`,
    [businessId]
  );
  const { rows: recentPayments } = await pool.query(
    `SELECT amount, paid_at, order_id FROM payments WHERE business_id = $1 AND paid_at IS NOT NULL ORDER BY paid_at DESC LIMIT 5`,
    [businessId]
  );

  const items = [
    ...recentOrders.map(o => ({ text: `${o.customer_name || 'A customer'} placed an order`, meta: `Order #BF-${String(o.id).padStart(4, '0')}`, date: o.created_at })),
    ...recentPayments.map(p => ({ text: `₦${Number(p.amount).toLocaleString()} payment confirmed`, meta: `Order #BF-${String(p.order_id).padStart(4, '0')}`, date: p.paid_at })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);

  res.json(items);
});

module.exports = router;
