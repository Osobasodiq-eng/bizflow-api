// db/plans.js — the plan catalogue. THIS IS THE ONLY FILE YOU EDIT TO CHANGE PRICES, LIMITS OR WHAT EACH PLAN INCLUDES.
// Prices are in naira. `null` for a limit means unlimited.

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS === undefined ? 14 : process.env.TRIAL_DAYS); // set TRIAL_DAYS=0 on Render to switch trials off
const GRACE_DAYS = 3;                // a failed renewal keeps the plan this long while we retry the card

const PLANS = {
  free: {
    key: 'free', name: 'Starter', tagline: 'Everything you need to start selling',
    price: { monthly: 0, yearly: 0 },
    limits: { products: 15, emails: 0 },
    features: { marketing: false, automations: false, inbox: false, content: false },
    highlights: ['Online storefront & checkout', 'Up to 15 products', 'Unlimited orders & customers', 'Fulfilment with customer email updates', 'Payments & expenses tracking'],
  },
  growth: {
    key: 'growth', name: 'Growth', tagline: 'Win repeat customers',
    price: { monthly: 7500, yearly: 75000 },
    limits: { products: 200, emails: 2000 },
    features: { marketing: true, automations: false, inbox: true, content: true },
    highlights: ['Everything in Starter', 'Up to 200 products', 'Email campaigns & customer segments (2,000 emails/month)', 'Shared inbox: storefront chat & email', 'Content calendar with AI captions'],
  },
  pro: {
    key: 'pro', name: 'Pro', tagline: 'Put your marketing on autopilot',
    price: { monthly: 18000, yearly: 180000 },
    limits: { products: null, emails: 20000 },
    features: { marketing: true, automations: true, inbox: true, content: true },
    highlights: ['Everything in Growth', 'Unlimited products', 'Marketing automations (win-back, post-purchase)', '20,000 emails/month', 'Priority support'],
  },
};
const ORDER = ['free', 'growth', 'pro'];

const FEATURE_LABELS = { marketing: 'Marketing', automations: 'Automations', inbox: 'The inbox', content: 'The content calendar' };

// The cheapest plan that includes a feature (used in "upgrade to …" messages)
const planWithFeature = f => ORDER.find(k => PLANS[k].features[f]) || 'pro';

module.exports = { PLANS, ORDER, TRIAL_DAYS, GRACE_DAYS, FEATURE_LABELS, planWithFeature };
