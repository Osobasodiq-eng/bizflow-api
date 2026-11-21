// routes/admin.js
// Platform-owner-only view across ALL businesses. Every query here
// deliberately does NOT filter by business_id — that's the whole point,
// this is the one place in the API that's allowed to see everything.
// Access is gated by requireAdmin (see routes/auth.js) before any of
// these handlers run.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const billing = require('../db/billing');
const { PLANS } = require('../db/plans');

// GET /api/admin/meta-check — are WhatsApp / Messenger / Instagram set up correctly on the platform?
router.get('/meta-check', async (req, res) => {
  try { res.json(await require('../db/meta').diagnose(`${req.protocol}://${req.get('host')}`)); }
  catch (e) { console.error('[meta-check]', e); res.status(500).json({ error: 'Could not run the check' }); }
});

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
  // Read-only look at subscriptions (opening this page never starts anyone's trial clock)
  const { rows: subRows } = await pool.query('SELECT * FROM subscriptions');
  const subs = new Map(subRows.map(r => [r.business_id, r]));
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
      ...(() => { const sub = subs.get(b.id); if (!sub) return { plan: 'free', planState: 'not_started', planName: 'Starter', periodEnd: null }; const r = billing.resolve(sub); return { plan: r.plan, planState: r.state, planName: PLANS[r.plan].name, periodEnd: sub.current_period_end || sub.trial_ends_at }; })(),
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

// GET /api/admin/billing — what Kooza earns: paying merchants, monthly recurring revenue, latest payments
router.get('/billing', async (req, res) => {
  const { rows: subRows } = await pool.query(`SELECT * FROM subscriptions`);
  let mrr = 0; const counts = { free: 0, growth: 0, pro: 0, trial: 0 };
  for (const sub of subRows) {
    const r = billing.resolve(sub);
    if (r.state === 'trial') { counts.trial++; continue; }
    counts[r.plan]++;
    if (r.plan !== 'free' && sub.authorization_code && !sub.cancel_at_period_end) {
      mrr += sub.billing_interval === 'yearly' ? PLANS[r.plan].price.yearly / 12 : PLANS[r.plan].price.monthly;
    }
  }
  const { rows: recent } = await pool.query(
    `SELECT p.plan, p.amount, p.method, p.created_at, b.name FROM subscription_payments p JOIN businesses b ON b.id = p.business_id ORDER BY p.created_at DESC LIMIT 10`);
  res.json({ mrr: Math.round(mrr), counts, recent: recent.map(r => ({ business: r.name, plan: r.plan, amount: Number(r.amount), method: r.method, at: r.created_at })) });
});

