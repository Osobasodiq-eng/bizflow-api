// routes/public.js
//
// PUBLIC storefront routes — deliberately NOT behind requireAuth.
// A buyer browsing a merchant's storefront has no BizFlow login and never
// should need one, so these routes take the business as a URL param
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

function parseBusinessId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function paystackFetch(path, options = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.status === false) {
    throw new Error(data.message || 'Paystack request failed');
  }
  return data;
}

// Looks up a delivery zone's real fee — NEVER trust a fee amount sent by
// the client, only ever look it up ourselves. Returns 0 for pickup (no
// zone chosen at all).
async function resolveDeliveryFee(client, businessId, deliveryZoneId) {
  if (!deliveryZoneId) return 0;
  const zoneResult = await client.query(
    'SELECT fee FROM delivery_zones WHERE id = $1 AND business_id = $2',
    [deliveryZoneId, businessId]
  );
  if (!zoneResult.rows[0]) throw { status: 400, message: 'Selected delivery location is not valid for this store' };
  return Number(zoneResult.rows[0].fee);
}

// The actual "create an order" work — checks stock, decrements it, creates
// the customer, inserts the order row, logs the inventory change. Shared by
// both the manual "place order, seller confirms payment later" flow AND the
// real-payment flow (called only after Paystack confirms money moved), so
// an order created either way ends up identical in the database.
async function createOrderFromItems(client, { businessId, customer, items, delivery, deliveryFee, paymentStatus, paystackReference }) {
  const custResult = await client.query(
    `INSERT INTO customers (business_id, name, phone, location, tag) VALUES ($1, $2, $3, $4, 'New') RETURNING id`,
    [businessId, customer.name, customer.phone, customer.location || 'Unknown']
  );
  const resolvedCustomerId = custResult.rows[0].id;

  let itemsTotal = 0;
  const orderItems = [];
  const stockLogEntries = [];
  const touchedProductIds = new Set(); // products whose variant stock changed — need their total resynced after
  for (const item of items) {
    const prodResult = await client.query(
      'SELECT * FROM products WHERE id = $1 AND business_id = $2 FOR UPDATE',
      [item.productId, businessId]
    );
    const product = prodResult.rows[0];
    if (!product) throw { status: 400, message: `Unknown productId ${item.productId}` };

    let unitPrice = Number(product.price);
    let variantLabel = null;

    if (item.variantId) {
      const variantResult = await client.query(
        'SELECT * FROM product_variants WHERE id = $1 AND product_id = $2 AND business_id = $3 FOR UPDATE',
        [item.variantId, product.id, businessId]
      );
      const variant = variantResult.rows[0];
      if (!variant) throw { status: 400, message: `Selected size is not valid for ${product.name}` };
      if (variant.quantity < item.qty) throw { status: 400, message: `Not enough stock for ${product.name} (${variant.label})` };

      await client.query('UPDATE product_variants SET quantity = quantity - $1 WHERE id = $2', [item.qty, variant.id]);
      touchedProductIds.add(product.id);
      unitPrice = Number(variant.price);
      variantLabel = variant.label;
      stockLogEntries.push({
        productId: product.id, productName: `${product.name} (${variant.label})`,
        quantityChange: -item.qty, quantityBefore: variant.quantity, quantityAfter: variant.quantity - item.qty,
      });
    } else {
      if (product.quantity < item.qty) throw { status: 400, message: `Not enough stock for ${product.name}` };
      await client.query('UPDATE products SET quantity = quantity - $1 WHERE id = $2', [item.qty, product.id]);
      stockLogEntries.push({
        productId: product.id, productName: product.name,
        quantityChange: -item.qty, quantityBefore: product.quantity, quantityAfter: product.quantity - item.qty,
      });
    }

    itemsTotal += unitPrice * item.qty;
    orderItems.push({
      productId: product.id, name: product.name, qty: item.qty, price: unitPrice,
      variantId: item.variantId || null, variantLabel,
    });
  }

  // Keep each touched product's total quantity column correct (sum of its
  // variants) — same recompute the dashboard's variant routes do.
  for (const productId of touchedProductIds) {
    await client.query(
      `UPDATE products SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM product_variants WHERE product_id = $1) WHERE id = $1`,
      [productId]
    );
  }

  const amount = itemsTotal + deliveryFee;

  const orderResult = await client.query(
    `INSERT INTO orders (business_id, customer_id, items, amount, payment_status, status, delivery, paystack_reference)
     VALUES ($1, $2, $3, $4, $5, 'New', $6, $7) RETURNING *`,
    [businessId, resolvedCustomerId, JSON.stringify(orderItems), amount, paymentStatus, delivery || null, paystackReference || null]
  );
  const newOrderId = orderResult.rows[0].id;

  // Only real, confirmed payments get a row in `payments` — the manual
  // "Awaiting" flow legitimately has no money yet, so nothing to record
  // there (mark-paid, elsewhere, is what creates that row once the seller
  // confirms it themselves).
  if (paymentStatus === 'Paid' && paystackReference) {
    await client.query(
      `INSERT INTO payments (business_id, order_id, customer_id, amount, method, ref, status, paid_at)
       VALUES ($1, $2, $3, $4, 'Paystack', $5, 'Confirmed', now())`,
      [businessId, newOrderId, resolvedCustomerId, amount, paystackReference]
    );
  }

  for (const entry of stockLogEntries) {
    await logInventoryChange(client, {
      businessId, productId: entry.productId, productName: entry.productName,
      changeType: 'Sale', quantityChange: entry.quantityChange,
      quantityBefore: entry.quantityBefore, quantityAfter: entry.quantityAfter,
      note: `Storefront order BF-${String(newOrderId).padStart(4, '0')}`,
    });
  }

  return {
    id: `BF-${String(newOrderId).padStart(4, '0')}`,
    itemsTotal, deliveryFee, amount,
    items: orderItems,
    status: 'New',
    paymentStatus,
  };
}

