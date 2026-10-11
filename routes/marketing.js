// routes/marketing.js
// Powers the Marketing section: overview numbers, live customer segments,
// email campaigns (create / test / send now / schedule), and analytics with
// revenue attributed to each campaign (orders placed through its "Shop now" link).

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { SEGMENTS, SEGMENT_KEYS, loadCustomerStats, membersOf, isReachable } = require('../db/segments');
const { startCampaign, sendInBackground, buildEmail } = require('../db/campaigns');
const { sendMarketingEmail, emailConfigured } = require('../db/email');
const { KINDS, ensureAutomations } = require('../db/automations');

const EMAIL_NOT_SET_UP = 'Email isn\'t set up on the server yet (Mailgun). Add MAILGUN_API_KEY and MAILGUN_DOMAIN, then try again.';

function shapeCampaign(c, stats = {}) {
  return {
    id: c.id, name: c.name, channel: c.channel, segment: c.segment,
    segmentLabel: (SEGMENTS.find(s => s.key === c.segment) || {}).label || c.segment,
    subject: c.subject, body: c.body, status: c.status,
    scheduledAt: c.scheduled_at, sentAt: c.sent_at, createdAt: c.created_at,
    recipientCount: c.recipient_count, sentCount: c.sent_count, failedCount: c.failed_count,
    isAutomation: c.status === 'automation',
    orders: Number(stats.orders || 0), revenue: Number(stats.revenue || 0),
  };
}

// Validates + trims the fields a campaign is made of. Throws { status, message }.
function readCampaignFields(body, { partial = false } = {}) {
  const out = {};
  const bad = message => { throw { status: 400, message }; };
  if (!partial || body.name !== undefined) { out.name = String(body.name || '').trim(); if (!out.name) bad('Give the campaign a name'); if (out.name.length > 100) bad('Campaign name is too long (100 characters max)'); }
  if (!partial || body.segment !== undefined) { out.segment = String(body.segment || ''); if (!SEGMENT_KEYS.includes(out.segment)) bad('Pick who this should go to'); }
  if (!partial || body.subject !== undefined) { out.subject = String(body.subject || '').trim(); if (!out.subject) bad('Add a subject line'); if (out.subject.length > 150) bad('Subject is too long (150 characters max)'); }
  if (!partial || body.body !== undefined) { out.body = String(body.body || '').trim(); if (!out.body) bad('Write the message'); if (out.body.length > 5000) bad('Message is too long (5,000 characters max)'); }
  return out;
}
function readScheduleTime(value) {
  const t = new Date(value);
  if (!value || isNaN(t.getTime())) throw { status: 400, message: 'Pick a valid date and time' };
  if (t.getTime() < Date.now() + 60 * 1000) throw { status: 400, message: 'Pick a time in the future' };
  return t;
}
const fail = (res, err) => {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  throw err;
};

const CAMPAIGN_STATS_SQL = `
  SELECT campaign_id, COUNT(*) AS orders,
         COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0) AS revenue
  FROM orders WHERE business_id = $1 AND campaign_id IS NOT NULL AND status != 'Cancelled'
  GROUP BY campaign_id`;

