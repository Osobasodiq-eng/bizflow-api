// routes/paystack-webhook.js
//
// Paystack calls this URL itself whenever a payment succeeds. It matters
// because the buyer's redirect back to the storefront is NOT guaranteed — if
// they pay and then close the tab, lose signal, or the page fails to load,
// the redirect never fires and (without this) they'd be charged with no order.
//
// Setup (one time): Paystack Dashboard -> Settings -> API Keys & Webhooks ->
// Webhook URL = https://<your-api-host>/api/paystack-webhook
//
// Security: anyone can POST to this URL, so every call is checked against the
// x-paystack-signature header (HMAC-SHA512 of the raw body using our secret
// key). Unsigned or wrongly signed calls are rejected.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { fulfillPaystackReference } = require('./public');

router.post('/', async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !req.rawBody) return res.sendStatus(500);

  const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
  const given = String(req.get('x-paystack-signature') || '');
  const ok = given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.sendStatus(401);

  const event = req.body || {};
  if (event.event === 'charge.success' && event.data && event.data.reference) {
    try {
      const { status, body } = await fulfillPaystackReference(event.data.reference, null);
      if (status >= 400) console.error(`Webhook could not fulfil ${event.data.reference}:`, body.error);
    } catch (err) {
      console.error(`Webhook error for ${event.data.reference}:`, err.message);
    }
  }
  // Always 200 once the signature is valid, so Paystack doesn't retry forever
  // for problems (e.g. item sold out) that a retry can't fix.
  res.sendStatus(200);
});

module.exports = router;
