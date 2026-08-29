// routes/admin.js
// Platform-owner-only view across ALL businesses. Every query here
// deliberately does NOT filter by business_id — that's the whole point,
// this is the one place in the API that's allowed to see everything.
// Access is gated by requireAdmin (see routes/auth.js) before any of
// these handlers run.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Replace your EXISTING `router.get('/stats', ...)` and `router.get('/businesses', ...)`
// handlers in routes/admin.js with the two below. Everything else in that file
// (imports, DELETE route, module.exports) stays exactly as it is.
//
// ASSUMPTION: `orders` has a `customer_id` column, used for repeat-customer rate.
// If your column is named differently, update the one query marked below.

// GET /api/admin/stats — platform-wide totals + health metrics for the top of the dashboard
router.get('/stats', async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    businesses,
    orders,
    revenueAndPaid,
    newThisWeek,
    activeStores,
    storesWithASale,
    customers,
    repeatCustomers,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM businesses'),
    pool.query('SELECT COUNT(*) FROM orders'),
    pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0) AS revenue,
        COUNT(*) FILTER (WHERE payment_status = 'Paid') AS paid_count
      FROM orders
    `),
    pool.query('SELECT COUNT(*) FROM businesses WHERE created_at > $1', [weekAgo]),
    // Stores with at least one order in the last 30 days
    pool.query('SELECT COUNT(DISTINCT business_id) FROM orders WHERE created_at > $1', [monthAgo]),
    // Stores that have EVER made a paid sale (for activation rate)
    pool.query(`SELECT COUNT(DISTINCT business_id) FROM orders WHERE payment_status = 'Paid'`),
    pool.query('SELECT COUNT(*) FROM customers'),
    // ASSUMPTION: orders.customer_id — rename if your schema differs
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE order_count > 1) AS repeat_count,
        COUNT(*) AS total_count
      FROM (SELECT customer_id, COUNT(*) AS order_count FROM orders GROUP BY customer_id) t
    `),
  ]);

  const totalBusinesses = Number(businesses.rows[0].count);
  const totalOrders = Number(orders.rows[0].count);
  const totalRevenue = Number(revenueAndPaid.rows[0].revenue);
  const paidOrders = Number(revenueAndPaid.rows[0].paid_count);
  const activeStoreCount = Number(activeStores.rows[0].count);
  const repeatCount = Number(repeatCustomers.rows[0].repeat_count);
  const customersWithOrders = Number(repeatCustomers.rows[0].total_count);

  res.json({
    totalBusinesses,
    newBusinessesThisWeek: Number(newThisWeek.rows[0].count),
    totalOrders,
    totalRevenue,
    avgOrderValue: paidOrders ? totalRevenue / paidOrders : 0,
    paymentSuccessRate: totalOrders ? (paidOrders / totalOrders) * 100 : 0,
    activeStores: activeStoreCount,
    dormantStores: totalBusinesses - activeStoreCount,
    activationRate: totalBusinesses ? (Number(storesWithASale.rows[0].count) / totalBusinesses) * 100 : 0,
    totalCustomers: Number(customers.rows[0].count),
    repeatCustomerRate: customersWithOrders ? (repeatCount / customersWithOrders) * 100 : 0,
  });
});