// ---------- overview ----------
router.get('/overview', async (req, res) => {
  const customers = await loadCustomerStats(req.businessId);
  const [sent30, attributed, recent, counts] = await Promise.all([
    pool.query(
      `SELECT (SELECT COUNT(*) FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
               WHERE c.business_id = $1 AND r.status = 'sent' AND r.sent_at > now() - interval '30 days')
            + (SELECT COUNT(*) FROM automation_sends WHERE business_id = $1 AND status = 'sent' AND sent_at > now() - interval '30 days') AS count`, [req.businessId]),
    pool.query(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0) AS revenue
       FROM orders WHERE business_id = $1 AND campaign_id IS NOT NULL AND status != 'Cancelled' AND created_at > now() - interval '30 days'`, [req.businessId]),
    pool.query(`SELECT * FROM campaigns WHERE business_id = $1 AND status != 'automation' ORDER BY created_at DESC LIMIT 5`, [req.businessId]),
    pool.query(`SELECT status, COUNT(*) FROM campaigns WHERE business_id = $1 GROUP BY status`, [req.businessId]),
  ]);
  const byStatus = Object.fromEntries(counts.rows.map(r => [r.status, Number(r.count)]));
  res.json({
    totalCustomers: customers.length,
    reachableCustomers: customers.filter(isReachable).length,
    emailsSent30d: Number(sent30.rows[0].count),
    ordersAttributed30d: Number(attributed.rows[0].orders),
    revenueAttributed30d: Number(attributed.rows[0].revenue),
    campaignsSent: byStatus.sent || 0, campaignsScheduled: byStatus.scheduled || 0, campaignsDraft: byStatus.draft || 0,
    emailConfigured: emailConfigured(),
    recentCampaigns: recent.rows.map(c => shapeCampaign(c)),
  });
});

// ---------- segments ----------
router.get('/segments', async (req, res) => {
  const customers = await loadCustomerStats(req.businessId);
  res.json(SEGMENTS.map(s => {
    const members = membersOf(s.key, customers);
    return { key: s.key, label: s.label, description: s.description, total: members.length, reachable: members.filter(isReachable).length };
  }));
});

router.get('/segments/:key/customers', async (req, res) => {
  if (!SEGMENT_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown segment' });
  const customers = await loadCustomerStats(req.businessId);
  const members = membersOf(req.params.key, customers);
  res.json({
    total: members.length,
    customers: members.slice(0, 200).map(c => ({
      id: c.id, name: c.name, phone: c.phone, email: c.email, tag: c.tag, orderCount: c.orderCount,
      spend: c.spend, lastOrderDate: c.lastOrderDate, reachable: isReachable(c), optedOut: c.optedOut,
    })),
  });
});

// ---------- campaigns ----------
router.get('/campaigns', async (req, res) => {
  const [campaigns, stats] = await Promise.all([
    pool.query(`SELECT * FROM campaigns WHERE business_id = $1 AND status != 'automation' ORDER BY created_at DESC`, [req.businessId]),
    pool.query(CAMPAIGN_STATS_SQL, [req.businessId]),
  ]);
  const byId = Object.fromEntries(stats.rows.map(r => [r.campaign_id, r]));
  res.json(campaigns.rows.map(c => shapeCampaign(c, byId[c.id])));
});

router.get('/campaigns/:id', async (req, res) => {
  const { rows: [c] } = await pool.query('SELECT * FROM campaigns WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  const [stats, failures] = await Promise.all([
    pool.query(CAMPAIGN_STATS_SQL, [req.businessId]),
    pool.query(`SELECT email, error FROM campaign_recipients WHERE campaign_id = $1 AND status = 'failed' ORDER BY id LIMIT 10`, [c.id]),
  ]);
  res.json({ ...shapeCampaign(c, stats.rows.find(r => r.campaign_id === c.id)), failures: failures.rows });
});

router.post('/campaigns', async (req, res) => {
  try {
    const f = readCampaignFields(req.body);
    const { rows: [c] } = await pool.query(
      `INSERT INTO campaigns (business_id, name, segment, subject, body) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.businessId, f.name, f.segment, f.subject, f.body]
    );
    res.status(201).json(shapeCampaign(c));
  } catch (err) { fail(res, err); }
});

router.patch('/campaigns/:id', async (req, res) => {
  try {
    const f = readCampaignFields(req.body, { partial: true });
    const keys = Object.keys(f);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
    const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows: [c] } = await pool.query(
      `UPDATE campaigns SET ${set} WHERE id = $${keys.length + 1} AND business_id = $${keys.length + 2} AND status IN ('draft','scheduled') RETURNING *`,
      [...keys.map(k => f[k]), req.params.id, req.businessId]
    );
    if (!c) return res.status(400).json({ error: 'Only drafts and scheduled campaigns can be edited' });
    res.json(shapeCampaign(c));
  } catch (err) { fail(res, err); }
});

