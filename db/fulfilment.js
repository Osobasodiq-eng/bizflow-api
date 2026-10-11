// db/fulfilment.js
// The ONE place an order's status is allowed to change. Used by the new
// Fulfilment screen (routes/fulfilment.js) and by the older order edit form
// (PATCH /api/orders/:id), so both behave identically:
//   - the change is saved together with its tracking details
//   - it is written to order_status_history
//   - cancelling an order puts its stock back
//   - the buyer is emailed (if they gave an email address)

const pool = require('./pool');
const { logInventoryChange } = require('./inventoryLog');
const { sendOrderStatusEmail } = require('./email');

const STAGES = ['New', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const orderCode = id => `BF-${String(id).padStart(4, '0')}`;

// Which moves the Fulfilment screen allows. Forward only (skipping a step is
// fine, e.g. a pickup order going straight to Delivered); cancelling is only
// possible before the order ships; Delivered and Cancelled are final.
function canMove(from, to, strict) {
  if (from === 'Cancelled') return false; // stock was returned — make a new order instead
  if (!strict) return true;
  if (from === 'Delivered') return false;
  if (to === 'Cancelled') return from === 'New' || from === 'Processing';
  return STAGES.indexOf(to) > STAGES.indexOf(from);
}

function nextOptions(status) {
  return STAGES.filter(s => s !== status && canMove(status, s, true));
}

function isPickup(delivery) {
  return /^pickup/i.test(String(delivery || '').trim());
}

async function restockOrderItems(client, businessId, order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const touchedProducts = new Set();
  for (const it of items) {
    const qty = Number(it.qty) || 0;
    if (qty <= 0) continue;
    const note = `${orderCode(order.id)} cancelled`;
    if (it.variantId) {
      const v = (await client.query(
        'SELECT id, product_id, label, quantity FROM product_variants WHERE id = $1 AND business_id = $2 FOR UPDATE',
        [it.variantId, businessId]
      )).rows[0];
      if (!v) continue; // variant was deleted since — nothing to put back
      await client.query('UPDATE product_variants SET quantity = quantity + $1 WHERE id = $2', [qty, v.id]);
      touchedProducts.add(v.product_id);
      await logInventoryChange(client, {
        businessId, productId: v.product_id, productName: `${it.name} (${v.label})`, changeType: 'Restock',
        quantityChange: qty, quantityBefore: v.quantity, quantityAfter: v.quantity + qty, note,
      });
    } else {
      const p = (await client.query(
        'SELECT id, name, quantity FROM products WHERE id = $1 AND business_id = $2 FOR UPDATE',
        [it.productId, businessId]
      )).rows[0];
      if (!p) continue; // product was deleted since
      await client.query('UPDATE products SET quantity = quantity + $1 WHERE id = $2', [qty, p.id]);
      await logInventoryChange(client, {
        businessId, productId: p.id, productName: p.name, changeType: 'Restock',
        quantityChange: qty, quantityBefore: p.quantity, quantityAfter: p.quantity + qty, note,
      });
    }
  }
  for (const productId of touchedProducts) {
    await client.query(
      `UPDATE products SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM product_variants WHERE product_id = $1) WHERE id = $1`,
      [productId]
    );
  }
}

// Throws { status, message } for problems the caller should show to the user.
// Returns { order (raw row), customer ({name,email}), previousStatus, changed, email: {attempted, sent, reason} }
async function changeOrderStatus({ businessId, orderId, status, note, courier, trackingNumber, notify = true, strict = true }) {
  if (!STAGES.includes(status)) throw { status: 400, message: `status must be one of: ${STAGES.join(', ')}` };

  const client = await pool.connect();
  let order, previousStatus, historyId;
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM orders WHERE id = $1 AND business_id = $2 FOR UPDATE', [orderId, businessId]);
    order = found.rows[0];
    if (!order) throw { status: 404, message: 'Order not found' };
    previousStatus = order.status;

    const detailsGiven = courier !== undefined || trackingNumber !== undefined;
    if (status === previousStatus) {
      if (strict && !detailsGiven) throw { status: 400, message: `Order is already ${status}` };
      // Same stage but tracking details were corrected — save them, no email, no history entry.
      if (detailsGiven) {
        const upd = await client.query(
          'UPDATE orders SET courier = COALESCE($1, courier), tracking_number = COALESCE($2, tracking_number) WHERE id = $3 RETURNING *',
          [courier ?? null, trackingNumber ?? null, order.id]
        );
        order = upd.rows[0];
      }
      await client.query('COMMIT');
      const cust = (await pool.query('SELECT name, email FROM customers WHERE id = $1', [order.customer_id])).rows[0] || {};
      return { order, customer: cust, previousStatus, changed: false, email: { attempted: false } };
    }

    if (!canMove(previousStatus, status, strict)) {
      throw { status: 400, message: previousStatus === 'Cancelled'
        ? 'A cancelled order can\'t be reopened — create a new order instead.'
        : `An order that is ${previousStatus} can't be moved to ${status}.` };
    }

    if (status === 'Cancelled') await restockOrderItems(client, businessId, order);

    const upd = await client.query(
      `UPDATE orders SET status = $1::text,
         courier = COALESCE($2, courier),
         tracking_number = COALESCE($3, tracking_number),
         shipped_at = CASE WHEN $1::text = 'Shipped' THEN now() ELSE shipped_at END,
         delivered_at = CASE WHEN $1::text = 'Delivered' THEN now() ELSE delivered_at END
       WHERE id = $4 RETURNING *`,
      [status, courier ?? null, trackingNumber ?? null, order.id]
    );
    order = upd.rows[0];

    const hist = await client.query(
      `INSERT INTO order_status_history (business_id, order_id, from_status, to_status, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [businessId, order.id, previousStatus, status, note || null]
    );
    historyId = hist.rows[0].id;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Email AFTER the change is safely saved — a mail problem must never undo it.
  const cust = (await pool.query('SELECT name, email FROM customers WHERE id = $1', [order.customer_id])).rows[0] || {};
  let email = { attempted: false };
  if (notify) {
    const biz = (await pool.query('SELECT name FROM businesses WHERE id = $1', [businessId])).rows[0];
    const result = await sendOrderStatusEmail({
      to: cust.email, storeName: biz && biz.name, orderId: orderCode(order.id), status,
      amount: Number(order.amount), courier: order.courier, trackingNumber: order.tracking_number,
      note, isPickup: isPickup(order.delivery), businessId,
    });
    email = { attempted: true, sent: !!result.sent, reason: result.reason };
    if (result.sent) await pool.query('UPDATE order_status_history SET customer_notified = true WHERE id = $1', [historyId]);
  }
  return { order, customer: cust, previousStatus, changed: true, email };
}

module.exports = { STAGES, changeOrderStatus, nextOptions, isPickup, orderCode };
