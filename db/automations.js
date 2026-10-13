// db/automations.js
// Automated emails. Each business gets two flows (off by default):
//   win_back       — a customer's last order was N days ago and they haven't come back
//   post_purchase  — N days after an order was placed
//
// Safety rules (so an automation can't spam anyone):
//   - Only things that happen AFTER the flow is switched on trigger it (turning it on never mails your history).
//   - Win-back: at most once per customer per 60 days. Post-purchase: once per order.
//   - Customers without an email, or who unsubscribed, are never emailed.
//   - Each email carries the same unsubscribe link and "Shop now" tracking as a campaign.
// A check runs every 5 minutes; if the server was asleep, due emails go out when it wakes.

const pool = require('./pool');
const { hasFeature, assertEmailRoom } = require('./billing');
const { sendMarketingEmail, emailConfigured, inboxAddress, inboundEnabled } = require('./email');
const { ownerEmail } = require('./campaigns');
const { buildEmail } = require('./campaigns');

const WIN_BACK_COOLDOWN_DAYS = 60;
const MAX_PER_RUN = 50; // per automation per check — a backlog drains over a few runs

const KINDS = {
  win_back: {
    name: '30-day win-back', delayDays: 30, minDelay: 7,
    description: 'Emails a customer once their last order was this many days ago and they haven\'t ordered again.',
    subject: 'We miss you, {{first_name}}',
    body: 'Hi {{first_name}},\n\nIt\'s been a little while since your last order and we\'d love to see you again. We\'ve added new items we think you\'ll like.\n\nTap the button below to take a look.',
  },
  post_purchase: {
    name: 'Post-purchase follow-up', delayDays: 3, minDelay: 1,
    description: 'Emails a customer this many days after they place an order — a thank-you and a chance to tell you if anything\'s wrong.',
    subject: 'How was your order, {{first_name}}?',
    body: 'Hi {{first_name}},\n\nThank you for shopping with us! We hope you\'re enjoying your purchase. If anything isn\'t right, just reply to this email and we\'ll sort it out.\n\nWhen you\'re ready for more, you\'ll find everything here:',
  },
};

// Makes sure this business has both flows (created switched off) and the hidden
// "campaign" row each uses to collect sales attribution.
async function ensureAutomations(businessId) {
  for (const [kind, d] of Object.entries(KINDS)) {
    const ins = await pool.query(
      `INSERT INTO automations (business_id, kind, name, delay_days, subject, body) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_id, kind) DO NOTHING RETURNING id`,
      [businessId, kind, d.name, d.delayDays, d.subject, d.body]
    );
    if (ins.rows[0]) await ensureBucket(ins.rows[0].id);
  }
  // heal any flow whose bucket is missing (e.g. deleted)
  const { rows } = await pool.query('SELECT id FROM automations WHERE business_id = $1 AND bucket_campaign_id IS NULL', [businessId]);
  for (const r of rows) await ensureBucket(r.id);
}

async function ensureBucket(automationId) {
  const { rows: [a] } = await pool.query('SELECT * FROM automations WHERE id = $1', [automationId]);
  if (!a || a.bucket_campaign_id) return a && a.bucket_campaign_id;
  const { rows: [c] } = await pool.query(
    `INSERT INTO campaigns (business_id, name, segment, subject, body, status) VALUES ($1, $2, 'all', $3, $4, 'automation') RETURNING id`,
    [a.business_id, a.name, a.subject, a.body]
  );
  await pool.query('UPDATE automations SET bucket_campaign_id = $1 WHERE id = $2', [c.id, a.id]);
  return c.id;
}

const REACHABLE_SQL = `c.email IS NOT NULL AND c.email LIKE '%@%' AND NOT c.marketing_opt_out`;

