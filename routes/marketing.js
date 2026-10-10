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

const EMAIL_NOT_SET_UP = 'Email isn\'t set up on the server yet (Mailgun). Add MAILGUN_API_KEY and MAILGUN_DOMAIN, then try again.';

function shapeCampaign(c, stats = {}) {
  return {
    id: c.id, name: c.name, channel: c.channel, segment: c.segment,
    segmentLabel: (SEGMENTS.find(s => s.key === c.segment) || {}).label || c.segment,
    subject: c.subject, body: c.body, status: c.status,
    scheduledAt: c.scheduled_at, sentAt: c.sent_at, createdAt: c.created_at,
    recipientCount: c.recipient_count, sentCount: c.sent_count, failedCount: c.failed_count,
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
      `SELECT COUNT(*) FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.business_id = $1 AND r.status = 'sent' AND r.sent_at > now() - interval '30 days'`, [req.businessId]),
    pool.query(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(amount) FILTER (WHERE payment_status = 'Paid'), 0) AS revenue
       FROM orders WHERE business_id = $1 AND campaign_id IS NOT NULL AND status != 'Cancelled' AND created_at > now() - interval '30 days'`, [req.businessId]),
    pool.query(`SELECT * FROM campaigns WHERE business_id = $1 ORDER BY created_at DESC LIMIT 5`, [req.businessId]),
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
    pool.query('SELECT * FROM campaigns WHERE business_id = $1 ORDER BY created_at DESC', [req.businessId]),
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
    `DELETE FROM campaigns WHERE id = $1 AND business_id = $2 AND status != 'sending'`, [req.params.id, req.businessId]
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

// ---------- analytics ----------
router.get('/analytics', async (req, res) => {
  const [campaigns, stats] = await Promise.all([
    pool.query(`SELECT * FROM campaigns WHERE business_id = $1 AND status IN ('sent','failed','sending') ORDER BY created_at DESC`, [req.businessId]),
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

module.exports = router;
