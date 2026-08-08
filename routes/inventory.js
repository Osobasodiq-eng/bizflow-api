// routes/inventory.js
// Every query here includes "WHERE business_id = $1" — that one clause is
// the entire multi-tenant security model. Forget it on any query and you'd
// leak data between businesses, so every route below starts from req.businessId.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

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

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, category, cost, price, quantity, threshold FROM products WHERE business_id = $1 ORDER BY id',
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
  const { name, cost, price, quantity, threshold, category } = req.body;
  if (!name || cost == null || price == null) return res.status(400).json({ error: 'name, cost, and price are required' });

  const { rows } = await pool.query(
    `INSERT INTO products (business_id, name, category, cost, price, quantity, threshold)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.businessId, name, category || 'Uncategorized', cost, price, quantity ?? 0, threshold ?? 5]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  // Only these fields are editable; build the SET clause dynamically from whatever was sent
  const fields = ['name', 'category', 'cost', 'price', 'quantity', 'threshold'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = updates.map(f => req.body[f]);
  const { rows } = await pool.query(
    `UPDATE products SET ${setClause} WHERE id = $${updates.length + 1} AND business_id = $${updates.length + 2} RETURNING *`,
    [...values, req.params.id, req.businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!rowCount) return res.status(404).json({ error: 'Product not found' });
  res.status(204).send();
});

// POST /import — bulk-create products from a parsed CSV. Each row is
// processed independently so one bad row doesn't stop the whole file;
// the response reports exactly what succeeded and what didn't.
router.post('/import', async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array is required' });

  let created = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.name || r.cost == null || r.price == null) throw new Error('name, cost, and price are required');
      await pool.query(
        `INSERT INTO products (business_id, name, category, cost, price, quantity, threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.businessId, r.name, r.category || 'Uncategorized', Number(r.cost), Number(r.price), Number(r.quantity) || 0, Number(r.threshold) || 5]
      );
      created++;
    } catch (err) {
      errors.push({ row: i + 1, name: r.name || '(no name)', error: err.message });
    }
  }
  res.json({ created, errors });
});

module.exports = router;
