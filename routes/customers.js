// routes/customers.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Computes orderCount/spend/lastOrderDate live from the orders table,
// same approach as the in-memory version — just SQL instead of .filter()
async function withStats(businessId, customerRows) {
  if (!customerRows.length) return [];
  const ids = customerRows.map(c => c.id);
  const { rows: orderRows } = await pool.query(
    `SELECT customer_id, amount, items, created_at FROM orders
     WHERE business_id = $1 AND customer_id = ANY($2) AND status != 'Cancelled'`,
    [businessId, ids]
  );
  return customerRows.map(c => {
    const custOrders = orderRows.filter(o => o.customer_id === c.id);
    const spend = custOrders.reduce((sum, o) => sum + Number(o.amount), 0);
    const sorted = [...custOrders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const last = sorted[0];
    return {
      ...c,
      orderCount: custOrders.length,
      spend,
      lastOrderDate: last ? last.created_at : null,
      lastOrderItem: last ? last.items[0]?.name : null,
    };
  });
}

router.get('/segments', async (req, res) => {
  const { rows } = await pool.query('SELECT tag, COUNT(*) FROM customers WHERE business_id = $1 GROUP BY tag', [req.businessId]);
  const counts = { VIP: 0, Frequent: 0, New: 0, 'At Risk': 0 };
  rows.forEach(r => { if (counts[r.tag] !== undefined) counts[r.tag] = Number(r.count); });
  res.json(counts);
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers WHERE business_id = $1 ORDER BY id', [req.businessId]);
  res.json(await withStats(req.businessId, rows));
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
  const [withStatsRow] = await withStats(req.businessId, rows);
  res.json(withStatsRow);
});

router.post('/', async (req, res) => {
  const { name, phone, location } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  const { rows } = await pool.query(
    `INSERT INTO customers (business_id, name, phone, location, tag) VALUES ($1, $2, $3, $4, 'New') RETURNING *`,
    [req.businessId, name, phone, location || 'Unknown']
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const fields = ['name', 'phone', 'location', 'tag'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = updates.map(f => req.body[f]);
  const { rows } = await pool.query(
    `UPDATE customers SET ${setClause} WHERE id = $${updates.length + 1} AND business_id = $${updates.length + 2} RETURNING *`,
    [...values, req.params.id, req.businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM customers WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!rowCount) return res.status(404).json({ error: 'Customer not found' });
  res.status(204).send();
});

module.exports = router;
