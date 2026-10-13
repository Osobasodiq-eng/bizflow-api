// db/campaigns.js
// The campaign engine: turns a saved campaign into one email per reachable
// customer, sends them in the background, tracks each one, and runs scheduled
// campaigns when they are due.
//
// Sending never happens inside a web request (a big list would time out):
// startCampaign() lists the recipients and marks the campaign "sending",
// then processCampaign() works through them a few at a time. If the server
// restarts mid-send, tick() picks the campaign up where it left off, because
// each recipient row remembers whether it was already sent.

const crypto = require('crypto');
const pool = require('./pool');
const { sendMarketingEmail, esc, inboxAddress, inboundEnabled } = require('./email');
const { loadCustomerStats, membersOf, isReachable } = require('./segments');
const { notify } = require('./notifications');
const { assertEmailRoom } = require('./billing');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-in-production';
const CONCURRENCY = 5;
const active = new Set(); // campaign ids being processed by THIS server right now

// ---- unsubscribe links: signed with the server secret, so no extra table/column is needed ----
function unsubToken(customerId) {
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`unsub:${customerId}`).digest('hex').slice(0, 32);
  return `${customerId}.${sig}`;
}
function verifyUnsubToken(token) {
  const [id, sig] = String(token || '').split('.');
  if (!/^\d+$/.test(id || '') || !sig) return null;
  const expected = unsubToken(id).split('.')[1];
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return Number(id);
}
const apiBase = () => (process.env.API_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const unsubUrl = customerId => (apiBase() ? `${apiBase()}/api/unsubscribe/${unsubToken(customerId)}` : null);

// ---- content ----
function personalise(text, customer, storeName) {
  const first = (customer.name || '').trim().split(/\s+/)[0] || 'there';
  return String(text)
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, customer.name || 'there')
    .replace(/\{\{\s*store_name\s*\}\}/gi, storeName || '');
}

