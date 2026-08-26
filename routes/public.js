// routes/public.js
//
// PUBLIC storefront routes — deliberately NOT behind requireAuth.
// A buyer browsing a merchant's storefront has no BizFlow login and never
// should need one, so these two routes take the business as a URL param
// (:businessId) instead of reading it off a JWT the way every other route
// file does.
//
// Everything here still filters by business_id, same as the authenticated
// routes — a request for business 3's products can never see business 7's
// rows. What's different is WHO is allowed to ask: anyone, not just that
// business's logged-in owner.
//
// Mounted in server.js as: app.use('/api/public', require('./routes/public'));
// (no requireAuth in front of it — that's the whole point)

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logInventoryChange } = require('../db/inventoryLog');

// Small helper: turns the :businessId route param into a real integer, or
// null if it's garbage. Every route below bails out early with a 404 if
// this comes back null, instead of ever passing NaN into a SQL query.
function parseBusinessId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/public/:businessId/store
// Basic storefront header info (business name) — lets the storefront show
// "You're shopping at {name}" without needing that hardcoded client-side.
router.get('/:businessId/store', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });

  const { rows } = await pool.query(
    'SELECT id, name, logo_url, banner_url, description, theme, delivery_fee FROM businesses WHERE id = $1',
    [businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json({
    id: rows[0].id,
    name: rows[0].name,
    logoUrl: rows[0].logo_url,
    bannerUrl: rows[0].banner_url,
    description: rows[0].description,
    theme: rows[0].theme,
    deliveryFee: Number(rows[0].delivery_fee),
  });
});

// GET /api/public/:businessId/products
// Read-only catalog for buyers. Deliberately returns FEWER fields than the
// authenticated GET /api/products — cost price and low-stock threshold are
// internal business numbers a buyer has no reason to see. Out-of-stock
// products are included (with quantity: 0) rather than hidden, so the
// storefront can grey them out instead of just not mentioning them.
router.get('/:businessId/products', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });

  const { rows } = await pool.query(
    'SELECT id, name, category, price, quantity, image_url, description, specifications FROM products WHERE business_id = $1 ORDER BY id',
    [businessId]
  );
  res.json(rows.map(p => ({
    id: p.id,
    name: p.name,
    category: p.category,
    price: Number(p.price),
    inStock: p.quantity > 0,
    imageUrl: p.image_url || null,
    description: p.description || null,
    specifications: p.specifications || [],
  })));
});

// POST /api/public/:businessId/orders
// Same shape and same underlying logic as the authenticated POST
// /api/orders (stock check, stock decrement, inventory log, customer
// lookup/creation) — just scoped by the :businessId param instead of
// req.businessId from a JWT. A storefront order and a manually-created
// "+ New Order" both end up as ordinary rows in the same orders table, so
// they show up in the BizFlow dashboard identically.
//
// Body: { items: [{ productId, qty }], customer: { name, phone, location },
//          delivery }
// (customerId is intentionally NOT accepted here — a public buyer should
// never be able to attach an order to an existing customer record just by
// guessing an id; every storefront order creates its own customer.)
router.post('/:businessId/orders', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });

  const { customer, items, delivery, deliveryMethod } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items are required' });
  if (!customer || !customer.name || !customer.phone) {
    return res.status(400).json({ error: 'customer name and phone are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Confirm the store actually exists before writing anything against it,
    // and grab its delivery fee while we're here.
    const bizCheck = await client.query('SELECT id, delivery_fee FROM businesses WHERE id = $1', [businessId]);
    if (!bizCheck.rows[0]) throw { status: 404, message: 'Store not found' };
    // Pickup orders never carry a delivery fee, regardless of what the
    // business has configured — only charge it when the buyer actually
    // chose delivery. Defaults to no fee if the field wasn't sent at all,
    // so this never accidentally charges someone.
    const deliveryFee = deliveryMethod === 'delivery' ? Number(bizCheck.rows[0].delivery_fee) : 0;

    const custResult = await client.query(
      `INSERT INTO customers (business_id, name, phone, location, tag) VALUES ($1, $2, $3, $4, 'New') RETURNING id`,
      [businessId, customer.name, customer.phone, customer.location || 'Unknown']
    );
    const resolvedCustomerId = custResult.rows[0].id;

    let itemsTotal = 0;
    const orderItems = [];
    const stockLogEntries = [];
    for (const item of items) {
      const prodResult = await client.query(
        'SELECT * FROM products WHERE id = $1 AND business_id = $2 FOR UPDATE',
        [item.productId, businessId]
      );
      const product = prodResult.rows[0];
      if (!product) throw { status: 400, message: `Unknown productId ${item.productId}` };
      if (product.quantity < item.qty) throw { status: 400, message: `Not enough stock for ${product.name}` };

      await client.query('UPDATE products SET quantity = quantity - $1 WHERE id = $2', [item.qty, product.id]);
      itemsTotal += Number(product.price) * item.qty;
      orderItems.push({ productId: product.id, name: product.name, qty: item.qty });
      stockLogEntries.push({
        productId: product.id, productName: product.name,
        quantityChange: -item.qty, quantityBefore: product.quantity, quantityAfter: product.quantity - item.qty,
      });
    }
    const amount = itemsTotal + deliveryFee;

    const orderResult = await client.query(
      `INSERT INTO orders (business_id, customer_id, items, amount, payment_status, status, delivery)
       VALUES ($1, $2, $3, $4, 'Awaiting', 'New', $5) RETURNING *`,
      [businessId, resolvedCustomerId, JSON.stringify(orderItems), amount, delivery || null]
    );
    const newOrderId = orderResult.rows[0].id;

    for (const entry of stockLogEntries) {
      await logInventoryChange(client, {
        businessId, productId: entry.productId, productName: entry.productName,
        changeType: 'Sale', quantityChange: entry.quantityChange,
        quantityBefore: entry.quantityBefore, quantityAfter: entry.quantityAfter,
        note: `Storefront order BF-${String(newOrderId).padStart(4, '0')}`,
      });
    }

    await client.query('COMMIT');
    res.status(201).json({
      id: `BF-${String(newOrderId).padStart(4, '0')}`,
      itemsTotal,
      deliveryFee,
      amount,
      items: orderItems,
      status: 'New',
      paymentStatus: 'Awaiting',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.status || 500;
    console.error('Storefront order creation error:', err);
    res.status(status).json({ error: err.message || 'Could not create order' });
  } finally {
    client.release();
  }
});

module.exports = router;
