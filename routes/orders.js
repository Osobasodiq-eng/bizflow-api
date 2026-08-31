// routes/orders.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logInventoryChange } = require('../db/inventoryLog');
const { sendOrderStatusEmail } = require('../db/email');

function formatOrder(row, customerName) {
  return {
    id: `BF-${String(row.id).padStart(4, '0')}`,
    rawId: row.id,
    customerId: row.customer_id,
    customerName: customerName || 'Unknown',
    items: row.items,
    amount: Number(row.amount),
    paymentStatus: row.payment_status,
    status: row.status,
    delivery: row.delivery,
    date: row.created_at,
  };
}

router.get('/', async (req, res) => {
  const { search, status, paymentStatus } = req.query;
  let query = `
    SELECT o.*, c.name AS customer_name FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.business_id = $1`;
  const params = [req.businessId];

  if (status) { params.push(status); query += ` AND o.status = $${params.length}`; }
  if (paymentStatus) { params.push(paymentStatus); query += ` AND o.payment_status = $${params.length}`; }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    query += ` AND (LOWER(c.name) LIKE $${params.length} OR o.id::text LIKE $${params.length})`;
  }
  query += ' ORDER BY o.created_at DESC';

  const { rows } = await pool.query(query, params);
  res.json(rows.map(r => formatOrder(r, r.customer_name)));
});

router.get('/:idOrCode', async (req, res) => {
  const id = req.params.idOrCode.replace(/^BF-0*/, ''); // accept "BF-0042" or raw "42"
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1 AND o.business_id = $2`,
    [id, req.businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Order not found' });

  // Include how much has actually been paid so far, and what's left — this
  // is what makes partial payments visible in the order detail view instead
  // of just a binary Paid/Awaiting label.
  const paidResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = $1 AND status = 'Confirmed'`,
    [id]
  );
  const amountPaid = Number(paidResult.rows[0].total);

  res.json({
    ...formatOrder(rows[0], rows[0].customer_name),
    amountPaid,
    balanceRemaining: Math.max(0, Number(rows[0].amount) - amountPaid),
  });
});

router.post('/', async (req, res) => {
  const { customerId, customer, items, delivery } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let resolvedCustomerId = customerId;
    if (!resolvedCustomerId && customer) {
      const custResult = await client.query(
        `INSERT INTO customers (business_id, name, phone, location, tag) VALUES ($1, $2, $3, $4, 'New') RETURNING id`,
        [req.businessId, customer.name, customer.phone, customer.location || 'Unknown']
      );
      resolvedCustomerId = custResult.rows[0].id;
    }
    if (!resolvedCustomerId) throw { status: 400, message: 'customerId or customer info is required' };

    let amount = 0;
    const orderItems = [];
    const stockLogEntries = []; // collected here, written after the order gets a real ID below
    for (const item of items) {
      const prodResult = await client.query(
        'SELECT * FROM products WHERE id = $1 AND business_id = $2 FOR UPDATE',
        [item.productId, req.businessId]
      );
      const product = prodResult.rows[0];
      if (!product) throw { status: 400, message: `Unknown productId ${item.productId}` };
      if (product.quantity < item.qty) throw { status: 400, message: `Not enough stock for ${product.name}` };

      await client.query('UPDATE products SET quantity = quantity - $1 WHERE id = $2', [item.qty, product.id]);
      amount += Number(product.price) * item.qty;
      orderItems.push({ productId: product.id, name: product.name, qty: item.qty });
      stockLogEntries.push({
        productId: product.id, productName: product.name,
        quantityChange: -item.qty, quantityBefore: product.quantity, quantityAfter: product.quantity - item.qty,
      });
    }

    const orderResult = await client.query(
      `INSERT INTO orders (business_id, customer_id, items, amount, payment_status, status, delivery)
       VALUES ($1, $2, $3, $4, 'Awaiting', 'New', $5) RETURNING *`,
      [req.businessId, resolvedCustomerId, JSON.stringify(orderItems), amount, delivery || null]
    );
    const newOrderId = orderResult.rows[0].id;

    for (const entry of stockLogEntries) {
      await logInventoryChange(client, {
        businessId: req.businessId, productId: entry.productId, productName: entry.productName,
        changeType: 'Sale', quantityChange: entry.quantityChange,
        quantityBefore: entry.quantityBefore, quantityAfter: entry.quantityAfter,
        note: `Order BF-${String(newOrderId).padStart(4, '0')}`,
      });
    }

    const custResult = await client.query('SELECT name FROM customers WHERE id = $1', [resolvedCustomerId]);
    await client.query('COMMIT');
    res.status(201).json(formatOrder(orderResult.rows[0], custResult.rows[0]?.name));
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.status || 500;
    console.error('Order creation error:', err);
    res.status(status).json({ error: err.message || 'Could not create order' });
  } finally {
    client.release();
  }
});

