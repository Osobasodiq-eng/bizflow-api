// routes/inventory.js
// Every query here includes "WHERE business_id = $1" — that one clause is
// the entire multi-tenant security model. Forget it on any query and you'd
// leak data between businesses, so every route below starts from req.businessId.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logInventoryChange } = require('../db/inventoryLog');

router.get('/summary', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE business_id = $1', [req.businessId]);
  const stockValue = rows.reduce((sum, p) => sum + Number(p.cost) * p.quantity, 0);
  const lowStock = rows.filter(p => p.quantity > 0 && p.quantity <= p.threshold);
  const outOfStock = rows.filter(p => p.quantity === 0);
  res.json({
    totalProducts: rows.length,
    categories: new Set(rows.map(p => p.category)).size,
    stockValue,
    lowStockCount: lowStock.length,
    outOfStockCount: outOfStock.length,
    outOfStockNames: outOfStock.map(p => p.name),
  });
});

// GET /history -> the audit trail for the "Inventory History" view.
// Placed BEFORE /:id so the literal word "history" doesn't get swallowed
// by the :id route parameter.
router.get('/history', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM inventory_history WHERE business_id = $1 ORDER BY created_at DESC LIMIT 300`,
    [req.businessId]
  );
  res.json(rows.map(r => ({
    id: r.id, productId: r.product_id, productName: r.product_name,
    changeType: r.change_type, quantityChange: r.quantity_change,
    quantityBefore: r.quantity_before, quantityAfter: r.quantity_after,
    note: r.note, date: r.created_at,
  })));
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, category, cost, price, quantity, threshold, image_url, description, specifications FROM products WHERE business_id = $1 ORDER BY id',
    [req.businessId]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
  res.json(rows[0]);
});

router.post('/', async (req, res) => {
  const { name, cost, price, quantity, threshold, category, image_url, description, specifications } = req.body;
  if (!name || cost == null || price == null) return res.status(400).json({ error: 'name, cost, and price are required' });

  const startQty = quantity ?? 0;
  const { rows } = await pool.query(
    `INSERT INTO products (business_id, name, category, cost, price, quantity, threshold, image_url, description, specifications)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [req.businessId, name, category || 'Uncategorized', cost, price, startQty, threshold ?? 5, image_url || null,
     description || null, JSON.stringify(specifications || [])]
  );
  const product = rows[0];

  if (startQty > 0) {
    await logInventoryChange(null, {
      businessId: req.businessId, productId: product.id, productName: product.name,
      changeType: 'New product', quantityChange: startQty, quantityBefore: 0, quantityAfter: startQty,
    });
  }
  res.status(201).json(product);
});

router.patch('/:id', async (req, res) => {
  const fields = ['name', 'category', 'cost', 'price', 'quantity', 'threshold', 'image_url', 'description', 'specifications'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  // Fetch the current quantity BEFORE updating, so we can log the real
  // before/after change if quantity is one of the fields being edited.
  const before = await pool.query('SELECT quantity, name FROM products WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!before.rows[0]) return res.status(404).json({ error: 'Product not found' });
  const quantityBefore = before.rows[0].quantity;

  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(', ');
  // specifications is a JSONB column — it needs to arrive as a JSON string,
  // unlike every other plain text/number field here.
  const values = updates.map(f => f === 'specifications' ? JSON.stringify(req.body[f]) : req.body[f]);
  const { rows } = await pool.query(
    `UPDATE products SET ${setClause} WHERE id = $${updates.length + 1} AND business_id = $${updates.length + 2} RETURNING *`,
    [...values, req.params.id, req.businessId]
  );
  const product = rows[0];

  if (updates.includes('quantity') && Number(req.body.quantity) !== quantityBefore) {
    const quantityAfter = Number(req.body.quantity);
    await logInventoryChange(null, {
      businessId: req.businessId, productId: product.id, productName: product.name,
      changeType: 'Manual adjustment', quantityChange: quantityAfter - quantityBefore,
      quantityBefore, quantityAfter, note: 'Edited via Inventory panel',
    });
  }
  res.json(product);
});

router.delete('/:id', async (req, res) => {
  const existing = await pool.query('SELECT name, quantity FROM products WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Product not found' });

  const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!rowCount) return res.status(404).json({ error: 'Product not found' });

  const { name, quantity } = existing.rows[0];
  if (quantity > 0) {
    // product_id is left null here on purpose — the product row is gone,
    // but product_name preserves what it was for the history record.
    await logInventoryChange(null, {
      businessId: req.businessId, productId: null, productName: name,
      changeType: 'Product deleted', quantityChange: -quantity, quantityBefore: quantity, quantityAfter: 0,
    });
  }
  res.status(204).send();
});