// GET /api/public/:businessId/store
router.get('/:businessId/store', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });

  const { rows } = await pool.query(
    'SELECT id, name, logo_url, banner_url, description, theme, paystack_subaccount_code FROM businesses WHERE id = $1',
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
    // Tells the storefront whether to show a real "Pay now" checkout or
    // fall back to the manual "place order, seller confirms payment" flow.
    paymentsEnabled: !!rows[0].paystack_subaccount_code,
  });
});

// GET /api/public/:businessId/delivery-zones
router.get('/:businessId/delivery-zones', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });

  const { rows } = await pool.query(
    'SELECT id, location_name, fee FROM delivery_zones WHERE business_id = $1 ORDER BY id',
    [businessId]
  );
  res.json(rows.map(z => ({ id: z.id, locationName: z.location_name, fee: Number(z.fee) })));
});

// GET /api/public/:businessId/products
router.get('/:businessId/products', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });

  const { rows } = await pool.query(
    'SELECT id, name, category, price, quantity, image_url, description, specifications FROM products WHERE business_id = $1 ORDER BY id',
    [businessId]
  );
  const variantRows = await pool.query(
    'SELECT id, product_id, label, price, quantity FROM product_variants WHERE business_id = $1 ORDER BY id',
    [businessId]
  );
  const variantsByProduct = {};
  for (const v of variantRows.rows) {
    (variantsByProduct[v.product_id] ||= []).push({ id: v.id, label: v.label, price: Number(v.price), inStock: v.quantity > 0 });
  }

  res.json(rows.map(p => {
    const variants = variantsByProduct[p.id] || [];
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      price: Number(p.price),
      // A product with variants is only "in stock" overall if at least one
      // size/variant actually has stock — the base quantity column is kept
      // in sync as a sum, but inStock should reflect real buyable state.
      inStock: variants.length ? variants.some(v => v.inStock) : p.quantity > 0,
      imageUrl: p.image_url || null,
      description: p.description || null,
      specifications: p.specifications || [],
      variants,
    };
  }));
});

// POST /api/public/:businessId/orders
// The ORIGINAL manual flow: creates the order immediately, payment status
// "Awaiting", seller confirms payment themselves later. Kept working
// unchanged for any store that hasn't linked a bank account yet — real
// payment (below) only kicks in once a merchant connects one.
router.post('/:businessId/orders', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });

  const { customer, items, delivery, deliveryZoneId } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items are required' });
  if (!customer || !customer.name || !customer.phone) {
    return res.status(400).json({ error: 'customer name and phone are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bizCheck = await client.query('SELECT id FROM businesses WHERE id = $1', [businessId]);
    if (!bizCheck.rows[0]) throw { status: 404, message: 'Store not found' };

    const deliveryFee = await resolveDeliveryFee(client, businessId, deliveryZoneId);
    const result = await createOrderFromItems(client, {
      businessId, customer, items, delivery, deliveryFee, paymentStatus: 'Awaiting',
    });

    await client.query('COMMIT');
    res.status(201).json(result);
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.status || 500;
    console.error('Storefront order creation error:', err);
    res.status(status).json({ error: err.message || 'Could not create order' });
  } finally {
    client.release();
  }
});

