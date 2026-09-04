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

async function sendOrderStatusEmail({ to, storeName, orderId, status, amount }) {
  if (!to) return; // no email on file for this customer — nothing to do
  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
    console.log(`(Email skipped — Mailgun not configured) Would have emailed ${to} about ${orderId}: ${status}`);
    return;
  }
  const content = STATUS_CONTENT[status];
  if (!content) return; // not a status we send an email for

  const amountLine = amount != null ? `<p style="color:#6B7280;font-size:14px;">Order total: <strong>₦${Number(amount).toLocaleString('en-NG')}</strong></p>` : '';

  try {
    const form = new URLSearchParams();
    // Sandbox domains can only send FROM an address on that same sandbox
    // domain — "postmaster@" is the one every sandbox domain has by default.
    form.append('from', `${storeName || 'Kooza Store'} <postmaster@${process.env.MAILGUN_DOMAIN}>`);
    form.append('to', to);
    form.append('subject', `${content.subject} — ${orderId}`);
    form.append('html', `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;">
        <h2 style="margin:0 0 8px;">${content.heading}</h2>
        <p style="color:#4B5563;font-size:14px;">${content.body}</p>
        <p style="color:#6B7280;font-size:14px;">Order number: <strong>${orderId}</strong></p>
        ${amountLine}
        <p style="color:#9CA3AF;font-size:12px;margin-top:28px;">Sent by ${storeName || 'your seller'} via Kooza.</p>
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
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Order email failed for ${orderId} (${status}):`, err);
    }
  } catch (err) {
    console.error(`Order email failed for ${orderId} (${status}):`, err.message);
  }
}

module.exports = { sendOrderStatusEmail };
