// db/planstore.js — plans and features the admin edits in the panel.
// db/plans.js holds the built-in defaults; whatever is saved in plan_settings / feature_settings is laid on top of them
// IN PLACE (the same PLANS / ORDER objects the rest of the API already reads), so billing, pricing and gates all follow.
const pool = require('./pool');
const P = require('./plans');
const { PLANS, ORDER, FEATURES } = P;

const clone = o => JSON.parse(JSON.stringify(o));
const DEFAULTS = clone(PLANS), BUILTIN = ORDER.slice();
let cats = {}, settings = {};                       // category overrides, saved plan rows
const KEYS = FEATURES.filter(f => f.enforced).map(f => f.key);

const catOf = f => (cats[f.key] === 'free' || cats[f.key] === 'paid') ? cats[f.key] : f.category;
const num = v => (v === null || v === '' || v === undefined) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

function applyAll() {
  // built-in plans: reset to the defaults, then apply any saved changes
  for (const k of BUILTIN) {
    const d = clone(DEFAULTS[k]), tgt = PLANS[k], sv = (settings[k] && settings[k].data) || {};
    Object.assign(tgt.price, d.price, sv.price || {}); Object.assign(tgt.limits, d.limits, sv.limits || {});
    Object.assign(tgt.features, d.features, sv.features || {});
    tgt.name = sv.name || d.name; tgt.tagline = sv.tagline != null ? sv.tagline : d.tagline;
    tgt.highlights = Array.isArray(sv.highlights) ? sv.highlights : d.highlights; tgt.active = k === 'free' ? true : sv.active !== false;
  }
  // custom plans
  for (const [k, row] of Object.entries(settings)) {
    if (!row.custom) continue; const sv = row.data || {};
    const t = PLANS[k] || (PLANS[k] = { key: k, price: {}, limits: {}, features: {}, highlights: [] });
    Object.assign(t, { key: k, custom: true, name: sv.name || k, tagline: sv.tagline || '', highlights: sv.highlights || [], active: sv.active !== false });
    t.price.monthly = Number(sv.price && sv.price.monthly) || 0; t.price.yearly = Number(sv.price && sv.price.yearly) || 0;
    t.limits.products = sv.limits ? num(sv.limits.products) : null; t.limits.emails = sv.limits ? (num(sv.limits.emails) || 0) : 0;
    for (const x of Object.keys(t.features)) delete t.features[x]; Object.assign(t.features, sv.features || {});
  }
  for (const k of Object.keys(PLANS)) if (!BUILTIN.includes(k) && !(settings[k] && settings[k].custom)) delete PLANS[k]; // custom plan removed elsewhere
  // features: every enforced key exists on every plan, and a "free" feature is on for every plan
  for (const plan of Object.values(PLANS)) for (const f of FEATURES.filter(x => x.enforced)) {
    if (plan.features[f.key] === undefined) plan.features[f.key] = false;
    if (catOf(f) === 'free') plan.features[f.key] = true;
  }
  const customKeys = Object.keys(settings).filter(k => settings[k].custom && PLANS[k]).sort((a, b) => settings[a].sort - settings[b].sort);
  ORDER.length = 0; [...BUILTIN, ...customKeys].filter(k => PLANS[k] && PLANS[k].active !== false).forEach(k => ORDER.push(k));
}

async function load() {
  try {
    const [pr, fr] = await Promise.all([pool.query('SELECT * FROM plan_settings'), pool.query('SELECT * FROM feature_settings')]);
    settings = Object.fromEntries(pr.rows.map(r => [r.plan_key, r])); cats = Object.fromEntries(fr.rows.map(r => [r.feature_key, r.category]));
  } catch (e) { /* tables not created yet: the built-in plans stay as they are */ return; }
  applyAll();
}
function start() { load(); setInterval(load, 60 * 1000).unref(); }

async function savePlan(key, data, custom, sort) {
  await pool.query(`INSERT INTO plan_settings (plan_key, data, custom, sort, updated_at) VALUES ($1,$2,$3,$4,now())
    ON CONFLICT (plan_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [key, data, !!custom, sort || 100]);
  await load();
}
async function setCategory(key, category) {
  await pool.query(`INSERT INTO feature_settings (feature_key, category, updated_at) VALUES ($1,$2,now())
    ON CONFLICT (feature_key) DO UPDATE SET category = EXCLUDED.category, updated_at = now()`, [key, category]);
  await load();
}
async function removePlan(key) { await pool.query('DELETE FROM plan_settings WHERE plan_key = $1 AND custom = true', [key]); await load(); }

// the full picture for the admin screen
function snapshot() {
  const keys = [...BUILTIN, ...Object.keys(settings).filter(k => settings[k].custom && PLANS[k]).sort((a, b) => settings[a].sort - settings[b].sort)];
  return {
    plans: keys.map(k => ({ ...clone(PLANS[k]), builtin: BUILTIN.includes(k), active: PLANS[k].active !== false })),
    features: FEATURES.map(f => ({ ...f, category: catOf(f), defaultCategory: f.category })),
  };
}
const saved = () => settings;
module.exports = { load, start, savePlan, setCategory, removePlan, snapshot, saved, BUILTIN, KEYS };
