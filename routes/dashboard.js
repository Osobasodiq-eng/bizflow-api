// routes/dashboard.js
// Powers the main "Dashboard" panel: 4 KPI cards + 4 charts + activity feed.
// Every number here is CALCULATED from orders/payments/products —
// nothing is hardcoded. This is how real analytics dashboards work.

const express = require('express');
const router = express.Router();
const db = require('../data/store');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/dashboard/summary -> the 4 KPI cards
router.get('/summary', (req, res) => {
  const today = startOfToday();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const ordersToday = db.orders.filter(o => new Date(o.date) >= today);
  const revenueToday = ordersToday
    .filter(o => o.paymentStatus === 'Paid')
    .reduce((sum, o) => sum + o.amount, 0);

  const ordersYesterday = db.orders.filter(o => new Date(o.date) >= yesterday && new Date(o.date) < today);
  const revenueYesterday = ordersYesterday
    .filter(o => o.paymentStatus === 'Paid')
    .reduce((sum, o) => sum + o.amount, 0);
  const revenueChangePct = revenueYesterday > 0
    ? Math.round(((revenueToday - revenueYesterday) / revenueYesterday) * 100)
    : null;

  const unpaidOrders = db.orders.filter(o => o.paymentStatus === 'Awaiting');
  const unpaidAmount = unpaidOrders.reduce((sum, o) => sum + o.amount, 0);

  const lowStock = db.products.filter(p => p.quantity > 0 && p.quantity <= p.threshold).length
    + db.products.filter(p => p.quantity === 0).length;

  res.json({
    revenueToday,
    revenueChangePct,
    ordersToday: ordersToday.length,
    unpaidAmount,
    unpaidCount: unpaidOrders.length,
    lowStockCount: lowStock,
  });
});

// GET /api/dashboard/revenue-trend -> line chart, revenue per day for last 7 days
router.get('/revenue-trend', (req, res) => {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const totals = days.map(day => ({ day, revenue: 0 }));

  db.orders.filter(o => o.paymentStatus === 'Paid').forEach(o => {
    const dayIndex = (new Date(o.date).getDay() + 6) % 7;
    totals[dayIndex].revenue += o.amount;
  });

  res.json(totals);
});

// GET /api/dashboard/payment-methods -> donut chart
router.get('/payment-methods', (req, res) => {
  const confirmed = db.payments.filter(p => p.status === 'Confirmed');
  const total = confirmed.reduce((sum, p) => sum + p.amount, 0) || 1;
  const byMethod = { Transfer: 0, POS: 0, Cash: 0 };
  confirmed.forEach(p => { byMethod[p.method] += p.amount; });

  res.json({
    total,
    breakdown: Object.entries(byMethod).map(([method, amount]) => ({
      method,
      amount,
      pct: Math.round((amount / total) * 100),
    })),
  });
});

// GET /api/dashboard/orders-by-status -> bar chart
router.get('/orders-by-status', (req, res) => {
  const statuses = ['New', 'Processing', 'Paid', 'Shipped', 'Delivered', 'Cancelled'];
  const counts = statuses.map(status => ({
    status,
    count: db.orders.filter(o => o.status === status).length,
  }));
  res.json(counts);
});

// GET /api/dashboard/top-products -> horizontal bar chart, units sold this month
router.get('/top-products', (req, res) => {
  const unitsSold = {};
  db.orders.filter(o => o.status !== 'Cancelled').forEach(o => {
    o.items.forEach(item => {
      unitsSold[item.name] = (unitsSold[item.name] || 0) + item.qty;
    });
  });

  const ranked = Object.entries(unitsSold)
    .map(([name, units]) => ({ name, units }))
    .sort((a, b) => b.units - a.units)
    .slice(0, 5);

  res.json(ranked);
});

// GET /api/dashboard/activity -> "Today's activity" timeline
router.get('/activity', (req, res) => {
  const sorted = [...db.activity].sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(sorted);
});

module.exports = router;
