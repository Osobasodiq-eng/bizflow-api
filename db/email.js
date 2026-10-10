// db/email.js
//
// Sends order-tracking emails to buyers via Mailgun. This is a plain helper
// module (not an Express route) — it gets called from wherever an order is
// created or its status changes, same pattern as db/inventoryLog.js.
//
// Requires MAILGUN_API_KEY and MAILGUN_DOMAIN in the environment. If either
// is missing, or the send fails for any reason, this fails SILENTLY (logs
// to the server console but never throws) — a broken email should never be
// able to break someone's order from being created or updated. Email is a
// nice-to-have layered on top of the real transaction, not a dependency
// of it.
//
// Using Mailgun's sandbox domain: while on the sandbox, only email
// addresses added as "Authorized Recipients" in the Mailgun dashboard can
// actually receive mail — anyone else will silently fail to deliver. This
// is fine for testing with a handful of real addresses; a verified custom
// domain removes that limit later.

const STATUS_CONTENT = {
  New:        { subject: 'Order confirmed', heading: 'Your order is confirmed!', body: "We've received your order and the seller has been notified. We'll keep you posted as it moves along." },
  Processing: { subject: 'Order update: being prepared', heading: 'Your order is being prepared', body: 'The seller is getting your order ready.' },
  Shipped:    { subject: 'Order update: on its way', heading: 'Your order is on its way!', body: "Your order has shipped and is headed your way." },
  Delivered:  { subject: 'Order delivered', heading: 'Your order has been delivered', body: 'Thanks for shopping with us — we hope you love it!' },
  Cancelled:  { subject: 'Order cancelled', heading: 'Your order was cancelled', body: 'This order has been cancelled. Contact the seller directly if you have any questions.' },
};

// Pickup orders are never "shipped" — same stages, wording that fits.
const PICKUP_CONTENT = {
  Shipped:   { subject: 'Ready for pickup', heading: 'Your order is ready for pickup!', body: 'You can collect your order from the seller now.' },
  Delivered: { subject: 'Order collected', heading: 'Your order has been collected', body: 'Thanks for shopping with us — we hope you love it!' },
};

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Returns { sent: boolean, reason?: string } — never throws. Callers that
// don't care (order creation) can ignore the result; the fulfilment screen
// uses it to tell the seller whether the buyer was actually emailed.
async function sendOrderStatusEmail({ to, storeName, orderId, status, amount, courier, trackingNumber, note, isPickup }) {
  if (!to) return { sent: false, reason: 'no_email' }; // no email on file for this customer
  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
    console.log(`(Email skipped — Mailgun not configured) Would have emailed ${to} about ${orderId}: ${status}`);
    return { sent: false, reason: 'not_configured' };
  }
  const content = (isPickup && PICKUP_CONTENT[status]) || STATUS_CONTENT[status];
  if (!content) return { sent: false, reason: 'no_template' }; // not a status we send an email for

  const amountLine = amount != null ? `<p style="color:#6B7280;font-size:14px;">Order total: <strong>₦${Number(amount).toLocaleString('en-NG')}</strong></p>` : '';
  const trackingLine = (status === 'Shipped' && !isPickup && (courier || trackingNumber))
    ? `<div style="background:#F3F4F6;border-radius:8px;padding:12px 14px;margin:14px 0;font-size:14px;color:#374151;">
         ${courier ? `Courier: <strong>${esc(courier)}</strong><br>` : ''}
         ${trackingNumber ? `Tracking number: <strong>${esc(trackingNumber)}</strong>` : ''}
       </div>` : '';
  const noteLine = note ? `<p style="color:#374151;font-size:14px;border-left:3px solid #D1D5DB;padding-left:12px;margin:14px 0;">Message from the seller: ${esc(note)}</p>` : '';
  const store = esc(storeName || 'Kooza Store');

  try {
    const form = new URLSearchParams();
    // Sandbox domains can only send FROM an address on that same sandbox
    // domain — "postmaster@" is the one every sandbox domain has by default.
    form.append('from', `${(storeName || 'Kooza Store').replace(/[<>"]/g, '')} <postmaster@${process.env.MAILGUN_DOMAIN}>`);
    form.append('to', to);
    form.append('subject', `${content.subject} — ${orderId}`);
    form.append('html', `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;">
        <h2 style="margin:0 0 8px;">${content.heading}</h2>
        <p style="color:#4B5563;font-size:14px;">${content.body}</p>
        ${trackingLine}
        ${noteLine}
        <p style="color:#6B7280;font-size:14px;">Order number: <strong>${esc(orderId)}</strong></p>
        ${amountLine}
        <p style="color:#9CA3AF;font-size:12px;margin-top:28px;">Sent by ${store} via Kooza.</p>
      </div>
    `);

    const auth = Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64');
    const res = await fetch(`https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Order email failed for ${orderId} (${status}):`, err);
      return { sent: false, reason: 'send_failed' };
    }
    return { sent: true };
  } catch (err) {
    console.error(`Order email failed for ${orderId} (${status}):`, err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

// Sends the "reset your password" email. Same fail-silent rules as above.
async function sendPasswordResetEmail({ to, resetLink, token }) {
  if (!to) return;
  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
    console.log(`(Email skipped — Mailgun not configured) Would have sent a password reset email to ${to}`);
    return;
  }
  const action = resetLink
    ? `<p><a href="${resetLink}" style="display:inline-block;background:#4F46E5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Reset my password</a></p>
       <p style="color:#6B7280;font-size:12px;">Or paste this link into your browser:<br>${resetLink}</p>`
    : `<p style="color:#4B5563;font-size:14px;">Your reset code (paste it into the reset screen):</p>
       <p style="font-family:monospace;font-size:13px;word-break:break-all;background:#F3F4F6;padding:10px;border-radius:6px;">${token}</p>`;
  try {
    const form = new URLSearchParams();
    form.append('from', `Kooza <postmaster@${process.env.MAILGUN_DOMAIN}>`);
    form.append('to', to);
    form.append('subject', 'Reset your password');
    form.append('html', `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;">
        <h2 style="margin:0 0 8px;">Reset your password</h2>
        <p style="color:#4B5563;font-size:14px;">We got a request to reset the password on your account. This link works once and expires in 1 hour.</p>
        ${action}
        <p style="color:#9CA3AF;font-size:12px;margin-top:28px;">Didn't ask for this? You can ignore this email — your password won't change.</p>
      </div>`);
    const auth = Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64');
    const res = await fetch(`https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) console.error('Password reset email failed:', await res.text());
  } catch (err) {
    console.error('Password reset email failed:', err.message);
  }
}

module.exports = { sendOrderStatusEmail, sendPasswordResetEmail };