router.delete('/campaigns/:id', async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM campaigns WHERE id = $1 AND business_id = $2 AND status NOT IN ('sending','automation')`, [req.params.id, req.businessId]
  );
  if (!rowCount) return res.status(400).json({ error: 'Campaign not found, or it is sending right now' });
  res.status(204).send();
});

// Send now
router.post('/campaigns/:id/send', async (req, res) => {
  if (!emailConfigured()) return res.status(400).json({ error: EMAIL_NOT_SET_UP });
  try {
    const started = await startCampaign(Number(req.params.id), req.businessId);
    sendInBackground(started.id);
    res.json({ ok: true, recipientCount: started.recipientCount });
  } catch (err) { fail(res, err); }
});

// Schedule for later (body: { scheduledAt: ISO string })
router.post('/campaigns/:id/schedule', async (req, res) => {
  if (!emailConfigured()) return res.status(400).json({ error: EMAIL_NOT_SET_UP });
  try {
    const when = readScheduleTime(req.body.scheduledAt);
    const { rows: [c] } = await pool.query(
      `UPDATE campaigns SET status = 'scheduled', scheduled_at = $1 WHERE id = $2 AND business_id = $3 AND status IN ('draft','scheduled') RETURNING *`,
      [when, req.params.id, req.businessId]
    );
    if (!c) return res.status(400).json({ error: 'Only drafts can be scheduled' });
    res.json(shapeCampaign(c));
  } catch (err) { fail(res, err); }
});

// Take a scheduled campaign back to draft
router.post('/campaigns/:id/unschedule', async (req, res) => {
  const { rows: [c] } = await pool.query(
    `UPDATE campaigns SET status = 'draft', scheduled_at = NULL WHERE id = $1 AND business_id = $2 AND status = 'scheduled' RETURNING *`,
    [req.params.id, req.businessId]
  );
  if (!c) return res.status(400).json({ error: 'This campaign isn\'t scheduled' });
  res.json(shapeCampaign(c));
});

// Send a preview to the merchant's own login email. Works for unsaved content too
// (body: { subject, body }) so the editor can offer "Send test" before saving.
router.post('/test', async (req, res) => {
  if (!emailConfigured()) return res.status(400).json({ error: EMAIL_NOT_SET_UP });
  try {
    const f = readCampaignFields({ name: 'test', segment: 'all', subject: req.body.subject, body: req.body.body });
    const { rows: [biz] } = await pool.query('SELECT name FROM businesses WHERE id = $1', [req.businessId]);
    const mail = buildEmail({
      campaign: { subject: `[Test] ${f.subject}`, body: f.body }, customer: { id: 0, name: 'Ada Customer' },
      storeName: biz && biz.name, businessId: req.businessId, preview: true,
    });
    const result = await sendMarketingEmail({ to: req.userEmail, fromName: biz && biz.name, ...mail, unsubscribeUrl: null });
    if (!result.sent) return res.status(502).json({ error: `Couldn't send the test email${result.detail ? ' — ' + result.detail : ''}` });
    res.json({ ok: true, sentTo: req.userEmail });
  } catch (err) { fail(res, err); }
});

// ---------- automations ----------
function shapeAutomation(a, stats = {}) {
  const k = KINDS[a.kind] || {};
  return {
    id: a.id, kind: a.kind, name: a.name, description: k.description || '', enabled: a.enabled,
    delayDays: a.delay_days, minDelay: k.minDelay || 1, subject: a.subject, body: a.body, enabledAt: a.enabled_at,
    sent: Number(stats.sent || 0), failed: Number(stats.failed || 0), lastSentAt: stats.last_sent || null,
    orders: Number(stats.orders || 0), revenue: Number(stats.revenue || 0),
  };
}

router.get('/automations', async (req, res) => {
  await ensureAutomations(req.businessId);
  const [autos, sends, attributed] = await Promise.all([
    pool.query('SELECT * FROM automations WHERE business_id = $1 ORDER BY id', [req.businessId]),
    pool.query(
      `SELECT automation_id, COUNT(*) FILTER (WHERE status = 'sent') AS sent, COUNT(*) FILTER (WHERE status = 'failed') AS failed, MAX(sent_at) AS last_sent
       FROM automation_sends WHERE business_id = $1 GROUP BY automation_id`, [req.businessId]),
    pool.query(CAMPAIGN_STATS_SQL, [req.businessId]),
  ]);
  const sendsBy = Object.fromEntries(sends.rows.map(r => [r.automation_id, r]));
  const attrBy = Object.fromEntries(attributed.rows.map(r => [r.campaign_id, r]));
  res.json({
    emailConfigured: emailConfigured(),
    automations: autos.rows.map(a => shapeAutomation(a, { ...sendsBy[a.id], ...(attrBy[a.bucket_campaign_id] || {}) })),
  });
});

