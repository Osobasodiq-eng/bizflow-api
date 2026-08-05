// routes/customers.js
// Powers the "Customers" panel: segment chart + customer detail card + customer table

const express = require('express');
const router = express.Router();
const db = require('../data/store');

// Derive live stats (orders count, spend, last order, tag) from the orders table
// rather than storing them redundantly — this is how real APIs usually do it.
function withStats(customer) {
  const custOrders = db.orders.filter(o => o.customerId === customer.id && o.status !== 'Cancelled');
  const spend = custOrders.reduce((sum, o) => sum + o.amount, 0);
  const sorted = [...custOrders].sort((a, b) => new Date(b.date) - new Date(a.date));
  const lastOrder = sorted[0] || null;

  return {
    ...customer,
    orderCount: custOrders.length,
    spend,
    lastOrderDate: lastOrder ? lastOrder.date : null,
    lastOrderItem: lastOrder ? lastOrder.items[0]?.name : null,
  };
}

// GET /api/customers/segments -> counts for the segment bar chart (VIP/Frequent/New/At Risk)
router.get('/segments', (req, res) => {
  const counts = { VIP: 0, Frequent: 0, New: 0, 'At Risk': 0 };
  db.customers.forEach(c => { if (counts[c.tag] !== undefined) counts[c.tag]++; });
  res.json(counts);
});

// GET /api/customers -> the "All customers" table
router.get('/', (req, res) => {
  res.json(db.customers.map(withStats));
});

// GET /api/customers/:id -> the customer detail card (e.g. "Amaka Okonkwo" card)
router.get('/:id', (req, res) => {
  const customer = db.customers.find(c => c.id === req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(withStats(customer));
});

// POST /api/customers -> create a customer (used when a new order comes from an unknown number)
router.post('/', (req, res) => {
  const { name, phone, location } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  const id = `C-${String(db.customers.length + 1).padStart(3, '0')}`;
  const customer = { id, name, phone, location: location || 'Unknown', since: new Date().toISOString(), tag: 'New' };
  db.customers.push(customer);
  res.status(201).json(customer);
});

module.exports = router;
