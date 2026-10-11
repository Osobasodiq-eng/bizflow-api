// routes/inbound.js — receives customer emails from Mailgun and files them in the inbox.
//
// Mailgun setup (once): Receiving → Routes → Create route
//   Expression: match_recipient("b.*@YOUR_MAILGUN_DOMAIN")      Action: Forward → https://YOUR-API/api/inbound/email
// Each store's address is b<storeId>@YOUR_MAILGUN_DOMAIN (shown in Inbox → Channels).
//
// Mailgun signs every request; we check the signature so strangers can't post fake messages.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db/pool');
const { recordInbound, preview } = require('../db/inbox');
const { inboxAddress } = require('../db/email');

// Mailgun sends form data as urlencoded, or multipart when there are attachments. We keep only the text fields.
function parseMultipart(buf, boundary) {
  const fields = {}, delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const next = buf.indexOf(delim, pos + delim.length);
    if (next === -1) break;
    const part = buf.subarray(pos + delim.length + 2, next - 2); // skip CRLF after boundary and before the next one
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8');
      const name = /name="([^"]+)"/i.exec(head);
      if (name && !/filename=/i.test(head)) fields[name[1]] = part.subarray(split + 4).toString('utf8');
    }
    pos = next;
  }
  return fields;
}

function readFields(req) {
  const type = req.headers['content-type'] || '';
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (/multipart\/form-data/i.test(type)) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
    return m ? parseMultipart(raw, m[1] || m[2]) : {};
  }
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
}

function validSignature(f) {
  const key = process.env.MAILGUN_SIGNING_KEY || process.env.MAILGUN_API_KEY;
  if (!key || !f.timestamp || !f.token || !f.signature) return false;
  const expected = crypto.createHmac('sha256', key).update(f.timestamp + f.token).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(f.signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseAddress(v) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(v || ''));
  return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: String(v || '').trim() };
}

router.post('/email', express.raw({ type: ['multipart/form-data', 'application/x-www-form-urlencoded'], limit: '15mb' }), async (req, res) => {
  const f = readFields(req);
  if (!process.env.MAILGUN_API_KEY && !process.env.MAILGUN_SIGNING_KEY) return res.status(503).json({ error: 'Email not configured' });
  if (!validSignature(f)) return res.status(401).json({ error: 'Bad signature' });

  const to = String(f.recipient || f.To || '');
  const m = /(?:^|[<\s,])b(\d+)@/i.exec(to);
  const businessId = m ? Number(m[1]) : null;
  if (!businessId) return res.status(406).json({ error: 'Unknown recipient' }); // 406 = Mailgun won't retry
  const { rows: [biz] } = await pool.query('SELECT id FROM businesses WHERE id = $1', [businessId]);
  if (!biz) return res.status(406).json({ error: 'Unknown store' });

  const from = parseAddress(f.from || f.From || f.sender);
  const addr = from.address.toLowerCase();
  // never file our own mail, bounces or system senders (avoids reply loops)
  if (!addr.includes('@') || addr === String(inboxAddress(businessId)).toLowerCase() || /^(mailer-daemon|postmaster|no-?reply)@/.test(addr)) return res.json({ ok: true, ignored: true });

  const body = (f['stripped-text'] || f['body-plain'] || '').trim();
  if (!body) return res.json({ ok: true, ignored: true });
  await recordInbound({
    businessId, channel: 'email', handle: addr, name: from.name || null,
    subject: (f.subject || f.Subject || '').slice(0, 200) || null, body,
    externalId: f['Message-Id'] || f['message-id'] || null,
  });
  res.json({ ok: true });
});

module.exports = router;
