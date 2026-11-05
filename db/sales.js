// db/sales.js
// Sales: automatic price cuts a merchant switches on for a period — on everything, on chosen categories, or on chosen products.
// The storefront shows the cut price with the normal price struck through, and checkout charges the cut price.
// A sale never edits a product's real price: when it ends, prices are simply back to normal.

// Sales that are live right now, in a friendly shape. If the table doesn't exist yet (schema.sql not applied) there are none.
async function activeSales(db, businessId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM sales WHERE business_id = $1 AND active = true
         AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [businessId]);
    return rows.map(r => ({
      id: r.id, name: r.name, percent: Number(r.percent), scope: r.scope,
      categories: r.categories || [], productIds: (r.product_ids || []).map(Number), endsAt: r.ends_at,
    }));
  } catch (e) { return []; }
}

const norm = v => String(v == null || String(v).trim() === '' ? 'Other' : v).trim().toLowerCase();

// Does this sale (a DB row OR the shape above) cover this product?
function appliesTo(sale, product) {
  if (sale.scope === 'all') return true;
  if (sale.scope === 'products') return (sale.productIds || sale.product_ids || []).map(Number).includes(Number(product.id));
  if (sale.scope === 'categories') return (sale.categories || []).map(norm).includes(norm(product.category));
  return false;
}

// The sale a product gets right now: when several overlap, the biggest percentage wins (they don't stack).
function saleFor(sales, product) {
  let best = null;
  for (const s of sales) if (appliesTo(s, product) && (!best || s.percent > best.percent)) best = s;
  return best;
}

// Price after the cut, in whole naira.
const applyPercent = (price, pct) => (pct > 0 ? Math.max(0, Math.round(Number(price) * (100 - pct) / 100)) : Number(price));

module.exports = { activeSales, appliesTo, saleFor, applyPercent };