// POST /api/public/:businessId/checkout/initialize
// Starts a REAL Paystack payment. Does NOT touch stock or create anything
// yet — that only happens once the payment is verified as successful
// (below). This just returns a link for the buyer to actually pay at.
router.post('/:businessId/checkout/initialize', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });

  const { customer, items, delivery, deliveryZoneId, callbackUrl } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items are required' });
  if (!customer || !customer.name || !customer.phone || !customer.email) {
    return res.status(400).json({ error: 'customer name, phone, and email are required' });
  }

  const client = await pool.connect();
  try {
    const bizResult = await client.query(
      'SELECT id, paystack_subaccount_code FROM businesses WHERE id = $1', [businessId]
    );
    const business = bizResult.rows[0];
    if (!business) return res.status(404).json({ error: 'Store not found' });
    if (!business.paystack_subaccount_code) {
      return res.status(400).json({ error: 'This store has not set up payments yet' });
    }

    const deliveryFee = await resolveDeliveryFee(client, businessId, deliveryZoneId);

    // Check stock is AVAILABLE without decrementing it yet — we don't want
    // to hold stock hostage for a payment that might never complete. Real
    // decrement happens at verify time, right before the order is created.
    let itemsTotal = 0;
    for (const item of items) {
      const prodResult = await client.query('SELECT price, quantity, name FROM products WHERE id = $1 AND business_id = $2', [item.productId, businessId]);
      const product = prodResult.rows[0];
      if (!product) return res.status(400).json({ error: `Unknown productId ${item.productId}` });

      if (item.variantId) {
        const variantResult = await client.query('SELECT price, quantity, label FROM product_variants WHERE id = $1 AND product_id = $2 AND business_id = $3', [item.variantId, item.productId, businessId]);
        const variant = variantResult.rows[0];
        if (!variant) return res.status(400).json({ error: `Selected size is not valid for ${product.name}` });
        if (variant.quantity < item.qty) return res.status(400).json({ error: `Not enough stock for ${product.name} (${variant.label})` });
        itemsTotal += Number(variant.price) * item.qty;
      } else {
        if (product.quantity < item.qty) return res.status(400).json({ error: `Not enough stock for ${product.name}` });
        itemsTotal += Number(product.price) * item.qty;
      }
    }
    const amount = itemsTotal + deliveryFee;

    const paystackRes = await paystackFetch('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: customer.email,
        amount: Math.round(amount * 100), // Paystack expects kobo, not naira
        subaccount: business.paystack_subaccount_code,
        callback_url: callbackUrl || undefined,
        metadata: { businessId, customer, items, delivery, deliveryZoneId },
      }),
    });

    res.json({ authorizationUrl: paystackRes.data.authorization_url, reference: paystackRes.data.reference });
  } catch (err) {
    console.error('Checkout initialize error:', err);
    res.status(400).json({ error: err.message || 'Could not start payment' });
  } finally {
    client.release();
  }
});

// GET /api/public/:businessId/checkout/verify/:reference
// Called after the buyer is redirected back from Paystack. Verifies the
// payment DIRECTLY with Paystack (never trusts the redirect alone — a
// buyer could reach this URL without ever actually paying), and only THEN
// creates the real order. Safe to call more than once for the same
// reference (e.g. a page reload) — returns the existing order instead of
// creating a duplicate.
router.get('/:businessId/checkout/verify/:reference', async (req, res) => {
  const businessId = parseBusinessId(req.params.businessId);
  if (!businessId) return res.status(404).json({ error: 'Store not found' });
  const { reference } = req.params;

  const client = await pool.connect();
  try {
    // Already processed this reference? Return the same result instead of
    // creating a second order for the same payment.
    const existing = await client.query(
      'SELECT id, items, amount, payment_status FROM orders WHERE paystack_reference = $1 AND business_id = $2',
      [reference, businessId]
    );
    if (existing.rows[0]) {
      const o = existing.rows[0];
      return res.json({
        id: `BF-${String(o.id).padStart(4, '0')}`, amount: Number(o.amount),
        items: o.items, status: 'New', paymentStatus: o.payment_status, alreadyProcessed: true,
      });
    }

    const verifyRes = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (verifyRes.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment was not successful' });
    }

    const meta = verifyRes.data.metadata;
    if (!meta || Number(meta.businessId) !== businessId) {
      return res.status(400).json({ error: 'This payment does not belong to this store' });
    }

    await client.query('BEGIN');
    const deliveryFee = await resolveDeliveryFee(client, businessId, meta.deliveryZoneId);
    const result = await createOrderFromItems(client, {
      businessId, customer: meta.customer, items: meta.items, delivery: meta.delivery,
      deliveryFee, paymentStatus: 'Paid', paystackReference: reference,
    });

    // Defense in depth: confirm what we actually charged for matches what
    // Paystack actually collected, in case of a rare race condition (e.g.
    // stock/price changed between initialize and verify).
    if (Math.round(result.amount * 100) !== verifyRes.data.amount) {
      console.error(`Amount mismatch on reference ${reference}: expected ${result.amount * 100}, Paystack charged ${verifyRes.data.amount}`);
    }

    await client.query('COMMIT');
    res.status(201).json(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Checkout verify error:', err);
    res.status(400).json({ error: err.message || 'Could not verify payment' });
  } finally {
    client.release();
  }
});

module.exports = router;
