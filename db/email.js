// db/email.js
//
// Sends order-tracking emails to buyers via Resend. This is a plain helper
// module (not an Express route) — it gets called from wherever an order is
// created or its status changes, same pattern as db/inventoryLog.js.
//
// Requires RESEND_API_KEY in the environment. If it's missing, or the send
// fails for any reason, this fails SILENTLY (logs to the server console but
// never throws) — a broken email should never be able to break someone's
// order from being created or updated. Email is a nice-to-have layered on
// top of the real transaction, not a dependency of it.

const STATUS_CONTENT = {
  New:        { subject: 'Order confirmed', heading: 'Your order is confirmed!', body: "We've received your order and the seller has been notified. We'll keep you posted as it moves along." },
  Processing: { subject: 'Order update: being prepared', heading: 'Your order is being prepared', body: 'The seller is getting your order ready.' },
  Shipped:    { subject: 'Order update: on its way', heading: 'Your order is on its way!', body: "Your order has shipped and is headed your way." },
  Delivered:  { subject: 'Order delivered', heading: 'Your order has been delivered', body: 'Thanks for shopping with us — we hope you love it!' },
  Cancelled:  { subject: 'Order cancelled', heading: 'Your order was cancelled', body: 'This order has been cancelled. Contact the seller directly if you have any questions.' },
};

async function sendOrderStatusEmail({ to, storeName, orderId, status, amount }) {
  if (!to) return; // no email on file for this customer — nothing to do
  if (!process.env.RESEND_API_KEY) {
    console.log(`(Email skipped — RESEND_API_KEY not set) Would have emailed ${to} about ${orderId}: ${status}`);
    return;
  }
  const content = STATUS_CONTENT[status];
  if (!content) return; // not a status we send an email for

  const amountLine = amount != null ? `<p style="color:#6B7280;font-size:14px;">Order total: <strong>₦${Number(amount).toLocaleString('en-NG')}</strong></p>` : '';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Uses Resend's shared testing domain — works immediately with no
        // setup, but only the "onboarding@resend.dev" address itself can
        // be used until a real domain is verified on the Resend account.
        from: `${storeName || 'BizFlow Store'} <onboarding@resend.dev>`,
        to: [to],
        subject: `${content.subject} — ${orderId}`,
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;">
            <h2 style="margin:0 0 8px;">${content.heading}</h2>
            <p style="color:#4B5563;font-size:14px;">${content.body}</p>
            <p style="color:#6B7280;font-size:14px;">Order number: <strong>${orderId}</strong></p>
            ${amountLine}
            <p style="color:#9CA3AF;font-size:12px;margin-top:28px;">Sent by ${storeName || 'your seller'} via BizFlow.</p>
          </div>
        `,
      }),
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
