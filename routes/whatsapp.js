// routes/whatsapp.js
// Powers the "WhatsApp" panel: incoming message inbox (with AI-detected
// order info) and broadcast campaign segment counts.
//
// Note: this does NOT do real message parsing/NLP — the `detected` field
// on each thread is pre-computed seed data (see data/store.js). A real
// implementation would run an LLM step here to extract product/qty/location
// from the raw message text. The rest of the flow (turning that into a real
// order, decrementing stock, creating a customer) is fully real and wired.

const express = require('express');
const router = express.Router();
const db = require('../data/store');

// GET /api/whatsapp/inbox -> pending incoming messages for the "Incoming message" card
router.get('/inbox', (req, res) => {
  const pending = db.whatsappThreads.filter(t => t.status === 'pending').map(t => {
    const product = db.products.find(p => p.id === t.detected.productId);
    const customer = t.customerId ? db.customers.find(c => c.id === t.customerId) : null;
    return {
      ...t,
      customerName: customer ? customer.name : 'Unknown customer',
      detected: {
        ...t.detected,
        productName: product ? product.name : 'Unknown product',
        itemTotal: product ? product.price * t.detected.qty : 0,
        total: product ? product.price * t.detected.qty + t.detected.deliveryFee : t.detected.deliveryFee,
      },
    };
  });
  res.json(pending);
});

// POST /api/whatsapp/inbox/:id/create-order -> "Create Order" button
// Turns the AI-detected info into a REAL order: creates a customer if new,
// decrements real stock, creates a real order — same underlying data
// orders.js and inventory.js work with.
router.post('/inbox/:id/create-order', (req, res) => {
  const thread = db.whatsappThreads.find(t => t.id === req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  if (thread.status !== 'pending') return res.status(400).json({ error: 'Thread already handled' });

  const product = db.products.find(p => p.id === thread.detected.productId);
  if (!product) return res.status(400).json({ error: 'Detected product no longer exists' });
  if (product.quantity < thread.detected.qty) {
    return res.status(400).json({ error: `Not enough stock for ${product.name}` });
  }

  // Resolve or create the customer
  let customerId = thread.customerId;
  if (!customerId) {
    customerId = `C-${String(db.customers.length + 1).padStart(3, '0')}`;
    db.customers.push({
      id: customerId, name: `WhatsApp customer (${thread.phone})`, phone: thread.phone,
      location: thread.detected.location, since: new Date().toISOString(), tag: 'New',
    });
  }

  // Decrement stock and create the order — identical logic to POST /api/orders
  product.quantity -= thread.detected.qty;
  const amount = product.price * thread.detected.qty + thread.detected.deliveryFee;
  const order = {
    id: db.nextOrderId(),
    customerId,
    items: [{ productId: product.id, name: product.name, qty: thread.detected.qty }],
    amount,
    paymentStatus: 'Awaiting',
    status: 'New',
    delivery: thread.detected.location,
    date: new Date().toISOString(),
  };
  db.orders.push(order);

  thread.status = 'ordered';
  thread.customerId = customerId;

  res.status(201).json({ order, customerId });
});

// POST /api/whatsapp/inbox/:id/ignore -> "Ignore" button
router.post('/inbox/:id/ignore', (req, res) => {
  const thread = db.whatsappThreads.find(t => t.id === req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  thread.status = 'ignored';
  res.json({ ok: true });
});

// GET /api/whatsapp/broadcasts -> real contact counts per segment for the
// "Broadcast campaigns" card
router.get('/broadcasts', (req, res) => {
  const now = new Date();
  const daysSince = dateStr => dateStr ? (now - new Date(dateStr)) / (1000 * 60 * 60 * 24) : Infinity;

  // Compute each customer's last order date live, same way customers.js does
  const withLastOrder = db.customers.map(c => {
    const custOrders = db.orders.filter(o => o.customerId === c.id && o.status !== 'Cancelled');
    const sorted = [...custOrders].sort((a, b) => new Date(b.date) - new Date(a.date));
    return { ...c, lastOrderDate: sorted[0] ? sorted[0].date : null };
  });

  const vip = withLastOrder.filter(c => c.tag === 'VIP');
  const dormant = withLastOrder.filter(c => daysSince(c.lastOrderDate) > 30);
  const newCustomers = withLastOrder.filter(c => c.tag === 'New');
  const frequent = withLastOrder.filter(c => c.tag === 'Frequent');

  res.json([
    { key: 'vip', title: 'VIP customers', count: vip.length, sub: `${vip.length} contact${vip.length !== 1 ? 's' : ''} · High-value` },
    { key: 'dormant', title: 'Dormant customers', count: dormant.length, sub: `${dormant.length} contact${dormant.length !== 1 ? 's' : ''} · No order in 30+ days` },
    { key: 'new', title: 'New customers', count: newCustomers.length, sub: `${newCustomers.length} contact${newCustomers.length !== 1 ? 's' : ''} · First order recently` },
    { key: 'frequent', title: 'Frequent buyers', count: frequent.length, sub: `${frequent.length} contact${frequent.length !== 1 ? 's' : ''} · 3+ orders each` },
  ]);
});

module.exports = router;
