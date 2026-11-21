// db/plans.js — the plan catalogue. THIS IS THE ONLY FILE YOU EDIT TO CHANGE PRICES, LIMITS OR WHAT EACH PLAN INCLUDES.
// Prices are in naira. `null` for a limit means unlimited.

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS === undefined ? 14 : process.env.TRIAL_DAYS); // set TRIAL_DAYS=0 on Render to switch trials off
const GRACE_DAYS = 3;                // a failed renewal keeps the plan this long while we retry the card

const PLANS = {
  free: {
    key: 'free', name: 'Starter', tagline: 'Everything you need to start selling',
    price: { monthly: 0, yearly: 0 },
    limits: { products: 15, emails: 0 },
    features: { marketing: false, discounts: false, sales: false, automations: false, inbox: false, content: false, subdomain: false, custom_domain: false },
    highlights: ['Online storefront & checkout', 'Up to 15 products', 'Unlimited orders & customers', 'Fulfilment with customer email updates', 'Payments & expenses tracking'],
  },
  growth: {
    key: 'growth', name: 'Growth', tagline: 'Win repeat customers',
    price: { monthly: 7500, yearly: 75000 },
    limits: { products: 200, emails: 2000 },
    features: { marketing: true, discounts: true, sales: true, automations: false, inbox: true, content: true, subdomain: true, custom_domain: false },
    highlights: ['Everything in Starter', 'Up to 200 products', 'Email campaigns & customer segments (2,000 emails/month)', 'Shared inbox: storefront chat & email', 'Content calendar with AI captions', 'Your own store address: yourname.kooza.store'],
  },
  pro: {
    key: 'pro', name: 'Pro', tagline: 'Put your marketing on autopilot',
    price: { monthly: 18000, yearly: 180000 },
    limits: { products: null, emails: 20000 },
    features: { marketing: true, discounts: true, sales: true, automations: true, inbox: true, content: true, subdomain: true, custom_domain: true },
    highlights: ['Everything in Growth', 'Unlimited products', 'Marketing automations (win-back, post-purchase)', '20,000 emails/month', 'Use your own domain (yourbrand.com)', 'Priority support'],
  },
};
const ORDER = ['free', 'growth', 'pro'];

// Every merchant feature. `category` is the default (admins can change it): "free" features are part of every plan,
// "paid" features are switched on or off per plan. `enforced: false` means the feature is simply always available today.
const FEATURES = [
  { key: 'storefront',     group: 'Selling',   label: 'Online storefront & checkout',            category: 'free', enforced: false },
  { key: 'orders',         group: 'Selling',   label: 'Orders & fulfilment with customer emails', category: 'free', enforced: false },
  { key: 'customers',      group: 'Selling',   label: 'Customers & order history',               category: 'free', enforced: false },
  { key: 'payments',       group: 'Selling',   label: 'Paystack payments & payouts',             category: 'free', enforced: false },
  { key: 'delivery_zones', group: 'Selling',   label: 'Delivery zones & fees',                   category: 'free', enforced: false },
  { key: 'expenses',       group: 'Running',   label: 'Expenses tracking',                       category: 'free', enforced: false },
  { key: 'analytics',      group: 'Running',   label: 'Sales analytics',                         category: 'free', enforced: false },
  { key: 'looks',          group: 'Storefront', label: 'Store designs, layouts & looks',         category: 'free', enforced: false },
  { key: 'displays',       group: 'Storefront', label: 'Product display styles',                 category: 'free', enforced: false },
  { key: 'marketing',      group: 'Marketing', label: 'Email campaigns & customer segments',     category: 'paid', enforced: true },
  { key: 'discounts',      group: 'Marketing', label: 'Discount codes',                          category: 'paid', enforced: true },
  { key: 'sales',          group: 'Marketing', label: 'Store-wide sales',                        category: 'paid', enforced: true },
  { key: 'automations',    group: 'Marketing', label: 'Marketing automations',                   category: 'paid', enforced: true },
  { key: 'content',        group: 'Marketing', label: 'Content calendar with AI captions',       category: 'paid', enforced: true },
  { key: 'inbox',          group: 'Messaging', label: 'Shared inbox (chat, email, WhatsApp, Messenger, Instagram)', category: 'paid', enforced: true },
  { key: 'subdomain',      group: 'Store address', label: 'Store address on our domain',        category: 'paid', enforced: true },
  { key: 'custom_domain',  group: 'Store address', label: 'Connect your own domain',            category: 'paid', enforced: true },
];
// What shows in "upgrade to unlock …" messages
const FEATURE_LABELS = { marketing: 'Marketing', discounts: 'Discount codes', sales: 'Store-wide sales', automations: 'Automations', inbox: 'The inbox', content: 'The content calendar', subdomain: 'A store address on our domain', custom_domain: 'Connecting your own domain' };

// The cheapest plan that includes a feature (used in "upgrade to …" messages)
const planWithFeature = f => ORDER.find(k => PLANS[k].features[f]) || 'pro';

module.exports = { PLANS, ORDER, TRIAL_DAYS, GRACE_DAYS, FEATURE_LABELS, FEATURES, planWithFeature };
