# BizFlow / Kooza API

Multi-business API: Express + Postgres, JWT login, storefront checkout with
Paystack split payments, inventory, expenses, and a platform-owner admin view.
Every merchant route is scoped by `business_id` taken from the login token.

## Run locally
```bash
npm install
cp .env.example .env   # fill in what you need; export the vars or use your host's env UI
npm start              # runs db/migrate.js (idempotent) then server.js on :4000
```
Needs a Postgres database (`DATABASE_URL`). Without it, it falls back to
`postgresql://postgres:devpass@localhost:5432/bizflow_dev`.

## Environment variables
See `.env.example`. The important ones:
- `JWT_SECRET` — **must be set in production.** Without it the server uses a public default and anyone could forge a login.
- `DASHBOARD_URL` — used to build the link in password-reset emails (`<DASHBOARD_URL>/?reset=<token>`).
- `PAYSTACK_SECRET_KEY`, `MAILGUN_*`, `IMAGEKIT_*`, `ADMIN_EMAILS`.

## Paystack webhook (one-time setup)
Paystack Dashboard -> Settings -> API Keys & Webhooks -> Webhook URL:
`https://<your-api-host>/api/paystack-webhook`
This guarantees an order is created for every successful payment even if the
buyer closes the tab before being redirected back to the storefront. Calls are
verified with Paystack's signature; duplicates are safe (one order per reference).

## Route map
- `POST /api/auth/{signup,login,forgot-password,reset-password}` — public, rate-limited
- `/api/public/:businessId/*` — storefront (store, products, delivery-zones, orders, checkout/initialize, checkout/verify)
- `POST /api/paystack-webhook` — Paystack only (signature checked)
- Authenticated (Bearer token): `/api/dashboard`, `/api/orders`, `/api/customers`, `/api/products`, `/api/payments`, `/api/expenses`, `/api/delivery-zones`, `/api/business`, `/api/paystack`, `/api/imagekit`
- `/api/marketing/*` — email campaigns, segments, analytics (see below)
- `GET|POST /api/unsubscribe/:token` — public unsubscribe page linked from every marketing email
- `/api/fulfilment/*` — fulfilment board and status changes (see below)
- `/api/admin/*` — only emails listed in `ADMIN_EMAILS`

## Fulfilment & order emails
The dashboard's **Fulfilment** screen shows open orders as a board: New -> Preparing -> Shipped -> Delivered (Cancelled is a side branch).
- `GET /api/fulfilment/board` — orders grouped by stage
- `POST /api/fulfilment/:id/status` `{ status, note?, courier?, trackingNumber?, notify? }` — move one order
- `POST /api/fulfilment/bulk-status` `{ orderIds, status }` — move many at once
- `GET /api/fulfilment/:id/history` — status timeline (who was emailed)

Every move emails the customer (if they gave an email). Shipped emails include courier/tracking, pickup orders get "Ready for pickup" wording, and an optional note from the seller is included. Moves are forward-only; cancelling is allowed before shipping and **puts the stock back**. A cancelled order can't be reopened. All status changes (including the older order edit form) go through `db/fulfilment.js`. Needs Mailgun (`MAILGUN_*`) to actually send.

## Marketing (email campaigns)
Dashboard -> Marketing: Overview, Campaigns, Segments, Analytics.
- **Segments** are computed live from orders (`db/segments.js`): All, VIP, Ordered 30d, Inactive 60d, New this week, Never ordered. Only customers with an email who haven't unsubscribed can be emailed.
- **Campaigns**: write once, "Send test to me", save a draft, send now, or schedule. Sending runs in the background (`db/campaigns.js`), one row per recipient in `campaign_recipients`; a minute-by-minute check starts scheduled campaigns when due and resumes interrupted sends. On a free host that sleeps, a scheduled campaign goes out when the server next wakes up.
- **Unsubscribe**: every email has a signed unsubscribe link (+ List-Unsubscribe header). Needs `API_URL` or Render's automatic `RENDER_EXTERNAL_URL`.
- **Sales tracking**: the email's "Shop now" button opens your storefront with `?c=<campaign id>`; orders placed in that visit are credited to the campaign (paid revenue shown in Analytics). Needs `STOREFRONT_URL`.
- Returning buyers are matched to the existing customer by phone number (ignoring spaces/dashes) instead of creating a duplicate.
- Needs Mailgun configured. On Mailgun's free sandbox only authorised recipients receive mail — verify your own domain to email real customers.

## Marketing automations

Two emails that send themselves (Dashboard → Marketing → Automations), both **off by default**:
- **30-day win-back** — a customer's last order was N days ago and they haven't returned (max once per customer per 60 days).
- **Post-purchase follow-up** — N days after an order is placed (once per order).

Switching one on only affects things that happen from that moment — it never emails past customers in bulk. Customers with no email or who unsubscribed are skipped. A check runs every 5 minutes while the server is awake (due emails go out when a sleeping Render instance wakes). Sales from the "Shop now" button are attributed the same way as campaigns. Requires the same Mailgun setup as campaigns. Tables: `automations`, `automation_sends` (in `db/schema.sql`).

## Content calendar

Dashboard → Content calendar: plan posts by day (Instagram, WhatsApp status, Facebook, TikTok), copy captions, mark as posted. Posting happens on your own accounts — no Meta connection needed. The **Write for me** button drafts a caption from a title and/or product: with `ANTHROPIC_API_KEY` set it uses Claude (optional `ANTHROPIC_MODEL`, default `claude-haiku-5-5`, limited to 20 per shop per hour); without it, it fills in a simple template. Table: `content_posts`.

## Inbox

Dashboard → Inbox: one place for customer messages, with replies sent from the app.

- **Storefront chat** — a "Message us" button on the storefront. Works with no setup. Each visitor gets a private thread (a secret token kept in their browser); the email/phone they type is only a label.
- **Email** — customers' replies to your campaigns, automations and order emails land in the inbox. One-time setup:
  1. Mailgun → Receiving → Create route → *Match Recipient* `b.*@YOUR_MAILGUN_DOMAIN` → Action *Forward* to `https://YOUR-API/api/inbound/email`.
  2. In Render add `MAILGUN_INBOUND=true`. (Until then replies keep going to the owner's own mailbox, so nothing is lost.)
  Each store's address is `b<storeId>@YOUR_MAILGUN_DOMAIN`. Needs a verified Mailgun domain — the free sandbox can't receive mail. Incoming requests are checked against Mailgun's signature.
- **WhatsApp / Instagram / Facebook** — not connected yet (need a Meta Business account). They will plug into `db/inbox.js` (`recordInbound` for incoming, a branch in `sendReply` for outgoing).

Tables: `inbox_conversations`, `inbox_messages`.

## Known unfinished
- WhatsApp / Instagram messaging, the shared inbox and the content calendar are not built (they need Meta approvals; the dashboard shows them as "Soon").
- `routes/whatsapp.js` and `data/store.js` are leftovers from the in-memory prototype. They are **not mounted** in `server.js` and the dashboard marks WhatsApp as "Soon". A real version needs a `whatsapp_threads` table and an inbound webhook.
- Deleting an order (as opposed to cancelling it) does not return stock to inventory.
