// server.js
const express = require('express');
const cors = require('cors');
const { router: authRouter, requireAuth, requireAdmin } = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Auth routes are PUBLIC — you need to sign up / log in before you have a token
app.use('/api/auth', authRouter);

// Storefront routes are also PUBLIC — a buyer browsing a merchant's store
// has no BizFlow login. Scoped by :businessId in the URL instead of a JWT;
// see routes/public.js for how that stays safe.
app.use('/api/public', require('./routes/public'));

// Everything below this line requires a valid "Authorization: Bearer <token>"
// header. requireAuth reads the token and sets req.businessId, which every
// route file then uses to filter its SQL queries.
app.use('/api/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/api/orders', requireAuth, require('./routes/orders'));
app.use('/api/customers', requireAuth, require('./routes/customers'));
app.use('/api/products', requireAuth, require('./routes/inventory'));
app.use('/api/imagekit', requireAuth, require('./routes/imagekit'));
app.use('/api/business', requireAuth, require('./routes/business'));
app.use('/api/delivery-zones', requireAuth, require('./routes/delivery-zones'));
app.use('/api/paystack', requireAuth, require('./routes/paystack'));
app.use('/api/payments', requireAuth, require('./routes/payments'));
app.use('/api/expenses', requireAuth, require('./routes/expenses'));

// Admin routes require BOTH a valid login AND being listed in ADMIN_EMAILS —
// this is the one part of the API that can see across all businesses.
app.use('/api/admin', requireAuth, requireAdmin, require('./routes/admin'));

app.get('/', (req, res) => {
  res.json({ status: 'BizFlow API (multi-business) running' });
});

app.listen(PORT, () => {
  console.log(`BizFlow API running at http://localhost:${PORT}`);
});
