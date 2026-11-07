// routes/meta.js — Meta integration.
//   webhook  : public. Meta calls it with customer messages (checked by signature). Mounted at /api/meta-webhook.
//   merchant : login required. Connect / disconnect WhatsApp, Messenger and Instagram. Mounted at /api/meta.
const express = require('express');
const crypto = require('crypto');
const M = require('../db/meta');
const { requireFeature } = require('../db/billing');

// ---------- webhook ----------
const webhook = express.Router();

// Meta checks the URL once, with a GET carrying your verify token.
webhook.get('/', (req, res) => {
  const { verifyToken } = M.cfg();
  if (verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  res.sendStatus(403);
});
webhook.post('/', (req, res) => {
  if (!M.validSignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // answer fast; Meta retries anything slower than a few seconds
  M.handleWebhook(req.body).catch(e => console.error('[meta] webhook failed:', e.message || e));
});

// Required for Meta app review: what happens when someone removes the app or asks us to delete their data.
const deletions = new Map(); // confirmation code -> time (informational; the data is removed straight away)
const fromMeta = express.urlencoded({ extended: false });
webhook.post('/deauthorize', fromMeta, async (req, res) => { const id = M.readSignedRequest(req.body.signed_request); if (!id) return res.sendStatus(400); await M.forgetUser(id); res.sendStatus(200); });
webhook.post('/data-deletion', fromMeta, async (req, res) => {
  const id = M.readSignedRequest(req.body.signed_request); if (!id) return res.sendStatus(400);
  await M.forgetUser(id);
  const code = crypto.randomBytes(8).toString('hex'); deletions.set(code, Date.now());
  res.json({ url: `${req.protocol}://${req.get('host')}/api/meta-webhook/deletion-status?code=${code}`, confirmation_code: code });
});
webhook.get('/deletion-status', (req, res) => res.type('text').send(deletions.has(String(req.query.code)) ? 'Your connected Meta accounts and their access tokens have been deleted from Kooza.' : 'No such request.'));

// ---------- merchant ----------
const merchant = express.Router();
const fail = (res, err) => (err && err.status) ? res.status(err.status).json({ error: err.message }) : (console.error('[meta]', err), res.status(500).json({ error: 'Something went wrong on our side' }));

merchant.get('/', async (req, res) => {
  const c = M.cfg();
  res.json({
    configured: M.configured(), appId: c.appId || null, version: c.version, scopes: M.SCOPES,
    whatsappReady: M.configured() && !!c.waConfigId, waConfigId: c.waConfigId || null,
    channels: await M.listChannels(req.businessId),
  });
});

merchant.post('/whatsapp/connect', requireFeature('inbox'), async (req, res) => {
  try { res.json(await M.connectWhatsApp(req.businessId, req.body || {})); } catch (e) { fail(res, e); }
});
merchant.post('/pages', requireFeature('inbox'), async (req, res) => {
  try { res.json({ pages: await M.discoverPages(String((req.body || {}).accessToken || '')) }); } catch (e) { fail(res, e); }
});
merchant.post('/pages/connect', requireFeature('inbox'), async (req, res) => {
  try { const { accessToken, pageId, instagram } = req.body || {}; res.json({ channels: await M.connectPage(req.businessId, { accessToken: String(accessToken || ''), pageId, instagram: !!instagram }) }); } catch (e) { fail(res, e); }
});
merchant.delete('/channels/:id', async (req, res) => {
  try { await M.disconnect(req.businessId, Number(req.params.id) || 0); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

module.exports = { webhook, merchant };
