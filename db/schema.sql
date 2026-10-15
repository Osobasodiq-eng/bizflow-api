-- schema.sql
-- Every table below (except `businesses` itself) has a `business_id` column.
-- This is THE mechanism that keeps Friend A's data separate from Friend B's:
-- every query in every route file filters by business_id, so it's physically
-- impossible for one business's API calls to touch another's rows.

CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  logo_url TEXT,
  banner_url TEXT,
  description TEXT,
  theme TEXT NOT NULL DEFAULT 'forest',
  delivery_fee NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One business can have multiple staff logins later; for now, one user = one business.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Holds short-lived reset tokens. We store a HASH of the token, never the
-- token itself — same principle as password_hash: if this table ever leaked,
-- the hashes alone can't be used to reset anyone's account.
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Uncategorized',
  cost NUMERIC NOT NULL DEFAULT 0,
  price NUMERIC NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  threshold INTEGER NOT NULL DEFAULT 5,
  image_url TEXT,
  description TEXT,
  specifications JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_zones (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_name TEXT NOT NULL,
  fee NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_zones_business ON delivery_zones(business_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  price NUMERIC NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_business ON product_variants(business_id);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  location TEXT,
  tag TEXT NOT NULL DEFAULT 'New',
  since TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  items JSONB NOT NULL, -- [{productId, name, qty}] — kept as JSON, same shape as before
  amount NUMERIC NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'Awaiting',
  status TEXT NOT NULL DEFAULT 'New',
  delivery TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  method TEXT NOT NULL,
  ref TEXT,
  status TEXT NOT NULL DEFAULT 'Confirmed',
  paid_at TIMESTAMPTZ
);

-- Money going OUT of the business — rent, transport, supplies, etc. Tracked
-- separately from payments (money coming IN), so real profit (revenue minus
-- expenses) can be computed instead of just showing raw sales.
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  amount NUMERIC NOT NULL,
  expense_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit trail of every stock quantity change — sales, manual edits, new
-- stock added, imports, deletions. product_id is ON DELETE SET NULL (not
-- CASCADE) so history survives even after a product is deleted; product_name
-- is stored as a snapshot so old entries still make sense later.
CREATE TABLE IF NOT EXISTS inventory_history (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  change_type TEXT NOT NULL,
  quantity_change INTEGER NOT NULL,
  quantity_before INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes so lookups scoped by business stay fast as data grows
CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_business ON orders(business_id);
CREATE INDEX IF NOT EXISTS idx_payments_business ON payments(business_id);
CREATE INDEX IF NOT EXISTS idx_expenses_business ON expenses(business_id);
CREATE INDEX IF NOT EXISTS idx_inventory_history_business ON inventory_history(business_id);

-- Added later: product photo links (ImageKit URLs). IF NOT EXISTS makes this
-- safe to run against the live database, which already has a products table
-- without this column — running it again does nothing on a fresh install
-- where the CREATE TABLE above already included it.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS specifications JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Several photos per product (first = main photo, mirrored in image_url)
ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE products SET images = jsonb_build_array(image_url) WHERE image_url IS NOT NULL AND image_url <> '' AND images = '[]'::jsonb;

-- Added later: storefront customization (logo, banner, description, theme)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS banner_url TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'forest';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC NOT NULL DEFAULT 0;

-- Paystack subaccount details, once a merchant links their bank account
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS paystack_subaccount_code TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS paystack_bank_code TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS paystack_bank_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS paystack_account_number TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS paystack_account_name TEXT;

-- Set once a Paystack payment for this order is verified, so we never
-- accidentally create the same order twice (e.g. buyer reloads the
-- confirmation page after paying)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paystack_reference TEXT UNIQUE;

-- Needed so order-status emails have somewhere to send to
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT;

-- Fulfilment: shipping details on the order, plus a record of every status change
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS order_status_history (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  customer_notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_business_status ON orders(business_id, status);

-- Marketing: email campaigns, who each one was sent to, and attribution
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  segment TEXT NOT NULL DEFAULT 'all',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | sending | sent | failed
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_business ON campaigns(business_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status, scheduled_at);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  error TEXT,
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients(campaign_id, status);

-- Which campaign's link a buyer came through (set at checkout)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_campaign ON orders(campaign_id);

-- Marketing automations: emails that send themselves when something happens
-- (e.g. a customer goes quiet for 30 days, or 3 days after an order).
CREATE TABLE IF NOT EXISTS automations (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- win_back | post_purchase
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  delay_days INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,            -- only things that happen AFTER this trigger an email (no blasting history)
  bucket_campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL, -- hidden campaign row that collects this automation's sales attribution
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, kind)
);

CREATE TABLE IF NOT EXISTS automation_sends (
  id SERIAL PRIMARY KEY,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
-- one email per order for order-based automations, even if two servers race
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_sends_order ON automation_sends(automation_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_sends_lookup ON automation_sends(automation_id, customer_id, created_at);

-- Content calendar: social posts planned by date (posting itself is done by the owner)
CREATE TABLE IF NOT EXISTS content_posts (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  post_date DATE NOT NULL,
  channel TEXT NOT NULL DEFAULT 'instagram',  -- instagram | whatsapp | facebook | tiktok | other
  title TEXT NOT NULL,
  caption TEXT,
  status TEXT NOT NULL DEFAULT 'planned',     -- planned | posted
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_posts_date ON content_posts(business_id, post_date);

-- Inbox: one conversation per contact per channel, with its messages.
-- channel: chat (storefront) | email | whatsapp | instagram | facebook
CREATE TABLE IF NOT EXISTS inbox_conversations (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  contact_handle TEXT NOT NULL,        -- email address, phone number, social id, or a guest id for chat
  contact_name TEXT,
  contact_detail TEXT,                 -- chat only: the email/phone the visitor typed (never used as a key — see routes/chat.js)
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_preview TEXT,
  last_direction TEXT,                 -- in | out
  last_inbound_external_id TEXT,       -- email Message-Id, so replies thread correctly
  chat_token TEXT,                     -- secret the storefront visitor keeps to read replies
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, channel, contact_handle)
);
CREATE INDEX IF NOT EXISTS idx_inbox_conv_list ON inbox_conversations(business_id, status, last_message_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbox_chat_token ON inbox_conversations(chat_token) WHERE chat_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbox_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,             -- in | out
  body TEXT NOT NULL,
  external_id TEXT,                    -- provider's message id; stops the same message being stored twice
  status TEXT NOT NULL DEFAULT 'sent', -- sent | failed
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbox_msg_external ON inbox_messages(conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_msg_conv ON inbox_messages(conversation_id, id);

-- ---- in-app notifications (the bell in the dashboard) ----
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                  -- order | stock | message | campaign
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                           -- dashboard page to open: orders | inventory | inbox | marketing
  dedupe_key TEXT,                     -- while unread, the same key updates one row instead of piling up
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_list ON notifications(business_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_unread_key ON notifications(business_id, dedupe_key) WHERE read_at IS NULL AND dedupe_key IS NOT NULL;

-- ---- subscriptions: merchants paying Kooza ----
CREATE TABLE IF NOT EXISTS subscriptions (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',                -- free | growth | pro (the plan they PAID for; during a trial the effective plan is Pro)
  status TEXT NOT NULL DEFAULT 'trialing',          -- trialing | active | past_due | free
  billing_interval TEXT NOT NULL DEFAULT 'monthly', -- monthly | yearly
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  authorization_code TEXT,                          -- Paystack's reusable card token (the card number itself never touches our server)
  card_brand TEXT, card_last4 TEXT, card_exp TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  next_charge_at TIMESTAMPTZ,
  trial_reminded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_renewal ON subscriptions(status, current_period_end);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  billing_interval TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  reference TEXT NOT NULL UNIQUE,                   -- Paystack reference; UNIQUE so a webhook + redirect can never charge-credit twice
  method TEXT NOT NULL DEFAULT 'card',              -- card | manual
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_biz ON subscription_payments(business_id, created_at DESC);
