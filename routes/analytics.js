// routes/analytics.js
// Business analytics for the dashboard's Analytics page. Read-only; every query is scoped by business_id.
//
// Definitions (kept simple so the numbers match what merchants see elsewhere):
//   • Revenue   = money actually collected: orders whose payment_status is 'Paid' (cancelled orders excluded)
//   • Orders    = every order placed in the period that wasn't cancelled
//   • Avg order = revenue ÷ paid orders
//   • Profit    = revenue − cost of the goods sold (today's product cost × qty) − expenses logged in the period
//   • Repeat    = buyers in the period who had also bought before the period started
// Days are cut at midnight Africa/Lagos time.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const TZ = 'Africa/Lagos';
const RANGES = { 7: 7, 30: 30, 90: 90, 365: 365 };

const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null); // null = nothing to compare to

router.get('/', async (req, res) => {
  const days = RANGES[Number(req.query.days)] || 30;
  const biz = req.businessId;

  // period = last N days including today; previous = the N days before that
  const periodSql = `
    WITH bounds AS (
      SELECT ((now() AT TIME ZONE '${TZ}')::date - ($2::int - 1)) AS p_start,
             ((now() AT TIME ZONE '${TZ}')::date + 1)              AS p_end,
             ((now() AT TIME ZONE '${TZ}')::date - (2 * $2::int - 1)) AS prev_start
    )`;

  const totalsQ = pool.query(`${periodSql}
    SELECT
      CASE WHEN d >= p_start THEN 'cur' ELSE 'prev' END AS span,
      COUNT(*)::int AS orders,
      COUNT(*) FILTER (WHERE payment_status = 'Paid')::int AS paid_orders,
      COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0)::float AS revenue
    FROM (SELECT o.*, (o.created_at AT TIME ZONE '${TZ}')::date AS d FROM orders o WHERE o.business_id = $1 AND o.status <> 'Cancelled') x, bounds
    WHERE d >= prev_start AND d < p_end
    GROUP BY 1`, [biz, days]);

  const seriesQ = pool.query(`${periodSql}
    SELECT g::date AS day,
      COUNT(o.id)::int AS orders,
      COALESCE(SUM(o.amount) FILTER (WHERE o.payment_status = 'Paid'), 0)::float AS revenue
    FROM bounds, generate_series(p_start, p_end - 1, interval '1 day') g
    LEFT JOIN orders o ON o.business_id = $1 AND o.status <> 'Cancelled' AND (o.created_at AT TIME ZONE '${TZ}')::date = g::date
    GROUP BY g ORDER BY g`, [biz, days]);

  // cost of goods + top products, from the JSON items on paid orders in the period
  const itemsQ = pool.query(`${periodSql}
    SELECT it->>'name' AS name,
      SUM((it->>'qty')::int)::int AS units,
      SUM((it->>'qty')::int * (it->>'price')::numeric)::float AS revenue,
      SUM((it->>'qty')::int * COALESCE(p.cost, 0))::float AS cost
    FROM bounds, orders o
    CROSS JOIN LATERAL jsonb_array_elements(o.items) it
    LEFT JOIN products p ON p.id = NULLIF(it->>'productId', '')::int AND p.business_id = o.business_id
    WHERE o.business_id = $1 AND o.status <> 'Cancelled' AND o.payment_status = 'Paid'
      AND (o.created_at AT TIME ZONE '${TZ}')::date >= p_start AND (o.created_at AT TIME ZONE '${TZ}')::date < p_end
    GROUP BY 1 ORDER BY revenue DESC`, [biz, days]);

  const expensesQ = pool.query(`${periodSql}
    SELECT COALESCE(SUM(amount), 0)::float AS total FROM expenses, bounds
    WHERE business_id = $1 AND (expense_date AT TIME ZONE '${TZ}')::date >= p_start AND (expense_date AT TIME ZONE '${TZ}')::date < p_end`, [biz, days]);

  const weekdayQ = pool.query(`${periodSql}
    SELECT EXTRACT(dow FROM (o.created_at AT TIME ZONE '${TZ}'))::int AS dow, COUNT(*)::int AS orders,
      COALESCE(SUM(o.amount) FILTER (WHERE o.payment_status = 'Paid'), 0)::float AS revenue
    FROM bounds, orders o
    WHERE o.business_id = $1 AND o.status <> 'Cancelled'
      AND (o.created_at AT TIME ZONE '${TZ}')::date >= p_start AND (o.created_at AT TIME ZONE '${TZ}')::date < p_end
    GROUP BY 1`, [biz, days]);

  const sourcesQ = pool.query(`${periodSql}
    SELECT CASE WHEN o.campaign_id IS NOT NULL THEN 'email' WHEN o.source IS NOT NULL THEN o.source ELSE 'direct' END AS src,
      COUNT(*)::int AS orders, COALESCE(SUM(o.amount), 0)::float AS revenue
    FROM bounds, orders o
    WHERE o.business_id = $1 AND o.status <> 'Cancelled' AND o.payment_status = 'Paid'
      AND (o.created_at AT TIME ZONE '${TZ}')::date >= p_start AND (o.created_at AT TIME ZONE '${TZ}')::date < p_end
    GROUP BY 1`, [biz, days]);

  // who bought in the period, and whether they'd bought before it started
  const buyersQ = pool.query(`${periodSql}
    SELECT c.id, c.name, COUNT(*)::int AS orders, COALESCE(SUM(o.amount), 0)::float AS spend,
      EXISTS (SELECT 1 FROM orders e WHERE e.business_id = $1 AND e.customer_id = c.id AND e.status <> 'Cancelled'
              AND (e.created_at AT TIME ZONE '${TZ}')::date < p_start) AS returning
    FROM bounds, orders o JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id
    WHERE o.business_id = $1 AND o.status <> 'Cancelled' AND o.payment_status = 'Paid'
      AND (o.created_at AT TIME ZONE '${TZ}')::date >= p_start AND (o.created_at AT TIME ZONE '${TZ}')::date < p_end
    GROUP BY c.id, c.name, p_start ORDER BY spend DESC`, [biz, days]);

  const newCustQ = pool.query(`${periodSql}
    SELECT COUNT(*) FILTER (WHERE (since AT TIME ZONE '${TZ}')::date >= p_start)::int AS cur,
           COUNT(*) FILTER (WHERE (since AT TIME ZONE '${TZ}')::date >= prev_start AND (since AT TIME ZONE '${TZ}')::date < p_start)::int AS prev
    FROM customers, bounds WHERE business_id = $1`, [biz, days]);

  const owedQ = pool.query(`SELECT COALESCE(SUM(amount), 0)::float AS total, COUNT(*)::int AS n FROM orders
    WHERE business_id = $1 AND status <> 'Cancelled' AND payment_status <> 'Paid'`, [biz]);

  const [totals, series, items, expenses, weekday, sources, buyers, newCust, owed] =
    await Promise.all([totalsQ, seriesQ, itemsQ, expensesQ, weekdayQ, sourcesQ, buyersQ, newCustQ, owedQ]);

  const t = { cur: { orders: 0, paid_orders: 0, revenue: 0 }, prev: { orders: 0, paid_orders: 0, revenue: 0 } };
  totals.rows.forEach(r => { t[r.span] = r; });

  const cogs = items.rows.reduce((s, r) => s + r.cost, 0);
  const expenseTotal = expenses.rows[0].total;
  const profit = t.cur.revenue - cogs - expenseTotal;
  const aov = t.cur.paid_orders ? t.cur.revenue / t.cur.paid_orders : 0;
  const aovPrev = t.prev.paid_orders ? t.prev.revenue / t.prev.paid_orders : 0;

  const returning = buyers.rows.filter(b => b.returning).length;
  const repeatRate = buyers.rows.length ? Math.round((returning / buyers.rows.length) * 100) : 0;

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDow = Object.fromEntries(weekday.rows.map(r => [r.dow, r]));
  const SRC_LABEL = { email: 'Email campaigns', instagram: 'Instagram', whatsapp: 'WhatsApp', facebook: 'Facebook', tiktok: 'TikTok', other: 'Other links', direct: 'Direct / shared link' };

  res.json({
    days,
    kpis: {
      revenue: { value: t.cur.revenue, change: pct(t.cur.revenue, t.prev.revenue) },
      orders: { value: t.cur.orders, change: pct(t.cur.orders, t.prev.orders) },
      avgOrder: { value: Math.round(aov), change: pct(aov, aovPrev) },
      newCustomers: { value: newCust.rows[0].cur, change: pct(newCust.rows[0].cur, newCust.rows[0].prev) },
      repeatRate: { value: repeatRate, buyers: buyers.rows.length, returning },
      profit: { value: Math.round(profit), cogs: Math.round(cogs), expenses: Math.round(expenseTotal) },
      owed: { value: owed.rows[0].total, orders: owed.rows[0].n },
    },
    series: series.rows.map(r => ({ day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10), orders: r.orders, revenue: r.revenue })),
    topProducts: items.rows.slice(0, 8).map(r => ({ name: r.name, units: r.units, revenue: r.revenue, margin: r.revenue ? Math.round(((r.revenue - r.cost) / r.revenue) * 100) : null })),
    weekdays: DOW.map((label, i) => ({ label, orders: byDow[i]?.orders || 0, revenue: byDow[i]?.revenue || 0 })),
    sources: sources.rows.map(r => ({ key: r.src, label: SRC_LABEL[r.src] || r.src, orders: r.orders, revenue: r.revenue })).sort((a, b) => b.revenue - a.revenue),
    topCustomers: buyers.rows.slice(0, 5).map(b => ({ name: b.name, orders: b.orders, spend: b.spend, returning: b.returning })),
  });
});

module.exports = router;
