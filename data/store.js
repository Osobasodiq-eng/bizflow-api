// data/store.js
// In-memory "database" seeded with the exact data your dashboard mockup shows.
// Swap this for a real database (Postgres, MongoDB, etc) later — the routes
// won't need to change much since they just call these functions.

let products = [
  { id: 'DS-001', name: 'Oud Noir 50ml',  cost: 8000,  price: 18500, quantity: 18, threshold: 5, category: 'Oud' },
  { id: 'DS-002', name: 'Oud Noir 100ml', cost: 14000, price: 32000, quantity: 11, threshold: 5, category: 'Oud' },
  { id: 'DS-003', name: 'Rose Silk',      cost: 5500,  price: 12000, quantity: 4,  threshold: 5, category: 'Floral' },
  { id: 'DS-004', name: 'Amber Musk',     cost: 6000,  price: 14500, quantity: 2,  threshold: 5, category: 'Musk' },
  { id: 'DS-005', name: 'Cedar & Oud',    cost: 9000,  price: 20000, quantity: 0,  threshold: 5, category: 'Oud' },
];

let customers = [
  { id: 'C-001', name: 'Amaka Okonkwo', phone: '+234 803 441 2211', location: 'Lagos Island', since: '2025-01-01', tag: 'VIP' },
  { id: 'C-002', name: 'Chioma Ike',    phone: '+234 801 933 4409', location: 'Lekki',        since: '2025-02-14', tag: 'VIP' },
  { id: 'C-003', name: 'Fatima Kamara', phone: '+234 809 226 7700', location: 'Ikeja',         since: '2025-03-20', tag: 'Frequent' },
  { id: 'C-004', name: 'Tunde Eze',     phone: '+234 706 548 2213', location: 'Surulere',       since: '2025-04-02', tag: 'Frequent' },
  { id: 'C-005', name: 'Ngozi Bello',   phone: '+234 812 004 8817', location: 'Yaba',           since: '2026-06-01', tag: 'New' },
  { id: 'C-006', name: 'Mide Ojo',      phone: '+234 705 112 9938', location: 'Ajah',           since: '2025-05-10', tag: 'At Risk' },
];

let orders = [
  { id: 'BF-0042', customerId: 'C-001', items: [{ productId: 'DS-001', name: 'Oud Noir 50ml', qty: 1 }], amount: 18500, paymentStatus: 'Paid',     status: 'Shipped',    delivery: 'GIG Logistics', date: '2026-06-09T09:00:00Z' },
  { id: 'BF-0041', customerId: 'C-003', items: [{ productId: 'DS-003', name: 'Rose Silk', qty: 2 }],     amount: 24000, paymentStatus: 'Awaiting', status: 'Processing', delivery: null,            date: '2026-06-09T08:30:00Z' },
  { id: 'BF-0040', customerId: 'C-004', items: [{ productId: 'DS-004', name: 'Amber Musk', qty: 1 }],    amount: 14500, paymentStatus: 'Paid',     status: 'Shipped',    delivery: 'Kwik',          date: '2026-06-09T05:00:00Z' },
  { id: 'BF-0039', customerId: 'C-005', items: [{ productId: 'DS-002', name: 'Oud Noir 100ml', qty: 1 }],amount: 32000, paymentStatus: 'Awaiting', status: 'New',        delivery: null,            date: '2026-06-09T09:03:00Z' },
  { id: 'BF-0038', customerId: 'C-002', items: [{ productId: 'DS-003', name: 'Rose Silk', qty: 1 }, { productId: 'DS-004', name: 'Amber Musk', qty: 1 }], amount: 26000, paymentStatus: 'Paid', status: 'Delivered', delivery: 'Kwik', date: '2026-06-08T10:00:00Z' },
  { id: 'BF-0037', customerId: 'C-006', items: [{ productId: 'DS-005', name: 'Cedar & Oud', qty: 1 }],   amount: 20000, paymentStatus: 'Cancelled', status: 'Cancelled', delivery: null,          date: '2026-06-07T12:00:00Z' },
];

let payments = [
  { id: 'PAY-1', orderId: 'BF-0042', customerId: 'C-001', amount: 18500, method: 'Transfer', ref: 'TRF9283', status: 'Confirmed', date: '2026-06-09T11:42:00Z' },
  { id: 'PAY-2', orderId: 'BF-0041', customerId: 'C-003', amount: 24000, method: 'Transfer', ref: null,      status: 'Awaiting',  date: null },
  { id: 'PAY-3', orderId: 'BF-0040', customerId: 'C-004', amount: 14500, method: 'POS',      ref: 'POS441',  status: 'Confirmed', date: '2026-06-09T09:11:00Z' },
  { id: 'PAY-4', orderId: 'BF-0038', customerId: 'C-002', amount: 26000, method: 'Transfer', ref: 'TRF9201', status: 'Confirmed', date: '2026-06-08T10:00:00Z' },
];

let activity = [
  { id: 1, text: "Tunde's order shipped via GIG", meta: 'Order #BF-0040', date: '2026-06-09T14:15:00Z' },
  { id: 2, text: '₦18,500 transfer confirmed',    meta: 'Amaka O.',        date: '2026-06-09T11:42:00Z' },
  { id: 3, text: 'Rose Silk stock alert — 4 left', meta: 'Inventory',       date: '2026-06-09T10:04:00Z' },
  { id: 4, text: 'Ngozi placed new order',         meta: 'Order #BF-0039', date: '2026-06-09T09:03:00Z' },
];

// WhatsApp threads — in a real system, an NLP/AI step would populate `detected`
// from the message text. Here it's pre-computed to keep the demo focused on
// the API/integration layer rather than building an NLP pipeline.
let whatsappThreads = [
  {
    id: 'WA-1',
    phone: '+234 805 772 3318',
    customerId: null, // null = unknown/new customer
    status: 'pending', // pending | ordered | ignored
    messages: [
      { from: 'them', text: 'Hi, I want the Rose Silk perfume. How much is it?' },
      { from: 'us',   text: 'Rose Silk is ₦12,000 + ₦1,500 delivery. Should I create your order?' },
      { from: 'them', text: "Yes please! I'm in Lekki Phase 1" },
    ],
    detected: { productId: 'DS-003', qty: 1, location: 'Lekki Phase 1', deliveryFee: 1500, isNewCustomer: true },
  },
];

let nextOrderNum = 43;
let nextPaymentNum = 5;

module.exports = {
  products, customers, orders, payments, activity, whatsappThreads,
  nextOrderId: () => `BF-${String(nextOrderNum++).padStart(4, '0')}`,
  nextPaymentId: () => `PAY-${nextPaymentNum++}`,
};