// body: { enabled?, delayDays?, subject?, body? }
router.patch('/automations/:id', async (req, res) => {
  try {
    const { rows: [a] } = await pool.query('SELECT * FROM automations WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
    if (!a) return res.status(404).json({ error: 'Automation not found' });
    const k = KINDS[a.kind] || { minDelay: 1 };
    const bad = message => { throw { status: 400, message }; };
    const sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (req.body.subject !== undefined) { const v = String(req.body.subject).trim(); if (!v) bad('Add a subject line'); if (v.length > 150) bad('Subject is too long (150 characters max)'); add('subject', v); }
    if (req.body.body !== undefined) { const v = String(req.body.body).trim(); if (!v) bad('Write the message'); if (v.length > 5000) bad('Message is too long (5,000 characters max)'); add('body', v); }
    if (req.body.delayDays !== undefined) {
      const d = Number(req.body.delayDays);
      if (!Number.isInteger(d) || d < k.minDelay || d > 365) bad(`Days must be a whole number from ${k.minDelay} to 365`);
      add('delay_days', d);
    }
    if (req.body.enabled !== undefined) {
      const on = req.body.enabled === true;
      if (on && !emailConfigured()) bad(EMAIL_NOT_SET_UP);
      add('enabled', on);
      // switching ON starts the clock: only events from now on trigger emails
      if (on && !a.enabled) add('enabled_at', new Date());
    }
    if (!sets.length) bad('Nothing to update');

    vals.push(a.id);
    const { rows: [updated] } = await pool.query(`UPDATE automations SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    // keep the hidden attribution campaign's label in step with the flow
    if (updated.bucket_campaign_id) await pool.query('UPDATE campaigns SET name = $1, subject = $2, body = $3 WHERE id = $4', [updated.name, updated.subject, updated.body, updated.bucket_campaign_id]);
    res.json(shapeAutomation(updated));
  } catch (err) { fail(res, err); }
});

// Recent sends for one automation (so you can see who was emailed and any errors)
router.get('/automations/:id/sends', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.email, s.status, s.error, s.created_at, s.sent_at, c.name
     FROM automation_sends s LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.automation_id = $1 AND s.business_id = $2 ORDER BY s.id DESC LIMIT 25`,
    [req.params.id, req.businessId]
  );
  res.json(rows.map(r => ({ name: r.name, email: r.email, status: r.status, error: r.error, at: r.sent_at || r.created_at })));
});

// ---------- analytics ----------
router.get('/analytics', async (req, res) => {
  const [campaigns, stats] = await Promise.all([
    pool.query(`SELECT * FROM campaigns WHERE business_id = $1 AND (status IN ('sent','failed','sending') OR (status = 'automation' AND sent_count > 0)) ORDER BY created_at DESC`, [req.businessId]),
    pool.query(CAMPAIGN_STATS_SQL, [req.businessId]),
  ]);
  const byId = Object.fromEntries(stats.rows.map(r => [r.campaign_id, r]));
  const list = campaigns.rows.map(c => shapeCampaign(c, byId[c.id]));
  const totalRevenue = list.reduce((s, c) => s + c.revenue, 0);
  res.json({
    campaigns: list,
    channels: [
      { channel: 'Email', revenue: totalRevenue, orders: list.reduce((s, c) => s + c.orders, 0), available: true },
      { channel: 'WhatsApp', revenue: 0, orders: 0, available: false },
      { channel: 'Instagram', revenue: 0, orders: 0, available: false },
    ],
  });
});


// ---------- content calendar ----------
const CONTENT_CHANNELS = ['instagram', 'whatsapp', 'facebook', 'tiktok', 'other'];
const shapePost = r => ({ id: r.id, date: r.post_date, channel: r.channel, title: r.title, caption: r.caption || '', status: r.status });

function readPost(body, partial) {
  const bad = message => { throw { status: 400, message }; };
  const out = {};
  if (!partial || body.date !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) bad('Pick a date'); out.post_date = body.date; }
  if (!partial || body.title !== undefined) { const v = String(body.title || '').trim(); if (!v) bad('Give the post a title'); if (v.length > 120) bad('Title is too long (120 characters max)'); out.title = v; }
  if (body.caption !== undefined) { const v = String(body.caption || '').trim(); if (v.length > 3000) bad('Caption is too long (3,000 characters max)'); out.caption = v; }
  if (body.channel !== undefined) { if (!CONTENT_CHANNELS.includes(body.channel)) bad('Pick a channel'); out.channel = body.channel; }
  if (body.status !== undefined) { if (!['planned', 'posted'].includes(body.status)) bad('Invalid status'); out.status = body.status; }
  return out;
}

// ?month=YYYY-MM
router.get('/content', async (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT id, to_char(post_date, 'YYYY-MM-DD') AS post_date, channel, title, caption, status FROM content_posts
     WHERE business_id = $1 AND post_date >= ($2::text || '-01')::date AND post_date < (($2::text || '-01')::date + interval '1 month')
     ORDER BY post_date, id`, [req.businessId, m]);
  res.json(rows.map(shapePost));
});

router.post('/content', async (req, res) => {
  try {
    const f = readPost(req.body, false);
    const { rows: [r] } = await pool.query(
      `INSERT INTO content_posts (business_id, post_date, channel, title, caption) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, to_char(post_date, 'YYYY-MM-DD') AS post_date, channel, title, caption, status`,
      [req.businessId, f.post_date, f.channel || 'instagram', f.title, f.caption || '']);
    res.status(201).json(shapePost(r));
  } catch (err) { fail(res, err); }
});

router.patch('/content/:id', async (req, res) => {
  try {
    const f = readPost(req.body, true);
    const keys = Object.keys(f);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
    const vals = keys.map(k => f[k]); vals.push(req.params.id, req.businessId);
    const { rows: [r] } = await pool.query(
      `UPDATE content_posts SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} AND business_id = $${keys.length + 2}
       RETURNING id, to_char(post_date, 'YYYY-MM-DD') AS post_date, channel, title, caption, status`, vals);
    if (!r) return res.status(404).json({ error: 'Post not found' });
    res.json(shapePost(r));
  } catch (err) { fail(res, err); }
});

router.delete('/content/:id', async (req, res) => {
  await pool.query('DELETE FROM content_posts WHERE id = $1 AND business_id = $2', [req.params.id, req.businessId]);
  res.status(204).end();
});

// ---------- caption writer ----------
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise falls back to a simple template so the button always works.
const captionUse = new Map(); // businessId -> [timestamps]; keeps one shop from running up the bill
function captionAllowed(id) {
  const now = Date.now(), list = (captionUse.get(id) || []).filter(t => now - t < 3600e3);
  if (list.length >= 20) return false;
  list.push(now); captionUse.set(id, list); return true;
}
const CHANNEL_HINT = { instagram: 'an Instagram post (friendly, a few emojis, 5-8 relevant hashtags at the end)', whatsapp: 'a short WhatsApp status (1-3 lines, no hashtags)', facebook: 'a Facebook post (conversational, 1-2 short paragraphs, at most 2 hashtags)', tiktok: 'a TikTok caption (punchy, one hook line, 3-5 hashtags)', other: 'a social media post' };

function templateCaption({ store, title, product, channel }) {
  const what = product ? `${product.name}${product.price ? ` — ₦${Number(product.price).toLocaleString()}` : ''}` : title;
  const tags = channel === 'whatsapp' ? '' : `\n\n#${store.replace(/[^A-Za-z0-9]/g, '')} #shopnow #newarrivals`;
  return `✨ ${what}\n\n${product && product.description ? product.description.slice(0, 160) + '\n\n' : ''}Order now from ${store} — link in bio! 🛍️${tags}`;
}

router.post('/content/caption', async (req, res) => {
  try {
    if (!captionAllowed(req.businessId)) return res.status(429).json({ error: 'You\'ve used the caption writer a lot this hour. Try again a little later.' });
    const channel = CONTENT_CHANNELS.includes(req.body.channel) ? req.body.channel : 'instagram';
    const title = String(req.body.title || '').trim().slice(0, 120);
    const notes = String(req.body.notes || '').trim().slice(0, 300);
    const { rows: [biz] } = await pool.query('SELECT name FROM businesses WHERE id = $1', [req.businessId]);
    let product = null;
    if (req.body.productId) {
      const { rows: [pr] } = await pool.query('SELECT name, price, description, category FROM products WHERE id = $1 AND business_id = $2', [Number(req.body.productId) || 0, req.businessId]);
      product = pr || null;
    }
    if (!title && !product) return res.status(400).json({ error: 'Add a title or pick a product first.' });
    const store = (biz && biz.name) || 'our store';

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.json({ caption: templateCaption({ store, title, product, channel }), source: 'template' });

    const prompt = `Write ${CHANNEL_HINT[channel]} for a small online shop called "${store}".\n`
      + (product ? `Product: ${product.name}. Price: ₦${Number(product.price).toLocaleString()}. ${product.description ? 'Details: ' + product.description.slice(0, 400) + '.' : ''}\n` : '')
      + (title ? `Post idea: ${title}\n` : '') + (notes ? `Extra notes from the owner: ${notes}\n` : '')
      + 'Write in simple, warm English suited to Nigerian customers. Do not invent discounts, prices or claims that were not given. Mention that people can order through the link in bio. Reply with ONLY the caption text.';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      console.error('Caption writer failed:', r.status, (await r.text()).slice(0, 300));
      return res.json({ caption: templateCaption({ store, title, product, channel }), source: 'template' }); // never leave the owner stuck
    }
    const data = await r.json();
    const text = ((data.content || []).find(b => b.type === 'text') || {}).text;
    res.json({ caption: (text || '').trim() || templateCaption({ store, title, product, channel }), source: text ? 'ai' : 'template' });
  } catch (err) { fail(res, err); }
});


module.exports = router;