// POST /api/admin/businesses/:id/plan { plan: 'free'|'growth'|'pro', days } — give a plan by hand (bank transfer, partner, goodwill)
router.post('/businesses/:id/plan', async (req, res) => {
  try {
    await billing.adminSetPlan(Number(req.params.id), String(req.body.plan), req.body.days);
    res.json({ ok: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

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

// GET /api/admin/timeseries?days=30 — daily order count + revenue,
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

// DELETE /api/admin/businesses/:id — removes a business AND everything
// under it (users, products, customers, orders, payments), thanks to
// "ON DELETE CASCADE" on every foreign key in schema.sql

// ---- Feature adoption: what merchants are actually using (every query is optional, so a missing table never breaks the page)
async function safe(sql, params, fallback) { try { return (await pool.query(sql, params || [])).rows; } catch (e) { return fallback; } }
const num = v => Number(v || 0);

// GET /api/admin/features — platform-wide adoption of each merchant feature
router.get('/features', async (req, res) => {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [looks, designs, displays, addr, chans, camps, autos, discs, sales, inbox, zones, paystack, expenses, ns] = await Promise.all([
    safe(`SELECT look_style AS k, COUNT(*) AS n FROM businesses GROUP BY 1`, [], []),
    safe(`SELECT design_style AS k, COUNT(*) AS n FROM businesses GROUP BY 1`, [], []),
    safe(`SELECT display_style AS k, COUNT(*) AS n FROM businesses GROUP BY 1`, [], []),
    safe(`SELECT COUNT(*) FILTER (WHERE subdomain IS NOT NULL AND subdomain <> '') AS subdomains,
                 COUNT(*) FILTER (WHERE custom_domain IS NOT NULL AND custom_domain <> '') AS custom,
                 COUNT(*) FILTER (WHERE custom_domain IS NOT NULL AND custom_domain <> '' AND custom_domain_status = 'verified') AS custom_verified FROM businesses`, [], [{}]),
    safe(`SELECT channel AS k, COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'error') AS errors FROM meta_channels GROUP BY 1`, [], []),
    safe(`SELECT COUNT(*) AS total, COUNT(DISTINCT business_id) AS stores, COUNT(*) FILTER (WHERE status = 'sent') AS sent,
                 COALESCE(SUM(sent_count),0) AS messages, COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM campaigns`, [], [{}]),
    safe(`SELECT COUNT(*) FILTER (WHERE enabled) AS enabled, COUNT(DISTINCT business_id) FILTER (WHERE enabled) AS stores FROM automations`, [], [{}]),
    safe(`SELECT COUNT(*) AS total, COUNT(DISTINCT business_id) AS stores, COUNT(*) FILTER (WHERE active) AS active, COALESCE(SUM(uses),0) AS uses FROM discount_codes`, [], [{}]),
    safe(`SELECT COUNT(*) AS total, COUNT(DISTINCT business_id) AS stores,
                 COUNT(*) FILTER (WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())) AS live FROM sales`, [], [{}]),
    safe(`SELECT channel AS k, COUNT(*) AS n, COUNT(*) FILTER (WHERE last_message_at > $1) AS recent FROM inbox_conversations GROUP BY 1`, [monthAgo], null),
    safe(`SELECT COUNT(DISTINCT business_id) AS stores, COUNT(*) AS zones FROM delivery_zones`, [], [{}]),
    safe(`SELECT COUNT(*) AS n FROM businesses WHERE paystack_subaccount_code IS NOT NULL AND paystack_subaccount_code <> ''`, [], [{}]),
    safe(`SELECT COUNT(DISTINCT business_id) AS stores, COUNT(*) AS n FROM expenses`, [], [{}]),
    safe(`SELECT COUNT(*) AS n FROM orders WHERE discount_code IS NOT NULL AND discount_code <> ''`, [], [{}]),
  ]);
  let inboxRows = inbox;
  if (inboxRows === null) inboxRows = await safe(`SELECT channel AS k, COUNT(*) AS n, 0 AS recent FROM inbox_conversations GROUP BY 1`, [], []);
  const map = rows => Object.fromEntries(rows.map(r => [r.k || 'none', num(r.n)]));
  res.json({
    looks: map(looks), designs: map(designs), displays: map(displays),
    addresses: { subdomains: num(addr[0].subdomains), customDomains: num(addr[0].custom), customVerified: num(addr[0].custom_verified) },
    channels: Object.fromEntries(chans.map(r => [r.k, { connected: num(r.n), errors: num(r.errors) }])),
    campaigns: { total: num(camps[0].total), stores: num(camps[0].stores), sent: num(camps[0].sent), failed: num(camps[0].failed), messages: num(camps[0].messages) },
    automations: { enabled: num(autos[0].enabled), stores: num(autos[0].stores) },
    discounts: { codes: num(discs[0].total), stores: num(discs[0].stores), active: num(discs[0].active), uses: num(discs[0].uses), ordersWithCode: num(ns[0].n) },
    sales: { total: num(sales[0].total), stores: num(sales[0].stores), live: num(sales[0].live) },
    inbox: { byChannel: map(inboxRows), recent: inboxRows.reduce((a, r) => a + num(r.recent), 0) },
    delivery: { stores: num(zones[0].stores), zones: num(zones[0].zones) },
    paystack: { stores: num(paystack[0].n) },
    expenses: { stores: num(expenses[0].stores), entries: num(expenses[0].n) },
  });
});

// GET /api/admin/businesses/:id/features — one store's setup at a glance
router.get('/businesses/:id/features', async (req, res) => {
  const id = Number(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
  const one = async (sql, fb) => (await safe(sql, [id], [fb]))[0] || fb;
  const [b, chans, camps, autos, discs, sales, convs, zones, exp] = await Promise.all([
    one(`SELECT name, theme, display_style, design_style, look_style, subdomain, custom_domain, custom_domain_status,
                (paystack_subaccount_code IS NOT NULL AND paystack_subaccount_code <> '') AS paystack, paystack_bank_name FROM businesses WHERE id = $1`, {}),
    safe(`SELECT channel, name, detail, status, last_error, created_at FROM meta_channels WHERE business_id = $1 ORDER BY created_at`, [id], []),
    one(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='sent') AS sent, COALESCE(SUM(sent_count),0) AS messages FROM campaigns WHERE business_id = $1`, {}),
    safe(`SELECT kind, enabled FROM automations WHERE business_id = $1`, [id], []),
    one(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active, COALESCE(SUM(uses),0) AS uses FROM discount_codes WHERE business_id = $1`, {}),
    one(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())) AS live FROM sales WHERE business_id = $1`, {}),
    safe(`SELECT channel, COUNT(*) AS n FROM inbox_conversations WHERE business_id = $1 GROUP BY 1`, [id], []),
    one(`SELECT COUNT(*) AS n FROM delivery_zones WHERE business_id = $1`, {}),
    one(`SELECT COUNT(*) AS n FROM expenses WHERE business_id = $1`, {}),
  ]);
  let store = null;
  try { store = await require('../db/domains').storeBaseFor(id); } catch (e) {}
  res.json({
    look: b.look_style || 'none', design: b.design_style || 'cinematic', display: b.display_style || 'grid', theme: b.theme || null,
    address: { subdomain: b.subdomain || null, customDomain: b.custom_domain || null, customDomainStatus: b.custom_domain ? (b.custom_domain_status || 'pending') : null, live: store && store.base ? store.base : null },
    paystack: { connected: !!b.paystack, bank: b.paystack_bank_name || null },
    channels: chans.map(c => ({ channel: c.channel, name: c.name, detail: c.detail, status: c.status, error: c.last_error })),
    campaigns: { total: num(camps.total), sent: num(camps.sent), messages: num(camps.messages) },
    automations: autos.map(a => ({ kind: a.kind, enabled: !!a.enabled })),
    discounts: { total: num(discs.total), active: num(discs.active), uses: num(discs.uses) },
    sales: { total: num(sales.total), live: num(sales.live) },
    inbox: Object.fromEntries(convs.map(c => [c.channel, num(c.n)])),
    deliveryZones: num(zones.n), expenses: num(exp.n),
  });
});

// POST /api/admin/businesses/:id/release-address — take back a store's subdomain and/or custom domain (support / abuse)
router.post('/businesses/:id/release-address', async (req, res) => {
  const which = req.body && req.body.which;
  if (!['subdomain', 'custom_domain', 'both'].includes(which)) return res.status(400).json({ error: 'which must be subdomain, custom_domain or both' });
  const sets = [];
  if (which !== 'custom_domain') sets.push('subdomain = NULL');
  if (which !== 'subdomain') sets.push(`custom_domain = NULL, custom_domain_status = 'pending', custom_domain_render_id = NULL`);
  try { await pool.query(`UPDATE businesses SET ${sets.join(', ')} WHERE id = $1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { console.error('[release-address]', e); res.status(500).json({ error: 'Could not release the address' }); }
});

// POST /api/admin/businesses/:id/disconnect-channel — drop a Meta channel that is misbehaving
router.post('/businesses/:id/disconnect-channel', async (req, res) => {
  const channel = req.body && req.body.channel;
  if (!['whatsapp', 'facebook', 'instagram'].includes(channel)) return res.status(400).json({ error: 'Unknown channel' });
  try { await pool.query('DELETE FROM meta_channels WHERE business_id = $1 AND channel = $2', [req.params.id, channel]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Could not disconnect' }); }
});

router.delete('/businesses/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM businesses WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Business not found' });
  res.status(204).send();
});

module.exports = router;
