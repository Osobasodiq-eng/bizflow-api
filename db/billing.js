// db/billing.js — merchants paying Kooza.
//   • which plan a business is effectively on right now (trial / paid / lapsed)      → effective()
//   • guards other routes use to lock paid features and enforce limits               → requireFeature(), limitGuard()
//   • Paystack: first payment (checkout + verify), then automatic renewals            → startCheckout(), verifyAndActivate(), startBilling()
// Nothing here ever deletes a merchant's data: when a plan lapses, paid FEATURES lock; the store, products and orders stay.

const crypto = require('crypto');
const pool = require('./pool');
const { PLANS, ORDER, TRIAL_DAYS, GRACE_DAYS, FEATURE_LABELS, planWithFeature } = require('./plans');
const { notify } = require('./notifications');

const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://bizflow-dashboard.onrender.com').replace(/\/+$/, '');
const paid = key => key === 'growth' || key === 'pro';
const INTERVALS = ['monthly', 'yearly'];

async function paystack(path, options = {}) {
  if (!process.env.PAYSTACK_SECRET_KEY) throw { status: 503, message: 'Online billing isn\'t set up yet (PAYSTACK_SECRET_KEY is missing on the server).' };
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) throw { status: 502, message: data.message || 'Paystack request failed' };
  return data;
}

// ---------- reading a business's subscription ----------
async function getSub(businessId) {
  let { rows: [s] } = await pool.query('SELECT * FROM subscriptions WHERE business_id = $1', [businessId]);
  if (!s) {
    // First time we see this business (new signup, or one that existed before billing did): start the free trial.
    const days = TRIAL_DAYS > 0 ? TRIAL_DAYS : 0;
    await pool.query(
      `INSERT INTO subscriptions (business_id, plan, status, trial_ends_at) VALUES ($1, 'free', $2, now() + ($3 || ' days')::interval) ON CONFLICT (business_id) DO NOTHING`,
      [businessId, days > 0 ? 'trialing' : 'free', String(days)]
    );
    ({ rows: [s] } = await pool.query('SELECT * FROM subscriptions WHERE business_id = $1', [businessId]));
  }
  return s;
}

// Works out what a subscription row means RIGHT NOW. Pure function — easy to test, no cron needed for access to change on time.
function resolve(s, now = Date.now()) {
  const t = v => (v ? new Date(v).getTime() : 0);
  if (s.status === 'trialing') {
    return t(s.trial_ends_at) > now ? { plan: 'pro', state: 'trial' } : { plan: 'free', state: 'trial_ended' };
  }
  if (s.status === 'active' || s.status === 'past_due') {
    const end = t(s.current_period_end);
    // While a renewal is being retried the plan stays on for the grace period; a cancelled plan ends exactly at period end.
    const keepUntil = end + (s.cancel_at_period_end ? 0 : GRACE_DAYS * 86400000);
    if (now <= end) return { plan: s.plan, state: s.cancel_at_period_end ? 'canceling' : 'active' };
    if (now <= keepUntil) return { plan: s.plan, state: 'past_due' };
    return { plan: 'free', state: 'expired' };
  }
  return { plan: 'free', state: 'free' };
}

const cache = new Map(); // businessId -> { at, value } — keeps feature checks off the database for 20 seconds
async function effective(businessId) {
  const hit = cache.get(businessId);
  if (hit && Date.now() - hit.at < 20000) return hit.value;
  const sub = await getSub(businessId);
  const r = resolve(sub);
  const value = { ...r, planDef: PLANS[r.plan], sub };
  cache.set(businessId, { at: Date.now(), value });
  return value;
}
const invalidate = businessId => cache.delete(businessId);

async function hasFeature(businessId, feature) { return !!(await effective(businessId)).planDef.features[feature]; }

// Express middleware: answers 402 so the dashboard can show an upgrade card instead of an error.
function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      if (await hasFeature(req.businessId, feature)) return next();
      const need = planWithFeature(feature);
      res.status(402).json({ error: `${FEATURE_LABELS[feature] || feature} is available on the ${PLANS[need].name} plan. Upgrade to unlock it.`, code: 'plan_required', feature, requiredPlan: need });
    } catch (e) { next(e); }
  };
}

// ---------- usage + limits ----------
async function usage(businessId) {
  const [p, e1, e2] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM products WHERE business_id = $1', [businessId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
                WHERE c.business_id = $1 AND r.status IN ('sent','pending') AND COALESCE(r.sent_at, now()) >= date_trunc('month', now())`, [businessId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM automation_sends WHERE business_id = $1 AND status IN ('sent','pending') AND COALESCE(sent_at, created_at) >= date_trunc('month', now())`, [businessId]),
  ]);
  return { products: p.rows[0].n, emails: e1.rows[0].n + e2.rows[0].n };
}