function shopLink(businessId, campaignId) {
  const base = (process.env.STOREFRONT_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}?business=${businessId}${campaignId ? `&c=${campaignId}` : ''}`;
}

function buildEmail({ campaign, customer, storeName, businessId, preview = false }) {
  const subject = personalise(campaign.subject, customer, storeName);
  const bodyText = personalise(campaign.body, customer, storeName);
  const link = shopLink(businessId, preview ? null : campaign.id);
  const unsub = unsubUrl(customer.id);
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827;">
      <div style="font-size:13px;font-weight:600;color:#6B7280;margin-bottom:16px;">${esc(storeName || '')}</div>
      <div style="font-size:15px;line-height:1.6;color:#1F2937;">${esc(bodyText).replace(/\r?\n/g, '<br>')}</div>
      ${link ? `<p style="margin:24px 0 0;"><a href="${esc(link)}" style="display:inline-block;background:#4F46E5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Shop now</a></p>` : ''}
      <p style="color:#9CA3AF;font-size:11px;margin-top:32px;line-height:1.5;">You're receiving this because you've shopped with ${esc(storeName || 'us')}.
        ${unsub ? `<a href="${esc(unsub)}" style="color:#9CA3AF;">Unsubscribe</a>` : 'Reply to this email to stop receiving these messages.'}</p>
    </div>`;
  const text = `${bodyText}\n\n${link ? `Shop: ${link}\n\n` : ''}${unsub ? `Unsubscribe: ${unsub}` : ''}`;
  return { subject, html, text, unsubscribeUrl: unsub };
}

// The store owner's login email — used as Reply-To so customers' replies reach a real person.
async function ownerEmail(businessId) {
  const { rows } = await pool.query('SELECT email FROM users WHERE business_id = $1 ORDER BY id LIMIT 1', [businessId]);
  return rows[0] ? rows[0].email : null;
}

// ---- starting a send ----
// Atomically claims a draft/scheduled campaign, lists its recipients, and sets it to "sending".
// Throws { status, message } for problems to show the merchant.
async function startCampaign(campaignId, businessId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `UPDATE campaigns SET status = 'sending' WHERE id = $1 AND business_id = $2 AND status IN ('draft','scheduled') RETURNING *`,
      [campaignId, businessId]
    );
    const campaign = claimed.rows[0];
    if (!campaign) throw { status: 400, message: 'This campaign can\'t be sent (it may already be sending or sent).' };

    const customers = await loadCustomerStats(businessId, client);
    const recipients = membersOf(campaign.segment, customers).filter(isReachable);
    await assertEmailRoom(businessId, recipients.length); // plan: marketing on, monthly email allowance
    if (!recipients.length) throw { status: 400, message: 'No one in this segment has an email address (or they have all unsubscribed), so there is nobody to send to.' };

    await client.query(
      `INSERT INTO campaign_recipients (campaign_id, customer_id, email)
       SELECT $1, unnest($2::int[]), unnest($3::text[])`,
      [campaign.id, recipients.map(r => r.id), recipients.map(r => r.email.trim())]
    );
    await client.query('UPDATE campaigns SET recipient_count = $1, sent_count = 0, failed_count = 0 WHERE id = $2', [recipients.length, campaign.id]);
    await client.query('COMMIT');
    return { id: campaign.id, recipientCount: recipients.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- sending ----
async function processCampaign(campaignId) {
  if (active.has(campaignId)) return;
  active.add(campaignId);
  try {
    const { rows: [campaign] } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    if (!campaign || campaign.status !== 'sending') return;
    const { rows: [biz] } = await pool.query('SELECT name FROM businesses WHERE id = $1', [campaign.business_id]);
    const replyTo = inboundEnabled() ? inboxAddress(campaign.business_id) : await ownerEmail(campaign.business_id);

    for (;;) {
      const { rows: batch } = await pool.query(
        `SELECT r.id, r.email, r.customer_id, c.name, c.marketing_opt_out
         FROM campaign_recipients r LEFT JOIN customers c ON c.id = r.customer_id
         WHERE r.campaign_id = $1 AND r.status = 'pending' ORDER BY r.id LIMIT $2`,
        [campaignId, CONCURRENCY]
      );
      if (!batch.length) break;

      await Promise.all(batch.map(async (r) => {
        // Someone who unsubscribed after the campaign was queued is skipped, not emailed.
        if (r.marketing_opt_out) {
          await pool.query(`UPDATE campaign_recipients SET status = 'skipped', error = 'unsubscribed' WHERE id = $1`, [r.id]);
          return;
        }
        const customer = { id: r.customer_id, name: r.name };
        const mail = buildEmail({ campaign, customer, storeName: biz && biz.name, businessId: campaign.business_id });
        const result = await sendMarketingEmail({ to: r.email, fromName: biz && biz.name, tag: `campaign-${campaignId}`, replyTo, ...mail });
        if (result.sent) {
          await pool.query(`UPDATE campaign_recipients SET status = 'sent', sent_at = now() WHERE id = $1`, [r.id]);
        } else {
          await pool.query(`UPDATE campaign_recipients SET status = 'failed', error = $2 WHERE id = $1`, [r.id, (result.detail || result.reason || 'failed').slice(0, 300)]);
        }
      }));
    }

    const { rows: [counts] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent') AS sent, COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM campaign_recipients WHERE campaign_id = $1`, [campaignId]
    );
    const sent = Number(counts.sent), failed = Number(counts.failed);
    await pool.query(
      `UPDATE campaigns SET status = $2, sent_count = $3, failed_count = $4, sent_at = now() WHERE id = $1`,
      [campaignId, sent === 0 && failed > 0 ? 'failed' : 'sent', sent, failed]
    );
    notify(campaign.business_id, {
      type: 'campaign', link: 'marketing',
      title: sent === 0 && failed > 0 ? `Campaign “${campaign.name}” failed to send` : `Campaign “${campaign.name}” was sent`,
      body: `${sent} email${sent === 1 ? '' : 's'} delivered${failed ? `, ${failed} failed` : ''}.`,
    });
  } catch (err) {
    console.error(`Campaign ${campaignId} processing error:`, err);
  } finally {
    active.delete(campaignId);
  }
}

// Fire and forget — the caller (a web request) must not wait for the whole list.
function sendInBackground(campaignId) {
  processCampaign(campaignId).catch(err => console.error('Campaign send error:', err));
}

// Runs every minute: starts scheduled campaigns that are due, and resumes any
// "sending" campaign this server isn't already working on (e.g. after a restart
// or after the free instance woke up late — due campaigns go out as soon as it's awake).
async function tick() {
  try {
    const { rows: due } = await pool.query(
      `SELECT id, business_id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now() ORDER BY scheduled_at LIMIT 20`
    );
    for (const c of due) {
      try {
        await startCampaign(c.id, c.business_id);
      } catch (err) {
        // e.g. nobody left to send to — mark failed so it doesn't retry forever
        await pool.query(`UPDATE campaigns SET status = 'failed' WHERE id = $1 AND status IN ('scheduled','sending')`, [c.id]);
        console.error(`Scheduled campaign ${c.id} could not start:`, err.message || err);
        notify(c.business_id, { type: 'campaign', link: 'marketing', title: 'A scheduled campaign could not be sent', body: String(err.message || 'Something went wrong').slice(0, 200) });
      }
    }
    await require('./automations').runAutomations();

    const { rows: sending } = await pool.query(`SELECT id FROM campaigns WHERE status = 'sending'`);
    for (const c of sending) if (!active.has(c.id)) sendInBackground(c.id);
  } catch (err) {
    console.error('Campaign scheduler error:', err.message);
  }
}

function startScheduler() {
  setTimeout(tick, 5000);
  setInterval(tick, 60 * 1000);
}

module.exports = { ownerEmail, startCampaign, sendInBackground, startScheduler, buildEmail, verifyUnsubToken, unsubUrl, personalise };
