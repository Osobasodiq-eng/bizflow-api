// db/notifications.js
// In-app notifications (the bell in the dashboard). notify() is best-effort: it never throws,
// so a notification problem can never break an order, a message or a campaign.

const pool = require('./pool');

const TYPES = new Set(['order', 'stock', 'message', 'campaign', 'billing']);

// dedupeKey: while the previous notification with the same key is still unread, it is updated
// (new text, bumped to the top) instead of adding another row — so 12 chat messages from one
// person show as one notification, not twelve.
async function notify(businessId, { type, title, body, link, dedupeKey }) {
  try {
    if (!businessId || !TYPES.has(type) || !title) return;
    const vals = [businessId, type, String(title).slice(0, 160), body ? String(body).slice(0, 300) : null, link || null, dedupeKey || null];
    if (dedupeKey) {
      await pool.query(
        `INSERT INTO notifications (business_id, type, title, body, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (business_id, dedupe_key) WHERE read_at IS NULL AND dedupe_key IS NOT NULL
         DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, created_at = now()`, vals);
    } else {
      await pool.query(`INSERT INTO notifications (business_id, type, title, body, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)`, vals);
    }
  } catch (err) { console.error('notify failed:', err.message); }
}

// Called after a storefront order is saved (so a rolled-back order never notifies).
async function notifyStorefrontOrder(businessId, order, customerName) {
  try {
    const paid = order.paymentStatus === 'Paid';
    await notify(businessId, {
      type: 'order', link: 'orders',
      title: `New order ${order.id} — ₦${Number(order.amount).toLocaleString()}`,
      body: `${customerName || 'A customer'} · ${paid ? 'Paid online' : 'Awaiting payment'}`,
    });
    const ids = [...new Set((order.items || []).map(i => i.productId).filter(Boolean))];
    if (!ids.length) return;
    const { rows } = await pool.query(
      `SELECT id, name, quantity FROM products WHERE business_id = $1 AND id = ANY($2::int[]) AND quantity <= threshold`, [businessId, ids]);
    for (const p of rows) {
      await notify(businessId, {
        type: 'stock', link: 'inventory', dedupeKey: `stock-${p.id}`,
        title: p.quantity <= 0 ? `${p.name} is out of stock` : `Low stock: ${p.name}`,
        body: p.quantity <= 0 ? 'Customers can no longer order it until you restock.' : `Only ${p.quantity} left — time to restock.`,
      });
    }
  } catch (err) { console.error('notifyStorefrontOrder failed:', err.message); }
}

module.exports = { notify, notifyStorefrontOrder };
