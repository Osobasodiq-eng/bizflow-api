// routes/inventory.js
// Powers the "Inventory" panel: KPI row + product table + "Add product" button

const express = require('express');
const router = express.Router();
const db = require('../data/store');

// GET /api/inventory/summary -> the 4 KPI cards at the top of the Inventory panel
router.get('/summary', (req, res) => {
  const products = db.products;
  const stockValue = products.reduce((sum, p) => sum + p.cost * p.quantity, 0);
  const lowStock = products.filter(p => p.quantity > 0 && p.quantity <= p.threshold).length;
  const outOfStock = products.filter(p => p.quantity === 0);

  res.json({
    totalProducts: products.length,
    categories: [...new Set(products.map(p => p.category))].length,
    stockValue,
    lowStockCount: lowStock,
    outOfStockCount: outOfStock.length,
    outOfStockNames: outOfStock.map(p => p.name),
  });
});

// GET /api/products -> the product table rows
router.get('/', (req, res) => {
  res.json(db.products);
});

// GET /api/products/:id -> single product
router.get('/:id', (req, res) => {
  const product = db.products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// POST /api/products -> "Add product" button
router.post('/', (req, res) => {
  const { name, cost, price, quantity, threshold, category } = req.body;
  if (!name || cost == null || price == null) {
    return res.status(400).json({ error: 'name, cost, and price are required' });
  }
  const id = `DS-${String(db.products.length + 1).padStart(3, '0')}`;
  const product = { id, name, cost, price, quantity: quantity ?? 0, threshold: threshold ?? 5, category: category ?? 'Uncategorized' };
  db.products.push(product);
  res.status(201).json(product);
});

// PATCH /api/products/:id -> update stock level, price, threshold, etc.
router.patch('/:id', (req, res) => {
  const product = db.products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  Object.assign(product, req.body);
  res.json(product);
});

module.exports = router;
