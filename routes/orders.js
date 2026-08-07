// routes/orders.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

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
  res.json(formatOrder(rows[0], rows[0].customer_name));
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
    }

    const orderResult = await client.query(
      `INSERT INTO orders (business_id, customer_id, items, amount, payment_status, status, delivery)
       VALUES ($1, $2, $3, $4, 'Awaiting', 'New', $5) RETURNING *`,
      [req.businessId, resolvedCustomerId, JSON.stringify(orderItems), amount, delivery || null]
    );

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

  const setClause = updates.map((f, i) => `${fieldMap[f]} = $${i + 1}`).join(', ');
  const values = updates.map(f => req.body[f]);
  const { rows } = await pool.query(
    `UPDATE orders SET ${setClause} WHERE id = $${updates.length + 1} AND business_id = $${updates.length + 2} RETURNING *`,
    [...values, id, req.businessId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
  const cust = await pool.query('SELECT name FROM customers WHERE id = $1', [rows[0].customer_id]);
  res.json(formatOrder(rows[0], cust.rows[0]?.name));
});

router.delete('/:idOrCode', async (req, res) => {
  const id = req.params.idOrCode.replace(/^BF-0*/, '');
  const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1 AND business_id = $2', [id, req.businessId]);
  if (!rowCount) return res.status(404).json({ error: 'Order not found' });
  res.status(204).send();
});

module.exports = router;
