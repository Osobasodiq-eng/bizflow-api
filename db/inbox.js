// db/inbox.js
// The shared inbox: every channel (email, storefront chat, and later WhatsApp / Instagram / Facebook)
// funnels messages through recordInbound(), and replies leave through sendReply().
// Adding a new channel = one way to receive (a webhook that calls recordInbound) + one branch in sendReply.

const pool = require('./pool');
const { sendInboxEmail, emailConfigured } = require('./email');
const { notify } = require('./notifications');

const CHANNELS = {
  chat:      { label: 'Storefront chat', canReply: true },
  email:     { label: 'Email', canReply: true },
  whatsapp:  { label: 'WhatsApp', canReply: false },
  instagram: { label: 'Instagram', canReply: false },
  facebook:  { label: 'Facebook', canReply: false },
};

const preview = text => String(text).replace(/\s+/g, ' ').trim().slice(0, 140);
const normPhone = v => String(v || '').replace(/[^\d+]/g, '');

// Finds the customer this contact belongs to (so the inbox can show VIP / Ordered tags and link the profile).
async function findCustomer(businessId, channel, handle) {
  if (channel === 'email' || (channel === 'chat' && handle.includes('@'))) {
    const { rows } = await pool.query('SELECT id FROM customers WHERE business_id = $1 AND lower(email) = lower($2) ORDER BY id LIMIT 1', [businessId, handle]);
    return rows[0] ? rows[0].id : null;
  }
  if (channel === 'whatsapp' || (channel === 'chat' && /^\+?\d{7,}$/.test(handle))) {
    const { rows } = await pool.query(`SELECT id FROM customers WHERE business_id = $1 AND regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g') ORDER BY id LIMIT 1`, [businessId, handle]);
    return rows[0] ? rows[0].id : null;
  }
  return null;
}

// Stores one incoming message. Returns { conversation, message, duplicate }.
async function recordInbound({ businessId, channel, handle, name, detail, subject, body, externalId, chatToken }) {
  handle = String(handle).trim(); if (channel === 'email') handle = handle.toLowerCase();
  const text = String(body || '').trim();
  if (!handle || !text) throw { status: 400, message: 'Empty message' };

  // Chat visitors type their own email/phone and nothing proves it's theirs, so we never link them to a customer record
  // (otherwise anyone could appear as a VIP). Email and WhatsApp senders are matched by their verified address.
  const customerId = channel === 'chat' ? null : await findCustomer(businessId, channel, handle);
  const { rows: [conv] } = await pool.query(
    `INSERT INTO inbox_conversations (business_id, channel, contact_handle, contact_name, contact_detail, customer_id, subject, chat_token)
     VALUES ($1, $2, $3, $4, $8, $5, $6, $7)
     ON CONFLICT (business_id, channel, contact_handle) DO UPDATE SET
       contact_name = COALESCE(inbox_conversations.contact_name, EXCLUDED.contact_name),
       customer_id = COALESCE(inbox_conversations.customer_id, EXCLUDED.customer_id)
     RETURNING *`,
    [businessId, channel, handle, name || null, customerId, subject || null, chatToken || null, detail || null]
  );
  const { rows: [msg] } = await pool.query(
    `INSERT INTO inbox_messages (conversation_id, business_id, direction, body, external_id) VALUES ($1, $2, 'in', $3, $4)
     ON CONFLICT DO NOTHING RETURNING *`,
    [conv.id, businessId, text.slice(0, 5000), externalId || null]
  );
  if (!msg) return { conversation: conv, message: null, duplicate: true }; // already stored (provider retry)
  await pool.query(
    `UPDATE inbox_conversations SET status = 'open', unread_count = unread_count + 1, last_message_at = now(), last_message_preview = $2,
       last_direction = 'in', last_inbound_external_id = COALESCE($3, last_inbound_external_id), subject = COALESCE($4, subject)
     WHERE id = $1`,
    [conv.id, preview(text), externalId || null, subject || null]
  );
  notify(businessId, {
    type: 'message', link: 'inbox', dedupeKey: `conv-${conv.id}`,
    title: `New message from ${conv.contact_name || conv.contact_detail || (channel === 'chat' ? 'a website visitor' : handle)}`,
    body: preview(text),
  });
  return { conversation: conv, message: msg, duplicate: false };
}

// Sends a reply from the merchant. Throws { status, message } for problems worth showing.
async function sendReply(businessId, conversationId, body) {
  const text = String(body || '').trim();
  if (!text) throw { status: 400, message: 'Write a message first' };
  if (text.length > 5000) throw { status: 400, message: 'Message is too long (5,000 characters max)' };
  const { rows: [conv] } = await pool.query('SELECT * FROM inbox_conversations WHERE id = $1 AND business_id = $2', [conversationId, businessId]);
  if (!conv) throw { status: 404, message: 'Conversation not found' };
  const ch = CHANNELS[conv.channel];
  if (!ch || !ch.canReply) throw { status: 400, message: `${ch ? ch.label : conv.channel} replies aren't connected yet.` };

  let externalId = null, error = null;
  if (conv.channel === 'email') {
    if (!emailConfigured()) throw { status: 400, message: 'Email isn\'t set up on the server yet (Mailgun), so replies can\'t be sent.' };
    const { rows: [biz] } = await pool.query('SELECT name FROM businesses WHERE id = $1', [businessId]);
    const subj = conv.subject ? (/^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject}`) : `Message from ${(biz && biz.name) || 'our store'}`;
    const r = await sendInboxEmail({ businessId, to: conv.contact_handle, fromName: biz && biz.name, subject: subj, text, inReplyTo: conv.last_inbound_external_id });
    if (!r.sent) error = r.detail || 'Could not send';
    externalId = r.messageId || null;
  }
  // chat: the visitor's widget reads the reply from here — nothing to send.

  const { rows: [msg] } = await pool.query(
    `INSERT INTO inbox_messages (conversation_id, business_id, direction, body, external_id, status, error) VALUES ($1, $2, 'out', $3, $4, $5, $6) RETURNING *`,
    [conv.id, businessId, text, externalId, error ? 'failed' : 'sent', error]
  );
  if (!error) {
    await pool.query(`UPDATE inbox_conversations SET last_message_at = now(), last_message_preview = $2, last_direction = 'out', unread_count = 0 WHERE id = $1`, [conv.id, preview(text)]);
  }
  return msg;
}

module.exports = { CHANNELS, recordInbound, sendReply, preview, normPhone };
