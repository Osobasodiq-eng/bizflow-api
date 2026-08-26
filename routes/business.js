// routes/business.js
//
// Lets a logged-in merchant view and update their OWN store's
// customization settings — logo, banner, description, theme. Scoped by
// req.businessId (from the JWT via requireAuth), same pattern as every
// other authenticated route: a merchant can only ever touch their own row.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Themes are a fixed, small set we design and control — NOT a free-form
// color picker. Keeping the list here (not just in the frontend) means the
// backend can reject anything that isn't one of these, so a business can
// never end up with a broken/unknown theme value.
const VALID_THEMES = [
  'forest', 'midnight', 'rose', 'ocean',
  'plum', 'amber', 'slate', 'terracotta', 'sage', 'noir',
];

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, logo_url, banner_url, description, theme FROM businesses WHERE id = $1',
    [req.businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Business not found' });
  res.json(rows[0]);
});

router.patch('/', async (req, res) => {
  const { logo_url, banner_url, description, theme } = req.body;

  if (theme !== undefined && !VALID_THEMES.includes(theme)) {
    return res.status(400).json({ error: `theme must be one of: ${VALID_THEMES.join(', ')}` });
  }

  // Only update fields that were actually sent, same pattern as the
  // existing product PATCH route — a merchant can save just the logo
  // without accidentally wiping their description, for example.
  const fields = { logo_url, banner_url, description, theme };
  const setParts = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      setParts.push(`${key} = $${i}`);
      values.push(value);
      i++;
    }
  }
  if (!setParts.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.businessId);
  const { rows } = await pool.query(
    `UPDATE businesses SET ${setParts.join(', ')} WHERE id = $${i} RETURNING id, name, logo_url, banner_url, description, theme`,
    values
  );
  res.json(rows[0]);
});

module.exports = router;
