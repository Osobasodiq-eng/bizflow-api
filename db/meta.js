// db/meta.js — Meta (WhatsApp Business, Facebook Messenger, Instagram DMs) for the shared inbox.
//   Env: META_APP_ID, META_APP_SECRET        from developers.facebook.com -> your app -> Settings -> Basic
//        META_VERIFY_TOKEN                   any secret string; you paste the same one into Meta's webhook setup
//        META_WA_CONFIG_ID                   the "Embedded Signup" configuration id (WhatsApp)
//        META_GRAPH_VERSION                  optional, default v23.0
//        META_TOKEN_KEY                      optional secret used to encrypt stored tokens (falls back to JWT_SECRET)
const crypto = require('crypto');
const pool = require('./pool');

const cfg = () => ({
  appId: process.env.META_APP_ID || '', appSecret: process.env.META_APP_SECRET || '',
  verifyToken: process.env.META_VERIFY_TOKEN || '', waConfigId: process.env.META_WA_CONFIG_ID || '',
  version: process.env.META_GRAPH_VERSION || 'v23.0',
});
const configured = () => { const c = cfg(); return !!(c.appId && c.appSecret); };
const SCOPES = 'pages_show_list,pages_messaging,pages_manage_metadata,instagram_basic,instagram_manage_messages,business_management';

// ---- token encryption at rest (AES-256-GCM) ----
const key = () => crypto.createHash('sha256').update(process.env.META_TOKEN_KEY || process.env.JWT_SECRET || 'dev-only-key').digest();
function seal(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv), enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.'); }
function unseal(blob) { const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); }

// ---- Graph API ----
async function graph(path, { method = 'GET', token, params = {}, body } = {}) {
  const c = cfg(), url = new URL(`https://graph.facebook.com/${c.version}/${path.replace(/^\//, '')}`);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {}; const err = new Error(e.error_user_msg || e.message || `Meta responded ${res.status}`);
    err.code = e.code; err.subcode = e.error_subcode; err.status = res.status; throw err;
  }
  return data;
}

