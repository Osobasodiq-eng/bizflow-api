// db/segments.js
// Customer segments for marketing — computed live from real order history, never stored,
// so they are always current. The same rules feed the Segments screen, campaign
// sending, and the customer tag shown in the Customers tab.

const pool = require('./pool');

// Classifies a customer from their REAL order behavior. Priority matters: a
// customer who's gone quiet is "At Risk" even if they used to be a big spender.
//   At Risk — has ordered before, but nothing in the last 60 days
//   VIP     — N100,000+ total spend, or 5+ orders (and not gone quiet)
//   Frequent— 2+ orders, most recent within 30 days
//   New     — everything else
function computeTag({ orderCount, spend, lastOrderDate }) {
  const days = lastOrderDate ? (Date.now() - new Date(lastOrderDate).getTime()) / 86400000 : null;
  if (orderCount >= 1 && days !== null && days > 60) return 'At Risk';
  if (spend >= 100000 || orderCount >= 5) return 'VIP';
  if (orderCount >= 2 && days !== null && days <= 30) return 'Frequent';
  return 'New';
}

const daysAgo = d => (Date.now() - new Date(d).getTime()) / 86400000;

const SEGMENTS = [
  { key: 'all',           label: 'All customers',  description: 'Everyone you have a record of',               test: () => true },
  { key: 'vip',           label: 'VIP',            description: '₦100,000+ spent, or 5+ orders',              test: c => c.tag === 'VIP' },
  { key: 'ordered_30d',   label: 'Ordered · 30d',  description: 'Placed an order in the last 30 days',        test: c => c.lastOrderDate && daysAgo(c.lastOrderDate) <= 30 },
  { key: 'inactive_60d',  label: 'Inactive · 60d', description: 'Ordered before, but not in the last 60 days', test: c => c.orderCount >= 1 && daysAgo(c.lastOrderDate) > 60 },
  { key: 'new_7d',        label: 'New this week',  description: 'Added in the last 7 days',                   test: c => daysAgo(c.since) <= 7 },
  { key: 'never_ordered', label: 'Never ordered',  description: 'In your list but haven\'t bought yet',       test: c => c.orderCount === 0 },
];
const SEGMENT_KEYS = SEGMENTS.map(s => s.key);

// Every customer of a business with their order stats and tag attached.
async function loadCustomerStats(businessId, db = pool) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.phone, c.email, c.location, c.since, c.marketing_opt_out,
            COALESCE(s.order_count, 0) AS order_count, COALESCE(s.spend, 0) AS spend, s.last_order
     FROM customers c
     LEFT JOIN (
       SELECT customer_id, COUNT(*) AS order_count, SUM(amount) AS spend, MAX(created_at) AS last_order
       FROM orders WHERE business_id = $1 AND status != 'Cancelled' GROUP BY customer_id
     ) s ON s.customer_id = c.id
     WHERE c.business_id = $1
     ORDER BY c.id`,
    [businessId]
  );
  return rows.map(r => {
    const c = {
      id: r.id, name: r.name, phone: r.phone, email: r.email, location: r.location, since: r.since,
      optedOut: r.marketing_opt_out, orderCount: Number(r.order_count), spend: Number(r.spend), lastOrderDate: r.last_order,
    };
    c.tag = computeTag(c);
    return c;
  });
}

const isReachable = c => !!(c.email && String(c.email).includes('@') && !c.optedOut);

function membersOf(key, customers) {
  const seg = SEGMENTS.find(s => s.key === key);
  return seg ? customers.filter(seg.test) : [];
}

module.exports = { SEGMENTS, SEGMENT_KEYS, computeTag, loadCustomerStats, membersOf, isReachable };
