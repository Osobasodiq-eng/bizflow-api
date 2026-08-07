// server.js
const express = require('express');
const cors = require('cors');
const { router: authRouter, requireAuth } = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Auth routes are PUBLIC — you need to sign up / log in before you have a token
app.use('/api/auth', authRouter);

// Everything below this line requires a valid "Authorization: Bearer <token>"
// header. requireAuth reads the token and sets req.businessId, which every
// route file then uses to filter its SQL queries.
app.use('/api/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/api/orders', requireAuth, require('./routes/orders'));
app.use('/api/customers', requireAuth, require('./routes/customers'));
app.use('/api/products', requireAuth, require('./routes/inventory'));
app.use('/api/payments', requireAuth, require('./routes/payments'));

app.get('/', (req, res) => {
  res.json({ status: 'BizFlow API (multi-business) running' });
});

app.listen(PORT, () => {
  console.log(`BizFlow API running at http://localhost:${PORT}`);
});
