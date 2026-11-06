// db/domains.js — store addresses: a name on our domain (kicksmith.<STORE_BASE_DOMAIN>) or the merchant's own domain.
//   Env: STORE_BASE_DOMAIN        the platform domain, e.g. kooza.store (wildcard *.kooza.store must point at the storefront site)
//        STOREFRONT_URL           the plain storefront URL, used as the fallback link
//        STOREFRONT_CNAME_TARGET  where a merchant's own domain must point (default: the Render storefront host)
//        STOREFRONT_A_RECORD      the IP to use for apex domains with no CNAME (default: Render's 216.24.57.1)
//        RENDER_API_KEY + RENDER_STOREFRONT_SERVICE_ID   optional: lets us attach merchant domains to the storefront site automatically
const dns = require('dns').promises;
const pool = require('./pool');
const { hasFeature } = require('./billing');

const clean = v => String(v || '').trim().toLowerCase();
const BASE = () => clean(process.env.STORE_BASE_DOMAIN).replace(/^https?:\/\//, '').replace(/^\*?\./, '').replace(/\/.*$/, '');
const FALLBACK = () => (process.env.STOREFRONT_URL || 'https://bizflow-storefront.onrender.com').replace(/\/+$/, '');
const CNAME_TARGET = () => clean(process.env.STOREFRONT_CNAME_TARGET) || 'bizflow-storefront.onrender.com';
const A_RECORD = () => clean(process.env.STOREFRONT_A_RECORD) || '216.24.57.1';

const RESERVED = new Set(['www', 'app', 'api', 'admin', 'dashboard', 'mail', 'email', 'smtp', 'ftp', 'support', 'help', 'status', 'blog', 'store', 'shop', 'billing', 'login', 'signup', 'static', 'assets', 'cdn', 'kooza', 'bizflow', 'test', 'demo', 'staging']);

// "Kicksmith Lagos!" -> "kicksmith-lagos". Returns '' if nothing usable is left.
function slugify(raw) {
  return clean(raw).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}
// Validates a chosen subdomain. Returns { ok, value, error }.
function checkSub(raw) {
  const value = slugify(raw);
  if (value.length < 3) return { ok: false, value, error: 'Use at least 3 letters or numbers.' };
  if (RESERVED.has(value)) return { ok: false, value, error: `"${value}" is reserved. Try another name.` };
  return { ok: true, value };
}
// Validates a merchant's own domain: kicksmith.com, shop.kicksmith.com ...
function checkHost(raw) {
  const value = clean(raw).replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(value)) return { ok: false, value, error: 'That doesn\'t look like a domain. Example: kicksmith.com' };
  const base = BASE();
  if ((base && (value === base || value.endsWith('.' + base))) || /(^|\.)(onrender\.com|localhost)$/.test(value)) return { ok: false, value, error: 'Use a domain you own, not one of ours.' };
  return { ok: true, value };
}

async function row(businessId) {
  try {
    const { rows } = await pool.query('SELECT subdomain, custom_domain, custom_domain_status, custom_domain_render_id FROM businesses WHERE id = $1', [businessId]);
    return rows[0] || {};
  } catch (e) { return {}; } // columns not applied yet
}

// The address a store should be shared on right now: { base, param, kind }.
//   param is the "business=ID" query the plain storefront URL needs (blank on a domain that already identifies the store).
async function storeBaseFor(businessId) {
  const r = await row(businessId);
  try {
    if (r.custom_domain && r.custom_domain_status === 'verified' && await hasFeature(businessId, 'custom_domain')) return { base: `https://${r.custom_domain}`, param: '', kind: 'custom' };
    if (r.subdomain && BASE() && await hasFeature(businessId, 'subdomain')) return { base: `https://${r.subdomain}.${BASE()}`, param: '', kind: 'subdomain' };
  } catch (e) { /* fall through to the plain link */ }
  return { base: FALLBACK(), param: `business=${businessId}`, kind: 'default' };
}

// Which store does this hostname belong to? Returns a business id or null.
async function resolveHost(rawHost) {
  const host = clean(rawHost).replace(/:\d+$/, '');
  if (!host) return null;
  try {
    const base = BASE();
    if (base && host.endsWith('.' + base)) {
      const sub = host.slice(0, -(base.length + 1));
      if (!/^[a-z0-9-]{3,40}$/.test(sub)) return null;
      const { rows } = await pool.query('SELECT id FROM businesses WHERE lower(subdomain) = $1', [sub]);
      return rows[0] && (await hasFeature(rows[0].id, 'subdomain')) ? rows[0].id : null;
    }
    const { rows } = await pool.query('SELECT id FROM businesses WHERE lower(custom_domain) = ANY($1::text[])', [[host, host.replace(/^www\./, '')]]);
    return rows[0] && (await hasFeature(rows[0].id, 'custom_domain')) ? rows[0].id : null;
  } catch (e) { return null; }
}

// ---- DNS: is the merchant's domain pointing at our storefront? ----
async function dnsPointsHere(host) {
  const target = CNAME_TARGET();
  try { const c = (await dns.resolveCname(host)).map(clean); if (c.some(x => x.replace(/\.$/, '') === target)) return { ok: true, via: 'CNAME' }; } catch (e) { /* no CNAME */ }
  try { const a = await dns.resolve4(host); if (a.includes(A_RECORD())) return { ok: true, via: 'A' }; } catch (e) { /* no A */ }
  return { ok: false };
}

// ---- Render: attach / verify / detach the domain on the storefront static site (best effort) ----
const renderOn = () => !!(process.env.RENDER_API_KEY && process.env.RENDER_STOREFRONT_SERVICE_ID);
async function render(path, method = 'GET', body) {
  const res = await fetch(`https://api.render.com/v1/services/${process.env.RENDER_STOREFRONT_SERVICE_ID}/custom-domains${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 404) throw new Error(data.message || `Render responded ${res.status}`);
  return data;
}
async function renderAttach(host) { if (!renderOn()) return { id: null, note: 'manual' }; try { const d = await render('', 'POST', { name: host }); return { id: d.id || null }; } catch (e) { return { id: null, error: e.message }; } }
async function renderVerify(host) { if (!renderOn()) return; try { await render(`/${encodeURIComponent(host)}/verify`, 'POST'); } catch (e) { /* DNS check above is the source of truth */ } }
async function renderDetach(host) { if (!renderOn()) return; try { await render(`/${encodeURIComponent(host)}`, 'DELETE'); } catch (e) { /* already gone */ } }

module.exports = { BASE, FALLBACK, CNAME_TARGET, A_RECORD, slugify, checkSub, checkHost, row, storeBaseFor, resolveHost, dnsPointsHere, renderOn, renderAttach, renderVerify, renderDetach };
