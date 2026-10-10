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
- `/api/admin/*` — only emails listed in `ADMIN_EMAILS`

## Known unfinished
- `routes/whatsapp.js` and `data/store.js` are leftovers from the in-memory prototype. They are **not mounted** in `server.js` and the dashboard marks WhatsApp as "Soon". A real version needs a `whatsapp_threads` table and an inbound webhook.
- Cancelling or deleting an order does not return stock to inventory.
