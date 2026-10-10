// routes/delivery-zones.js
//
// A merchant's delivery zones — a list of locations they deliver to, each
// with its own fee (e.g. "Ikeja — ₦1,500", "Outside Lagos — ₦5,000").
// Scoped by req.businessId, same pattern as every other authenticated
// route: a merchant can only ever see or touch their own zones.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, location_name, fee FROM delivery_zones WHERE business_id = $1 ORDER BY id',
    [req.businessId]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { location_name, fee } = req.body;
  if (!location_name || !location_name.trim()) return res.status(400).json({ error: 'location_name is required' });
  if (fee == null || isNaN(fee) || Number(fee) < 0) return res.status(400).json({ error: 'fee must be a number 0 or greater' });

  const { rows } = await pool.query(
    'INSERT INTO delivery_zones (business_id, location_name, fee) VALUES ($1, $2, $3) RETURNING id, location_name, fee',
    [req.businessId, location_name.trim(), fee]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const { location_name, fee } = req.body;
  const fields = [];
  const values = [];
  let i = 1;

  if (location_name !== undefined) {
    if (!location_name.trim()) return res.status(400).json({ error: 'location_name cannot be empty' });
    fields.push(`location_name = $${i++}`); values.push(location_name.trim());
  }
  if (fee !== undefined) {
    if (isNaN(fee) || Number(fee) < 0) return res.status(400).json({ error: 'fee must be a number 0 or greater' });
    fields.push(`fee = $${i++}`); values.push(fee);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.params.id, req.businessId);
  const { rows } = await pool.query(
    `UPDATE delivery_zones SET ${fields.join(', ')} WHERE id = $${i} AND business_id = $${i + 1} RETURNING id, location_name, fee`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Delivery zone not found' });
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM delivery_zones WHERE id = $1 AND business_id = $2 RETURNING id',
    [req.params.id, req.businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Delivery zone not found' });
  res.json({ deleted: true });
});

// POST /api/delivery-zones/import — bulk create from a CSV upload.
// Matches the existing pattern used by products/customers/etc: takes a
// { rows: [...] } array from the parsed CSV and reports how many succeeded
// vs. any row-level errors, rather than failing the whole batch on one bad
// row. A location name that already exists for this business gets its fee
// UPDATED rather than creating a duplicate zone.
router.post('/import', async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array is required' });

  let created = 0;
  let updated = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const location_name = (r.location_name || '').trim();
      const fee = Number(r.fee);
      if (!location_name) throw new Error('location_name is required');
      if (isNaN(fee) || fee < 0) throw new Error('fee must be a number 0 or greater');

      const existing = await pool.query(
        'SELECT id FROM delivery_zones WHERE business_id = $1 AND location_name = $2',
        [req.businessId, location_name]
      );
      if (existing.rows[0]) {
        await pool.query('UPDATE delivery_zones SET fee = $1 WHERE id = $2', [fee, existing.rows[0].id]);
        updated++;
      } else {
        await pool.query(
          'INSERT INTO delivery_zones (business_id, location_name, fee) VALUES ($1, $2, $3)',
          [req.businessId, location_name, fee]
        );
        created++;
      }
    } catch (err) {
      errors.push({ row: i + 1, error: err.message });
    }
  }
  res.json({ created: created + updated, failed: errors.length, errors });
});

module.exports = router;