router.patch('/:idOrCode', async (req, res) => {
  const id = req.params.idOrCode.replace(/^BF-0*/, '');
  const fieldMap = { status: 'status', paymentStatus: 'payment_status', delivery: 'delivery' };
  const updates = Object.keys(fieldMap).filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  // Fetch the CURRENT status before updating, so we only email when it
  // actually changes — not every time the edit form is saved.
  const before = await pool.query('SELECT status FROM orders WHERE id = $1 AND business_id = $2', [id, req.businessId]);
  const previousStatus = before.rows[0]?.status;

  const setClause = updates.map((f, i) => `${fieldMap[f]} = $${i + 1}`).join(', ');
  const values = updates.map(f => req.body[f]);
  const { rows } = await pool.query(
    `UPDATE orders SET ${setClause} WHERE id = $${updates.length + 1} AND business_id = $${updates.length + 2} RETURNING *`,
    [...values, id, req.businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
  const cust = await pool.query('SELECT name, email FROM customers WHERE id = $1', [rows[0].customer_id]);

  if (req.body.status !== undefined && req.body.status !== previousStatus && cust.rows[0]?.email) {
    const biz = await pool.query('SELECT name FROM businesses WHERE id = $1', [req.businessId]);
    sendOrderStatusEmail({
      to: cust.rows[0].email, storeName: biz.rows[0]?.name,
      orderId: `BF-${String(rows[0].id).padStart(4, '0')}`, status: rows[0].status, amount: Number(rows[0].amount),
    }).catch(() => {});
  }

  res.json(formatOrder(rows[0], cust.rows[0]?.name));
});

router.delete('/:idOrCode', async (req, res) => {
  const id = req.params.idOrCode.replace(/^BF-0*/, '');
  const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1 AND business_id = $2', [id, req.businessId]);
  if (!rowCount) return res.status(404).json({ error: 'Order not found' });
  res.status(204).send();
});

// POST /import — bulk-create orders from a parsed CSV. Each CSV row = one
// order with ONE product (the common case for small-business exports).
// Customer is matched by phone number if it already exists, otherwise a
// new customer is created. Product is matched by exact name (case-
// insensitive) within this business. Each row runs in its own short
// transaction so stock decrements stay atomic per-row, and one bad row
// doesn't abort the rest of the file.
router.post('/import', async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array is required' });

  let created = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!r.customerName || !r.customerPhone) throw new Error('customerName and customerPhone are required');
      if (!r.productName) throw new Error('productName is required');
      const qty = Number(r.quantity) || 1;

      let custResult = await client.query('SELECT id FROM customers WHERE business_id = $1 AND phone = $2', [req.businessId, r.customerPhone]);
      let customerId;
      if (custResult.rows.length) {
        customerId = custResult.rows[0].id;
      } else {
        const newCust = await client.query(
          `INSERT INTO customers (business_id, name, phone, location, tag) VALUES ($1, $2, $3, $4, 'New') RETURNING id`,
          [req.businessId, r.customerName, r.customerPhone, r.location || 'Unknown']
        );
        customerId = newCust.rows[0].id;
      }

      const prodResult = await client.query(
        `SELECT * FROM products WHERE business_id = $1 AND LOWER(name) = LOWER($2) FOR UPDATE`,
        [req.businessId, r.productName]
      );
      const product = prodResult.rows[0];
      if (!product) throw new Error(`Product "${r.productName}" not found`);
      if (product.quantity < qty) throw new Error(`Not enough stock for ${product.name} (have ${product.quantity}, need ${qty})`);

      await client.query('UPDATE products SET quantity = quantity - $1 WHERE id = $2', [qty, product.id]);
      const amount = Number(product.price) * qty;
      const items = JSON.stringify([{ productId: product.id, name: product.name, qty }]);

      const orderInsert = await client.query(
        `INSERT INTO orders (business_id, customer_id, items, amount, payment_status, status, delivery)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.businessId, customerId, items, amount, r.paymentStatus || 'Awaiting', r.status || 'New', r.delivery || null]
      );

      await logInventoryChange(client, {
        businessId: req.businessId, productId: product.id, productName: product.name,
        changeType: 'Sale', quantityChange: -qty, quantityBefore: product.quantity, quantityAfter: product.quantity - qty,
        note: `Order BF-${String(orderInsert.rows[0].id).padStart(4, '0')} (CSV import)`,
      });

      await client.query('COMMIT');
      created++;
    } catch (err) {
      await client.query('ROLLBACK');
      errors.push({ row: i + 1, customer: r.customerName || '(no name)', error: err.message });
    } finally {
      client.release();
    }
  }

  res.json({ created, errors });
});

module.exports = router;
