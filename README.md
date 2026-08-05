# BizFlow API + Fully Connected Dashboard

**Status: integration complete.** Every panel in `bizflow_v2.html` now pulls
live data from this API — no hardcoded numbers left. This README documents
what's wired and how to run it.

## Run it

```bash
cd api
npm install
npm start
```
Runs at `http://localhost:4000`. Then open `bizflow_v2.html` in your browser
(same folder, one level up) — every tab will load real data automatically.

## What's live in each panel

### Dashboard
- 4 KPI cards, revenue chart, payment methods donut, orders-by-status bar
  chart, top products chart, and the activity feed — all fetched and
  rendered from `/api/dashboard/*` the moment the page loads.

### Orders
- Table loads from `GET /api/orders`.
- **Search box and status filter are live** — every keystroke/selection
  re-queries the API with `?search=` and `?status=` and re-renders the table.
- "New Order" still opens the AI assistant flow (unchanged).

### Customers
- Segment chart from `GET /api/customers/segments`.
- Detail card automatically shows your highest-spending customer
  (`GET /api/customers`, sorted by spend).
- Full customer table, all computed live from real order history.

### Inventory
- KPI cards + product list load from `/api/products/summary` and `/api/products`.
- **"Add product" is now a real action** — click it, answer the 4 prompts
  (name/cost/price/quantity), and it `POST`s to `/api/products`, then
  refreshes the list immediately.

### Payments
- KPI cards, the 7-day collections chart, and the payment log all load from
  `/api/payments/*`.
- **"Mark as paid" is now a real action** — click it, type an order ID
  (e.g. `BF-0041`) and a method, and it `POST`s to
  `/api/payments/:orderId/mark-paid`, then refreshes the log.

### WhatsApp
Still the "Phase 2 preview" mock — see the note in the original guide below
for how `POST /api/orders` already supports the flow it hints at.

## How the wiring works (the pattern used everywhere)

Every panel follows the same 3-step pattern:
1. HTML elements get an `id` (e.g. `id="kpi-revenue"`)
2. A `load...()` JS function `fetch()`s the relevant endpoint(s)
3. The response is used to fill in text (`.textContent`), build a Chart.js
   chart, or generate table rows (`.innerHTML = array.map(...).join('')`)

Panels other than Dashboard load **lazily** — the first time you click into
that tab — tracked with flags like `window._ordersDone`, so data isn't
fetched for tabs you never visit.

The action buttons (Add product, Mark as paid) use simple `prompt()` dialogs
to collect input rather than a full form UI — good enough to prove the real
`POST` requests work end-to-end; swap these for proper modals when you're
ready to polish the UI.

## Next steps when you're ready to go live

1. **Swap the in-memory arrays in `data/store.js` for a real database.**
   The route files won't need to change much — they just call functions;
   only `store.js` needs to talk to Postgres/MongoDB/etc instead.
2. **Add authentication** — right now anyone who knows the URL can call
   these endpoints. You'll want an `Authorization: Bearer <token>` header
   checked on every request before this touches real customer data.
3. **Deploy the API** somewhere (Render, Railway, Fly.io) and update
   `API_BASE` in `bizflow_v2.html` to point at the deployed URL instead of
   `localhost:4000` — this is the ONE line you'll need to change.
4. **Replace the `prompt()`-based actions** with real modal forms for a
   production-quality UI.

## Files

- `server.js` — wires up all the route modules
- `data/store.js` — in-memory data (seeded to match your mockup)
- `routes/dashboard.js` — KPI + chart aggregation endpoints
- `routes/orders.js` — orders CRUD + search/filter
- `routes/customers.js` — customers + segments
- `routes/inventory.js` — products CRUD + stock
- `routes/payments.js` — payment log + collections chart + mark-as-paid
