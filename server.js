// server.js
const express = require('express');
const cors = require('cors');
const { router: authRouter, requireAuth, requireAdmin } = require('./routes/auth');
const safe = require('./middleware/safe');
const rateLimit = require('./middleware/rateLimit');

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

// Paystack calls this itself (no login possible) — it is protected by
// verifying Paystack's signature instead. See routes/paystack-webhook.js.
app.use('/api/paystack-webhook', safe(require('./routes/paystack-webhook')));

// Everything below this line requires a valid "Authorization: Bearer <token>"
// header. requireAuth reads the token and sets req.businessId, which every
// route file then uses to filter its SQL queries.
app.use('/api/dashboard', requireAuth, safe(require('./routes/dashboard')));
app.use('/api/orders', requireAuth, safe(require('./routes/orders')));
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

app.listen(PORT, () => {
  console.log(`BizFlow API running at http://localhost:${PORT}`);
});
