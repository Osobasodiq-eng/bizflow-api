// routes/admin.js
// Platform-owner-only view across ALL businesses. Every query here
// deliberately does NOT filter by business_id — that's the whole point,
// this is the one place in the API that's allowed to see everything.
// Access is gated by requireAdmin (see routes/auth.js) before any of
// these handlers run.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/admin/stats — platform-wide totals for the top of the dashboard
router.get('/stats', async (req, res) => {
  const [businesses, orders, revenue] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM businesses'),
    pool.query('SELECT COUNT(*) FROM orders'),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE payment_status = 'Paid'`),
  ]);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const newThisWeek = await pool.query('SELECT COUNT(*) FROM businesses WHERE created_at > $1', [weekAgo]);

  res.json({
    totalBusinesses: Number(businesses.rows[0].count),
    newBusinessesThisWeek: Number(newThisWeek.rows[0].count),
    totalOrders: Number(orders.rows[0].count),
    totalRevenue: Number(revenue.rows[0].total),
  });
});

// GET /api/admin/businesses — every business with real aggregate stats,
// each computed live (not stored/cached) so it's always accurate
router.get('/businesses', async (req, res) => {
  const { rows: businesses } = await pool.query('SELECT * FROM businesses ORDER BY created_at DESC');

  const withStats = await Promise.all(businesses.map(async (b) => {
    const [users, products, customers, orders, revenue] = await Promise.all([
      pool.query('SELECT email, created_at FROM users WHERE business_id = $1 ORDER BY created_at ASC LIMIT 1', [b.id]),
      pool.query('SELECT COUNT(*) FROM products WHERE business_id = $1', [b.id]),
      pool.query('SELECT COUNT(*) FROM customers WHERE business_id = $1', [b.id]),
      pool.query('SELECT COUNT(*) FROM orders WHERE business_id = $1', [b.id]),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE business_id = $1 AND payment_status = 'Paid'`, [b.id]),
    ]);
    return {
      id: b.id,
      name: b.name,
      ownerEmail: users.rows[0]?.email || '(no user)',
      createdAt: b.created_at,
      productCount: Number(products.rows[0].count),
      customerCount: Number(customers.rows[0].count),
      orderCount: Number(orders.rows[0].count),
      totalRevenue: Number(revenue.rows[0].total),
    };
  }));

  res.json(withStats);
});

// DELETE /api/admin/businesses/:id — removes a business AND everything
// under it (users, products, customers, orders, payments), thanks to
// "ON DELETE CASCADE" on every foreign key in schema.sql
router.delete('/businesses/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM businesses WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Business not found' });
  res.status(204).send();
});

module.exports = router;// GET /api/admin/timeseries?days=30 — daily order count + revenue,
// platform-wide, for accurate day-by-day trend charts
router.get('/timeseries', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query(
    `SELECT
       date_trunc('day', created_at) AS day,
       COUNT(*) AS order_count,
       COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0) AS revenue
     FROM orders
     WHERE created_at > $1
     GROUP BY day
     ORDER BY day ASC`,
    [start]
  );

  // Fill in days with zero orders so the chart has no gaps
  const byDay = new Map(rows.map(r => [r.day.toISOString().slice(0, 10), r]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    series.push({
      date: key,
      orderCount: row ? Number(row.order_count) : 0,
      revenue: row ? Number(row.revenue) : 0,
    });
  }

  res.json(series);
});
// Add this route to routes/admin.js, alongside your other /businesses routes
// (above `module.exports = router;`). Unlike the other admin routes, this one
// DOES filter by business_id on purpose — it's a single store's own detail view,
// not a platform-wide one.

// GET /api/admin/businesses/:id/timeseries?days=30 — one store's daily order
// count + revenue, for the "click into a store" detail view
router.get('/businesses/:id/timeseries', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const businessId = req.params.id;

  const { rows } = await pool.query(
    `SELECT
       date_trunc('day', created_at) AS day,
       COUNT(*) AS order_count,
       COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0) AS revenue
     FROM orders
     WHERE business_id = $1 AND created_at > $2
     GROUP BY day
     ORDER BY day ASC`,
    [businessId, start]
  );

  // Fill in days with zero orders so the chart has no gaps
  const byDay = new Map(rows.map(r => [r.day.toISOString().slice(0, 10), r]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    series.push({
      date: key,
      orderCount: row ? Number(row.order_count) : 0,
      revenue: row ? Number(row.revenue) : 0,
    });
  }

  res.json(series);
});