// Returns true when `adding` more of `key` still fits the plan. Otherwise it answers 402 itself and returns false.
async function limitGuard(req, res, key, adding = 1) {
  const eff = await effective(req.businessId);
  const limit = eff.planDef.limits[key];
  if (limit === null || limit === undefined) return true;
  const used = (await usage(req.businessId))[key];
  if (used + adding <= limit) return true;
  const next = ORDER.find(k => ORDER.indexOf(k) > ORDER.indexOf(eff.plan) && (PLANS[k].limits[key] === null || PLANS[k].limits[key] >= used + adding)) || 'pro';
  res.status(402).json({ error: `Your ${eff.planDef.name} plan allows ${limit.toLocaleString()} ${key}. Upgrade to ${PLANS[next].name} to add more.`, code: 'limit_reached', limit: key, requiredPlan: next });
  return false;
}

// Used by the campaign engine (no req/res there): throws a message the merchant sees.
async function assertEmailRoom(businessId, adding) {
  const eff = await effective(businessId);
  if (!eff.planDef.features.marketing) throw { status: 402, code: 'plan_required', feature: 'marketing', requiredPlan: 'growth', message: 'Email campaigns are on the Growth plan. Upgrade to send.' };
  const limit = eff.planDef.limits.emails;
  if (limit === null) return;
  const used = (await usage(businessId)).emails;
  if (used + adding > limit) throw { status: 402, code: 'limit_reached', limit: 'emails', message: `This would pass your plan's ${limit.toLocaleString()} emails a month (you've used ${used.toLocaleString()}). Upgrade, or send to a smaller segment.` };
}

// ---------- the merchant-facing summary ----------
async function summary(businessId) {
  const eff = await effective(businessId);
  const s = eff.sub;
  const [u, pay] = await Promise.all([
    usage(businessId),
    pool.query('SELECT plan, billing_interval, amount, reference, method, note, created_at FROM subscription_payments WHERE business_id = $1 ORDER BY created_at DESC LIMIT 12', [businessId]),
  ]);
  const days = d => (d ? Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400000)) : null);
  return {
    plans: ORDER.map(k => ({ key: k, name: PLANS[k].name, tagline: PLANS[k].tagline, price: PLANS[k].price, limits: PLANS[k].limits, features: PLANS[k].features, highlights: PLANS[k].highlights })),
    current: {
      plan: eff.plan, planName: eff.planDef.name, state: eff.state, paidPlan: s.plan, interval: s.billing_interval,
      trialEndsAt: s.status === 'trialing' ? s.trial_ends_at : null, trialDaysLeft: s.status === 'trialing' ? days(s.trial_ends_at) : null,
      periodEnd: s.current_period_end, cancelAtPeriodEnd: s.cancel_at_period_end, failedAttempts: s.failed_attempts,
      card: s.card_last4 ? { brand: s.card_brand, last4: s.card_last4, exp: s.card_exp } : null,
      autoRenew: !!s.authorization_code && !s.cancel_at_period_end && (s.status === 'active' || s.status === 'past_due'),
      limits: eff.planDef.limits, features: eff.planDef.features,
    },
    usage: u,
    payments: pay.rows.map(p => ({ plan: p.plan, interval: p.billing_interval, amount: Number(p.amount), reference: p.reference, method: p.method, note: p.note, at: p.created_at })),
    trialDays: TRIAL_DAYS,
  };
}

// ---------- paying ----------
const reference = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

async function startCheckout(businessId, email, planKey, interval) {
  if (!paid(planKey)) throw { status: 400, message: 'Choose Growth or Pro.' };
  if (!INTERVALS.includes(interval)) interval = 'monthly';
  const amount = PLANS[planKey].price[interval];
  const ref = reference(`SUB-${businessId}`);
  const data = await paystack('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email, amount: amount * 100, reference: ref, currency: 'NGN',
      callback_url: `${DASHBOARD_URL}/?billing=1`,
      channels: ['card'],                      // a saved card is what lets renewals happen automatically
      metadata: { kind: 'subscription', businessId, plan: planKey, interval, custom_fields: [{ display_name: 'Kooza plan', variable_name: 'plan', value: `${PLANS[planKey].name} (${interval})` }] },
    }),
  });
  return { url: data.data.authorization_url, reference: ref };
}

