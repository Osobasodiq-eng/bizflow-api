// server.js
// This file just wires everything together. Each panel in your dashboard
// gets its own "router" mounted at a base path — this keeps the code
// organized the same way your UI is organized.

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

// Mount each resource's routes at its base path.
// e.g. router.get('/summary') inside routes/dashboard.js becomes
// GET /api/dashboard/summary once mounted here.
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/products', require('./routes/inventory'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/whatsapp', require('./routes/whatsapp'));

app.get('/', (req, res) => {
  res.json({ status: 'BizFlow API running', endpoints: '/api/dashboard, /api/orders, /api/customers, /api/products, /api/payments' });
});

app.listen(PORT, () => {
  console.log(`BizFlow API running at http://localhost:${PORT}`);
});
