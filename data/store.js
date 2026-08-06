// data/store.js
// In-memory "database" — starts EMPTY so you can add your own real products,
// customers, and orders through the dashboard instead of sample data.
// Swap this for a real database (Postgres, MongoDB, etc) later — the routes
// won't need to change much since they just call these functions.
//
// Note: because this is in-memory, everything you add here resets whenever
// the server restarts (which Render does periodically, and on every code
// update). That's expected for now — moving to a real database (our next
// planned step) is what makes data permanent.

let products = [];

let customers = [];

let orders = [];

let payments = [];

let activity = [];

// WhatsApp feature is currently disabled in the UI ("Soon"), so this stays
// empty — kept here so the API doesn't break if something still references it.
let whatsappThreads = [];

let nextOrderNum = 1;
let nextPaymentNum = 1;

module.exports = {
  products, customers, orders, payments, activity, whatsappThreads,
  nextOrderId: () => `BF-${String(nextOrderNum++).padStart(4, '0')}`,
  nextPaymentId: () => `PAY-${nextPaymentNum++}`,
};