// POST /import — bulk-create products from a parsed CSV. Each row is
// processed independently so one bad row doesn't stop the whole file;
// the response reports exactly what succeeded and what didn't.
// Turns "Size:50ml|Material:Glass" into [{label:"Size",value:"50ml"}, ...].
// Empty/malformed pieces are silently skipped rather than failing the row —
// a typo in specs shouldn't block the whole product from importing.
function parsePackedSpecs(raw) {
  if (!raw) return [];
  return raw.split('|').map(pair => {
    const [label, ...rest] = pair.split(':');
    return { label: (label || '').trim(), value: rest.join(':').trim() };
  }).filter(s => s.label && s.value);
}

router.post('/import', async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array is required' });

  let created = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.name || r.cost == null || r.price == null) throw new Error('name, cost, and price are required');
      const qty = Number(r.quantity) || 0;
      const inserted = await pool.query(
        `INSERT INTO products (business_id, name, category, cost, price, quantity, threshold, image_url, description, specifications)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [req.businessId, r.name, r.category || 'Uncategorized', Number(r.cost), Number(r.price), qty, Number(r.threshold) || 5,
         r.image_url || null, r.description || null, JSON.stringify(parsePackedSpecs(r.specifications))]
      );
      if (qty > 0) {
        await logInventoryChange(null, {
          businessId: req.businessId, productId: inserted.rows[0].id, productName: r.name,
          changeType: 'CSV import', quantityChange: qty, quantityBefore: 0, quantityAfter: qty,
        });
      }
      created++;
    } catch (err) {
      errors.push({ row: i + 1, name: r.name || '(no name)', error: err.message });
    }
  }
  res.json({ created, errors });
});

// --- Product variants (e.g. shoe sizes) — each variant has its OWN price
// and quantity, independent of the parent product and of every other
// variant. Whenever a variant's stock changes, the parent product's own
// `quantity` column is recomputed as the sum of all its variants — this
// keeps every existing feature that reads product.quantity (low-stock
// alerts, CSV export, the Inventory table) working correctly without
// needing to know variants exist at all.
async function recomputeProductQuantity(productId) {
  await pool.query(
    `UPDATE products SET quantity = (
       SELECT COALESCE(SUM(quantity), 0) FROM product_variants WHERE product_id = $1
     ) WHERE id = $1`,
    [productId]
  );
}

router.get('/:productId/variants', async (req, res) => {
  const product = await pool.query('SELECT id FROM products WHERE id = $1 AND business_id = $2', [req.params.productId, req.businessId]);
  if (!product.rows[0]) return res.status(404).json({ error: 'Product not found' });

  const { rows } = await pool.query(
    'SELECT id, label, price, quantity FROM product_variants WHERE product_id = $1 ORDER BY id',
    [req.params.productId]
  );
  res.json(rows);
});

router.post('/:productId/variants', async (req, res) => {
  const { label, price, quantity } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required (e.g. "Size 43")' });
  if (price == null || isNaN(price) || Number(price) < 0) return res.status(400).json({ error: 'price must be a number 0 or greater' });
  if (quantity == null || isNaN(quantity) || Number(quantity) < 0) return res.status(400).json({ error: 'quantity must be a number 0 or greater' });

  const product = await pool.query('SELECT id FROM products WHERE id = $1 AND business_id = $2', [req.params.productId, req.businessId]);
  if (!product.rows[0]) return res.status(404).json({ error: 'Product not found' });

  const { rows } = await pool.query(
    'INSERT INTO product_variants (product_id, business_id, label, price, quantity) VALUES ($1, $2, $3, $4, $5) RETURNING id, label, price, quantity',
    [req.params.productId, req.businessId, label.trim(), price, quantity]
  );
  await recomputeProductQuantity(req.params.productId);
  res.status(201).json(rows[0]);
});

router.patch('/variants/:variantId', async (req, res) => {
  const { label, price, quantity } = req.body;
  const fields = [];
  const values = [];
  let i = 1;

  if (label !== undefined) {
    if (!label.trim()) return res.status(400).json({ error: 'label cannot be empty' });
    fields.push(`label = $${i++}`); values.push(label.trim());
  }
  if (price !== undefined) {
    if (isNaN(price) || Number(price) < 0) return res.status(400).json({ error: 'price must be a number 0 or greater' });
    fields.push(`price = $${i++}`); values.push(price);
  }
  if (quantity !== undefined) {
    if (isNaN(quantity) || Number(quantity) < 0) return res.status(400).json({ error: 'quantity must be a number 0 or greater' });
    fields.push(`quantity = $${i++}`); values.push(quantity);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.params.variantId, req.businessId);
  const { rows } = await pool.query(
    `UPDATE product_variants SET ${fields.join(', ')} WHERE id = $${i} AND business_id = $${i + 1} RETURNING id, product_id, label, price, quantity`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Variant not found' });
  await recomputeProductQuantity(rows[0].product_id);
  res.json(rows[0]);
});

router.delete('/variants/:variantId', async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM product_variants WHERE id = $1 AND business_id = $2 RETURNING product_id',
    [req.params.variantId, req.businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Variant not found' });
  await recomputeProductQuantity(rows[0].product_id);
  res.json({ deleted: true });
});

module.exports = router;