async function activate({ businessId, plan, interval, reference: ref, amount, authorization, renewal = false, method = 'card', note = null, keepAuto = true }) {
  const { rows } = await pool.query(
    `INSERT INTO subscription_payments (business_id, plan, billing_interval, amount, reference, method, note) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (reference) DO NOTHING RETURNING id`, [businessId, plan, interval, amount, ref, method, note]);
  if (!rows.length) return false;                  // already processed (the redirect and the webhook both arrive — only the first counts)
  await getSub(businessId);
  const a = authorization && authorization.reusable ? authorization : null;
  await pool.query(
    `UPDATE subscriptions SET plan = $2, status = 'active', billing_interval = $3,
       current_period_end = ${renewal ? 'GREATEST(COALESCE(current_period_end, now()), now())' : 'now()'} + (CASE WHEN $3::text = 'yearly' THEN interval '1 year' ELSE interval '1 month' END),
       cancel_at_period_end = $4, failed_attempts = 0, next_charge_at = NULL,
       authorization_code = COALESCE($5, authorization_code), card_brand = COALESCE($6, card_brand), card_last4 = COALESCE($7, card_last4), card_exp = COALESCE($8, card_exp),
       updated_at = now()
     WHERE business_id = $1`,
    [businessId, plan, interval, !keepAuto, a && a.authorization_code, a && a.brand, a && a.last4, a && a.exp_month ? `${a.exp_month}/${a.exp_year}` : null]
  );
  invalidate(businessId);
  return true;
}

// Called from the redirect back to the dashboard AND from Paystack's webhook. Safe to call twice.
async function verifyAndActivate(ref, expectedBusinessId) {
  const { data } = await paystack(`/transaction/verify/${encodeURIComponent(ref)}`);
  const m = data.metadata || {};
  if (m.kind !== 'subscription') throw { status: 400, message: 'That payment is not a subscription payment.' };
  if (expectedBusinessId && Number(m.businessId) !== Number(expectedBusinessId)) throw { status: 403, message: 'That payment belongs to another account.' };
  if (data.status !== 'success') throw { status: 402, message: 'The payment was not completed.' };
  if (!paid(m.plan) || !INTERVALS.includes(m.interval)) throw { status: 400, message: 'Unknown plan on this payment.' };
  const expected = PLANS[m.plan].price[m.interval] * 100;
  if (data.amount !== expected) { console.error(`Subscription amount mismatch on ${ref}: paid ${data.amount}, expected ${expected}`); throw { status: 400, message: 'The amount paid does not match the plan price.' }; }
  const first = await activate({ businessId: Number(m.businessId), plan: m.plan, interval: m.interval, reference: ref, amount: expected / 100, authorization: data.authorization, renewal: !!m.renewal });
  if (first) notify(Number(m.businessId), { type: 'billing', link: 'billing', title: `You're on the ${PLANS[m.plan].name} plan`, body: `Payment of ₦${(expected / 100).toLocaleString()} received. Thank you!` });
  return { businessId: Number(m.businessId), plan: m.plan, firstTime: first };
}

async function cancel(businessId) {
  const s = await getSub(businessId);
  if (s.status === 'trialing') await pool.query(`UPDATE subscriptions SET trial_ends_at = now(), updated_at = now() WHERE business_id = $1`, [businessId]);
  else await pool.query(`UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE business_id = $1 AND status IN ('active','past_due')`, [businessId]);
  invalidate(businessId);
}
async function resume(businessId) {
  await pool.query(`UPDATE subscriptions SET cancel_at_period_end = false, updated_at = now() WHERE business_id = $1 AND status IN ('active','past_due') AND authorization_code IS NOT NULL`, [businessId]);
  invalidate(businessId);
}

// Platform admin: give someone a plan by hand (bank transfer, partner, goodwill). Never auto-renews.
async function adminSetPlan(businessId, planKey, days) {
  await getSub(businessId);
  if (planKey === 'free') {
    await pool.query(`UPDATE subscriptions SET plan = 'free', status = 'free', cancel_at_period_end = false, updated_at = now() WHERE business_id = $1`, [businessId]);
  } else {
    if (!PLANS[planKey]) throw { status: 400, message: 'Unknown plan' };
    const d = Math.min(Math.max(Number(days) || 30, 1), 3650);
    await pool.query(
      `INSERT INTO subscription_payments (business_id, plan, billing_interval, amount, reference, method, note) VALUES ($1,$2,'monthly',0,$3,'manual',$4)`,
      [businessId, planKey, reference(`ADMIN-${businessId}`), `Set by admin for ${d} days`]);
    await pool.query(
      `UPDATE subscriptions SET plan = $2, status = 'active', current_period_end = now() + ($3 || ' days')::interval, cancel_at_period_end = true,
         failed_attempts = 0, next_charge_at = NULL, updated_at = now() WHERE business_id = $1`, [businessId, planKey, String(d)]);
  }
  invalidate(businessId);
}

// ---------- automatic renewals ----------
async function owner(businessId) {
  const { rows } = await pool.query('SELECT email FROM users WHERE business_id = $1 ORDER BY id LIMIT 1', [businessId]);
  return rows[0] && rows[0].email;
}

