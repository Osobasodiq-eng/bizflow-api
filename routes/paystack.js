// routes/paystack.js
//
// Lets a logged-in merchant connect their bank account so Paystack can pay
// them directly for storefront sales (the "subaccount" side of split
// payments). Nothing here needs the merchant to have their own Paystack
// account — only BizFlow's own PAYSTACK_SECRET_KEY (set in Render's
// environment, never in code) talks to Paystack directly.
//
// Flow a merchant actually goes through:
//   1. GET /banks           -> populate a bank dropdown
//   2. POST /verify-account -> confirm the account number + bank match a
//                               real account name, BEFORE saving anything
//   3. POST /subaccount     -> actually create the Paystack subaccount and
//                               save it against this business

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const PLATFORM_FEE_PERCENT = 1.5; // BizFlow's cut of every transaction

// Small in-memory cache — the bank list barely ever changes, no reason to
// hit Paystack on every single page load of the dashboard.
let banksCache = null;
let banksCacheAt = 0;
const BANKS_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours

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

router.get('/banks', async (req, res) => {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ error: 'Payments are not configured on the server yet.' });
  }
  try {
    if (banksCache && Date.now() - banksCacheAt < BANKS_CACHE_MS) {
      return res.json(banksCache);
    }
    const data = await paystackFetch('/bank?country=nigeria&currency=NGN');
    banksCache = data.data.map(b => ({ name: b.name, code: b.code }));
    banksCacheAt = Date.now();
    res.json(banksCache);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/verify-account', async (req, res) => {
  const { account_number, bank_code } = req.body;
  if (!account_number || !bank_code) {
    return res.status(400).json({ error: 'account_number and bank_code are required' });
  }
  try {
    const data = await paystackFetch(`/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`);
    res.json({ accountName: data.data.account_name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/subaccount', async (req, res) => {
  const { bank_code, bank_name, account_number, account_name, business_name } = req.body;
  if (!bank_code || !bank_name || !account_number || !account_name) {
    return res.status(400).json({ error: 'bank_code, bank_name, account_number, and account_name are all required' });
  }

  try {
    const data = await paystackFetch('/subaccount', {
      method: 'POST',
      body: JSON.stringify({
        business_name: business_name || 'BizFlow merchant',
        settlement_bank: bank_code,
        account_number,
        percentage_charge: PLATFORM_FEE_PERCENT,
      }),
    });

    const subaccountCode = data.data.subaccount_code;
    const { rows } = await pool.query(
      `UPDATE businesses SET
         paystack_subaccount_code = $1, paystack_bank_code = $2, paystack_bank_name = $3,
         paystack_account_number = $4, paystack_account_name = $5
       WHERE id = $6
       RETURNING paystack_subaccount_code, paystack_bank_name, paystack_account_number, paystack_account_name`,
      [subaccountCode, bank_code, bank_name, account_number, account_name, req.businessId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/subaccount', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT paystack_subaccount_code, paystack_bank_name, paystack_account_number, paystack_account_name FROM businesses WHERE id = $1',
    [req.businessId]
  );
  res.json(rows[0] || {});
});

module.exports = router;