// ---- signature check for webhook calls ----
function validSignature(rawBody, header) {
  const { appSecret } = cfg(); if (!appSecret || !rawBody || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- stored channels ----
const PUBLIC_COLS = 'id, channel, external_id, name, detail, status, last_error, created_at';
async function listChannels(businessId) {
  try { return (await pool.query(`SELECT ${PUBLIC_COLS} FROM meta_channels WHERE business_id = $1 ORDER BY id`, [businessId])).rows; } catch (e) { return []; }
}
async function upsertChannel(businessId, { channel, externalId, name, detail, token, wabaId, pageId, fbUserId }) {
  const { rows: [taken] } = await pool.query('SELECT business_id FROM meta_channels WHERE channel = $1 AND external_id = $2', [channel, externalId]);
  if (taken && taken.business_id !== businessId) throw { status: 409, message: 'That account is already connected to another store.' };
  const { rows: [row] } = await pool.query(
    `INSERT INTO meta_channels (business_id, channel, external_id, name, detail, token, waba_id, page_id, fb_user_id, status, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',NULL)
     ON CONFLICT (channel, external_id) DO UPDATE SET name = EXCLUDED.name, detail = EXCLUDED.detail, token = EXCLUDED.token, waba_id = EXCLUDED.waba_id,
       page_id = EXCLUDED.page_id, fb_user_id = EXCLUDED.fb_user_id, status = 'active', last_error = NULL
     RETURNING ${PUBLIC_COLS}`,
    [businessId, channel, String(externalId), name || null, detail || null, seal(token), wabaId || null, pageId || null, fbUserId || null]);
  return row;
}
const flagBroken = (id, msg) => pool.query(`UPDATE meta_channels SET status = 'error', last_error = $2 WHERE id = $1`, [id, String(msg).slice(0, 300)]).catch(() => {});

// ---- WhatsApp: Embedded Signup finishes with a code + the new waba/phone ids ----
const waPin = phoneId => String(parseInt(crypto.createHmac('sha256', cfg().appSecret).update('wa-pin:' + phoneId).digest('hex').slice(0, 8), 16) % 1e6).padStart(6, '0');
async function connectWhatsApp(businessId, { code, wabaId, phoneNumberId }) {
  if (!configured()) throw { status: 503, message: 'Meta isn\'t set up on this server yet.' };
  if (!code || !wabaId || !phoneNumberId) throw { status: 400, message: 'The WhatsApp sign-up didn\'t finish. Please try again.' };
  const c = cfg();
  let token;
  try { token = (await graph('oauth/access_token', { params: { client_id: c.appId, client_secret: c.appSecret, code } })).access_token; }
  catch (e) { throw { status: 400, message: 'Meta rejected the sign-up code. Please try again.' }; }
  let info = {};
  try { info = await graph(phoneNumberId, { token, params: { fields: 'display_phone_number,verified_name' } }); }
  catch (e) { throw { status: 400, message: `Couldn't read that WhatsApp number: ${e.message}` }; }
  await graph(`${wabaId}/subscribed_apps`, { method: 'POST', token }).catch(e => { throw { status: 502, message: `Couldn't subscribe to WhatsApp messages: ${e.message}` }; });
  // Registering is needed for new numbers; harmless if it's already registered.
  await graph(`${phoneNumberId}/register`, { method: 'POST', token, body: { messaging_product: 'whatsapp', pin: waPin(phoneNumberId) } }).catch(() => {});
  return upsertChannel(businessId, { channel: 'whatsapp', externalId: phoneNumberId, name: info.verified_name || 'WhatsApp', detail: info.display_phone_number || '', token, wabaId });
}

// ---- Facebook page (+ linked Instagram) ----
async function pagesFor(userToken) {
  const c = cfg(); let long = userToken;
  try { long = (await graph('oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: userToken } })).access_token || userToken; } catch (e) { /* use the short one */ }
  const [me, pages] = await Promise.all([graph('me', { token: long, params: { fields: 'id' } }), graph('me/accounts', { token: long, params: { fields: 'id,name,access_token,instagram_business_account{id,username,name}', limit: 50 } })]);
  return { fbUserId: me.id, pages: pages.data || [] };
}
async function discoverPages(accessToken) {
  if (!configured()) throw { status: 503, message: 'Meta isn\'t set up on this server yet.' };
  try { const { pages } = await pagesFor(accessToken); return pages.map(p => ({ id: p.id, name: p.name, instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username || p.instagram_business_account.name } : null })); }
  catch (e) { throw { status: 400, message: `Couldn't read your Facebook pages: ${e.message}` }; }
}
async function connectPage(businessId, { accessToken, pageId, instagram }) {
  if (!configured()) throw { status: 503, message: 'Meta isn\'t set up on this server yet.' };
  let found;
  try { found = await pagesFor(accessToken); } catch (e) { throw { status: 400, message: `Couldn't read your Facebook pages: ${e.message}` }; }
  const page = found.pages.find(p => p.id === String(pageId));
  if (!page) throw { status: 404, message: 'That page wasn\'t found on your Facebook account.' };
  await graph(`${page.id}/subscribed_apps`, { method: 'POST', token: page.access_token, params: { subscribed_fields: 'messages,messaging_postbacks' } })
    .catch(e => { throw { status: 502, message: `Couldn't subscribe to the page's messages: ${e.message}` }; });
  const out = [await upsertChannel(businessId, { channel: 'facebook', externalId: page.id, name: page.name, detail: 'Messenger', token: page.access_token, fbUserId: found.fbUserId })];
  const ig = page.instagram_business_account;
  if (instagram && ig) out.push(await upsertChannel(businessId, { channel: 'instagram', externalId: ig.id, name: ig.username || ig.name || 'Instagram', detail: ig.username ? '@' + ig.username : 'Instagram', token: page.access_token, pageId: page.id, fbUserId: found.fbUserId }));
  return out;
}

async function disconnect(businessId, id) {
  const { rows: [r] } = await pool.query('SELECT * FROM meta_channels WHERE id = $1 AND business_id = $2', [id, businessId]);
  if (!r) throw { status: 404, message: 'Channel not found' };
  try {
    const token = unseal(r.token);
    if (r.channel === 'whatsapp' && r.waba_id) await graph(`${r.waba_id}/subscribed_apps`, { method: 'DELETE', token });
    if (r.channel === 'facebook') await graph(`${r.external_id}/subscribed_apps`, { method: 'DELETE', token });
  } catch (e) { /* the token may already be revoked — still remove it here */ }
  await pool.query('DELETE FROM meta_channels WHERE id = $1', [id]);
}

// ---- sending ----
const WINDOW_MS = 24 * 3600 * 1000;
async function channelFor(conv) {
  const q = conv.meta_channel_id
    ? await pool.query('SELECT * FROM meta_channels WHERE id = $1 AND business_id = $2', [conv.meta_channel_id, conv.business_id])
    : await pool.query(`SELECT * FROM meta_channels WHERE business_id = $1 AND channel = $2 AND status = 'active' ORDER BY id LIMIT 1`, [conv.business_id, conv.channel]);
  return q.rows[0] || null;
}
// Meta only allows free-form replies within 24 hours of the customer's last message.
async function replyWindow(conversationId) {
  const { rows: [r] } = await pool.query(`SELECT max(created_at) AS at FROM inbox_messages WHERE conversation_id = $1 AND direction = 'in'`, [conversationId]);
  const last = r && r.at ? new Date(r.at).getTime() : 0, ends = last + WINDOW_MS;
  return { open: Date.now() < ends, endsAt: last ? new Date(ends).toISOString() : null };
}
// Returns the provider's message id. Throws { status, message } with a merchant-friendly reason.
async function sendText(conv, text) {
  const ch = await channelFor(conv);
  if (!ch) throw { status: 400, message: `${conv.channel === 'whatsapp' ? 'WhatsApp' : conv.channel === 'instagram' ? 'Instagram' : 'Facebook'} isn't connected. Open Inbox → Channels to connect it.` };
  const win = await replyWindow(conv.id);
  if (!win.open) throw { status: 400, message: 'It\'s been more than 24 hours since this customer last wrote, so Meta doesn\'t allow a free-form reply. When they message again you can reply.' };
  const token = unseal(ch.token);
  try {
    if (ch.channel === 'whatsapp') {
      const d = await graph(`${ch.external_id}/messages`, { method: 'POST', token, body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: conv.contact_handle, type: 'text', text: { preview_url: true, body: text } } });
      return d.messages && d.messages[0] && d.messages[0].id;
    }
    const pageId = ch.channel === 'instagram' ? ch.page_id : ch.external_id;
    const d = await graph(`${pageId}/messages`, { method: 'POST', token, body: { recipient: { id: conv.contact_handle }, messaging_type: 'RESPONSE', message: { text } } });
    return d.message_id;
  } catch (e) {
    if (e.code === 190) { await flagBroken(ch.id, 'Access expired — reconnect this channel'); throw { status: 400, message: 'Your Meta connection expired. Open Inbox → Channels and reconnect.' }; }
    if (e.code === 131047 || e.code === 10) throw { status: 400, message: 'Meta blocked this reply because the 24-hour window has closed.' };
    throw { status: 502, message: e.message };
  }
}

// ---- receiving: one webhook for all three products ----
const kindOf = m => (m.type && m.type !== 'text') ? ({ image: 'Photo', video: 'Video', audio: 'Voice note', voice: 'Voice note', document: 'Document', sticker: 'Sticker', location: 'Location', contacts: 'Contact', reaction: 'Reaction' }[m.type] || m.type) : null;
const waText = m => {
  if (m.type === 'text') return m.text && m.text.body;
  if (m.type === 'button') return m.button && m.button.text;
  if (m.type === 'interactive') { const i = m.interactive || {}; return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title); }
  const cap = m[m.type] && m[m.type].caption; const k = kindOf(m);
  return k ? `[${k}]${cap ? ' ' + cap : ''}` : null;
};
const msgText = m => {
  if (m.text) return m.text;
  const a = (m.attachments || [])[0]; if (!a) return null;
  const k = { image: 'Photo', video: 'Video', audio: 'Voice note', file: 'File', location: 'Location', share: 'Shared post', story_mention: 'Story mention', reel: 'Reel', ig_reel: 'Reel' }[a.type] || 'Attachment';
  return `[${k}]`;
};

async function profileName(ch, userId) {
  try { const d = await graph(userId, { token: unseal(ch.token), params: { fields: ch.channel === 'instagram' ? 'name,username' : 'name' } }); return d.name || d.username || null; } catch (e) { return null; }
}
async function setStatus(ch, id, status, errText) {
  await pool.query(`UPDATE inbox_messages SET status = $3, error = COALESCE($4, error) WHERE business_id = $1 AND external_id = $2 AND direction = 'out'
                    AND NOT (status = 'read' AND $3 = 'delivered')`, [ch.business_id, id, status, errText || null]).catch(() => {});
}

async function handleWebhook(body) {
  const { recordInbound } = require('./inbox'); // late require: inbox.js loads this file too
  if (!body || !Array.isArray(body.entry)) return;
  for (const entry of body.entry) {
    try {
      if (body.object === 'whatsapp_business_account') {
        for (const chg of entry.changes || []) {
          if (chg.field !== 'messages') continue; const v = chg.value || {};
          const phoneId = v.metadata && v.metadata.phone_number_id; if (!phoneId) continue;
          const { rows: [ch] } = await pool.query(`SELECT * FROM meta_channels WHERE channel = 'whatsapp' AND external_id = $1`, [String(phoneId)]); if (!ch) continue;
          const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile && c.profile.name]));
          for (const m of v.messages || []) {
            const text = waText(m); if (!text) continue;
            const r = await recordInbound({ businessId: ch.business_id, channel: 'whatsapp', handle: m.from, name: names[m.from] || null, detail: '+' + m.from, body: text, externalId: m.id });
            if (r && r.conversation) await pool.query('UPDATE inbox_conversations SET meta_channel_id = $1 WHERE id = $2', [ch.id, r.conversation.id]);
          }
          for (const s of v.statuses || []) await setStatus(ch, s.id, s.status === 'failed' ? 'failed' : s.status, s.errors && s.errors[0] && (s.errors[0].message || s.errors[0].title));
        }
      } else if (body.object === 'page' || body.object === 'instagram') {
        const kind = body.object === 'page' ? 'facebook' : 'instagram';
        const { rows: [ch] } = await pool.query('SELECT * FROM meta_channels WHERE channel = $1 AND external_id = $2', [kind, String(entry.id)]); if (!ch) continue;
        for (const ev of entry.messaging || []) {
          const m = ev.message; if (!m || m.is_echo || !ev.sender) continue; // echoes are our own replies
          const text = msgText(m); if (!text) continue;
          const { rows: [known] } = await pool.query('SELECT id FROM inbox_conversations WHERE business_id = $1 AND channel = $2 AND contact_handle = $3', [ch.business_id, kind, ev.sender.id]);
          const name = known ? null : await profileName(ch, ev.sender.id);
          const r = await recordInbound({ businessId: ch.business_id, channel: kind, handle: ev.sender.id, name, body: text, externalId: m.mid });
          if (r && r.conversation) await pool.query('UPDATE inbox_conversations SET meta_channel_id = $1 WHERE id = $2', [ch.id, r.conversation.id]);
        }
      }
    } catch (e) { console.error('[meta] webhook entry failed:', e.message || e); }
  }
}

// Meta's "data deletion" / "deauthorize" callbacks send a signed_request. Returns the Facebook user id, or null.
function readSignedRequest(signed) {
  const [sig, payload] = String(signed || '').split('.'); if (!sig || !payload) return null;
  const expected = crypto.createHmac('sha256', cfg().appSecret).update(payload).digest();
  const got = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try { return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).user_id || null; } catch (e) { return null; }
}
async function forgetUser(fbUserId) { const r = await pool.query('DELETE FROM meta_channels WHERE fb_user_id = $1', [String(fbUserId)]).catch(() => ({ rowCount: 0 })); return r.rowCount; }

module.exports = { cfg, configured, SCOPES, validSignature, listChannels, connectWhatsApp, discoverPages, connectPage, disconnect, sendText, replyWindow, handleWebhook, readSignedRequest, forgetUser, seal, unseal };