async function renewOne(s) {
  const email = await owner(s.business_id);
  const amount = PLANS[s.plan].price[s.billing_interval];
  const ref = reference(`SUB-${s.business_id}-R`);
  try {
    if (!email) throw new Error('no owner email');
    const { data } = await paystack('/transaction/charge_authorization', {
      method: 'POST',
      body: JSON.stringify({ email, amount: amount * 100, authorization_code: s.authorization_code, reference: ref, currency: 'NGN',
        metadata: { kind: 'subscription', businessId: s.business_id, plan: s.plan, interval: s.billing_interval, renewal: true } }),
    });
    if (data.status !== 'success' || data.amount !== amount * 100) throw new Error(data.gateway_response || data.status || 'declined');
    await activate({ businessId: s.business_id, plan: s.plan, interval: s.billing_interval, reference: ref, amount, authorization: data.authorization, renewal: true });
    notify(s.business_id, { type: 'billing', link: 'billing', title: `${PLANS[s.plan].name} plan renewed`, body: `₦${amount.toLocaleString()} was charged to your saved card.` });
  } catch (err) {
    const failed = s.failed_attempts + 1;
    await pool.query(
      `UPDATE subscriptions SET status = 'past_due', failed_attempts = $2, next_charge_at = $3, updated_at = now() WHERE business_id = $1`,
      [s.business_id, failed, failed < 3 ? new Date(Date.now() + 86400000) : null]);
    invalidate(s.business_id);
    console.error(`Renewal failed for business ${s.business_id}:`, err.message || err);
    notify(s.business_id, {
      type: 'billing', link: 'billing', dedupeKey: 'billing-failed',
      title: `We couldn't renew your ${PLANS[s.plan].name} plan`,
      body: failed < 3 ? 'Your card was declined. We\'ll try again tomorrow — or update your card now to keep your features.' : `Please update your card. Paid features lock in ${GRACE_DAYS} days if the payment doesn't go through.`,
    });
  }
}

let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    // 1) renewals that are due
    if (process.env.PAYSTACK_SECRET_KEY) {
      const { rows: due } = await pool.query(
        `SELECT * FROM subscriptions WHERE status IN ('active','past_due') AND cancel_at_period_end = false AND authorization_code IS NOT NULL
           AND current_period_end <= now() AND failed_attempts < 3 AND (next_charge_at IS NULL OR next_charge_at <= now()) LIMIT 25`);
      for (const s of due) await renewOne(s);
    }
    // 2) plans that have fully ended → Starter (data stays, paid features lock)
    const { rows: ended } = await pool.query(
      `UPDATE subscriptions SET plan = 'free', status = 'free', cancel_at_period_end = false, updated_at = now()
       WHERE status IN ('active','past_due') AND current_period_end + (CASE WHEN cancel_at_period_end THEN interval '0' ELSE ($1 || ' days')::interval END) < now() RETURNING business_id`, [String(GRACE_DAYS)]);
    for (const e of ended) { invalidate(e.business_id); notify(e.business_id, { type: 'billing', link: 'billing', title: 'Your plan has ended', body: 'You\'re back on Starter. Your data is safe — choose a plan any time to unlock Marketing and the Inbox again.' }); }
    // 3) trial about to end / just ended
    const { rows: soon } = await pool.query(
      `UPDATE subscriptions SET trial_reminded = true WHERE status = 'trialing' AND trial_reminded = false AND trial_ends_at <= now() + interval '3 days' RETURNING business_id, trial_ends_at`);
    for (const t of soon) {
      const left = Math.max(0, Math.ceil((new Date(t.trial_ends_at) - Date.now()) / 86400000));
      notify(t.business_id, { type: 'billing', link: 'billing', title: left > 0 ? `Your Pro trial ends in ${left} day${left === 1 ? '' : 's'}` : 'Your Pro trial has ended', body: 'Pick a plan to keep Marketing, the Inbox and Automations.' });
    }
    const { rows: over } = await pool.query(`UPDATE subscriptions SET status = 'free', updated_at = now() WHERE status = 'trialing' AND trial_ends_at < now() RETURNING business_id`);
    over.forEach(o => invalidate(o.business_id));
  } catch (err) { console.error('Billing scheduler error:', err.message); }
  finally { ticking = false; }
}
function startBilling() { setTimeout(tick, 20000); setInterval(tick, 30 * 60 * 1000); }

module.exports = { getSub, resolve, effective, invalidate, hasFeature, requireFeature, usage, limitGuard, assertEmailRoom, summary, startCheckout, verifyAndActivate, cancel, resume, adminSetPlan, startBilling, tick };
