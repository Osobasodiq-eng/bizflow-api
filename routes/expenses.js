// routes/expenses.js
// Money going OUT of the business — the counterpart to payments (money
// coming in). This is what lets "revenue" become "actual profit."

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const CATEGORIES = ['Rent', 'Transport', 'Supplies', 'Salaries', 'Utilities', 'Marketing', 'Other'];

router.get('/categories', (req, res) => res.json(CATEGORIES));

router.get('/summary', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM expenses WHERE business_id = $1', [req.businessId]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const thisMonth = rows.filter(e => new Date(e.expense_date) >= monthStart);
  const thisWeek = rows.filter(e => new Date(e.expense_date) >= weekAgo);

  const byCategory = {};
  thisMonth.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount); });

  res.json({
    totalThisMonth: thisMonth.reduce((s, e) => s + Number(e.amount), 0),
    totalThisWeek: thisWeek.reduce((s, e) => s + Number(e.amount), 0),
    countThisMonth: thisMonth.length,
    byCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
  });
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM expenses WHERE business_id = $1 ORDER BY expense_date DESC', [req.businessId]);
  res.json(rows.map(e => ({
    id: e.id, description: e.description, category: e.category,
    amount: Number(e.amount), date: e.expense_date,
  })));
});

router.post('/', async (req, res) => {
  const { description, category, amount, date } = req.body;
  if (!description || amount == null) return res.status(400).json({ error: 'description and amount are required' });

  const { rows } = await pool.query(
    `INSERT INTO expenses (business_id, description, category, amount, expense_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.businessId, description, category || 'Other', Number(amount), date ? new Date(date) : new Date()]
  );
  const e = rows[0];
  res.status(201).json({ id: e.id, description: e.description, category: e.category, amount: Number(e.amount), date: e.expense_date });
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM expenses WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!rowCount) return res.status(404).json({ error: 'Expense not found' });
  res.status(204).send();
});

// POST /import — same CSV bulk-import pattern as the other resources
router.post('/import', async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array is required' });

  let created = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.description || r.amount == null || r.amount === '') throw new Error('description and amount are required');
      await pool.query(
        `INSERT INTO expenses (business_id, description, category, amount, expense_date) VALUES ($1, $2, $3, $4, $5)`,
        [req.businessId, r.description, r.category || 'Other', Number(r.amount), r.date ? new Date(r.date) : new Date()]
      );
      created++;
    } catch (err) {
      errors.push({ row: i + 1, description: r.description || '(no description)', error: err.message });
    }
  }
  res.json({ created, errors });
});

module.exports = router;
