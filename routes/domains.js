// routes/domains.js — a merchant's store address.  Mounted at /api/domains (requireAuth).
//   Subdomain (kicksmith.<platform domain>) is a Growth/Pro feature; a merchant's own domain is Pro.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireFeature, hasFeature } = require('../db/billing');
const { planWithFeature, PLANS } = require('../db/plans');
const D = require('../db/domains');

async function state(businessId) {
  const [r, canSub, canCustom, cur] = await Promise.all([D.row(businessId), hasFeature(businessId, 'subdomain'), hasFeature(businessId, 'custom_domain'), D.storeBaseFor(businessId)]);
  const { rows: [b] } = await pool.query('SELECT name FROM businesses WHERE id = $1', [businessId]);
  return {
    baseDomain: D.BASE() || null,
    subdomain: r.subdomain || null,
    customDomain: r.custom_domain || null,
    customStatus: r.custom_domain ? (r.custom_domain_status || 'pending') : null,
    currentUrl: cur.base + (cur.param ? `/?${cur.param}` : '/'),
    currentKind: cur.kind,
    canSubdomain: canSub, canCustom,
    subdomainPlan: PLANS[planWithFeature('subdomain')].name, customPlan: PLANS[planWithFeature('custom_domain')].name,
    suggestion: D.slugify(b && b.name),
    dns: { cname: D.CNAME_TARGET(), a: D.A_RECORD(), auto: D.renderOn() },
  };
}

router.get('/', async (req, res) => res.json(await state(req.businessId)));

// Is this name free? (does not need a paid plan, so merchants can see what they'd get)
router.get('/check', async (req, res) => {
  const c = D.checkSub(req.query.name);
  if (!c.ok) return res.json({ available: false, value: c.value, error: c.error });
  const { rows } = await pool.query('SELECT id FROM businesses WHERE lower(subdomain) = $1 AND id <> $2', [c.value, req.businessId]);
  res.json({ available: !rows[0], value: c.value, error: rows[0] ? 'Someone already has that name.' : null, preview: D.BASE() ? `${c.value}.${D.BASE()}` : c.value });
});

router.put('/subdomain', requireFeature('subdomain'), async (req, res) => {
  const c = D.checkSub(req.body.subdomain);
  if (!c.ok) return res.status(400).json({ error: c.error });
  try {
    await pool.query('UPDATE businesses SET subdomain = $1 WHERE id = $2', [c.value, req.businessId]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Someone already has that name. Try another.' });
    if (e.code === '42703') return res.status(503).json({ error: 'Store addresses aren\'t switched on yet (the database update is pending).' });
    throw e;
  }
  res.json(await state(req.businessId));
});

router.delete('/subdomain', async (req, res) => {
  await pool.query('UPDATE businesses SET subdomain = NULL WHERE id = $1', [req.businessId]).catch(() => {});
  res.json(await state(req.businessId));
});

router.put('/custom', requireFeature('custom_domain'), async (req, res) => {
  const c = D.checkHost(req.body.domain);
  if (!c.ok) return res.status(400).json({ error: c.error });
  const { rows: taken } = await pool.query('SELECT id FROM businesses WHERE lower(custom_domain) = $1 AND id <> $2', [c.value, req.businessId]).catch(() => ({ rows: [] }));
  if (taken[0]) return res.status(409).json({ error: 'That domain is already connected to another store.' });
  const prev = await D.row(req.businessId);
  if (prev.custom_domain && prev.custom_domain !== c.value) await D.renderDetach(prev.custom_domain);
  const attach = await D.renderAttach(c.value);
  try {
    await pool.query(`UPDATE businesses SET custom_domain = $1, custom_domain_status = 'pending', custom_domain_render_id = $2 WHERE id = $3`, [c.value, attach.id, req.businessId]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That domain is already connected to another store.' });
    if (e.code === '42703') return res.status(503).json({ error: 'Custom domains aren\'t switched on yet (the database update is pending).' });
    throw e;
  }
  res.json({ ...(await state(req.businessId)), warning: attach.error ? `We saved your domain, but couldn't attach it automatically (${attach.error}). Support will finish the setup.` : null });
});

// "I've set up my DNS": check it, and mark the domain live when it points at us.
router.post('/custom/verify', async (req, res) => {
  const r = await D.row(req.businessId);
  if (!r.custom_domain) return res.status(400).json({ error: 'Add a domain first.' });
  const hit = await D.dnsPointsHere(r.custom_domain);
  if (!hit.ok) return res.json({ ...(await state(req.businessId)), verified: false, message: 'We can\'t see your DNS pointing at us yet. Changes can take a few minutes (sometimes a few hours) to spread. Try again shortly.' });
  await D.renderVerify(r.custom_domain);
  await pool.query(`UPDATE businesses SET custom_domain_status = 'verified' WHERE id = $1`, [req.businessId]);
  res.json({ ...(await state(req.businessId)), verified: true, message: 'Connected! Your secure (https) certificate can take up to 15 minutes to appear the first time.' });
});

router.delete('/custom', async (req, res) => {
  const r = await D.row(req.businessId);
  if (r.custom_domain) await D.renderDetach(r.custom_domain);
  await pool.query(`UPDATE businesses SET custom_domain = NULL, custom_domain_status = 'pending', custom_domain_render_id = NULL WHERE id = $1`, [req.businessId]).catch(() => {});
  res.json(await state(req.businessId));
});

module.exports = router;