// Who is due an email right now for this automation (capped at MAX_PER_RUN).
async function findTargets(a) {
  const since = a.enabled_at || new Date();
  if (a.kind === 'win_back') {
    const { rows } = await pool.query(
      `SELECT c.id AS customer_id, NULL::int AS order_id, c.name, c.email
       FROM customers c
       JOIN (SELECT customer_id, MAX(created_at) AS last_order FROM orders
             WHERE business_id = $1 AND status != 'Cancelled' AND customer_id IS NOT NULL GROUP BY customer_id) s ON s.customer_id = c.id
       WHERE c.business_id = $1 AND ${REACHABLE_SQL}
         AND s.last_order <= now() - ($2::int * interval '1 day')
         AND s.last_order >  $3::timestamptz - ($2::int * interval '1 day')
         AND NOT EXISTS (SELECT 1 FROM automation_sends x WHERE x.automation_id = $4 AND x.customer_id = c.id
                         AND x.created_at > now() - ($5::int * interval '1 day'))
       ORDER BY s.last_order LIMIT ${MAX_PER_RUN}`,
      [a.business_id, a.delay_days, since, a.id, WIN_BACK_COOLDOWN_DAYS]
    );
    return rows;
  }
  if (a.kind === 'post_purchase') {
    const { rows } = await pool.query(
      `SELECT c.id AS customer_id, o.id AS order_id, c.name, c.email
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.business_id = $1 AND o.status != 'Cancelled' AND ${REACHABLE_SQL}
         AND o.created_at <= now() - ($2::int * interval '1 day')
         AND o.created_at >  $3::timestamptz
         AND NOT EXISTS (SELECT 1 FROM automation_sends x WHERE x.automation_id = $4 AND x.order_id = o.id)
       ORDER BY o.created_at LIMIT ${MAX_PER_RUN}`,
      [a.business_id, a.delay_days, since, a.id]
    );
    return rows;
  }
  return [];
}

async function sendOne(a, storeName, t) {
  // Record first, send second: the unique rules above guarantee nobody is emailed twice.
  const ins = await pool.query(
    `INSERT INTO automation_sends (automation_id, business_id, customer_id, order_id, email)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
    [a.id, a.business_id, t.customer_id, t.order_id, t.email.trim()]
  );
  if (!ins.rows[0]) return;
  let result;
  try {
    const mail = buildEmail({
      campaign: { id: a.bucket_campaign_id, subject: a.subject, body: a.body },
      customer: { id: t.customer_id, name: t.name }, storeName, businessId: a.business_id,
    });
    result = await sendMarketingEmail({ to: t.email.trim(), fromName: storeName, tag: `automation-${a.id}`, replyTo: inboundEnabled() ? inboxAddress(a.business_id) : await ownerEmail(a.business_id), ...mail });
  } catch (err) {
    result = { sent: false, reason: err.message }; // never leave a row stuck on 'pending'
  }
  if (result.sent) {
    await pool.query(`UPDATE automation_sends SET status = 'sent', sent_at = now() WHERE id = $1`, [ins.rows[0].id]);
    if (a.bucket_campaign_id) await pool.query('UPDATE campaigns SET sent_count = sent_count + 1, recipient_count = recipient_count + 1, sent_at = now() WHERE id = $1', [a.bucket_campaign_id]);
  } else {
    await pool.query(`UPDATE automation_sends SET status = 'failed', error = $2 WHERE id = $1`, [ins.rows[0].id, (result.detail || result.reason || 'failed').slice(0, 300)]);
    if (a.bucket_campaign_id) await pool.query('UPDATE campaigns SET recipient_count = recipient_count + 1, failed_count = failed_count + 1 WHERE id = $1', [a.bucket_campaign_id]);
  }
}

let running = false;
async function tick() {
  if (running || !emailConfigured()) return; // nothing to do (or nothing to send with) — don't record fake failures
  running = true;
  try {
    const { rows: flows } = await pool.query(
      `SELECT a.*, b.name AS store_name FROM automations a JOIN businesses b ON b.id = a.business_id WHERE a.enabled = true`
    );
    for (const a of flows) {
      try {
        if (!(await hasFeature(a.business_id, 'automations'))) continue; // plan lapsed: paused, not deleted
        for (const t of await findTargets(a)) {
          try { await assertEmailRoom(a.business_id, 1); } catch (e) { break; } // monthly allowance used up — resumes next month or on upgrade
          await sendOne(a, a.store_name, t);
        }
      } catch (err) {
        console.error(`Automation ${a.id} (${a.kind}) error:`, err.message);
      }
    }
  } catch (err) {
    console.error('Automation scheduler error:', err.message);
  } finally {
    running = false;
  }
}

function startAutomations() {
  setTimeout(tick, 15000);
  setInterval(tick, 5 * 60 * 1000);
}

module.exports = { KINDS, ensureAutomations, findTargets, tick, startAutomations };
