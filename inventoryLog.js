// db/inventoryLog.js
// One shared function for recording a stock change — used from both
// routes/inventory.js (manual edits, new products, imports) and
// routes/orders.js (sales decrement stock). Keeping this in one place
// means every code path that touches product quantity leaves a consistent
// audit trail, instead of each route file reinventing its own logging.

const pool = require('./pool');

// `client` is optional — pass the transaction client when this log entry
// needs to be atomic with other changes (e.g. an order + its stock
// decrement should either both succeed or both roll back together).
// If omitted, this just runs directly against the pool.
async function logInventoryChange(client, {
  businessId, productId, productName, changeType, quantityChange, quantityBefore, quantityAfter, note,
}) {
  const q = client || pool;
  await q.query(
    `INSERT INTO inventory_history
       (business_id, product_id, product_name, change_type, quantity_change, quantity_before, quantity_after, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [businessId, productId, productName, changeType, quantityChange, quantityBefore, quantityAfter, note || null]
  );
}

module.exports = { logInventoryChange };
