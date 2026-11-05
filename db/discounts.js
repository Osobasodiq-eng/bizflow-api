// db/discounts.js
// Discount codes: validating one against a basket, and working out how much it takes off.
// A discount applies to the ITEMS total only (never to delivery).

const clean = c => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
const naira = n => '₦' + Number(n).toLocaleString('en-NG');

function amountOff(row, subtotal) {
  const raw = row.type === 'percent' ? (subtotal * Number(row.value)) / 100 : Number(row.value);
  return Math.max(0, Math.min(Math.round(raw), Math.round(subtotal))); // whole naira, never more than the items cost
}

// Looks a code up and says whether it can be used on a basket worth `subtotal`.
//   { ok: true,  row, discount }      or      { ok: false, message }
// lock:  SELECT ... FOR UPDATE (use inside an order transaction so two buyers can't both take the last use)
// force: the buyer already PAID for this discount at checkout, so don't re-reject on expiry / uses / min order
async function checkDiscount(db, businessId, rawCode, subtotal, { lock = false, force = false } = {}) {
  const code = clean(rawCode);
  if (!code) return { ok: false, message: 'Enter a discount code' };
  const { rows: [row] } = await db.query(
    `SELECT * FROM discount_codes WHERE business_id = $1 AND code = $2${lock ? ' FOR UPDATE' : ''}`, [businessId, code]
  );
  if (!row) return { ok: false, message: 'That code isn\'t valid' };
  if (!force) {
    const now = Date.now();
    if (!row.active) return { ok: false, message: 'That code is no longer active' };
    if (row.starts_at && new Date(row.starts_at).getTime() > now) return { ok: false, message: 'That code isn\'t active yet' };
    if (row.expires_at && new Date(row.expires_at).getTime() < now) return { ok: false, message: 'That code has expired' };
    if (row.max_uses != null && row.uses >= row.max_uses) return { ok: false, message: 'That code has been fully used' };
    if (Number(row.min_order) > 0 && subtotal < Number(row.min_order)) return { ok: false, message: `Spend ${naira(row.min_order)} or more to use this code` };
  }
  return { ok: true, row, discount: amountOff(row, subtotal) };
}

const describe = row => row.type === 'percent' ? `${Number(row.value)}% off` : `${naira(row.value)} off`;

module.exports = { clean, naira, amountOff, checkDiscount, describe };