// GET /api/admin/businesses — every business with real aggregate stats,
// each computed live (not stored/cached) so it's always accurate
router.get('/businesses', async (req, res) => {
  const { rows: businesses } = await pool.query('SELECT * FROM businesses ORDER BY created_at DESC');
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const withStats = await Promise.all(businesses.map(async (b) => {
    const [users, products, customers, orders, revenue, lastOrder, firstPaidOrder] = await Promise.all([
      pool.query('SELECT email, created_at FROM users WHERE business_id = $1 ORDER BY created_at ASC LIMIT 1', [b.id]),
      pool.query('SELECT COUNT(*) FROM products WHERE business_id = $1', [b.id]),
      pool.query('SELECT COUNT(*) FROM customers WHERE business_id = $1', [b.id]),
      pool.query('SELECT COUNT(*) FROM orders WHERE business_id = $1', [b.id]),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE business_id = $1 AND payment_status = 'Paid'`, [b.id]),
      pool.query('SELECT MAX(created_at) AS last FROM orders WHERE business_id = $1', [b.id]),
      pool.query(`SELECT MIN(created_at) AS first FROM orders WHERE business_id = $1 AND payment_status = 'Paid'`, [b.id]),
    ]);

    const orderCount = Number(orders.rows[0].count);
    const totalRevenue = Number(revenue.rows[0].total);
    const lastOrderAt = lastOrder.rows[0].last;
    const firstPaidOrderAt = firstPaidOrder.rows[0].first;

    return {
      id: b.id,
      name: b.name,
      ownerEmail: users.rows[0]?.email || '(no user)',
      createdAt: b.created_at,
      productCount: Number(products.rows[0].count),
      customerCount: Number(customers.rows[0].count),
      orderCount,
      totalRevenue,
      avgOrderValue: orderCount ? totalRevenue / orderCount : 0,
      lastOrderAt,
      isActive: lastOrderAt ? new Date(lastOrderAt) > monthAgo : false,
      daysToFirstSale: firstPaidOrderAt
        ? Math.round((new Date(firstPaidOrderAt) - new Date(b.created_at)) / (1000 * 60 * 60 * 24))
        : null,
    };
  }));

  res.json(withStats);
});
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
// Replace your EXISTING `router.get('/stats', ...)` and `router.get('/businesses', ...)`
// handlers in routes/admin.js with the two below. Everything else in that file
// (imports, DELETE route, module.exports) stays exactly as it is.
//
// ASSUMPTION: `orders` has a `customer_id` column, used for repeat-customer rate.
// If your column is named differently, update the one query marked below.

// GET /api/admin/stats — platform-wide totals + health metrics for the top of the dashboard
router.get('/stats', async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    businesses,
    orders,
    revenueAndPaid,
    newThisWeek,
    activeStores,
    storesWithASale,
    customers,
    repeatCustomers,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM businesses'),
    pool.query('SELECT COUNT(*) FROM orders'),
    pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0) AS revenue,
        COUNT(*) FILTER (WHERE payment_status = 'Paid') AS paid_count
      FROM orders
    `),
    pool.query('SELECT COUNT(*) FROM businesses WHERE created_at > $1', [weekAgo]),
    // Stores with at least one order in the last 30 days
    pool.query('SELECT COUNT(DISTINCT business_id) FROM orders WHERE created_at > $1', [monthAgo]),
    // Stores that have EVER made a paid sale (for activation rate)
    pool.query(`SELECT COUNT(DISTINCT business_id) FROM orders WHERE payment_status = 'Paid'`),
    pool.query('SELECT COUNT(*) FROM customers'),
    // ASSUMPTION: orders.customer_id — rename if your schema differs
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE order_count > 1) AS repeat_count,
        COUNT(*) AS total_count
      FROM (SELECT customer_id, COUNT(*) AS order_count FROM orders GROUP BY customer_id) t
    `),
  ]);

  const totalBusinesses = Number(businesses.rows[0].count);
  const totalOrders = Number(orders.rows[0].count);
  const totalRevenue = Number(revenueAndPaid.rows[0].revenue);
  const paidOrders = Number(revenueAndPaid.rows[0].paid_count);
  const activeStoreCount = Number(activeStores.rows[0].count);
  const repeatCount = Number(repeatCustomers.rows[0].repeat_count);
  const customersWithOrders = Number(repeatCustomers.rows[0].total_count);

  res.json({
    totalBusinesses,
    newBusinessesThisWeek: Number(newThisWeek.rows[0].count),
    totalOrders,
    totalRevenue,
    avgOrderValue: paidOrders ? totalRevenue / paidOrders : 0,
    paymentSuccessRate: totalOrders ? (paidOrders / totalOrders) * 100 : 0,
    activeStores: activeStoreCount,
    dormantStores: totalBusinesses - activeStoreCount,
    activationRate: totalBusinesses ? (Number(storesWithASale.rows[0].count) / totalBusinesses) * 100 : 0,
    totalCustomers: Number(customers.rows[0].count),
    repeatCustomerRate: customersWithOrders ? (repeatCount / customersWithOrders) * 100 : 0,
  });
});

// GET /api/admin/businesses — every business with real aggregate stats,
// each computed live (not stored/cached) so it's always accurate
router.get('/businesses', async (req, res) => {
  const { rows: businesses } = await pool.query('SELECT * FROM businesses ORDER BY created_at DESC');
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const withStats = await Promise.all(businesses.map(async (b) => {
    const [users, products, customers, orders, revenue, lastOrder, firstPaidOrder] = await Promise.all([
      pool.query('SELECT email, created_at FROM users WHERE business_id = $1 ORDER BY created_at ASC LIMIT 1', [b.id]),
      pool.query('SELECT COUNT(*) FROM products WHERE business_id = $1', [b.id]),
      pool.query('SELECT COUNT(*) FROM customers WHERE business_id = $1', [b.id]),
      pool.query('SELECT COUNT(*) FROM orders WHERE business_id = $1', [b.id]),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE business_id = $1 AND payment_status = 'Paid'`, [b.id]),
      pool.query('SELECT MAX(created_at) AS last FROM orders WHERE business_id = $1', [b.id]),
      pool.query(`SELECT MIN(created_at) AS first FROM orders WHERE business_id = $1 AND payment_status = 'Paid'`, [b.id]),
    ]);

    const orderCount = Number(orders.rows[0].count);
    const totalRevenue = Number(revenue.rows[0].total);
    const lastOrderAt = lastOrder.rows[0].last;
    const firstPaidOrderAt = firstPaidOrder.rows[0].first;

    return {
      id: b.id,
      name: b.name,
      ownerEmail: users.rows[0]?.email || '(no user)',
      createdAt: b.created_at,
      productCount: Number(products.rows[0].count),
      customerCount: Number(customers.rows[0].count),
      orderCount,
      totalRevenue,
      avgOrderValue: orderCount ? totalRevenue / orderCount : 0,
      lastOrderAt,
      isActive: lastOrderAt ? new Date(lastOrderAt) > monthAgo : false,
      daysToFirstSale: firstPaidOrderAt
        ? Math.round((new Date(firstPaidOrderAt) - new Date(b.created_at)) / (1000 * 60 * 60 * 24))
        : null,
    };
  }));

  res.json(withStats);
});
