// routes/orders.js
// Powers the "Orders" panel: search/filter table, order detail, "New Order" flow,
// plus the orders-by-status and top-products charts on the Dashboard.

const express = require('express');
const router = express.Router();
const db = require('../data/store');

function withCustomer(order) {
  const customer = db.customers.find(c => c.id === order.customerId);
  return { ...order, customerName: customer ? customer.name : 'Unknown' };
}

// GET /api/orders?search=&status=&paymentStatus=
// Powers the search box + status dropdown filter on the Orders panel
router.get('/', (req, res) => {
  let result = db.orders.map(withCustomer);
  const { search, status, paymentStatus } = req.query;

  if (search) {
    const q = search.toLowerCase();
    result = result.filter(o =>
      o.id.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q)
    );
  }
  if (status) result = result.filter(o => o.status === status);
  if (paymentStatus) result = result.filter(o => o.paymentStatus === paymentStatus);

  res.json(result);
});

// GET /api/orders/:id -> order detail (clicking a row in the mockup)
router.get('/:id', (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(withCustomer(order));
});

// POST /api/orders -> "New Order" / WhatsApp "Create Order" button
// body: { customerId (or new customer info), items: [{productId, qty}], delivery }
router.post('/', (req, res) => {
  const { customerId, customer, items, delivery } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ error: 'items are required' });
  }

  // Resolve customer: use existing id, or create a new one (e.g. from WhatsApp)
  let resolvedCustomerId = customerId;
  if (!resolvedCustomerId && customer) {
    const id = `C-${String(db.customers.length + 1).padStart(3, '0')}`;
    db.customers.push({ id, name: customer.name, phone: customer.phone, location: customer.location || 'Unknown', since: new Date().toISOString(), tag: 'New' });
    resolvedCustomerId = id;
  }
  if (!resolvedCustomerId) {
    return res.status(400).json({ error: 'customerId or customer info is required' });
  }

  // Build order items, look up prices, and decrement inventory
  let amount = 0;
  const orderItems = [];
  for (const item of items) {
    const product = db.products.find(p => p.id === item.productId);
    if (!product) return res.status(400).json({ error: `Unknown productId ${item.productId}` });
    if (product.quantity < item.qty) {
      return res.status(400).json({ error: `Not enough stock for ${product.name}` });
    }
    product.quantity -= item.qty;
    amount += product.price * item.qty;
    orderItems.push({ productId: product.id, name: product.name, qty: item.qty });
  }

  const order = {
    id: db.nextOrderId(),
    customerId: resolvedCustomerId,
    items: orderItems,
    amount,
    paymentStatus: 'Awaiting',
    status: 'New',
    delivery: delivery || null,
    date: new Date().toISOString(),
  };
  db.orders.push(order);
  res.status(201).json(withCustomer(order));
});

// PATCH /api/orders/:id -> update status (e.g. mark Shipped, add delivery courier)
router.patch('/:id', (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  Object.assign(order, req.body);
  res.json(withCustomer(order));
});

module.exports = router;
