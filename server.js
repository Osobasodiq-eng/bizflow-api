// server.js
const express = require('express');
const cors = require('cors');
const { router: authRouter, requireAuth, requireAdmin } = require('./routes/auth');

// ---- inlined helpers (previously middleware/safe.js, middleware/rateLimit.js, routes/paystack-webhook.js) ----
const crypto = require('crypto');
// middleware/safe.js
// Express 4 does not catch errors thrown inside async route handlers: a
// rejected promise (bad ID, DB hiccup, ...) becomes an unhandled rejection,
// which on modern Node CRASHES the whole server. safe(router) wraps every
// handler on a router so those errors go to Express's error handler instead.
// No dependency needed.

function safe(router) {
  const wrapLayers = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const l of layer.route.stack) {
          const fn = l.handle;
          if (fn.length > 3 || fn.__safe) continue; // skip error-handling middleware
          const wrapped = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
          wrapped.__safe = true;
          l.handle = wrapped;
        }
      }
    }
  };
  wrapLayers(router.stack);
  return router;
}


// middleware/rateLimit.js
// Minimal in-memory rate limiter (per IP, fixed window). Good enough for a
// single Render instance; if you ever run several instances, swap for a
// shared store (e.g. Redis) or the express-rate-limit package.

function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Periodically drop expired entries so the map can't grow forever
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + windowMs }; hits.set(req.ip, h); }
    h.count++;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests, please try again later.' });
    }
    next();
  };
}


const webhookRouter = express.Router();
webhookRouter.post('/', async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !req.rawBody) return res.sendStatus(500);

  const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
  const given = String(req.get('x-paystack-signature') || '');
  const ok = given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.sendStatus(401);

  const event = req.body || {};
  if (event.event === 'charge.success' && event.data && event.data.reference && event.data.metadata && event.data.metadata.kind === 'subscription') {
    // A merchant paying Kooza for a plan (not a shopper paying a store) — verify with Paystack, then switch the plan on.
    try { await require('./db/billing').verifyAndActivate(event.data.reference, null); }
    catch (err) { console.error(`Webhook could not activate subscription ${event.data.reference}:`, err.message || err); }
  } else if (event.event === 'charge.success' && event.data && event.data.reference) {
    try {
      const { status, body } = await require('./routes/public').fulfillPaystackReference(event.data.reference, null);
      if (status >= 400) console.error(`Webhook could not fulfil ${event.data.reference}:`, body.error);
    } catch (err) {
      console.error(`Webhook error for ${event.data.reference}:`, err.message);
    }
  }
  // Always 200 once the signature is valid, so Paystack doesn't retry forever
  // for problems (e.g. item sold out) that a retry can't fix.
  res.sendStatus(200);
});


// ---- end inlined helpers ----

const app = express();
const PORT = process.env.PORT || 4000;

// Render (and most hosts) sit behind a proxy — without this, req.ip is the
// proxy's address for every visitor and rate limiting would hit everyone at once.
app.set('trust proxy', 1);

app.use(cors());
// Keep the raw request bytes too: Paystack signs its webhook calls over the
// exact raw body, so the signature can only be checked against those bytes.
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Brute-force protection on the endpoints attackers actually hammer.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many attempts. Please wait a few minutes and try again.' });
const publicOrderLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: 'Too many requests. Please slow down.' });

// Auth routes are PUBLIC — you need to sign up / log in before you have a token
app.use('/api/auth', authLimiter, safe(authRouter));

// Storefront routes are also PUBLIC — a buyer browsing a merchant's store
// has no BizFlow login. Scoped by :businessId in the URL instead of a JWT;
// see routes/public.js for how that stays safe.
app.use('/api/public', publicOrderLimiter, safe(require('./routes/public')));

// Unsubscribe links inside marketing emails — public, signed per customer (see db/campaigns.js)
app.use('/api/unsubscribe', express.urlencoded({ extended: false }), safe(require('./routes/unsubscribe')));

// Storefront "Message us" chat — public, per-store; and Mailgun delivering customer emails (signature-checked).
app.use('/api/chat', safe(require('./routes/chat')));
app.use('/api/inbound', safe(require('./routes/inbound')));

// Paystack calls this itself (no login possible) — it is protected by
// verifying Paystack's signature instead. See routes/paystack-webhook.js.
app.use('/api/paystack-webhook', safe(webhookRouter));

// Everything below this line requires a valid "Authorization: Bearer <token>"
// header. requireAuth reads the token and sets req.businessId, which every
// route file then uses to filter its SQL queries.
app.use('/api/dashboard', requireAuth, safe(require('./routes/dashboard')));
app.use('/api/orders', requireAuth, safe(require('./routes/orders')));
app.use('/api/fulfilment', requireAuth, safe(require('./routes/fulfilment')));
app.use('/api/marketing', requireAuth, safe(require('./routes/marketing')));
app.use('/api/inbox', requireAuth, safe(require('./routes/inbox')));
app.use('/api/notifications', requireAuth, safe(require('./routes/notifications')));
app.use('/api/billing', requireAuth, safe(require('./routes/billing')));
app.use('/api/customers', requireAuth, safe(require('./routes/customers')));
app.use('/api/products', requireAuth, safe(require('./routes/inventory')));
app.use('/api/imagekit', requireAuth, safe(require('./routes/imagekit')));
app.use('/api/business', requireAuth, safe(require('./routes/business')));
app.use('/api/delivery-zones', requireAuth, safe(require('./routes/delivery-zones')));
app.use('/api/paystack', requireAuth, safe(require('./routes/paystack')));
app.use('/api/payments', requireAuth, safe(require('./routes/payments')));
app.use('/api/expenses', requireAuth, safe(require('./routes/expenses')));

// Admin routes require BOTH a valid login AND being listed in ADMIN_EMAILS —
// this is the one part of the API that can see across all businesses.
app.use('/api/admin', requireAuth, requireAdmin, safe(require('./routes/admin')));

app.get('/', (req, res) => {
  res.json({ status: 'BizFlow API (multi-business) running' });
});

// Unknown route -> JSON 404 instead of Express's HTML page
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Last-resort error handler: anything thrown/rejected in a route lands here
// instead of crashing the process. Postgres "bad input" errors (e.g. a
// non-numeric ID in the URL) are the caller's fault, so they get a 400.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.code === '22P02' || err.code === '22003') return res.status(400).json({ error: 'Invalid ID or number in request' });
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(err.status || 500).json({ error: 'Something went wrong on our side' });
});

// Belt and braces: log stray async failures instead of letting them kill the server.
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));

require('./db/campaigns').startScheduler(); // sends scheduled campaigns when they're due
require('./db/automations').startAutomations();
require('./db/billing').startBilling(); // renews plans on saved cards, ends lapsed plans, reminds about trials // sends automated emails (win-back, post-purchase) when they're due

app.listen(PORT, () => {
  console.log(`BizFlow API running at http://localhost:${PORT}`);
});
